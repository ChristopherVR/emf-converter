/**
 * Rebuilds `src/jpeg-cmyk-data.ts`, the 16^4 table of Windows' CMYK -> sRGB conversion for CMYK JPEG.
 *
 * What Windows does (found with `IcmProbe.cs`; see docs/limitations.md): GDI+ converts CMYK JPEG samples with the
 * Windows ICM colour-management module (`mscms.dll`, best-mode transform, perceptual intent, RSWOP.icm to sRGB),
 * and that module resamples the profile chain onto a 16 x 16 x 16 x 16 table of 16-bit colours over the input
 * 8-bit sample `v` taken as `v << 8` (node `j` sits at 4369 j, so ink `v` is at grid position `v * 256 / 4369`),
 * interpolates it tetrahedrally (fractions sorted in descending order), and keeps the top eight bits of the
 * result. `TranslateBitmapBits` with the same flags reproduces GDI+'s output byte for byte, so it is the oracle:
 *
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts inputs <dir>
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 icm-cmyk-srgb16 -TablesDir <dir>
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts fit <dir>
 *
 * `samples` writes the first 8,000 held-out samples (C, M, Y, K, then R, G, B bytes) to
 * `src/__fixtures__/gdi/icm-cmyk-samples.bin`, the committed ICM capture that `jpeg-cmyk.test.ts` pins.
 * `inputs` writes pseudo-random ink combinations (`probes*.ink`, `val.ink`: four bytes C, M, Y, K per sample). The
 * probe turns each into 16-bit sRGB (`.srgb16`, B, G, R words) and 8-bit sRGB (`.srgb8`). `fit` solves for the
 * node values by least squares: every sample is a known weighted sum of five nodes, so the system is linear.
 * Samples that came out as 0 or 65535 only bound the sum (nodes beyond the gamut are not clipped), which is handled
 * by iterating with the predicted value as the target wherever it already lies beyond the bound. Nodes are rounded
 * to steps of `CMYK_QUANT`, clamped near the gamut, and written as a 4-D difference. `val.*` is left out of the
 * fit and only reported.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { CMYK_DATA_ALPHABET, CMYK_GRID, CMYK_NODE_LIMIT, CMYK_QUANT } from '../../src/jpeg-cmyk';

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== 'inputs' && command !== 'fit' && command !== 'samples')) throw new Error('Usage: generate-cmyk-lut.ts inputs|fit|samples <directory>');
const N = CMYK_GRID;
const G = N ** 4;

if (command === 'samples') {
	const ink = readFileSync(join(dir, 'val.ink'));
	const rgb8 = readFileSync(join(dir, 'val.srgb8'));
	const count = 8000;
	const out = new Uint8Array(count * 7);
	for (let i = 0; i < count; i++) {
		out.set(ink.subarray(i * 4, i * 4 + 4), i * 7);
		// The 8-bit probe output is B, G, R, X.
		out.set([rgb8[i * 4 + 2], rgb8[i * 4 + 1], rgb8[i * 4]], i * 7 + 4);
	}
	writeFileSync(new URL('../../src/__fixtures__/gdi/icm-cmyk-samples.bin', import.meta.url), out);
	console.log(`wrote ${count} samples`);
	process.exit(0);
}
const SCALE = 256 / 4369;

if (command === 'inputs') {
	mkdirSync(dir, { recursive: true });
	for (const [name, seed0, count] of [['probes1', 12345, 3_000_000], ['val', 99991, 1_000_000]] as [string, number, number][]) {
		let seed = seed0;
		const random = (): number => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 4294967296;
		};
		const integer = (n: number): number => Math.floor(random() * n);
		const out = new Uint8Array(count * 4);
		for (let i = 0; i < count; i++) {
			let ink: number[];
			switch (i & 3) {
				case 0: ink = [integer(256), integer(256), integer(256), integer(256)]; break; // uniform
				case 1: ink = [0, 1, 2, 3].map(() => (random() < 0.5 ? 0 : integer(256))); break; // inks absent or uniform
				case 2: ink = [0, 1, 2, 3].map(() => Math.min(255, Math.floor(random() ** 2 * 256))); break; // light inks
				default: ink = [integer(256), integer(256), integer(256), random() < 0.5 ? 0 : integer(256)]; // sparse black
			}
			out.set(ink, i * 4);
		}
		writeFileSync(join(dir, `${name}.ink`), out);
	}
	console.log(`wrote probes1.ink and val.ink to ${dir}`);
	process.exit(0);
}

/** Tetrahedral cell of an ink: the five nodes (flat indices) and their weights. */
function cell(ink: ArrayLike<number>, offset: number, nodes: Int32Array, weights: Float64Array, at: number): void {
	const base = [0, 0, 0, 0];
	const frac = [0, 0, 0, 0];
	for (let d = 0; d < 4; d++) {
		const pos = ink[offset + d] * SCALE;
		base[d] = Math.min(N - 2, Math.floor(pos));
		frac[d] = pos - base[d];
	}
	const order = [0, 1, 2, 3].sort((a, b) => frac[b] - frac[a]);
	const walk = [...base];
	const index = (): number => ((walk[0] * N + walk[1]) * N + walk[2]) * N + walk[3];
	nodes[at] = index();
	weights[at] = 1 - frac[order[0]];
	for (let s = 0; s < 4; s++) {
		walk[order[s]]++;
		nodes[at + 1 + s] = index();
		weights[at + 1 + s] = frac[order[s]] - (s < 3 ? frac[order[s + 1]] : 0);
	}
}

