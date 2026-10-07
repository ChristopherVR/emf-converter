/**
 * Rebuilds `src/jpeg-cmyk-data.ts`, the table Windows' CMYK -> sRGB conversion is modelled by.
 *
 *   python scripts/gdi-fixtures/cmyk-lut-inputs.py <dir>
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 image-codecs-cmyk-lut -TablesDir <dir>
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts <dir>
 *
 * Each `<name>.jpg` in `<dir>` is a picture of flat 8 x 8 blocks; `<name>.png` is what GDI+ decodes it to. The
 * block's decoded components (no colour conversion) are the ink amounts, the PNG pixel is the colour Windows
 * draws. The script fits the node values of a 17^4 grid (linearly interpolated between the nodes, ink `v` at grid
 * position `v * 16 / 255`, the result clamped to 0..255) to those pairs by regularised least squares. A sample
 * that Windows clamped to 0 or 255 only bounds the interpolated value, so nodes may lie outside 0..255. Files
 * named `hold*` are left out of the fit and only reported.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodeJpegPlanes } from '../../src/jpeg-turbo';
import { decodePng } from '../../src/png-decoder';
import { CMYK_DATA_ALPHABET, CMYK_GRID, CMYK_NODE_OFFSET, cmykCorners } from '../../src/jpeg-cmyk';

const dir = process.argv[2];
if (!dir) throw new Error('Pass the directory holding the decoded pairs');
const N = CMYK_GRID;
const G = N ** 4;

interface Sample {
	ink: number[];
	rgb: number[];
}

async function load(name: string): Promise<Sample[]> {
	const planes = decodeJpegPlanes(new Uint8Array(readFileSync(join(dir, `${name}.jpg`))));
	const png = await decodePng(new Uint8Array(readFileSync(join(dir, `${name}.png`))));
	if (!planes || !png) throw new Error(`Cannot read ${name}`);
	const samples: Sample[] = [];
	for (let by = 0; by < planes.height / 8; by++) {
		for (let bx = 0; bx < planes.width / 8; bx++) {
			const i = (by * 8 + 3) * planes.width + bx * 8 + 3;
			// Adobe CMYK stores 255 minus the ink amount.
			samples.push({ ink: planes.planes.map(plane => 255 - plane[i]), rgb: [png.data[i * 4], png.data[i * 4 + 1], png.data[i * 4 + 2]] });
		}
	}
	return samples;
}

const names = readdirSync(dir).filter(f => f.endsWith('.jpg')).map(f => f.slice(0, -4)).sort();
const train: Sample[] = [];
const hold: Sample[] = [];
for (const name of names) (name.startsWith('hold') ? hold : train).push(...(await load(name)));
console.log(`fit ${train.length} samples, hold out ${hold.length}`);

const fitWeights = train.map(s => cmykCorners(s.ink[0], s.ink[1], s.ink[2], s.ink[3]));

// Normal equations A^T A x = A^T b with a weak smoothness term that keeps nodes nothing samples reach sensible.
const smooth = Number(process.env.CMYK_SMOOTH ?? 0.02);
const strides = [N ** 3, N ** 2, N, 1];
const nodes = [new Float64Array(G), new Float64Array(G), new Float64Array(G)];
for (let channel = 0; channel < 3; channel++) {
	const x = nodes[channel];
	const apply = (v: Float64Array, out: Float64Array): void => {
		out.fill(0);
		for (const w of fitWeights) {
			let p = 0;
			for (const [i, wt] of w) p += wt * v[i];
			for (const [i, wt] of w) out[i] += wt * p;
		}
		for (let i = 0; i < G; i++) {
			for (let d = 0; d < 4; d++) {
				if (Math.floor(i / strides[d]) % N === N - 1) continue;
				const j = i + strides[d];
				const diff = smooth * (v[i] - v[j]);
				out[i] += diff;
				out[j] -= diff;
			}
		}
	};
	// Outer passes handle clamped samples: where Windows drew 0 (or 255) the interpolated value only has to
	// be at or below 0 (at or above 255), so a prediction already beyond the bound is its own target.
	for (let pass = 0; pass < 4; pass++) {
		const b = new Float64Array(G);
		fitWeights.forEach((w, s) => {
			let target = train[s].rgb[channel];
			if (pass > 0 && (target === 0 || target === 255)) {
				let predicted = 0;
				for (const [i, wt] of w) predicted += wt * x[i];
				if (target === 0 ? predicted < 0 : predicted > 255) target = predicted;
			}
			for (const [i, wt] of w) b[i] += wt * target;
		});
		// Conjugate gradients on the residual of the current estimate.
		const r = new Float64Array(G);
		apply(x, r);
		for (let i = 0; i < G; i++) r[i] = b[i] - r[i];
		const p = Float64Array.from(r);
		const ap = new Float64Array(G);
		let rs = r.reduce((a, v) => a + v * v, 0);
		const rs0 = rs;
		for (let iteration = 0; iteration < (pass === 0 ? 200 : 80) && rs > rs0 * 1e-10; iteration++) {
			apply(p, ap);
			let denominator = 0;
			for (let i = 0; i < G; i++) denominator += p[i] * ap[i];
			const alpha = rs / denominator;
			for (let i = 0; i < G; i++) {
				x[i] += alpha * p[i];
				r[i] -= alpha * ap[i];
			}
			const next = r.reduce((a, v) => a + v * v, 0);
			const beta = next / rs;
			rs = next;
			for (let i = 0; i < G; i++) p[i] = r[i] + beta * p[i];
		}
	}
}

// Store sixteenths of a level above -CMYK_NODE_OFFSET, as `src/jpeg-cmyk.ts` reads them.
const packed = new Uint16Array(3 * G);
for (let channel = 0; channel < 3; channel++) {
	for (let i = 0; i < G; i++) packed[channel * G + i] = Math.max(0, Math.min(65535, Math.round((nodes[channel][i] + CMYK_NODE_OFFSET) * 16)));
}

function report(label: string, samples: Sample[]): void {
	let exact = 0;
	let within = 0;
	let total = 0;
	let worst = 0;
	for (const s of samples) {
		const w = cmykCorners(s.ink[0], s.ink[1], s.ink[2], s.ink[3]);
		for (let channel = 0; channel < 3; channel++) {
			let value = 0;
			for (const [i, wt] of w) value += wt * packed[channel * G + i];
			const level = Math.max(0, Math.min(255, Math.floor(value / 16 - CMYK_NODE_OFFSET + 0.5)));
			const diff = Math.abs(level - s.rgb[channel]);
			total++;
			if (diff === 0) exact++;
			if (diff <= 1) within++;
			worst = Math.max(worst, diff);
		}
	}
	console.log(`${label}: ${((100 * exact) / total).toFixed(1)}% exact, ${((100 * within) / total).toFixed(2)}% within one level, worst ${worst} (${total} channel values)`);
}
report('fit', train);
if (hold.length) report('hold out', hold);

// 4-D difference of each channel's grid, zigzag coded (one byte, or 255 and three bytes), deflated, base 85.
const residual = new Int32Array(3 * G);
residual.set(packed);
for (let channel = 0; channel < 3; channel++) {
	for (const stride of [1, N, N * N, N ** 3]) {
		for (let i = G - 1; i >= 0; i--) {
			if (Math.floor(i / stride) % N) residual[channel * G + i] -= residual[channel * G + i - stride];
		}
	}
}
const stream: number[] = [];
for (const r of residual) {
	const zigzag = r >= 0 ? r * 2 : -r * 2 - 1;
	if (zigzag < 255) stream.push(zigzag);
	else stream.push(255, zigzag & 255, (zigzag >> 8) & 255, zigzag >> 16);
}
const compressed = deflateSync(Uint8Array.from(stream), { level: 9 });
let encoded = '';
for (let i = 0; i < compressed.length; i += 4) {
	let group = 0;
	for (let j = 0; j < 4; j++) group = group * 256 + (i + j < compressed.length ? compressed[i + j] : 0);
	let digits = '';
	for (let d = 0; d < 5; d++) {
		digits = CMYK_DATA_ALPHABET[group % 85] + digits;
		group = Math.floor(group / 85);
	}
	encoded += digits;
}
// The last group's padding digits are dropped: 5 digits per 4 bytes, so a short group keeps one digit more than its bytes.
const tail = compressed.length % 4;
if (tail) encoded = encoded.slice(0, encoded.length - (4 - tail));
writeFileSync(
	new URL('../../src/jpeg-cmyk-data.ts', import.meta.url),
	`/**
 * Windows' CMYK -> sRGB conversion for CMYK JPEG, as a 17 x 17 x 17 x 17 grid of colours (ink amount \`v\` sits at
 * grid position \`v * 16 / 255\`; C varies slowest and K fastest) fitted to what GDI+ draws for ${train.length} flat ink
 * combinations, captured with \`scripts/gdi-fixtures\` (\`image-codecs-cmyk-lut\`) and fitted by
 * \`generate-cmyk-lut.ts\`. Each node holds sixteenths of a level (offset by ${CMYK_NODE_OFFSET} levels, nodes beyond
 * the gamut lie outside 0..255) for R, G and B; the table is stored as a 4-D difference, zigzag coded,
 * zlib-compressed and written in base 85 (see \`nodeTable\` in jpeg-cmyk.ts).
 *
 * @module jpeg-cmyk-data
 */

export const CMYK_LUT_DATA =
	'${encoded}';
`,
);
console.log(`wrote src/jpeg-cmyk-data.ts (${encoded.length} base64 characters)`);
