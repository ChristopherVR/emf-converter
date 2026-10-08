/**
 * Rebuilds `src/jpeg-cmyk-data.ts`, the 16^4 table of Windows' CMYK -> sRGB conversion for CMYK JPEG.
 *
 * What Windows does (found with `IcmProbe.cs`; see docs/limitations.md): GDI+ converts CMYK JPEG samples with the
 * Windows ICM colour-management module (`mscms.dll`, best-mode transform, perceptual intent, RSWOP.icm to sRGB).
 * The module samples the profile chain onto a 16 x 16 x 16 x 16 table of 16-bit integer colours and interpolates it
 * tetrahedrally (fractions sorted in descending order). An ink `v` sits at grid position `t(v) / 4369`, where `t` is
 * the 256-entry input table of the profile's A2B0 tag (`cmykInputCurve` in `src/jpeg-cmyk.ts`; `curve` below checks
 * the closed form against the profile). `TranslateBitmapBits` with the same flags reproduces GDI+'s output byte for
 * byte, so it is the oracle; `TranslateColors` takes 16-bit ink words and returns, for the 8-bit ink `v` entered as
 * `257 v`, exactly the 16-bit colour that the 8-bit path produces before it keeps the top byte.
 *
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts inputs <dir>
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 icm-cmyk-srgb16 -TablesDir <dir>
 *   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/gdi-fixtures/generate.ps1 icm-cmyk-translate16 -TablesDir <dir>
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts fit <dir>
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts samples <dir>
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts curve
 *
 * `inputs` writes pseudo-random ink combinations (`probes1.ink` mixed distributions, `uniform.ink` uniform bytes,
 * `val.ink` held out: four bytes C, M, Y, K per sample), `axes.ink` (pure inks and every equal-ink mixture, repeated
 * 40 times in the fit because flat graphics and grey ramps use them) and `t16.cmyk16` (little-endian 16-bit words: 2,000 inks as
 * `257 v` followed by 2,000 random 16-bit inks). The probes turn each `.ink` into 16-bit sRGB (`.srgb16`, B, G, R
 * words) and 8-bit sRGB (`.srgb8`), and `t16.cmyk16` into 16-bit R, G, B words (`t16.rgb16t`). `fit` solves the
 * node values: every sample is a known weighted sum of five nodes, so the system is linear. It runs a
 * preconditioned conjugate-gradient least squares (samples that came out as 0 or 65535 only bound the sum, since nodes
 * beyond the gamut are not clipped, which is handled by iterating with the predicted value as the target wherever it
 * already lies beyond the bound), then a coordinate descent that moves each node by whole `CMYK_QUANT` steps to
 * whatever minimises the squared error of the samples it touches (this is worth most of the difference between
 * rounding every node independently and the unquantised fit), refines the nodes that equal-ink colours interpolate
 * between (`cmykRefinedNodes`) to single levels, and writes the table as a 4-D difference followed by those
 * corrections. `val.*` is left out of the fit and only reported. `samples` writes the committed captures.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { CMYK_DATA_ALPHABET, CMYK_GRID, CMYK_NODE_LIMIT, CMYK_QUANT, cmykInputCurve, cmykRefinedNodes } from '../../src/jpeg-cmyk';

const [command, dir] = process.argv.slice(2);
if (command !== 'curve' && (!dir || (command !== 'inputs' && command !== 'fit' && command !== 'samples'))) {
	throw new Error('Usage: generate-cmyk-lut.ts inputs|fit|samples <directory> | curve');
}
const N = CMYK_GRID;
const G = N ** 4;
const STRIDES = [N ** 3, N ** 2, N, 1];
const CELL = 4369;
const u16 = (bytes: Buffer): Uint16Array => new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);

if (command === 'curve') {
	// The closed form against the A2B0 input tables (4 x 256 entries after the 52-byte lut16 header) of the profile.
	const profile = readFileSync('C:\\Windows\\System32\\spool\\drivers\\color\\RSWOP.icm');
	const view = new DataView(profile.buffer, profile.byteOffset, profile.length);
	let a2b0 = -1;
	for (let i = 0, n = view.getUint32(128); i < n; i++) if (profile.toString('latin1', 132 + i * 12, 136 + i * 12) === 'A2B0') a2b0 = view.getUint32(136 + i * 12);
	if (a2b0 < 0 || profile.toString('latin1', a2b0, a2b0 + 4) !== 'mft2' || view.getUint16(a2b0 + 48) !== 256) throw new Error('unexpected A2B0 layout');
	let mismatches = 0;
	for (let c = 0; c < 4; c++) for (let k = 0; k < 256; k++) if (view.getUint16(a2b0 + 52 + (c * 256 + k) * 2) !== cmykInputCurve(k)) mismatches++;
	console.log(`input curve: ${mismatches} of 1024 table entries differ from cmykInputCurve`);
	process.exit(mismatches ? 1 : 0);
}

function randomSource(seed0: number): { random: () => number; integer: (n: number) => number } {
	let seed = seed0;
	const random = (): number => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	return { random, integer: (n: number): number => Math.floor(random() * n) };
}

if (command === 'inputs') {
	mkdirSync(dir, { recursive: true });
	for (const [name, seed0, count] of [['probes1', 12345, 3_000_000], ['uniform', 424242, 3_000_000], ['val', 99991, 1_000_000]] as [string, number, number][]) {
		const { random, integer } = randomSource(seed0);
		const out = new Uint8Array(count * 4);
		for (let i = 0; i < count; i++) {
			let ink: number[];
			if (name === 'uniform') ink = [integer(256), integer(256), integer(256), integer(256)];
			else {
				switch (i & 3) {
					case 0: ink = [integer(256), integer(256), integer(256), integer(256)]; break; // uniform
					case 1: ink = [0, 1, 2, 3].map(() => (random() < 0.5 ? 0 : integer(256))); break; // inks absent or uniform
					case 2: ink = [0, 1, 2, 3].map(() => Math.min(255, Math.floor(random() ** 2 * 256))); break; // light inks
					default: ink = [integer(256), integer(256), integer(256), random() < 0.5 ? 0 : integer(256)]; // sparse black
				}
			}
			out.set(ink, i * 4);
		}
		writeFileSync(join(dir, `${name}.ink`), out);
	}
	// Pure inks and equal-ink mixtures (single-ink ramps, every pair, triple and all four at one value): the colours that
	// flat graphics, text and grey ramps use. The fit repeats them so their nodes are settled before the rest.
	const axes: number[] = [];
	for (let v = 0; v < 256; v++) {
		for (let mask = 1; mask < 16; mask++) for (let d = 0; d < 4; d++) axes.push(mask >> d & 1 ? v : 0);
	}
	writeFileSync(join(dir, 'axes.ink'), Uint8Array.from(axes));
	// 16-bit inks for TranslateColors: the first 2,000 held-out samples as 257 v, then 2,000 uniformly random words.
	const val = readFileSync(join(dir, 'val.ink'));
	const words = new Uint16Array(4000 * 4);
	for (let i = 0; i < 2000 * 4; i++) words[i] = val[i] * 257;
	const { integer } = randomSource(7777);
	for (let i = 2000 * 4; i < words.length; i++) words[i] = integer(65536);
	writeFileSync(join(dir, 't16.cmyk16'), new Uint8Array(words.buffer));
	console.log(`wrote probes1.ink, uniform.ink, val.ink and t16.cmyk16 to ${dir}`);
	process.exit(0);
}

if (command === 'samples') {
	const ink = readFileSync(join(dir, 'val.ink'));
	const rgb8 = readFileSync(join(dir, 'val.srgb8'));
	const rgb16 = u16(readFileSync(join(dir, 'val.srgb16')));
	const fixtures = new URL('../../src/__fixtures__/gdi/', import.meta.url);
	const count = 8000;
	const out8 = new Uint8Array(count * 7);
	const out16 = new Uint8Array(count * 10);
	for (let i = 0; i < count; i++) {
		out8.set(ink.subarray(i * 4, i * 4 + 4), i * 7);
		// The 8-bit probe output is B, G, R, X; the 16-bit one is B, G, R words.
		out8.set([rgb8[i * 4 + 2], rgb8[i * 4 + 1], rgb8[i * 4]], i * 7 + 4);
		out16.set(ink.subarray(i * 4, i * 4 + 4), i * 10);
		for (let c = 0; c < 3; c++) {
			const v = rgb16[i * 3 + 2 - c];
			out16[i * 10 + 4 + c * 2] = v & 255;
			out16[i * 10 + 5 + c * 2] = v >> 8;
		}
	}
	writeFileSync(new URL('icm-cmyk-samples.bin', fixtures), out8);
	writeFileSync(new URL('icm-cmyk-samples16.bin', fixtures), out16);
	// TranslateColors: 4,000 records of seven little-endian words (C, M, Y, K input, R, G, B output).
	const t16in = u16(readFileSync(join(dir, 't16.cmyk16')));
	const t16out = u16(readFileSync(join(dir, 't16.rgb16t')));
	const records = new Uint16Array(4000 * 7);
	for (let i = 0; i < 4000; i++) {
		for (let c = 0; c < 4; c++) records[i * 7 + c] = t16in[i * 4 + c];
		for (let c = 0; c < 3; c++) records[i * 7 + 4 + c] = t16out[i * 3 + c];
	}
	writeFileSync(new URL('icm-cmyk-translate16.bin', fixtures), new Uint8Array(records.buffer));
	console.log(`wrote ${count} samples (8-bit and 16-bit) and 4000 TranslateColors records`);
	process.exit(0);
}

// ---------------------------------------------------------------------------------------------------- fit

/** A set of samples: ink bytes and the 16-bit (and optionally 8-bit) colours Windows returns for them. */
interface Samples {
	count: number;
	ink: Uint8Array;
	/** R, G, B words per sample. */
	rgb16: Uint16Array;
	/** R, G, B bytes per sample. */
	rgb8: Uint8Array;
}

