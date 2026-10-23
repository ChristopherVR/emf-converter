/**
 * The one-dimensional path gradient: a uniform surround colour (with or without a focus), the case GDI+ draws as a single
 * colour ramp over a distance `t` that every pixel gets from a bilinear map.
 *
 * Everything here is the arithmetic of `DpOutputOneDPathGradientSpan` in gdiplus.dll (its constructor, `SetupPathGradientOneDData`
 * and `OutputSpan`) and of the helpers it calls (`GpBilinearTransform::SetBilinearTransform`, `GetXSpans` and `GetSourceParameter`,
 * `GpQuadAnalyzer::SetQuadAnalyzer`, `DpOutputOneDGradientSpan::AllocateOneDData`), in single precision rounding toward minus
 * infinity (`gdiplus-float.ts`):
 *
 * - The ramp is a table of `N + 2` premultiplied colours, entry `i` the surround blend at `t = i / N` (accumulated as a sum of
 *   single-precision `1 / N` steps), where `N = ceil(|d1| + |d2|)` and `d1`, `d2` are the diagonals of the brush's bounding box
 *   under the device matrix: the nested copies of the boundary other rounds fitted are the `N` levels of this table.
 * - Each boundary edge `A -> B` (both rounded to 1/16 pixel, ties up) becomes a quad `(F_A, A, F_B, B)` whose first side
 *   runs from the focus point to the boundary: with no focus the focus points are the centre and the quad is the triangle
 *   `(centre, A, B)`, with focus scales `(fx, fy)` they are `centre + (A - centre) (fx, fy)`. A second quad
 *   `(centre, F_A, centre, F_B)` of constant `t = 0` paints the flat inner triangle over the first.
 * - A scanline of a quad runs between the `ceil` of its two edge crossings sampled at the integer row; each pixel is solved at
 *   its integer coordinates for the bilinear parameter `t` (a quadratic whose root choice, tolerance `-0.02 .. 1.02` and failure
 *   behaviour are those of `GetSourceParameter`: a pixel whose solve fails keeps the previous pixel's `t`), clamped to `[0, 1]`
 *   and mapped to the table entry `floor(N t + 0.5)`. Quads paint in order, later ones over earlier ones.
 *
 * @module emf-plus-path-gradient-oned
 */

import { packPremultiplied, premultipliedColor } from './emf-plus-path-gradient-fan';
import { blendAdjuster, presetRamp } from './emf-plus-path-gradient-curves';
import { add, ceilInt, div, downF32, f32, floorInt, ja, jae, jb, jbe, mul, sqrt, sub, transformPoint } from './gdiplus-float';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/** A window wider than any surface: the spans are not cut. */
const UNCLIPPED = 2 ** 30;
/** The range a solved bilinear parameter may overshoot [0, 1] by: native constants (-0.02 and 1.02), read from gdiplus.dll `GpBilinearTransform::GetSourceParameter`. */
const TOLERANCE_LOW = f32(-0.02);
const TOLERANCE_HIGH = f32(1.02);

/** One bilinear quad of the gradient (`GpBilinearTransform`). */
export class BilinearQuad {
	/** A constant `t` (the flat inner triangle) or a negative number for a real bilinear map. */
	readonly constant: number;
	private minX = 0;
	private minY = 0;
	private width = 0;
	private height = 0;
	private e3x = 0;
	private e3y = 0;
	private e1x = 0;
	private e1y = 0;
	private e2x = 0;
	private e2y = 0;
	private p0x = 0;
	private p0y = 0;
	/** The quadratic's leading coefficient and the cross product of the two sides. */
	private a = 0;
	private det = 0;
	// the edge analyzer
	private yMin = 0;
	private yMax = 0;
	private flags: number[] = [0, 0, 0, 0];
	private yTop: number[] = [0, 0, 0, 0];
	private yBottom: number[] = [0, 0, 0, 0];
	private xTop: number[] = [0, 0, 0, 0];
	private slope: number[] = [0, 0, 0, 0];

