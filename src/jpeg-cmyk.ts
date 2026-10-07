/**
 * CMYK and YCCK JPEG to RGB, as Windows does it.
 *
 * Windows keeps a four-component JPEG as CMYK and, when it is drawn, converts it through a colour-managed
 * transform to sRGB (measured: it tracks the Windows "RSWOP" profile, perceptual or relative intent, but not
 * a plain `R = (255 - C)(255 - K) / 255`). The exact transform is not public, so it is reproduced by a
 * 17 x 17 x 17 x 17 grid (`jpeg-cmyk-data.ts`) fitted to what GDI+ draws and interpolated linearly.
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

/** Levels added to every node before it is stored (nodes beyond the gamut lie below 0 or above 255). */
export const CMYK_NODE_OFFSET = 128;
/** Grid nodes per ink. */
export const CMYK_GRID = 17;
const N = CMYK_GRID;
const GRID_SIZE = N ** 4;

let table: Uint16Array | null = null;

/** Characters of the base-85 text the table is stored as (4 bytes become 5 digits, most significant first). */
export const CMYK_DATA_ALPHABET = Array.from({ length: 90 }, (_, i) => String.fromCharCode(35 + i))
	.filter(c => c !== "'" && c !== '\\' && c !== '`')
	.slice(0, 85)
	.join('');

/**
 * The decoded grid: R, G and B planes of `GRID_SIZE` nodes (index `((c * N + m) * N + y) * N + k`), in sixteenths of
 * a level above -CMYK_NODE_OFFSET. They are stored as the 4-D difference of the grid (each node minus the
 * inclusion-exclusion sum of its lower neighbours), zigzag coded as one byte or, from 255, an escape byte and
 * three more, deflated and written in base 85; decoding sums the differences along K, Y, M and C.
 */
function nodeTable(): Uint16Array {
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
	const strides = [N ** 3, N ** 2, N, 1];
	for (let channel = 0; channel < 3; channel++) {
		const base = channel * GRID_SIZE;
		for (let d = 3; d >= 0; d--) {
			for (let i = 0; i < GRID_SIZE; i++) {
				if (Math.floor(i / strides[d]) % N) values[base + i] += values[base + i - strides[d]];
			}
		}
	}
	return (table = Uint16Array.from(values));
}

/** The grid nodes around an ink combination and their linear weights (used when fitting the table). */
export function cmykCorners(c: number, m: number, y: number, k: number): [number, number][] {
	const pos = [c, m, y, k].map(v => (v * (N - 1)) / 255);
	const base = pos.map(v => Math.min(N - 2, Math.floor(v)));
	const frac = pos.map((v, i) => v - base[i]);
	const out: [number, number][] = [];
	for (let corner = 0; corner < 16; corner++) {
		let weight = 1;
		let index = 0;
		for (let d = 0; d < 4; d++) {
			const high = (corner >> (3 - d)) & 1;
			weight *= high ? frac[d] : 1 - frac[d];
			index = index * N + base[d] + high;
		}
		if (weight) out.push([index, weight]);
	}
	return out;
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
		const pos = (v * (N - 1)) / 255;
		baseOf[v] = Math.min(N - 2, Math.floor(pos));
		fracOf[v] = pos - baseOf[v];
	}
	const strides = [N * N * N, N * N, N, 1];
	const out = new Uint8Array(width * height * 4);
	const fix = (x: number): number => Math.floor(x * 65536 + 0.5);
	const half = 1 << 15;
	const crR = fix(1.402);
	const cbB = fix(1.772);
	const crG = -fix(0.71414);
	const cbG = -fix(0.34414);
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
		const k = 255 - planes[3][p];
		const b0 = baseOf[c] * strides[0] + baseOf[m] * strides[1] + baseOf[y] * strides[2] + baseOf[k];
		const f0 = fracOf[c];
		const f1 = fracOf[m];
		const f2 = fracOf[y];
		const f3 = fracOf[k];
		let r = 0;
		let g = 0;
		let b = 0;
		for (let corner = 0; corner < 16; corner++) {
			const hc = (corner >> 3) & 1;
			const hm = (corner >> 2) & 1;
			const hy = (corner >> 1) & 1;
			const hk = corner & 1;
			const weight = (hc ? f0 : 1 - f0) * (hm ? f1 : 1 - f1) * (hy ? f2 : 1 - f2) * (hk ? f3 : 1 - f3);
			if (weight === 0) continue;
			const node = b0 + hc * strides[0] + hm * strides[1] + hy * strides[2] + hk;
			r += weight * nodes[node];
			g += weight * nodes[GRID_SIZE + node];
			b += weight * nodes[2 * GRID_SIZE + node];
		}
		out[p * 4] = clamp8(Math.floor(r / 16 - CMYK_NODE_OFFSET + 0.5));
		out[p * 4 + 1] = clamp8(Math.floor(g / 16 - CMYK_NODE_OFFSET + 0.5));
		out[p * 4 + 2] = clamp8(Math.floor(b / 16 - CMYK_NODE_OFFSET + 0.5));
		out[p * 4 + 3] = 255;
	}
	return out;
}
