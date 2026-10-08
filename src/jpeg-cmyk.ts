/**
 * CMYK and YCCK JPEG to RGB, as Windows does it.
 *
 * GDI+ draws a four-component JPEG through the Windows ICM colour-management module (`mscms.dll`): the RSWOP
 * profile to sRGB, perceptual intent, best-quality transform. Measured with `scripts/gdi-fixtures/IcmProbe.cs`,
 * that transform is byte for byte what GDI+ writes (the same module returns the same 16-bit colours through
 * `TranslateColors` from 16-bit input `257 v`). It resamples the profile chain onto a table of 16 x 16 x 16 x 16
 * colours with 16-bit integer nodes and interpolates it tetrahedrally (the four fractions sorted in descending
 * order; node weights are the steps between them), keeping the top eight bits of the 16-bit result. Nodes beyond
 * the sRGB gamut are not clipped, so a colour crossing the gamut edge inside a cell clips only after interpolation.
 *
 * Where an ink sits on the grid is the profile's own input curve, not a linear ramp: the A2B0 tag of RSWOP.icm
 * carries a 256-entry table per ink (the same four times), `t(0) = 0`, `t(v) = 256 v - 1` up to `v = 224`, then
 * a steeper line to `t(255) = 65535` (`cmykInputCurve`). The module takes the table entry as the 16-bit ink and
 * puts node `j` at `t = 4369 j` (`65535 / 15`), so ink `v` is at grid position `t(v) / 4369` and the last node is
 * reached by `v = 255`. (Treating `v` as `v << 8`, `v * 256 / 4369`, leaves the whole table wrong by up to ten
 * thousandths of a cell and misses the top inks entirely.) The table (`jpeg-cmyk-data.ts`) is solved from
 * `mscms.dll` samples (see `scripts/gdi-fixtures/generate-cmyk-lut.ts`); the profile data itself is not bundled.
 *
 * Sample conventions, all measured against GDI+:
 *   - the samples are stored inverted (Adobe style), with or without an Adobe APP14 marker: ink = 255 - sample;
 *   - Adobe transform 2 (YCCK) stores YCbCr in the first three components, converted to RGB with libjpeg's
 *     fixed-point arithmetic, which then is the ink amount of C, M and Y; K is inverted as above.
 *
 * @module jpeg-cmyk
 */
import { CMYK_LUT_DATA } from './jpeg-cmyk-data';
import { inflateZlibSync } from './png-decoder';

/** Grid nodes per ink. */
export const CMYK_GRID = 16;
/** Node values are stored in steps of this many 16-bit levels (a level of the 8-bit result is 256). */
export const CMYK_QUANT = 4;
/** Nodes beyond the gamut are held within this many 16-bit levels of 0..65535. */
export const CMYK_NODE_LIMIT = 2048;
const N = CMYK_GRID;
const GRID_SIZE = N ** 4;
/** Table units per grid cell: `65535 / 15`. */
const CELL = 4369;

/**
 * The profile's input curve for an 8-bit ink `v`, in 16-bit units (node `j` of the grid is at `4369 j`): the A2B0 input
 * table of RSWOP.icm, identical for the four inks. Verified against the 256 entries of all four tables by
 * `generate-cmyk-lut.ts curve`.
 */
export function cmykInputCurve(v: number): number {
	return v === 0 ? 0 : v <= 224 ? 256 * v - 1 : 57343 + Math.floor(((v - 224) * 8192) / 31);
}

/** Cell index (0 to 14) and fraction (0 to 1) of every 8-bit ink value. */
const BASE_OF = new Int32Array(256);
const FRAC_OF = new Float64Array(256);
for (let v = 0; v < 256; v++) {
	const t = cmykInputCurve(v);
	BASE_OF[v] = Math.min(N - 2, Math.floor(t / CELL));
	FRAC_OF[v] = (t - BASE_OF[v] * CELL) / CELL;
}

let table: Int32Array | null = null;