	/** @param p the four corner points in `GpBilinearTransform` order (origin, end of side 1, end of side 2, opposite) */
	constructor(p: [number, number][] | null, constant: number) {
		this.constant = constant;
		if (!p) return;
		const [p0, p1, p2, p3] = p;
		let minX = p0[0];
		let minY = p0[1];
		let maxX = p0[0];
		let maxY = p0[1];
		for (let k = 1; k < 4; k++) {
			const [x, y] = p[k];
			if (x < minX) minX = x;
			else if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			else if (y > maxY) maxY = y;
		}
		this.minX = minX;
		this.minY = minY;
		this.width = sub(maxX, minX);
		this.height = sub(maxY, minY);
		this.e3x = add(sub(sub(p0[0], p1[0]), p2[0]), p3[0]);
		this.e3y = add(sub(sub(p0[1], p1[1]), p2[1]), p3[1]);
		this.e1x = sub(p1[0], p0[0]);
		this.e1y = sub(p1[1], p0[1]);
		this.e2x = sub(p2[0], p0[0]);
		this.e2y = sub(p2[1], p0[1]);
		this.p0x = p0[0];
		this.p0y = p0[1];
		this.a = this.e3x === this.e2x && this.e3y === this.e2y ? 0 : sub(mul(this.e2y, this.e3x), mul(this.e2x, this.e3y));
		this.det = sub(mul(this.e1x, this.e2y), mul(this.e1y, this.e2x));
		// the quad analyzer walks the perimeter origin, side-1 end, opposite, side-2 end
		const q = [p0, p1, p3, p2];
		this.yMin = this.yMax = q[0][1];
		let xMin = q[0][0];
		let xMax = q[0][0];
		for (let i = 0; i < 4; i++) {
			const cur = q[i];
			const next = q[(i + 1) & 3];
			if (next[1] > cur[1]) {
				this.flags[i] = 1;
				this.yTop[i] = cur[1];
				this.yBottom[i] = next[1];
				this.xTop[i] = cur[0];
				this.slope[i] = div(sub(next[0], cur[0]), sub(next[1], cur[1]));
			} else if (cur[1] > next[1]) {
				this.flags[i] = 2;
				this.yTop[i] = next[1];
				this.yBottom[i] = cur[1];
				this.xTop[i] = next[0];
				this.slope[i] = div(sub(next[0], cur[0]), sub(next[1], cur[1]));
			} else {
				this.flags[i] = 0;
				this.yTop[i] = cur[1];
				this.yBottom[i] = cur[1];
				this.xTop[i] = cur[0];
				this.slope[i] = 0;
			}
			if (cur[0] < xMin) xMin = cur[0];
			if (cur[0] > xMax) xMax = cur[0];
			if (cur[1] < this.yMin) this.yMin = cur[1];
			if (cur[1] > this.yMax) this.yMax = cur[1];
		}
	}

	/** The pixel spans `[start, end)` of scanline `y` inside `[x0, x1)` (`GetXSpans`). */
	spans(y: number, x0: number, x1: number): number[] {
		if (this.constant < 0 && this.flags.every((f) => f === 0)) return [];
		const yf = y;
		if (ja(this.minY, yf)) return [];
		if (jae(yf, add(this.minY, this.height))) return [];
		const x0f = x0;
		const x1f = x1;
		if (ja(this.minX, x1f)) return [];
		if (jae(x0f, add(this.minX, this.width))) return [];
		if (ja(this.yMin, yf)) return [];
		if (jae(yf, this.yMax)) return [];
		const c: number[] = [];
		for (let i = 0; i < 4; i++) {
			if (!this.flags[i]) continue;
			if (jb(yf, this.yTop[i])) continue;
			if (jbe(this.yBottom[i], yf)) continue;
			c.push(add(mul(sub(yf, this.yTop[i]), this.slope[i]), this.xTop[i]));
		}
		const m = c.length & ~1;
		if (m < 2) return [];
		c.length = m;
		c.sort((p, q) => p - q);
		const out: number[] = [];
		for (let k = 0; k < m; k += 2) {
			let lo = c[k];
			let hi = c[k + 1];
			if (jae(lo, x1f) || jae(x0f, hi)) continue;
			if (lo < x0f) lo = x0f;
			if (hi > x1f) hi = x1f;
			const s = ceilInt(lo);
			const e = ceilInt(hi);
			if (e > s) out.push(s, e);
		}
		return out;
	}