function loadSet(name: string): Samples {
	const ink = new Uint8Array(readFileSync(join(dir, `${name}.ink`)));
	const count = ink.length / 4;
	const bgr16 = u16(readFileSync(join(dir, `${name}.srgb16`)));
	const bgr8 = readFileSync(join(dir, `${name}.srgb8`));
	const rgb16 = new Uint16Array(count * 3);
	const rgb8 = new Uint8Array(count * 3);
	for (let i = 0; i < count; i++) {
		for (let c = 0; c < 3; c++) {
			rgb16[i * 3 + c] = bgr16[i * 3 + 2 - c];
			rgb8[i * 3 + c] = bgr8[i * 4 + 2 - c];
		}
	}
	return { count, ink, rgb16, rgb8 };
}

/** The ink positions in cells (0 to 15) of every 8-bit value. */
const position = Float64Array.from({ length: 256 }, (_, v) => cmykInputCurve(v) / CELL);

/** Tetrahedral cell of an ink: the five nodes (flat indices) and their weights, written at `at`. */
function cell(ink: ArrayLike<number>, offset: number, nodes: Int32Array, weights: Float32Array | Float64Array, at: number): void {
	let index = 0;
	const frac = [0, 0, 0, 0];
	const order = [0, 1, 2, 3];
	for (let d = 0; d < 4; d++) {
		const pos = position[ink[offset + d]];
		const base = Math.min(N - 2, Math.floor(pos));
		index += base * STRIDES[d];
		frac[d] = pos - base;
	}
	for (let i = 1; i < 4; i++) {
		const o = order[i];
		let j = i - 1;
		while (j >= 0 && frac[order[j]] < frac[o]) {
			order[j + 1] = order[j];
			j--;
		}
		order[j + 1] = o;
	}
	nodes[at] = index;
	weights[at] = 1 - frac[order[0]];
	for (let s = 0; s < 4; s++) {
		index += STRIDES[order[s]];
		nodes[at + 1 + s] = index;
		weights[at + 1 + s] = frac[order[s]] - (s < 3 ? frac[order[s + 1]] : 0);
	}
}

