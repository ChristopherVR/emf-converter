/**
 * The axis-aligned HighQualityBilinear / HighQualityBicubic image span of gdiplus.dll, `DpOutputSpanStretch<0>` (tent) and
 * `<1>` (cubic).
 *
 * Read in gdiplus.dll (`CreateOutputSpan`, `DpOutputSpanStretch<n>::InitializeClass`, `OutputSpan_Original`,
 * `StretchScanline`, `Apply1DWrapModeX`, `GpValidFixed16`, `ValidateKernelRange`), every float32 operation rounded toward
 * minus infinity (MXCSR 0x3F80) and the rest 32-bit integer arithmetic:
 *
 * - The constructor turns the source rectangle (`sx, sy, sw, sh`) and the destination rectangle (`dx, dy, dw, dh`), both
 *   float32, into 16.16 fixed point: the source step per destination pixel `S = floor(s / d 65536 + 1/2)`, the reciprocal
 *   `R = floor(d / s 65536 + 1/2)`, the first position, and the kernel stretch `max(1, K s / d)` (with `K` 1 for the tent
 *   and 2 for the cubic, whose kernel has twice the radius) in 16.16 together with the reciprocal
 *   `floor(65536 / stretch 65536 + 1/2)` that scales source distances into the kernel table.
 * - A destination pixel's weights are the differences of the kernel's running integral (a table of 16.16 values: the tent's
 *   `512 j - 2 j^2` over 1/128 stretch, the cubic's measured table over 1/128 of half a stretch) at the texel edges, which
 *   are `(texel << 16 - position) R >> 16` stepped by `R` per texel from the first texel of each of up to three runs (taps
 *   left of the bitmap, inside it, right of it), the running integral carrying over from one run to the next.
 * - The horizontal pass produces 8-bit premultiplied pixels (`(sum + 0x8000) >> 16`) for every column the destination spans, and
 *   the vertical pass weights those rows the same way.
 *
 * @module gdiplus-span-stretch
 */

import { add, div, floorInt, mul, sub } from './gdiplus-float';
import { down32 } from './float32-down';
import { hqCubicCdf } from './emf-plus-hq-cubic-weights';

/** `WrapMode` Tile, TileFlipX, TileFlipY, TileFlipXY and Clamp. */
export type StretchWrap = 0 | 1 | 2 | 3 | 4;

export interface StretchRequest {
	/** Tent (HighQualityBilinear) or cubic (HighQualityBicubic). */
	kernel: 'tent' | 'cubic';
	/** Premultiplied 8-bit pixels, four bytes each, the alpha last. */
	pixels: ArrayLike<number>;
	width: number;
	height: number;
	/** The source rectangle `[x, y, w, h]` (float32 values). */
	src: readonly [number, number, number, number];
	/** The destination rectangle `[x, y, w, h]` (float32 values; negative sizes mirror). */
	dest: readonly [number, number, number, number];
	/** `ImageAttributes` wrap mode, `Clamp` (4) without attributes. */
	wrap?: StretchWrap;
	/** The clamp colour as ARGB, read as literal premultiplied bytes. */
	clampArgb?: number;
}

const TWO_POW_M16 = 1 / 65536;

/** The tent's running integral at index `n` (`n / 128` stretch units), over 65536. */
function tentTable(n: number): number {
	if (n <= -128) return 0;
	if (n >= 128) return 65536;
	return 32768 + (n < 0 ? -(512 * -n - 2 * n * n) : 512 * n - 2 * n * n);
}

/** The cubic's running integral at index `n` (`n / 128` kernel units), over 65536. */
function cubicTable(n: number): number {
	if (n < -256) return 0;
	if (n > 255) return 65536;
	return 32768 + hqCubicCdf(n);
}

const i32 = (v: number): number => v | 0;
/** `a * b >> 16` of two 32-bit values the way a 64-bit `imul` and `sar` give it. */
const mulShift16 = (a: number, b: number): number => Math.floor((a * b) / 65536);

function validFixed16(v: number): boolean {
	return v >= -32768 && v <= 32767;
}