	/**
	 * `GetSourceParameter`: solves the bilinear map for the point `(px, py)`. On success writes the parameter `t` (the first output)
	 * into `state[0]` and returns true; a failed solve leaves `state` as it was.
	 */
	parameter(px: number, py: number, state: number[]): boolean {
		if (this.constant >= 0) {
			state[0] = state[1] = this.constant;
			return true;
		}
		const dx = sub(this.p0x, px);
		const dy = sub(this.p0y, py);
		const a = this.a;
		const b = sub(add(mul(this.e3x, dy), this.det), mul(this.e3y, dx));
		const c = sub(mul(this.e1x, dy), mul(this.e1y, dx));
		let roots = 0; // `edi`
		let s = 0; // the root along side 2
		let other = 0; // the second root of a quadratic
		if (a !== 0 || a !== a) {
			const disc = sub(mul(b, b), mul(mul(a, 4), c));
			const twoA = add(a, a);
			if (ja(disc, 0)) {
				roots = 2;
				const sq = sqrt(disc);
				const twoC = add(c, c);
				const q = jb(b, 0) ? sub(sq, b) : sub(-b, sq);
				let r1 = div(twoC, q);
				let r2 = div(q, twoA);
				if (ja(0, r1) || ja(r1, 1)) {
					if (!(jb(r2, 0) || jb(1, r2))) [r1, r2] = [r2, r1];
				}
				s = r1;
				other = r2;
			} else if (disc === 0) {
				roots = 1;
				s = div(-b, twoA);
			}
			// disc < 0 or NaN: no root
		} else {
			if (b === 0) return false;
			roots = 1;
			s = div(-c, b);
		}
		if (roots === 0) return false;
		const [u, ok] = this.solveU(s, dx, dy);
		if (roots === 1) {
			if (!ok) return false;
			state[0] = u;
			state[1] = s;
			return true;
		}
		// two roots: keep the first when both coordinates are within the tolerance (a NaN passes this test ...)
		const firstInRange = (v: number): boolean => !(ja(TOLERANCE_LOW, v) || ja(v, TOLERANCE_HIGH));
		// ... and fails the one the second root has to pass
		const secondInRange = (v: number): boolean => !(jb(v, TOLERANCE_LOW) || jb(TOLERANCE_HIGH, v));
		if (ok && firstInRange(u) && firstInRange(s)) {
			state[0] = u;
			state[1] = s;
			return true;
		}
		const [u2, ok2] = this.solveU(other, dx, dy);
		if (ok2 && secondInRange(u2) && secondInRange(other)) {
			state[0] = u2;
			state[1] = other;
			return true;
		}
		if (ok) {
			state[0] = u;
			state[1] = s;
			return true;
		}
		return false;
	}

	/** The parameter along side 1 for a root `s` along side 2, from the better conditioned of the two coordinates. */
	private solveU(s: number, dx: number, dy: number): [number, boolean] {
		const dxdu = add(mul(this.e3x, s), this.e1x);
		const dydu = add(mul(this.e3y, s), this.e1y);
		if (ja(Math.abs(dxdu), Math.abs(dydu))) {
			return [div(-add(mul(s, this.e2x), dx), dxdu), true];
		}
		if (ja(Math.abs(dydu), 0)) {
			return [div(-add(mul(s, this.e2y), dy), dydu), true];
		}
		return [0, false];
	}
}

/** The ramp and the quads of a one-dimensional path gradient in device space. */
export class OneDGradient {
	readonly quads: BilinearQuad[];
	/** The premultiplied ARGB of table entry `i` (`i = 0 .. n + 1`). */
	private readonly table: Uint32Array;
	private readonly n: number;
	private readonly x0: number;
	private readonly width: number;
	private readonly rows = new Map<number | string, Float64Array | null>();

