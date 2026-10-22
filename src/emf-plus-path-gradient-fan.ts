/**
 * The Gouraud scan converter behind a path gradient whose surround colours differ from vertex to vertex.
 *
 * GDI+ fans the boundary into triangles (centre, vertex i, vertex i + 1; `DpOutputPathGradientSpan` and `DpTriangleData` in
 * gdiplus.dll) and shades each one with its own integer edge walker. Everything below is the arithmetic that code performs, read
 * from the system gdiplus.dll and confirmed against native captures (`path-gradient-vertices.json.gz`):
 *
 * - Every single-precision operation rounds toward minus infinity (`gdiplus-float.ts`).
 * - Device vertices are transformed in single precision (`x m11 + y m21 + dx`), multiplied by 16 twice (28.4 fixed point and one
 *   more factor 16), rounded to nearest and divided back by 16 rounding up: a 28.4 coordinate is `ceil(round(v 256) / 16)`.
 * - The three edges (centre to vertex i, vertex i to vertex i + 1, vertex i + 1 to centre) are walked top to bottom from the first
 *   scanline `ceil(yTop)`, one row at a time, with an integer error term (quotient and remainder of `dx / dy`, the start x ceiled
 *   to a whole pixel after being stepped through the sub-rows). A scanline's span is `[xLeft, xRight)` of the two active edges.
 * - Each edge carries a parameter `t = |c - c0| / steps` in single precision, where `c` is the scanline (y-major edge) or the
 *   edge's pixel x (x-major edge), `c0` the floor of the edge's first vertex on that axis and `steps` the truncated length of
 *   the edge on it. The weights of the two surround vertices are `(t, 0)`, `(1 - t, t)` and `(0, 1 - t)` for the three edges.
 * - A span steps the weights from the left edge's to the right edge's value in `n` equal single-precision steps (the right edge's
 *   value belongs to the first pixel past the span) and each pixel is `((c1 - c0) a + c0) + (c2 - c0) b` per premultiplied
 *   channel, clamped to `[0, alpha]` and floored after adding 0.5.
 *
 * @module emf-plus-path-gradient-fan
 */

import { add, div, f32, mul, sub, transformPoint } from './gdiplus-float';

export { transformPoint as fanTransform };

/** Single-precision epsilon native compares alpha against (`1.1920929e-07`). */
const ALPHA_EPSILON = 1.1920929e-7;

/** A window wider than any surface: the span is not cut. */
const UNCLIPPED = 2 ** 30;

/** A premultiplied colour as four single-precision channels (alpha, red, green, blue). */
export type PremultipliedColor = [number, number, number, number];

/** Native's premultiplication of an ARGB colour: `(a / 255) * channel` in single precision. */
export function premultipliedColor(argb: number): PremultipliedColor {
	const a = argb >>> 24;
	if (a < ALPHA_EPSILON) return [0, 0, 0, 0];
	const r = (argb >>> 16) & 0xff;
	const g = (argb >>> 8) & 0xff;
	const b = argb & 0xff;
	if (Math.abs(a - 255) < ALPHA_EPSILON) return [a, r, g, b];
	const s = div(a, 255);
	return [a, mul(s, r), mul(s, g), mul(s, b)];
}

/**
 * Native's 28.4 device coordinate of a device-space value: `ceil(round(v * 256) / 16)`. The multiplications and the half are
 * single precision.
 */
export function fanCoordinate(v: number): number {
	const scaled = add(mul(mul(v, 16), 16), 0.5);
	return (Math.floor(scaled) + 15) >> 4;
}

/** An edge of a fan triangle, oriented top to bottom, with its scan-conversion state. */
interface FanEdge {
	/** Index in the triangle (0: centre to vertex i, 1: vertex i to i + 1, 2: vertex i + 1 to centre). */
	kind: number;
	/** First and one past the last scanline. */
	yStart: number;
	yEnd: number;
	/** The pixel x of each scanline `yStart + k`. */
	xs: Int32Array;
	/** The parameter is measured along x (an x-major edge) or y. */
	xMajor: boolean;
	/** The floor of the edge's first vertex (in its original direction) on the major axis. */
	origin: number;
	/** The truncated length of the edge on the major axis, in pixels. */
	steps: number;
}