/** The fixed-point state of one stretched draw (`DpOutputSpanStretch::InitializeClass`). */
export interface StretchState {
	request: StretchRequest;
	/** First destination column (`[0x8c]`) and the number of columns the horizontal pass fills (`[0xc0]`). */
	firstColumn: number;
	columns: number;
	/** First destination row (`[0xa8]`). */
	firstRow: number;
	/** Horizontal: first position, step, stretch and reciprocal. */
	xStart: number;
	xStep: number;
	xStretch: number;
	xRecip: number;
	/** Vertical: first position, step, stretch and reciprocal. */
	yStart: number;
	yStep: number;
	yStretch: number;
	yRecip: number;
	/** Kernel rows (`[0xbc]`). */
	kernelRows: number;
	table: (n: number) => number;
	/** Table index shift of a position: 9 for the tent, 8 for the cubic. */
	shift: number;
	rows: Map<number, Uint8Array>;
}

/** `InitializeClass`: null when the rectangles are not valid for a stretch (the native class is then invalid). */
export function createStretch(request: StretchRequest): StretchState | null {
	const [sx, sy, sw, sh] = request.src.map(Math.fround);
	const [dx, dy, dw, dh] = request.dest.map(Math.fround);
	if (![sx, sy, sw, sh, dx, dy, dw, dh].every(validFixed16)) return null;
	const kScale = request.kernel === 'cubic' ? 2 : 1;
	// The stretch is never below one kernel radius: one texel for the tent, two for the cubic.
	const minStretch = request.kernel === 'cubic' ? 0x20000 : 0x10000;
	const half = 0.5;
	const fix = (v: number): number => floorInt(add(mul(v, 65536), half));
	const xStepS = fix(div(sw, dw));
	const xStepR = fix(div(dw, sw));
	const yStepS = fix(div(sh, dh));
	const yStepR = fix(div(dh, sh));
	void xStepR;
	void yStepR;
	if (xStepS === 0 || yStepS === 0) return null;
	const grid = (v: number): number => floorInt(add(mul(v, 16), half));
	const left = grid(dx);
	const right = grid(add(mul(sw, div(dw, sw)), dx));
	const top = grid(dy);
	const bottom = grid(add(mul(sh, div(dh, sh)), dy));
	const lo = Math.min(left, right);
	const hi = Math.max(left, right);
	const topLo = Math.min(top, bottom);
	const botHi = Math.max(top, bottom);
	const firstColumn = (lo + 15) >> 4;
	const loFix = i32(lo << 12);
	const hiFix = i32(hi << 12);
	const topFix = i32(topLo << 12);
	const botFix = i32(botHi << 12);
	const floatOf = (v: number): number => down32(v);
	// Horizontal first position.
	const sxF = floatOf(xStepS);
	let xBase: number;
	let xEdge: number;
	if (xStepS < 0) {
		xBase = floatOf((hiFix + 0xffff) >> 16);
		xEdge = add(dx, dw);
	} else {
		xBase = floatOf(loFix >> 16);
		xEdge = dx;
	}
	let v = sub(xEdge, xBase);
	v = mul(v, sxF);
	v = mul(v, TWO_POW_M16);
	v = add(v, sx);
	const xStart = fix(v);
	// Kernel stretch.
	const stretchOf = (s: number, d: number): number => {
		let r = fix(div(mul(kScale, s), d));
		if (r < 0) r = -r;
		return r < minStretch ? minStretch : r;
	};
	const xStretch = stretchOf(sw, dw);
	const xRecip = floorInt(add(mul(div(65536, floatOf(xStretch)), 65536), half));
	// Vertical first position.
	const syF = floatOf(yStepS);
	let yStart: number;
	if (yStepS < 0) {
		let w = floatOf((botFix + 0xffff) >> 16);
		w = sub(w, add(dh, dy));
		w = mul(w, syF);
		w = mul(w, TWO_POW_M16);
		yStart = fix(sub(sy, w));
	} else {
		let w = floatOf(topFix >> 16);
		w = sub(w, dy);
		w = mul(w, syF);
		w = mul(w, TWO_POW_M16);
		yStart = fix(add(w, sy));
	}
	const yStretch = stretchOf(sh, dh);
	const yRecip = floorInt(add(mul(div(65536, floatOf(yStretch)), 65536), half));
	const firstRow = topFix >> 16;
	const columns = ((hiFix + 0xffff) >> 16) - (loFix >> 16) + 1;
	const kernelRows = 2 * ((yStretch + 0xffff) >> 16) + 1;
	// ValidateKernelRange.
	const range = (stretch: number, start: number): boolean => {
		const r = start - 0x8000;
		return r >= -2147483648 && r <= 2147483647 && r - stretch >= -2147483648 && r + stretch <= 2147483647;
	};
	if (!range(xStretch, xStart) || !range(yStretch, yStart)) return null;
	return {
		request,
		firstColumn,
		columns,
		firstRow,
		xStart,
		xStep: xStepS,
		xStretch,
		xRecip,
		yStart,
		yStep: yStepS,
		yStretch,
		yRecip,
		kernelRows,
		table: request.kernel === 'cubic' ? cubicTable : tentTable,
		shift: request.kernel === 'cubic' ? 8 : 9,
		rows: new Map(),
	};
}