	constructor(quads: BilinearQuad[], table: Uint32Array, n: number, x0: number, width: number) {
		this.quads = quads;
		this.table = table;
		this.n = n;
		this.x0 = x0;
		this.width = width;
	}

	/**
	 * The premultiplied ARGB bytes of pixel (`px`, `py`) as one number, or `null` when no quad paints it. `clipLeft` and
	 * `clipRight` are the window the scanline's spans are requested for (a pixel whose solve fails repeats the previous pixel's
	 * parameter, starting from zero at the window's cut).
	 */
	colorAt(px: number, py: number, clipLeft = -UNCLIPPED, clipRight = UNCLIPPED): number | null {
		const key = clipLeft === -UNCLIPPED && clipRight === UNCLIPPED ? py : `${py}:${clipLeft}:${clipRight}`;
		let row = this.rows.get(key);
		if (row === undefined) {
			row = this.computeRow(py, clipLeft, clipRight);
			this.rows.set(key, row);
		}
		if (!row) return null;
		const i = px - this.x0;
		if (i < 0 || i >= this.width) return null;
		const v = row[i];
		return v < 0 ? null : v;
	}

	/** The premultiplied ARGB of ramp position `t` (0 at the centre or inside the focus, 1 at the boundary), as one number. */
	colorForPosition(t: number): number {
		let u = f32(t);
		if (ja(0, u)) u = 0;
		else if (!(u < 1)) u = 1;
		return this.table[floorInt(add(mul(this.n, u), 0.5))];
	}

	private computeRow(y: number, clipLeft: number, clipRight: number): Float64Array | null {
		let row: Float64Array | null = null;
		const state = [0, 0];
		const xLow = Math.max(clipLeft, this.x0 - 2);
		const xHigh = Math.min(clipRight, this.x0 + this.width + 2);
		for (const quad of this.quads) {
			const spans = quad.spans(y, xLow, xHigh);
			if (!spans.length) continue;
			if (!row) row = new Float64Array(this.width).fill(-1);
			state[0] = state[1] = 0;
			const ts: number[] = [];
			for (let k = 0; k < spans.length; k += 2) {
				for (let x = spans[k]; x < spans[k + 1]; x++) {
					quad.parameter(x, y, state);
					ts.push(state[0]);
				}
			}
			let at = 0;
			for (let k = 0; k < spans.length; k += 2) {
				for (let x = spans[k]; x < spans[k + 1]; x++) {
					const color = this.colorForPosition(ts[at++]);
					const i = x - this.x0;
					if (i >= 0 && i < this.width) row[i] = color;
				}
			}
		}
		return row;
	}
}

/**
 * The number of steps `N` of the colour ramp: `ceil(|d1| + |d2|)` for the two device diagonals of the boundary's brush-space
 * bounding box `w` x `h` under the linear part of `m` (`AllocateOneDData`), at least 1. Rotating the shape leaves it alone, shearing
 * makes the two diagonals differ.
 */
export function rampSteps(boundary: ReadonlyArray<{ x: number; y: number }>, m: readonly number[]): number {
	if (boundary.length === 0) return 0;
	let minX = f32(boundary[0].x);
	let minY = f32(boundary[0].y);
	let maxX = minX;
	let maxY = minY;
	for (const p of boundary) {
		const x = f32(p.x);
		const y = f32(p.y);
		if (x > maxX) maxX = x;
		else if (x < minX) minX = x;
		if (y > maxY) maxY = y;
		else if (y < minY) minY = y;
	}
	const w = sub(maxX, minX);
	const h = sub(maxY, minY);
	const vec = (x: number, y: number): [number, number] => [
		add(mul(y, f32(m[2])), mul(x, f32(m[0]))),
		add(mul(y, f32(m[3])), mul(x, f32(m[1]))),
	];
	const v0 = vec(0, 0);
	const v1 = vec(w, 0);
	const v2 = vec(w, h);
	const v3 = vec(0, h);
	const len = (a: [number, number], b: [number, number]): number => {
		const dx = sub(a[0], b[0]);
		const dy = sub(a[1], b[1]);
		return sqrt(add(mul(dx, dx), mul(dy, dy)));
	};
	const diagonals = add(len(v1, v3), len(v0, v2));
	return Math.max(1, ceilInt(diagonals));
}