/** Build an edge from two 28.4 vertices in fan order, or `null` when it crosses no scanline. */
function buildEdge(kind: number, x0: number, y0: number, x1: number, y1: number): FanEdge | null {
	let dx = x1 - x0;
	let dy = y1 - y0;
	const xMajor = Math.abs(dx) > Math.abs(dy);
	const origin = (xMajor ? x0 : y0) >> 4;
	const steps = (xMajor ? Math.abs(dx) : Math.abs(dy)) >> 4;
	let sx = x0;
	let sy = y0;
	let yStart: number;
	let yEnd: number;
	if (dy >= 0) {
		yStart = (y0 + 15) >> 4;
		yEnd = (y1 + 15) >> 4;
	} else {
		dx = -dx;
		dy = -dy;
		sx = x1;
		sy = y1;
		yStart = (y1 + 15) >> 4;
		yEnd = (y0 + 15) >> 4;
	}
	if (yEnd <= yStart) return null;
	// floor division of dx by dy
	let quotient: number;
	let remainder: number;
	if (dx >= 0) {
		if (dx < dy) {
			quotient = 0;
			remainder = dx;
		} else {
			quotient = Math.trunc(dx / dy);
			remainder = dx % dy;
		}
	} else {
		const m = -dx;
		if (m < dy) {
			quotient = -1;
			remainder = dy - m;
		} else {
			quotient = -Math.trunc(m / dy);
			const rem = m % dy;
			if (rem > 0) {
				quotient--;
				remainder = dy - rem;
			} else {
				remainder = 0;
			}
		}
	}
	// the start x stepped through the sub-rows down to the first whole scanline
	let error = -1;
	const frac = sy & 15;
	if (frac !== 0) {
		for (let i = 16 - frac; i > 0; i--) {
			error += remainder;
			const ex = quotient + sx;
			if (error >= 0) {
				error -= dy;
				sx = ex + 1;
			} else {
				sx = ex;
			}
		}
	}
	const fx = sx & 15;
	if (fx !== 0) {
		error -= (16 - fx) * dy;
		sx += 15;
	}
	let x = sx >> 4;
	error >>= 4;
	const xs = new Int32Array(yEnd - yStart);
	for (let k = 0; k < xs.length; k++) {
		xs[k] = x;
		x += quotient;
		const e = error + remainder;
		if (e >= 0) {
			error = e - dy;
			x += 1;
		} else {
			error = e;
		}
	}
	return { kind, yStart, yEnd, xs, xMajor, origin, steps };
}

/** One scanline of a fan triangle: native's premultiplied ARGB bytes (four per pixel) of `[xl, xl + n)`. */
export interface FanRow {
	xl: number;
	n: number;
	/** Alpha, red, green, blue of each pixel (premultiplied), as `Uint8Array`. */
	argb: Uint8Array;
}

/**
 * How a triangle turns its weights into a colour when the brush carries a Blend or InterpolationColors curve (the curves are
 * `emf-plus-path-gradient-curves.ts`): a preset ramp read at the centre's weight `t = 1 - a - b` replaces the vertex colours; a
 * Blend curve adjusts that weight and the other two are scaled to share what is left.
 */
export interface FanShading {
	preset?: (t: number, out: number[]) => void;
	adjust?: (t: number) => number;
}

/** One triangle of the fan. */
export class FanTriangle {
	private readonly edges: FanEdge[] = [];
	private readonly colors: [PremultipliedColor, PremultipliedColor, PremultipliedColor];
	private readonly rows = new Map<number | string, FanRow | null>();
	readonly yMin: number;
	readonly yMax: number;

	/**
	 * @param device centre, vertex i and vertex i + 1 in device pixels (already transformed in single precision)
	 * @param colors their premultiplied colours
	 */
	constructor(
		device: [number, number, number, number, number, number],
		colors: [PremultipliedColor, PremultipliedColor, PremultipliedColor],
		private readonly shading: FanShading = {},
	) {
		this.colors = colors;
		const px = [fanCoordinate(device[0]), fanCoordinate(device[2]), fanCoordinate(device[4]), fanCoordinate(device[0])];
		const py = [fanCoordinate(device[1]), fanCoordinate(device[3]), fanCoordinate(device[5]), fanCoordinate(device[1])];
		let yMin = Infinity;
		let yMax = -Infinity;
		for (let k = 0; k < 3; k++) {
			const e = buildEdge(k, px[k], py[k], px[k + 1], py[k + 1]);
			if (!e) continue;
			this.edges.push(e);
			yMin = Math.min(yMin, e.yStart);
			yMax = Math.max(yMax, e.yEnd);
		}
		this.yMin = yMin;
		this.yMax = yMax;
	}

	/**
	 * Scanline `y` of the triangle inside the window `[clipLeft, clipRight)` the span is requested for, or `null` when it has no
	 * pixels there. A span cut by the window starts from the weights interpolated at the cut, not from the edge.
	 */
	row(y: number, clipLeft = -UNCLIPPED, clipRight = UNCLIPPED): FanRow | null {
		if (y < this.yMin || y >= this.yMax) return null;
		const key = clipLeft === -UNCLIPPED && clipRight === UNCLIPPED ? y : `${y}:${clipLeft}:${clipRight}`;
		let cached = this.rows.get(key);
		if (cached === undefined) {
			cached = this.computeRow(y, clipLeft, clipRight);
			this.rows.set(key, cached);
		}
		return cached;
	}

