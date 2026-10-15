/**
 * CMYK and YCCK JPEG to RGB, as Windows does it.
 *
 * GDI+ draws a four-component JPEG through the Windows ICM colour-management module (`mscms.dll`): the RSWOP
 * profile to sRGB, perceptual intent, best-quality transform. The module resamples the profile chain onto a
 * table of 16 x 16 x 16 x 16 colours with 16-bit integer nodes and interpolates it tetrahedrally. Measured with
 * `scripts/gdi-fixtures/generate-cmyk-nodes.py` (native `TranslateColors` / `TranslateBitmapBits` probes, `IcmProbe.cs`):
 *
 *   - Ink position. An 8-bit ink `v` is the 16-bit word `257 v`. The module turns a word `w` into `x = w - (w >> 8) - 2`
 *     (not below zero), looks `x` up in a table of 4,081 entries that is the profile's 256-entry input curve with 16
 *     steps between entries (`cmykInputCurve`, plus one for every entry but the first), and interpolates between two
 *     neighbouring steps with the weight `r / 15` of the low four bits `r` of `x`. The result is a grid position in
 *     1/4096 of a cell, `p = (15 P[k] + (P[k + 1] - P[k]) r + 2) >> 4`: node `j` sits at `4096 j`. For `v` from 1 to 254
 *     (`cmykInputPositions`) that is `240 v - 1` up to `v = 224` and a steeper run to the last nodes; `v = 0` and `v = 255`
 *     sit exactly on the first and last node. The weights are therefore whole numbers of 1/4096.
 *   - Interpolation. The four fractions of a position are sorted in descending order; the five nodes along the path are
 *     weighted by the steps between them (integers summing to 4096), `S = sum(weight * node)`. A node value is a signed
 *     16-bit integer, and nodes beyond the sRGB gamut are not clipped, so a colour crossing the gamut edge inside a cell
 *     clips only after interpolation.
 *   - Eight-bit result. GDI+ keeps `(S + 4096) >> 20` (clamped to 0..255): the interpolated node value plus one, divided by
 *     256. That is why the top byte of the 16-bit result is not always the 8-bit result.
 *   - Sixteen-bit result (`cmykColour16`, for the probes only). The module scales the interpolated value `n = S / 4096`
 *     onto a table of 1,025 entries, `p = (n 65472 / 65535 + 511/1024) / 64`, and linearly interpolates the entries
 *     `K[m] = (65599 m + 511) >> 10`, rounded to nearest.
 *
 * The node values (`jpeg-cmyk-data.ts`) are the module's own, read with 16-bit probes placed exactly on the nodes and
 * refined against 19 million native conversions (`generate-cmyk-nodes.py`); the profile data itself is not bundled.
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
const N = CMYK_GRID;
const GRID_SIZE = N ** 4;

/**
 * The profile's input curve for an 8-bit ink `v`, in 16-bit units: the A2B0 input table of RSWOP.icm, identical for the
 * four inks. Verified against the 256 entries of all four tables by `generate-cmyk-lut.ts curve`.
 */
export function cmykInputCurve(v: number): number {
	return v === 0 ? 0 : v <= 224 ? 256 * v - 1 : 57343 + Math.floor(((v - 224) * 8192) / 31);
}

/** An entry of the table the module steps through: the profile curve plus one, except for the first entry. */
const stepEntry = (i: number): number => (i === 0 ? 0 : cmykInputCurve(i) + 1);

/** Grid position of every 8-bit ink, in 1/4096 cell (node `j` is at `4096 j`). See the module comment. */
export const cmykInputPositions: Int32Array = (() => {
	const positions = new Int32Array(256);
	for (let v = 1; v < 255; v++) {
		const start = stepEntry(v - 1);
		const end = stepEntry(v);
		const low = start + (((end - start) * 15) >> 4);
		positions[v] = (15 * low + (end - low) * 14 + 2) >> 4;
	}
	positions[255] = 15 * 4096;
	return positions;
})();

let table: Int32Array | null = null;

/** Characters of the base-85 text the table is stored as (4 bytes become 5 digits, most significant first). */
export const CMYK_DATA_ALPHABET = Array.from({ length: 90 }, (_, i) => String.fromCharCode(35 + i))
	.filter(c => c !== "'" && c !== '\\' && c !== '`')
	.slice(0, 85)
	.join('');

/**
 * The decoded grid: `GRID_SIZE` nodes of R, G and B interleaved (index `(((c * N + m) * N + y) * N + k) * 3 + channel`) as
 * signed 16-bit integers. The data are the 4-D difference of the grid (each value minus its neighbours along C, M, Y
 * and K, with the sign alternating), zigzag coded as one byte or, from 255, an escape byte and three more, deflated and
 * written in base 85; decoding sums the differences along C, M, Y and K.
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
	return (table = values);
}

const fraction = new Int32Array(4);
const order = new Int32Array(4);
const positionsIn = new Int32Array(4);
const STRIDES = [N * N * N * 3, N * N * 3, N * 3, 3];

/**
 * Interpolates the grid at the four grid positions held in `positionsIn` (1/4096 cell) and writes the three weighted sums
 * `S` (the interpolated node value times 4096) into `sums`.
 */