const AXES_REPEAT = 40;
const train = [loadSet('probes1'), loadSet('uniform'), ...Array.from({ length: AXES_REPEAT }, () => loadSet('axes'))];
const P = train.reduce((sum, set) => sum + set.count, 0);
console.log(`${P} training samples`);
const cellNodes = new Int32Array(P * 5);
const cellWeights = new Float32Array(P * 5);
const target = new Uint16Array(P * 3);
const label = new Uint8Array(P * 3);
{
	let p = 0;
	for (const set of train) {
		for (let i = 0; i < set.count; i++, p++) {
			cell(set.ink, i * 4, cellNodes, cellWeights, p * 5);
			for (let c = 0; c < 3; c++) {
				target[p * 3 + c] = set.rgb16[i * 3 + c];
				label[p * 3 + c] = set.rgb8[i * 3 + c];
			}
		}
	}
}

function predictions(x: Float64Array, channel: number, into: Float64Array): void {
	for (let p = 0; p < P; p++) {
		let s = 0;
		for (let q = 0; q < 5; q++) s += cellWeights[p * 5 + q] * x[cellNodes[p * 5 + q]];
		into[p] = s;
	}
	void channel;
}

/** Preconditioned conjugate gradients on the normal equations, targets lifted to the prediction where a sample only bounds it. */
function solveChannel(x: Float64Array, channel: number, iterations: number, initialise: boolean): void {
	const lambda = 1e-3;
	if (initialise) {
		const sum = new Float64Array(G);
		const mass = new Float64Array(G);
		for (let p = 0; p < P; p++) {
			for (let q = 0; q < 5; q++) {
				sum[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q] * target[p * 3 + channel];
				mass[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q];
			}
		}
		for (let i = 0; i < G; i++) x[i] = mass[i] ? sum[i] / mass[i] : 32768;
	}
	const predicted = new Float64Array(P);
	predictions(x, channel, predicted);
	const y = new Float64Array(P);
	for (let p = 0; p < P; p++) {
		const t = target[p * 3 + channel];
		y[p] = t === 0 && predicted[p] < 0 ? predicted[p] : t === 65535 && predicted[p] > 65535 ? predicted[p] : t;
	}
	const diag = new Float64Array(G).fill(lambda);
	for (let p = 0; p < P; p++) for (let q = 0; q < 5; q++) diag[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q] ** 2;
	const scratch = new Float64Array(P);
	const apply = (v: Float64Array, out: Float64Array): void => {
		predictions(v, channel, scratch);
		out.fill(0);
		for (let p = 0; p < P; p++) for (let q = 0; q < 5; q++) out[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q] * scratch[p];
		for (let i = 0; i < G; i++) out[i] += lambda * v[i];
	};
	const b = new Float64Array(G);
	for (let p = 0; p < P; p++) for (let q = 0; q < 5; q++) b[cellNodes[p * 5 + q]] += cellWeights[p * 5 + q] * y[p];
	for (let i = 0; i < G; i++) b[i] += lambda * x[i];
	const r = new Float64Array(G);
	const ap = new Float64Array(G);
	const z = new Float64Array(G);
	const d = new Float64Array(G);
	apply(x, r);
	for (let i = 0; i < G; i++) {
		r[i] = b[i] - r[i];
		z[i] = r[i] / diag[i];
		d[i] = z[i];
	}
	let rz = 0;
	for (let i = 0; i < G; i++) rz += r[i] * z[i];
	for (let iteration = 0; iteration < iterations; iteration++) {
		apply(d, ap);
		let denominator = 0;
		for (let i = 0; i < G; i++) denominator += d[i] * ap[i];
		const alpha = rz / denominator;
		for (let i = 0; i < G; i++) {
			x[i] += alpha * d[i];
			r[i] -= alpha * ap[i];
			z[i] = r[i] / diag[i];
		}
		let next = 0;
		for (let i = 0; i < G; i++) next += r[i] * z[i];
		const beta = next / rz;
		rz = next;
		for (let i = 0; i < G; i++) d[i] = z[i] + beta * d[i];
	}
}

