/**
 * CMYK and YCCK JPEG to RGB, as Windows does it.
 *
 * GDI+ draws a four-component JPEG through the Windows ICM colour-management module (`mscms.dll`): the RSWOP
 * profile to sRGB, perceptual intent, best-quality transform. Measured with `scripts/gdi-fixtures/IcmProbe.cs`,
 * that transform is byte for byte what GDI+ writes. The module resamples the profile chain onto a table of
 * 16 x 16 x 16 x 16 colours over the 8-bit sample taken as `v << 8` (node `j` sits at 4369 j, so ink `v` is at grid
 * position `v * 256 / 4369`, and the last node is never reached), interpolates tetrahedrally (the four fractions
 * sorted in descending order; node weights are the steps between them) and keeps the top eight bits of the 16-bit
 * result. Nodes beyond the sRGB gamut are not clipped, so a colour crossing the gamut edge inside a cell clips
 * only after interpolation. The table (`jpeg-cmyk-data.ts`) is solved from `mscms.dll` samples (see
 * `scripts/gdi-fixtures/generate-cmyk-lut.ts`); the profile data itself is not bundled.
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
const SCALE = 256 / 4369;

let table: Int32Array | null = null;

/** Characters of the base-85 text the table is stored as (4 bytes become 5 digits, most significant first). */
export const CMYK_DATA_ALPHABET = Array.from({ length: 90 }, (_, i) => String.fromCharCode(35 + i))
	.filter(c => c !== "'" && c !== '\\' &&c !== '`')
	.slice(0, 85)
	.join('');

/**
 * The decoded grid: `GRID_SIZE` nodes of R, G and B interleaved (index `(((c * N + m) * N + y) * N + k) * 3 + channel`),
 * in steps of `CMYK_QUANT`. They are stored as the 4-D difference of the grid, zigzag coded as one byte or, from
 * 255, an escape byte and three more, deflated and written in base 85; decoding sums the differences along C, M, Y and K.
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
	const values = new Int32Array(3 * GRID_SIZE);
	for (let i = 0, p = 0; i < values.length; i++) {
		let v = bytes[p++];
		if (v === 255) {
			v = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
			p += 3;
		}
		values[i] = v & 1 ? -((v + 1) >> 1) : v >> 1;
	}
	for (const stride of [N ** 3, N ** 2, N, 1]) {
		for (let i = 0; i < GRID_SIZE; i++) {
			if (Math.floor(i / stride) % N) for (let c = 0; c < 3; c++) values[i * 3 + c] += values[(i - stride) * 3 + c];
		}
	}
	return (table = values);
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Converts full-resolution component planes to RGBA. With `ycck` the first three planes hold YCbCr (libjpeg's
 * fixed-point conversion applies), otherwise they hold the stored (inverted) C, M and Y; the fourth plane is K.
 */
export function cmykPlanesToRgba(planes: Uint8Array[], width: number, height: number, ycck: boolean): Uint8Array {
	const nodes = nodeTable();
	const baseOf = new Int32Array(256);
	const fracOf = new Float64Array(256);
	for (let v = 0; v < 256; v++) {
		const pos = v * SCALE;
		baseOf[v] = Math.min(N - 2, Math.floor(pos));
		fracOf[v] = pos - baseOf[v];
	}
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

/** The top eight bits of an interpolated node value (in `CMYK_QUANT` steps), clamped to the 16-bit range. */
function level(v: number): number {
	const x = v * CMYK_QUANT;
	return x <= 0 ? 0 : x >= 65535 ? 255 : Math.floor(x / 256);
}