/** Characters of the base-85 text the table is stored as (4 bytes become 5 digits, most significant first). */
export const CMYK_DATA_ALPHABET = Array.from({ length: 90 }, (_, i) => String.fromCharCode(35 + i))
	.filter(c => c !== "'" && c !== '\\' &&c !== '`')
	.slice(0, 85)
	.join('');

/**
 * Nodes whose non-zero coordinates are all equal (the origin first, then every subset of the inks at one grid position):
 * the nodes that pure inks, every equal mixture of inks and neutral ramps interpolate between. They are refined to single
 * 16-bit levels, the rest of the grid being stored in steps of `CMYK_QUANT`. Shared with `generate-cmyk-lut.ts`.
 */
export function cmykRefinedNodes(): number[] {
	const strides = [N ** 3, N ** 2, N, 1];
	const nodes = [0];
	for (let mask = 1; mask < 16; mask++) {
		let step = 0;
		for (let d = 0; d < 4; d++) if (mask >> d & 1) step += strides[d];
		for (let j = 1; j < N; j++) nodes.push(j * step);
	}
	return nodes;
}

/**
 * The decoded grid: `GRID_SIZE` nodes of R, G and B interleaved (index `(((c * N + m) * N + y) * N + k) * 3 + channel`),
 * in 16-bit levels. The data are the 4-D difference of the grid in steps of `CMYK_QUANT` followed by one correction
 * per channel for each of `cmykRefinedNodes`, all zigzag coded as one byte or, from 255, an escape byte and three more,
 * deflated and written in base 85; decoding sums the differences along C, M, Y and K.
 */