/** `Apply1DWrapModeX/Y` for a mode that wraps (not Clamp). `mirror` marks the axis that flips. */
function wrapIndex(index: number, size: number, mirror: boolean): number {
	if (!mirror) {
		return ((index % size) + size) % size;
	}
	const q = ((index % size) + size) % size;
	return Math.floor(index / size) % 2 !== 0 ? size - q - 1 : q;
}

function clampBytes(argb: number): [number, number, number, number] {
	// [0x60..0x63] are A, R, G, B of the colour; pixels are R, G, B, A.
	return [(argb >>> 16) & 0xff, (argb >>> 8) & 0xff, argb & 0xff, argb >>> 24];
}

/** `StretchScanline`: one source row stretched to the `columns` destination columns. */
function stretchRow(state: StretchState, rowPixels: Uint8Array | null): Uint8Array {
	const { request, columns, xStart, xStep, xStretch, xRecip, table, shift } = state;
	const { width, wrap = 4, clampArgb = 0 } = request;
	const cubic = request.kernel === 'cubic';
	const out = new Uint8Array(columns * 4);
	const clamp = clampBytes(clampArgb);
	const mirrorX = wrap === 1 || wrap === 3;
	let pos = i32(xStart - 0x8000);
	const sum = [0, 0, 0, 0];
	for (let c = 0; c < columns; c++) {
		const edx = i32(xStretch + 0xffff + pos);
		const last = edx >> 16;
		const first = i32(edx - 2 * xStretch) >> 16;
		sum[0] = sum[1] = sum[2] = sum[3] = 0;
		let prev = 0;
		const accumulate = (idx: number, pixel: ArrayLike<number>, o: number): void => {
			const t = table(i32(idx) >> shift);
			const wgt = t - prev;
			prev = t;
			sum[0] += pixel[o] * wgt;
			sum[1] += pixel[o + 1] * wgt;
			sum[2] += pixel[o + 2] * wgt;
			sum[3] += pixel[o + 3] * wgt;
		};
		const startOf = (col: number): number => mulShift16(i32(i32(col << 16) - pos), xRecip);
		const inFirst = first < 0 ? 0 : first;
		const inLast = last < width - 1 ? last : width - 1;
		// Left of the bitmap.
		let idx = startOf(first);
		for (let t = first; t < Math.min(inFirst, last + 1); t++) {
			if (wrap === 4 || !rowPixels) accumulate(idx, clamp, 0);
			else accumulate(idx, rowPixels, wrapIndex(t, width, mirrorX) * 4);
			idx = i32(idx + xRecip);
		}
		// Inside it.
		if (inFirst <= inLast) {
			idx = startOf(inFirst);
			for (let t = inFirst; t <= inLast; t++) {
				if (rowPixels) accumulate(idx, rowPixels, t * 4);
				else accumulate(idx, clamp, 0);
				idx = i32(idx + xRecip);
			}
		}
		// Right of it.
		const rightFirst = Math.max(inLast + 1, first);
		if (rightFirst <= last) {
			idx = startOf(rightFirst);
			for (let t = rightFirst; t <= last; t++) {
				if (wrap === 4 || !rowPixels) accumulate(idx, clamp, 0);
				else accumulate(idx, rowPixels, wrapIndex(t, width, mirrorX) * 4);
				idx = i32(idx + xRecip);
			}
		}
		const o = c * 4;
		const a = Math.max(0, Math.min(255, (sum[3] + 0x8000) >> 16));
		out[o + 3] = a;
		for (let ch = 0; ch < 3; ch++) {
			const v = (sum[ch] + 0x8000) >> 16;
			out[o + ch] = cubic ? Math.max(0, Math.min(a, v)) : Math.min(255, v);
		}
		pos = i32(pos + xStep);
	}
	return out;
}