function loadSet(name: string): { ink: Uint8Array; rgb16: DataView; rgb8: Uint8Array | null } {
	const ink = new Uint8Array(readFileSync(join(dir, `${name}.ink`)));
	const bytes = readFileSync(join(dir, `${name}.srgb16`));
	let rgb8: Uint8Array | null = null;
	try { rgb8 = new Uint8Array(readFileSync(join(dir, `${name}.srgb8`))); } catch { /* optional */ }
	return { ink, rgb16: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), rgb8 };
}

const train = loadSet('probes1');
const P = train.ink.length / 4;
const cellNodes = new Int32Array(P * 5);
const cellWeights = new Float64Array(P * 5);
for (let p = 0; p < P; p++) cell(train.ink, p * 4, cellNodes, cellWeights, p * 5);

const fit = [new Float64Array(G), new Float64Array(G), new Float64Array(G)];
const lambda = 1e-5;
for (let channel = 0; channel < 3; channel++) {
	// The probe writes 16-bit words as B, G, R.
	const observed = new Float64Array(P);
	for (let p = 0; p < P; p++) observed[p] = train.rgb16.getUint16((p * 3 + 2 - channel) * 2, true);
	const x = fit[channel];
	// Start from the weighted mean of what each node was seen contributing to.
	const sum = new Float64Array(G);
	const mass = new Float64Array(G);
	for (let p = 0; p < P; p++) {
		for (let q = 0; q < 5; q++) {
			sum[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q] * observed[p];
			mass[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q];
		}
	}
	for (let i = 0; i < G; i++) x[i] = mass[i] ? sum[i] / mass[i] : 32768;
	const apply = (v: Float64Array, out: Float64Array): void => {
		out.fill(0);
		for (let p = 0; p < P; p++) {
			let s = 0;
			for (let q = 0; q < 5; q++) s += cellWeights[p * 5 + q] * v[cellNodes[p * 5 + q]];
			for (let q = 0; q < 5; q++) out[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q] * s;
		}
		for (let i = 0; i < G; i++) out[i] += lambda * v[i];
	};
	const outerPasses = Number(process.env.CMYK_PASSES ?? 80);
	for (let pass = 0; pass < outerPasses; pass++) {
		const b = new Float64Array(G);
		for (let p = 0; p < P; p++) {
			let predicted = 0;
			for (let q = 0; q < 5; q++) predicted += cellWeights[p * 5 + q] * x[cellNodes[p * 5 + q]];
			let target = observed[p];
			if (target === 0 && predicted < 0) target = predicted;
			if (target === 65535 && predicted > 65535) target = predicted;
			for (let q = 0; q < 5; q++) b[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q] * target;
		}
		const r = new Float64Array(G);
		apply(x, r);
		for (let i = 0; i < G; i++) r[i] = b[i] - r[i];
		const direction = Float64Array.from(r);
		const ap = new Float64Array(G);
		let rs = r.reduce((a, v) => a + v * v, 0);
		for (let iteration = 0; iteration < 60 && rs > 1e-6; iteration++) {
			apply(direction, ap);
			let denominator = 0;
			for (let i = 0; i < G; i++) denominator += direction[i] * ap[i];
			const alpha = rs / denominator;
			let next = 0;
			for (let i = 0; i < G; i++) {
				x[i] += alpha * direction[i];
				r[i] -= alpha * ap[i];
				next += r[i] * r[i];
			}
			const beta = next / rs;
			rs = next;
			for (let i = 0; i < G; i++) direction[i] = r[i] + beta * direction[i];
		}
		if (pass % 10 === 9 || pass === outerPasses - 1) {
			let squares = 0;
			for (let p = 0; p < P; p++) {
				let predicted = 0;
				for (let q = 0; q < 5; q++) predicted += cellWeights[p * 5 + q] * x[cellNodes[p * 5 + q]];
				const e = Math.min(65535, Math.max(0, predicted)) - observed[p];
				squares += e * e;
			}
			console.log(`channel ${channel} pass ${pass + 1}: rms ${Math.sqrt(squares / P).toFixed(2)} (16-bit levels)`);
		}
	}
}