/** The 1/16-pixel grid native snaps the boundary to: `floor(v 16 + 0.5) / 16`. */
function toSixteenth(v: number): number {
	return mul(floorInt(add(mul(v, 16), 0.5)), 0.0625);
}

/**
 * Builds the one-dimensional gradient of a path gradient with a uniform surround colour, or `null` for shapes the previous model
 * still answers (a Blend or preset curve). `full` maps brush space to device pixels.
 */
export function prepareOneD(shape: EmfPlusPathGradientShape, full: TransformMatrix): OneDGradient | null {
	const count = shape.boundary.length;
	if (count < 2) return null;
	const n = rampSteps(shape.boundary, full);
	// the colour ramp
	const e0 = premultipliedColor(shape.centerArgb);
	const e1 = premultipliedColor(shape.boundaryArgb[0] ?? 0xff000000);
	const table = new Uint32Array(n + 2);
	const step = div(1, n);
	const adjust = blendAdjuster(shape.blend);
	const preset = presetRamp(shape.preset);
	let t = 0;
	const v = [0, 0, 0, 0];
	const bytes = new Uint8Array(4);
	for (let i = 0; i < n + 2; i++) {
		if (preset) {
			preset(t, v);
		} else {
			const w = adjust ? adjust(t) : t;
			for (let q = 0; q < 4; q++) v[q] = add(mul(sub(e1[q], e0[q]), w), e0[q]);
		}
		packPremultiplied(v, bytes, 0);
		table[i] = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
		t = add(t, step);
	}
	// the quads
	const centre = transformPoint(full, shape.center.x, shape.center.y);
	const cx = toSixteenth(centre[0]);
	const cy = toSixteenth(centre[1]);
	const fx = f32(shape.focus?.x ?? 0);
	const fy = f32(shape.focus?.y ?? 0);
	const focused = fx !== 0 || fy !== 0;
	const quads: BilinearQuad[] = [];
	const inner: BilinearQuad[] = [];
	let lowX = cx;
	let highX = cx;
	for (let i = 0; i < count; i++) {
		const j = i + 1 < count ? i + 1 : 0;
		const pa = shape.boundary[i];
		const pb = shape.boundary[j];
		if (pa.x === pb.x && pa.y === pb.y) {
			quads.push(new BilinearQuad(null, -1));
			if (focused) inner.push(new BilinearQuad(null, -1));
			continue;
		}
		const da = transformPoint(full, pa.x, pa.y);
		const db = transformPoint(full, pb.x, pb.y);
		const ax = toSixteenth(da[0]);
		const ay = toSixteenth(da[1]);
		const bx = toSixteenth(db[0]);
		const by = toSixteenth(db[1]);
		lowX = Math.min(lowX, ax, bx);
		highX = Math.max(highX, ax, bx);
		let fax = cx;
		let fay = cy;
		let fbx = cx;
		let fby = cy;
		if (focused) {
			fax = add(mul(sub(ax, cx), fx), cx);
			fbx = add(mul(sub(bx, cx), fx), cx);
			fay = add(mul(sub(ay, cy), fy), cy);
			fby = add(mul(sub(by, cy), fy), cy);
			inner.push(new BilinearQuad([[cx, cy], [fax, fay], [cx, cy], [fbx, fby]], 0));
		}
		quads.push(new BilinearQuad([[fax, fay], [ax, ay], [fbx, fby], [bx, by]], -1));
	}
	const x0 = Math.floor(lowX) - 2;
	const width = Math.ceil(highX) + 3 - x0;
	return new OneDGradient(focused ? [...quads, ...inner] : quads, table, n, x0, width);
}