/** The stretched pixels of the source row `row` (the bitmap row, or the wrapped one), cached. */
function stretchedRow(state: StretchState, row: number): Uint8Array | null {
	const { request } = state;
	const { height, width, wrap = 4 } = request;
	let r = row;
	if (r < 0 || r >= height) {
		if (wrap === 4) {
			return null;
		}
		r = wrapIndex(r, height, wrap === 2 || wrap === 3);
	}
	let cached = state.rows.get(r);
	if (!cached) {
		const pixels = request.pixels instanceof Uint8Array || request.pixels instanceof Uint8ClampedArray
			? (request.pixels as Uint8Array).subarray(r * width * 4, (r + 1) * width * 4)
			: Uint8Array.from(Array.prototype.slice.call(request.pixels, r * width * 4, (r + 1) * width * 4));
		cached = stretchRow(state, pixels);
		state.rows.set(r, cached);
	}
	return cached;
}

/** The stretched row of a source row outside a Clamp bitmap: the clamp colour stretched. */
function clampRow(state: StretchState): Uint8Array {
	let cached = state.rows.get(Number.NaN);
	if (!cached) {
		cached = stretchRow(state, null);
		state.rows.set(Number.NaN, cached);
	}
	return cached;
}

/**
 * `OutputSpan(y, xLeft, xRight)`: the premultiplied pixels of destination row `y` from column `xLeft` (clamped to the
 * stretch's own first column) to `xRight`, or null when the run is outside the draw. `x` is the first column returned.
 */
export function stretchRun(state: StretchState, y: number, xLeft: number, xRight: number): { x: number; pixels: Uint8Array } | null {
	const { firstColumn, columns, firstRow, yStart, yStep, yStretch, yRecip, kernelRows, table, shift } = state;
	const xs = Math.max(xLeft, firstColumn);
	const xe = Math.min(xRight, firstColumn + columns);
	if (xe < xs || xe - xs > columns) return null;
	const n = xe - xs;
	const row = Math.max(y, firstRow);
	const pos = i32(yStart - 0x8000 + i32((row - firstRow) * yStep));
	const lastSource = i32(pos + yStretch + 0xffff) >> 16;
	const firstSource = i32(pos - yStretch + 0xffff) >> 16;
	if (lastSource < firstSource) return null;
	let idx = mulShift16(i32(i32(firstSource << 16) - pos), yRecip);
	let prev = 0;
	const sources: (Uint8Array | null)[] = [];
	const weights: number[] = [];
	for (let k = 0; k < kernelRows; k++) {
		const source = firstSource + k;
		if (source > lastSource) {
			weights.push(0);
			sources.push(null);
			continue;
		}
		const t = table(i32(idx) >> shift);
		weights.push(t - prev);
		prev = t;
		idx = i32(idx + yRecip);
		sources.push(source >= 0 && source < state.request.height ? stretchedRow(state, source) : state.request.wrap === 4 || state.request.wrap === undefined ? clampRow(state) : stretchedRow(state, source));
	}
	const cubic = state.request.kernel === 'cubic';
	const pixels = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const col = (xs - firstColumn + i) * 4;
		let r = 0;
		let g = 0;
		let b = 0;
		let a = 0;
		for (let k = 0; k < kernelRows; k++) {
			const src = sources[k];
			if (!src) continue;
			const wgt = weights[k];
			r += src[col] * wgt;
			g += src[col + 1] * wgt;
			b += src[col + 2] * wgt;
			a += src[col + 3] * wgt;
		}
		const o = i * 4;
		const alpha = Math.max(0, Math.min(255, (a + 0x8000) >> 16));
		pixels[o + 3] = alpha;
		for (const [ch, v] of [[0, r], [1, g], [2, b]] as const) {
			const q = (v + 0x8000) >> 16;
			pixels[o + ch] = cubic ? Math.max(0, Math.min(alpha, q)) : Math.min(255, q);
		}
	}
	return { x: xs, pixels };
}