// Quantise: steps of CMYK_QUANT, nodes held within CMYK_NODE_LIMIT of the 16-bit range.
const stored = new Int32Array(3 * G);
for (let i = 0; i < G; i++) {
	for (let channel = 0; channel < 3; channel++) {
		const v = Math.max(-CMYK_NODE_LIMIT, Math.min(65535 + CMYK_NODE_LIMIT, fit[channel][i]));
		stored[i * 3 + channel] = Math.round(v / CMYK_QUANT);
	}
}

function report(label: string, set: { ink: Uint8Array; rgb8: Uint8Array | null }): void {
	if (!set.rgb8) return;
	const nodes = new Int32Array(5);
	const weights = new Float64Array(5);
	let exact = 0;
	let within = 0;
	let worst = 0;
	const count = set.ink.length / 4;
	for (let p = 0; p < count; p++) {
		cell(set.ink, p * 4, nodes, weights, 0);
		for (let channel = 0; channel < 3; channel++) {
			let v = 0;
			for (let q = 0; q < 5; q++) v += weights[q] * stored[nodes[q] * 3 + channel];
			const level = Math.floor(Math.min(65535, Math.max(0, v * CMYK_QUANT)) / 256);
			const d = Math.abs(level - set.rgb8[p * 4 + 2 - channel]);
			if (d === 0) exact++;
			if (d <= 1) within++;
			worst = Math.max(worst, d);
		}
	}
	const total = count * 3;
	console.log(`${label}: ${((100 * exact) / total).toFixed(3)}% exact, ${((100 * within) / total).toFixed(3)}% within one level, worst ${worst} (${total} channel values)`);
}
report('fit samples', train);
report('held out', loadSet('val'));

// 4-D difference of each channel's grid, zigzag coded (one byte, or 255 and three bytes), deflated, base 85.
const residual = Int32Array.from(stored);
const strides = [N ** 3, N ** 2, N, 1];
for (const stride of [1, N, N * N, N ** 3]) {
	for (let i = G - 1; i >= 0; i--) {
		if (Math.floor(i / stride) % N) for (let channel = 0; channel < 3; channel++) residual[i * 3 + channel] -= residual[(i - stride) * 3 + channel];
	}
}
void strides;
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
 * The Windows ICM CMYK -> sRGB table that GDI+ applies to CMYK JPEG: 16 x 16 x 16 x 16 nodes of 16-bit R, G and B
 * (C varies slowest, K fastest; node \`j\` of an ink sits at sample value 4369 j / 256), in steps of ${CMYK_QUANT} levels,
 * nodes beyond the gamut kept up to ${CMYK_NODE_LIMIT} outside it. Captured from \`mscms.dll\` with
 * \`scripts/gdi-fixtures/IcmProbe.cs\` and solved by \`generate-cmyk-lut.ts\` from ${P} samples. Stored as a 4-D
 * difference, zigzag coded, zlib-compressed and written in base 85 (see \`nodeTable\` in jpeg-cmyk.ts).
 *
 * @module jpeg-cmyk-data
 */

export const CMYK_LUT_DATA =
	'${encoded}';
`,
);
console.log(`wrote src/jpeg-cmyk-data.ts (${encoded.length} characters)`);