function nodeTable(): Int32Array {
	if (table) return table;
	const lookup = new Int16Array(128).fill(-1);
	for (let i = 0; i < 85; i++) lookup[CMYK_DATA_ALPHABET.charCodeAt(i)] = i;
	const text = CMYK_LUT_DATA;
	const packed = new Uint8Array(Math.ceil((text.length * 4) / 5));
	for (let i = 0, o = 0; i < text.length; i += 5, o += 4) {
		let group = 0;
		for (let d = 0; d < 5; d++) group = group * 85 + (i + d < text.length ? lookup[text.charCodeAt(i + d)] : 84);
		packed[o] = group >>> 24;
		packed[o + 1] = (group >>> 16) & 255;
		packed[o + 2] = (group >>> 8) & 255;
		packed[o + 3] = group & 255;
	}
	const bytes = inflateZlibSync(packed.subarray(0, Math.floor((text.length * 4) / 5)));
	let p = 0;
	const next = (): number => {
		let v = bytes[p++];
		if (v === 255) {
			v = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
			p += 3;
		}
		return v & 1 ? -((v + 1) >> 1) : v >> 1;
	};
	const values = new Int32Array(3 * GRID_SIZE);
	for (let i = 0; i < values.length; i++) values[i] = next();
	for (const stride of [N ** 3, N ** 2, N, 1]) {
		for (let i = 0; i < GRID_SIZE; i++) {
			if (Math.floor(i / stride) % N) for (let c = 0; c < 3; c++) values[i * 3 + c] += values[(i - stride) * 3 + c];
		}
	}
	for (let i = 0; i < values.length; i++) values[i] *= CMYK_QUANT;
	for (const node of cmykRefinedNodes()) for (let c = 0; c < 3; c++) values[node * 3 + c] += next();
	return (table = values);
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Converts full-resolution component planes to RGBA. With `ycck` the first three planes hold YCbCr (libjpeg's
 * fixed-point conversion applies), otherwise they hold the stored (inverted) C, M and Y; the fourth plane is K.
 */
export function cmykPlanesToRgba(planes: Uint8Array[], width: number, height: number, ycck: boolean): Uint8Array {
	const nodes = nodeTable();
	const baseOf = BASE_OF;
	const fracOf = FRAC_OF;
	const strides = [N * N * N * 3, N * N * 3, N * 3, 3];
	const out = new Uint8Array(width * height * 4);
	const fix = (x: number): number => Math.floor(x * 65536 + 0.5);
	const half = 1 << 15;
	const crR = fix(1.402);
	const cbB = fix(1.772);
	const crG = -fix(0.71414);
	const cbG = -fix(0.34414);
	const inks = [0, 0, 0, 0];
	const frac = [0, 0, 0, 0];
	const order = [0, 1, 2, 3];
	for (let p = 0; p < width * height; p++) {
		if (ycck) {
			const lum = planes[0][p];
			const cb = planes[1][p] - 128;
			const cr = planes[2][p] - 128;
			inks[0] = clamp8(lum + ((crR * cr + half) >> 16));
			inks[1] = clamp8(lum + ((cbG * cb + half + crG * cr) >> 16));
			inks[2] = clamp8(lum + ((cbB * cb + half) >> 16));
		} else {
			inks[0] = 255 - planes[0][p];
			inks[1] = 255 - planes[1][p];
			inks[2] = 255 - planes[2][p];
		}
		inks[3] = 255 - planes[3][p];
		let at = 0;
		for (let d = 0; d < 4; d++) {
			at += baseOf[inks[d]] * strides[d];
			frac[d] = fracOf[inks[d]];
			order[d] = d;
		}
		// Descending by fraction, ties keeping the lower ink first (insertion sort).
		for (let i = 1; i < 4; i++) {
			const o = order[i];
			let j = i - 1;
			while (j >= 0 && frac[order[j]] < frac[o]) {
				order[j + 1] = order[j];
				j--;
			}
			order[j + 1] = o;
		}
		let weight = 1 - frac[order[0]];
		let r = weight * nodes[at];
		let g = weight * nodes[at + 1];
		let b = weight * nodes[at + 2];
		for (let s = 0; s < 4; s++) {
			at += strides[order[s]];
			weight = frac[order[s]] - (s < 3 ? frac[order[s + 1]] : 0);
			r += weight * nodes[at];
			g += weight * nodes[at + 1];
			b += weight * nodes[at + 2];
		}
		out[p * 4] = level(r);
		out[p * 4 + 1] = level(g);
		out[p * 4 + 2] = level(b);
		out[p * 4 + 3] = 255;
	}
	return out;
}

/**
 * The colour the table gives four 8-bit ink amounts before the top eight bits are taken: R, G and B on the 16-bit scale
 * of `TranslateColors` / `BM_16b_RGB` (unclamped, fractional). For tests and for comparing against the 16-bit captures.
 */
export function cmykRgb16(c: number, m: number, y: number, k: number, out: number[] = [0, 0, 0]): number[] {
	return cmykRgb16At(cmykInputCurve(c), cmykInputCurve(m), cmykInputCurve(y), cmykInputCurve(k), out);
}

/**
 * Like `cmykRgb16` for ink positions already in table units (0 to 65535, node `j` at `4369 j`): what `TranslateColors`
 * does with a 16-bit ink word, which it maps through the input table with a linear interpolation between entries
 * (`word / 257` is the table index).
 */
export function cmykRgb16At(tc: number, tm: number, ty: number, tk: number, out: number[] = [0, 0, 0]): number[] {
	const nodes = nodeTable();
	const strides = [N * N * N * 3, N * N * 3, N * 3, 3];
	const positions = [tc, tm, ty, tk];
	const frac = [0, 0, 0, 0];
	const order = [0, 1, 2, 3];
	let at = 0;
	for (let d = 0; d < 4; d++) {
		const base = Math.min(N - 2, Math.floor(positions[d] / CELL));
		at += base * strides[d];
		frac[d] = (positions[d] - base * CELL) / CELL;
	}
	order.sort((a, b) => frac[b] - frac[a] || a - b);
	let weight = 1 - frac[order[0]];
	for (let ch = 0; ch < 3; ch++) out[ch] = weight * nodes[at + ch];
	for (let s = 0; s < 4; s++) {
		at += strides[order[s]];
		weight = frac[order[s]] - (s < 3 ? frac[order[s + 1]] : 0);
		for (let ch = 0; ch < 3; ch++) out[ch] += weight * nodes[at + ch];
	}
	return out;
}

/** The top eight bits of an interpolated node value, clamped to the 16-bit range. */
function level(x: number): number {
	return x <= 0 ? 0 : x >= 65535 ? 255 : Math.floor(x / 256);
}