const fit = [new Float64Array(G), new Float64Array(G), new Float64Array(G)];
for (let pass = 0; pass < 3; pass++) {
	for (let channel = 0; channel < 3; channel++) solveChannel(fit[channel], channel, pass === 0 ? 60 : 40, pass === 0);
	const predicted = new Float64Array(P);
	let squares = 0;
	let counted = 0;
	for (let channel = 0; channel < 3; channel++) {
		predictions(fit[channel], channel, predicted);
		for (let p = 0; p < P; p += 5) {
			const t = target[p * 3 + channel];
			if (t > 0 && t < 65535) {
				squares += (predicted[p] - t) ** 2;
				counted++;
			}
		}
	}
	console.log(`least squares pass ${pass + 1}: rms ${Math.sqrt(squares / counted).toFixed(3)} (16-bit levels, unclipped samples)`);
}

// Coordinate descent on nodes restricted to multiples of the step (CMYK_QUANT; CMYK_STEP=n tries another step and does not write the module).
const STEP = Number(process.env.CMYK_STEP ?? CMYK_QUANT);
const stored = new Int32Array(G * 3);
/** The final node values in 16-bit levels: `stored` times the step, plus the refinement of the equal-ink nodes. */
const levels = new Int32Array(G * 3);
const refined = cmykRefinedNodes();
{
	// Samples per node.
	const count = new Int32Array(G + 1);
	for (let i = 0; i < P * 5; i++) count[cellNodes[i] + 1]++;
	for (let i = 0; i < G; i++) count[i + 1] += count[i];
	const next = Int32Array.from(count.subarray(0, G));
	const slots = new Int32Array(P * 5);
	for (let i = 0; i < P * 5; i++) slots[next[cellNodes[i]]++] = i;
	const low = Math.ceil(-CMYK_NODE_LIMIT / STEP);
	const high = Math.floor((65535 + CMYK_NODE_LIMIT) / STEP);
	const predicted = new Float64Array(P);
	for (let channel = 0; channel < 3; channel++) {
		const x = fit[channel];
		for (let i = 0; i < G; i++) x[i] = STEP * Math.max(low, Math.min(high, Math.round(x[i] / STEP)));
		predictions(x, channel, predicted);
		for (let sweep = 0; sweep < 4; sweep++) {
			let changed = 0;
			for (let node = 0; node < G; node++) {
				let numerator = 0;
				let denominator = 0;
				for (let k = count[node]; k < count[node + 1]; k++) {
					const slot = slots[k];
					const p = (slot / 5) | 0;
					const weight = cellWeights[slot];
					if (weight < 0.02) continue;
					const t = target[p * 3 + channel];
					const pr = predicted[p];
					if ((t === 0 && pr <= 0) || (t === 65535 && pr >= 65535)) continue;
					numerator += weight * (t - pr);
					denominator += weight * weight;
				}
				if (denominator < 1e-6) continue;
				const wanted = STEP * Math.max(low, Math.min(high, Math.round((x[node] + numerator / denominator) / STEP)));
				const delta = wanted - x[node];
				if (delta === 0) continue;
				changed++;
				x[node] = wanted;
				for (let k = count[node]; k < count[node + 1]; k++) predicted[(slots[k] / 5) | 0] += cellWeights[slots[k]] * delta;
			}
			console.log(`channel ${channel} descent sweep ${sweep + 1}: ${changed} nodes moved`);
		}
		for (let i = 0; i < G; i++) stored[i * 3 + channel] = x[i] / STEP;
		// The nodes that pure inks and equal mixtures of inks interpolate between move in single levels.
		for (let sweep = 0; sweep < 4; sweep++) {
			let changed = 0;
			for (const node of refined) {
				let numerator = 0;
				let denominator = 0;
				for (let k = count[node]; k < count[node + 1]; k++) {
					const slot = slots[k];
					const p = (slot / 5) | 0;
					const weight = cellWeights[slot];
					if (weight < 0.02) continue;
					const t = target[p * 3 + channel];
					const pr = predicted[p];
					if ((t === 0 && pr <= 0) || (t === 65535 && pr >= 65535)) continue;
					numerator += weight * (t - pr);
					denominator += weight * weight;
				}
				if (denominator < 1e-6) continue;
				const wanted = Math.round(x[node] + numerator / denominator);
				const delta = wanted - x[node];
				if (delta === 0) continue;
				changed++;
				x[node] = wanted;
				for (let k = count[node]; k < count[node + 1]; k++) predicted[(slots[k] / 5) | 0] += cellWeights[slots[k]] * delta;
			}
			console.log(`channel ${channel} refinement sweep ${sweep + 1}: ${changed} of ${refined.length} nodes moved`);
		}
		for (let i = 0; i < G; i++) levels[i * 3 + channel] = x[i];
	}
}