	private computeRow(y: number, clipLeft: number, clipRight: number): FanRow | null {
		const active: FanEdge[] = [];
		for (const e of this.edges) {
			if (y >= e.yStart && y < e.yEnd) active.push(e);
		}
		if (active.length < 2) return null;
		let first = active[0];
		let second = active[1];
		if (first.xs[y - first.yStart] > second.xs[y - second.yStart]) [first, second] = [second, first];
		const xl = first.xs[y - first.yStart];
		const xr = second.xs[y - second.yStart];
		if (xl === xr) return null;
		const [aL, bL] = this.weights(first, y);
		let [aR, bR] = this.weights(second, y);
		const start = Math.max(xl, clipLeft);
		const end = Math.min(xr, clipRight);
		if (start >= end) return null;
		const n = xr - xl;
		let a = aL;
		let b = bL;
		const cutLeft = sub(start, xl);
		if (Math.abs(cutLeft) > ALPHA_EPSILON) {
			const f = div(cutLeft, n);
			a = add(mul(sub(aR, aL), f), aL);
			b = add(mul(sub(bR, bL), f), bL);
		}
		const cutRight = sub(xr, end);
		if (Math.abs(cutRight) > ALPHA_EPSILON) {
			const f = div(cutRight, n);
			aR = sub(aR, mul(sub(aR, aL), f));
			bR = sub(bR, mul(sub(bR, bL), f));
		}
		const count = end - start;
		const da = div(sub(aR, a), count);
		const db = div(sub(bR, b), count);
		const [c0, c1, c2] = this.colors;
		const argb = new Uint8Array(count * 4);
		const v = [0, 0, 0, 0];
		const { preset, adjust } = this.shading;
		for (let i = 0; i < count; i++) {
			if (preset) {
				preset(sub(sub(1, a), b), v);
			} else {
				let wa = a;
				let wb = b;
				if (adjust) {
					const centre = adjust(sub(sub(1, a), b));
					const sum = add(b, a);
					if (sum !== 0) {
						const f = div(sub(1, centre), sum);
						wa = mul(a, f);
						wb = mul(b, f);
					}
				}
				for (let q = 0; q < 4; q++) {
					const base = c0[q];
					const s = add(mul(sub(c1[q], base), wa), base);
					v[q] = add(s, mul(sub(c2[q], base), wb));
				}
			}
			a = add(a, da);
			b = add(b, db);
			packPremultiplied(v, argb, i * 4);
		}
		return { xl: start, n: count, argb };
	}

	/** The weights `(a, b)` of vertices i and i + 1 at the edge's pixel on scanline `y`. */
	private weights(e: FanEdge, y: number): [number, number] {
		const c = e.xMajor ? e.xs[y - e.yStart] : y;
		const t = div(Math.abs(c - e.origin), e.steps);
		if (e.kind === 0) return [t, 0];
		if (e.kind === 1) return [sub(1, t), t];
		return [0, sub(1, t)];
	}
}

/**
 * Native's final step for a premultiplied colour of four single-precision channels (alpha, red, green, blue): a pixel with
 * (nearly) no alpha is transparent, alpha is clamped to `[0, 255]`, each colour channel to `[0, alpha]`, and every channel is
 * floored after adding one half. Writes four bytes (alpha, red, green, blue) at `out[offset]`.
 */
export function packPremultiplied(v: ArrayLike<number>, out: Uint8Array, offset: number): void {
	let alpha = v[0];
	if (!(Math.abs(alpha) >= ALPHA_EPSILON)) {
		out[offset] = out[offset + 1] = out[offset + 2] = out[offset + 3] = 0;
		return;
	}
	if (0 > alpha) alpha = 0;
	if (alpha > 255) alpha = 255;
	out[offset] = toByte(alpha);
	for (let q = 1; q < 4; q++) {
		let c = v[q];
		if (0 > c) c = 0;
		if (c > alpha) c = alpha;
		out[offset + q] = toByte(c);
	}
}

/** `floor(v + 0.5)` in single precision, the low byte of the 32-bit conversion (non-finite values convert to 0). */
function toByte(v: number): number {
	const r = Math.floor(add(v, 0.5));
	return Number.isFinite(r) ? r & 0xff : 0;
}

/**
 * The non-premultiplied ARGB colour of premultiplied bytes (a transparent pixel is 0). Rounded to nearest by default; with
 * `bitmap` the conversion native performs when it renders a gradient into a straight-alpha ARGB bitmap (the tile bitmap of a tiled
 * brush): `floor(p (255 / alpha))` with the reciprocal in single precision rounded down.
 */
export function unpremultipliedArgb(alpha: number, r: number, g: number, b: number, bitmap = false): number {
	if (alpha === 0) return 0;
	const scale = bitmap ? div(255, alpha) : 0;
	const ch = (premult: number): number => Math.min(255, bitmap ? Math.floor(mul(premult, scale)) : Math.round((premult * 255) / alpha));
	return ((alpha << 24) | (ch(r) << 16) | (ch(g) << 8) | ch(b)) >>> 0;
}