function interpolate(nodes: Int32Array, sums: Int32Array): void {
	let at = 0;
	for (let d = 0; d < 4; d++) {
		const j = Math.min(positionsIn[d] >> 12, N - 2);
		fraction[d] = positionsIn[d] - (j << 12);
		order[d] = d;
		at += j * STRIDES[d];
	}
	// Descending by fraction, ties keeping the lower ink first (insertion sort).
	for (let i = 1; i < 4; i++) {
		const o = order[i];
		let j = i - 1;
		while (j >= 0 && fraction[order[j]] < fraction[o]) {
			order[j + 1] = order[j];
			j--;
		}
		order[j + 1] = o;
	}
	let weight = 4096 - fraction[order[0]];
	let r = weight * nodes[at];
	let g = weight * nodes[at + 1];
	let b = weight * nodes[at + 2];
	for (let s = 0; s < 4; s++) {
		at += STRIDES[order[s]];
		weight = fraction[order[s]] - (s < 3 ? fraction[order[s + 1]] : 0);
		r += weight * nodes[at];
		g += weight * nodes[at + 1];
		b += weight * nodes[at + 2];
	}
	sums[0] = r;
	sums[1] = g;
	sums[2] = b;
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Converts full-resolution component planes to RGBA. With `ycck` the first three planes hold YCbCr (libjpeg's
 * fixed-point conversion applies), otherwise they hold the stored (inverted) C, M and Y; the fourth plane is K.
 */
export function cmykPlanesToRgba(planes: Uint8Array[], width: number, height: number, ycck: boolean): Uint8Array {
	const nodes = nodeTable();
	const out = new Uint8Array(width * height * 4);
	const fix = (x: number): number => Math.floor(x * 65536 + 0.5);
	const half = 1 << 15;
	const crR = fix(1.402);
	const cbB = fix(1.772);
	const crG = -fix(0.71414);
	const cbG = -fix(0.34414);
	const sums = new Int32Array(3);
	for (let p = 0; p < width * height; p++) {
		let c: number;
		let m: number;
		let y: number;
		if (ycck) {
			const lum = planes[0][p];
			const cb = planes[1][p] - 128;
			const cr = planes[2][p] - 128;
			c = clamp8(lum + ((crR * cr + half) >> 16));
			m = clamp8(lum + ((cbG * cb + half + crG * cr) >> 16));
			y = clamp8(lum + ((cbB * cb + half) >> 16));
		} else {
			c = 255 - planes[0][p];
			m = 255 - planes[1][p];
			y = 255 - planes[2][p];
		}
		positionsIn[0] = cmykInputPositions[c];
		positionsIn[1] = cmykInputPositions[m];
		positionsIn[2] = cmykInputPositions[y];
		positionsIn[3] = cmykInputPositions[255 - planes[3][p]];
		interpolate(nodes, sums);
		out[p * 4] = clamp8((sums[0] + 4096) >> 20);
		out[p * 4 + 1] = clamp8((sums[1] + 4096) >> 20);
		out[p * 4 + 2] = clamp8((sums[2] + 4096) >> 20);
		out[p * 4 + 3] = 255;
	}
	return out;
}

/** The output table of the 16-bit path: `K[m] = (65599 m + 511) >> 10` for `m` from 0 to 1024. */
const OUTPUT_TABLE = Array.from({ length: 1025 }, (_, m) => (65599 * m + 511) >> 10);

/**
 * The 16-bit R, G and B (the colour `TranslateColors` returns) of four grid positions in 1/4096 cell: the interpolated
 * node value goes through the module's 1,025-entry output table (see the module comment). The positions of the 8-bit inks
 * are `cmykInputPositions`; a 16-bit word `w` lands at `(15 k + r)` with `x = w - (w >> 8) - 2`, `k = x >> 4`, `r = x & 15`
 * for every word below grid cell 13 (the steeper end of the curve needs the interpolation of `cmykInputPositions`).
 * Used by the probes' regression tests; GDI+ keeps only `(S + 4096) >> 20` of the interpolation (`cmykPlanesToRgba`).
 */
export function cmykColour16(positions: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
	for (let d = 0; d < 4; d++) positionsIn[d] = positions[d];
	const sums = new Int32Array(3);
	interpolate(nodeTable(), sums);
	for (let ch = 0; ch < 3; ch++) {
		const index = Math.min(Math.max((((sums[ch] / 4096) * 65472) / 65535 + 511 / 1024) / 64, 0), 1023.999999);
		const entry = Math.floor(index);
		const value = OUTPUT_TABLE[entry] + (OUTPUT_TABLE[entry + 1] - OUTPUT_TABLE[entry]) * (index - entry);
		out[ch] = Math.min(65535, Math.floor(value + 0.5));
	}
	return out;
}