function report(label: string, set: Samples): void {
	let exact = 0;
	let within = 0;
	let worst = 0;
	const nodes = new Int32Array(5);
	const weights = new Float64Array(5);
	for (let p = 0; p < set.count; p++) {
		cell(set.ink, p * 4, nodes, weights, 0);
		for (let channel = 0; channel < 3; channel++) {
			let v = 0;
			for (let q = 0; q < 5; q++) v += weights[q] * levels[nodes[q] * 3 + channel];
			const level = Math.floor(Math.min(65535, Math.max(0, v)) / 256);
			const d = Math.abs(level - set.rgb8[p * 3 + channel]);
			if (d === 0) exact++;
			if (d <= 1) within++;
			worst = Math.max(worst, d);
		}
	}
	const total = set.count * 3;
	console.log(`${label}: ${((100 * exact) / total).toFixed(3)}% exact, ${((100 * within) / total).toFixed(3)}% within one level, worst ${worst} (${total} channel values)`);
}
report('fit samples', train[0]);
report('held out', loadSet('val'));

// 4-D difference of each channel's grid, zigzag coded (one byte, or 255 and three bytes), deflated, base 85.
const residual = Int32Array.from(stored);
for (const stride of [1, N, N * N, N ** 3]) {
	for (let i = G - 1; i >= 0; i--) {
		if (Math.floor(i / stride) % N) for (let channel = 0; channel < 3; channel++) residual[i * 3 + channel] -= residual[(i - stride) * 3 + channel];
	}
}
const stream: number[] = [];
// ... then, per refined node and channel, how far the final level sits from the step grid.
const corrections = refined.flatMap(node => [0, 1, 2].map(channel => levels[node * 3 + channel] - stored[node * 3 + channel] * STEP));
for (const r of [...residual, ...corrections]) {
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
if (STEP !== CMYK_QUANT) {
	console.log(`step ${STEP}: ${encoded.length} characters (not written: jpeg-cmyk.ts reads steps of ${CMYK_QUANT})`);
	process.exit(0);
}
writeFileSync(
	new URL('../../src/jpeg-cmyk-data.ts', import.meta.url),
	`/**
 * The Windows ICM CMYK -> sRGB table for CMYK JPEG (16^4 nodes of 16-bit R, G, B in steps of ${STEP}; see jpeg-cmyk.ts),
 * solved by scripts/gdi-fixtures/generate-cmyk-lut.ts from ${P} mscms.dll samples. 4-D difference, zigzag, zlib, base 85.
 *
 * @module jpeg-cmyk-data
 */

export const CMYK_LUT_DATA =
	'${encoded}';
`,
);
console.log(`wrote src/jpeg-cmyk-data.ts (${encoded.length} characters)`);
