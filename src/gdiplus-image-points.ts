/**
 * The float32 matrix chain of a plain `DrawImage(image, PointF[3], srcRect, GraphicsUnit.Pixel)` as gdiplus.dll runs it, and
 * the source positions of its Bilinear span.
 *
 * Read in gdiplus.dll (`GdipDrawImagePointsRect`, `GpGraphics::DrawImage`, `GpMatrix::InferAffineMatrix`,
 * `GpMatrix::Transform`, `GpGraphics::DrvDrawImage`, `DpDriver::DrawImage`, `GpMatrix::Invert`,
 * `GpMatrix::ComputeComplexity`, `DpOutputBilinearSpan::OutputSpan`), every operation a float32 one rounded toward minus
 * infinity (MXCSR 0x3F80):
 *
 * 1. The three points and the source rectangle give a matrix M (source rectangle to points; `det = (w + x)(y + h) - yx +
 *    (-hx - yw)`, entries `(h X1 - h X0) / det`, ...).
 * 2. The source rectangle's corners (x, y), (x + w, y), (x, y + h) are sent through M again (`GpMatrix::Transform`, which
 *    by `ComputeComplexity` drops the off-diagonal entries when they are under 5.96e-4 of the diagonal, and these are
 *    not zero: `(-w) * X0` rounds away from zero, `w * X2` does not) to give the points the driver gets.
 * 3. The driver infers the matrix N from those points once more, multiplies it by the world-to-device matrix, inverts it
 *    (det, reciprocal and entries all rounded down) and the span steps the inverse as {@link spanPositions}.
 *
 * Step 2 is the "4e-7 vertical term" earlier rounds fitted: the points move by a few float32 units, the off-diagonal
 * entries of N are tiny and nonzero, and `det = a d - b c` therefore sits one float32 unit under `a d` (the exact
 * difference of a number and a far smaller one rounds down to the next float32 below), which moves the inverse's scale
 * by one unit in either axis. The sums here are exact for that reason: a double sum of operands more than 29 binary
 * orders apart rounds the small operand away, so {@link addDown} corrects it with the sum's error term.
 *
 * Checked against the real functions executed under MXCSR 0x3F80 (300 random draws: every matrix, corner and inverse
 * identical) and against the native flip captures `image-points-positions.json.gz` (1,607 flips) and
 * `image-points-bisect-jpeg.json.gz` (124 flips).
 *
 * @module gdiplus-image-points
 */

import { down32 } from './float32-down';

const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);

function prevF32(x: number): number {
	scratch[0] = x;
	if (x > 0) scratchBits[0] -= 1;
	else if (x < 0) scratchBits[0] += 1;
	else scratchBits[0] = 0x80000001;
	return scratch[0];
}

/** `a + b` of two float32 values rounded toward minus infinity, exact also when one operand is far smaller. */
export function addDown(a: number, b: number): number {
	const s = a + b;
	const bb = s - a;
	const err = a - (s - bb) + (b - bb);
	const r = down32(s);
	return Math.fround(s) === s && err < 0 ? prevF32(s) : r;
}

const sub = (a: number, b: number): number => addDown(a, -b);
const mul = (a: number, b: number): number => down32(a * b);

function div(a: number, b: number): number {
	let c = down32(a / b);
	if (b > 0 ? c * b > a : c * b < a) c = prevF32(c);
	return c;
}

/** Affine matrix `[a, b, c, d, e, f]`. */
export type Mat6 = [number, number, number, number, number, number];

const COMPLEXITY_TOLERANCE = 0.000596046448;

/** `GpMatrix::ComputeComplexity`: 0 identity, 1 translation, 3 scale and translation, 5 or 7 rotation, 15 general. */
export function matrixComplexity(m: readonly number[]): number {
	const [a, b, c, d, e, f] = m;
	const absA = Math.abs(a);
	const absD = Math.abs(d);
	const absB = Math.abs(b);
	const absC = Math.abs(c);
	const maxDiagonal = absA > absD ? absA : absD;
	const off = absB > absC ? b : absC;
	let pivot: number;
	if (maxDiagonal > off) pivot = absA > absD ? a : d;
	else pivot = absB > absC ? b : c;
	const tolerance = down32(Math.abs(pivot) * COMPLEXITY_TOLERANCE);
	let flags = 15;
	if (tolerance > absB && tolerance > absC) {
		flags = 3;
		if (COMPLEXITY_TOLERANCE > Math.abs(sub(a, 1)) && COMPLEXITY_TOLERANCE > Math.abs(sub(d, 1))) flags = 1;
	} else if (tolerance > Math.abs(sub(a, d)) && tolerance > Math.abs(addDown(c, b))) {
		flags = COMPLEXITY_TOLERANCE > Math.abs(sub(addDown(mul(b, b), mul(a, a)), 1)) ? 5 : 7;
	}
	if (e === 0 && f === 0) flags &= ~1;
	return flags;
}

/** `GpMatrix::InferAffineMatrix(points, rect)`: the matrix taking the source rectangle to the three points, or null. */
export function inferPointsMatrix(points: readonly number[], src: readonly number[]): Mat6 | null {
	const [x0, y0, x1, y1, x2, y2] = points;
	const [x, y, w, h] = src;
	const nh = -h;
	const nw = -w;
	const product = sub(mul(addDown(w, x), addDown(y, h)), mul(y, x));
	const det = addDown(product, sub(mul(nh, x), mul(y, w)));
	if (!(Math.abs(det) >= 1.1920929e-7)) return null;
	const r = div(1, det);
	const a = mul(addDown(mul(h, x1), mul(nh, x0)), r);
	const b = mul(addDown(mul(h, y1), mul(nh, y0)), r);
	const c = mul(addDown(mul(w, x2), mul(nw, x0)), r);
	const d = mul(addDown(mul(w, y2), mul(nw, y0)), r);
	const nxh = mul(-x, h);
	const nyw = mul(-y, w);
	const p = sub(mul(addDown(x, w), addDown(y, h)), mul(x, y));
	const e = mul(addDown(addDown(mul(nxh, x1), mul(p, x0)), mul(nyw, x2)), r);
	const f = mul(addDown(addDown(mul(nxh, y1), mul(p, y0)), mul(nyw, y2)), r);
	return [a, b, c, d, e, f];
}

/** `GpMatrix::Transform` of flat x, y pairs, by the matrix's complexity. */
export function transformPoints(m: readonly number[], pts: readonly number[]): number[] {
	const complexity = matrixComplexity(m);
	const [a, b, c, d, e, f] = m;
	const out: number[] = [];
	for (let i = 0; i < pts.length; i += 2) {
		const x = pts[i];
		const y = pts[i + 1];
		if (complexity === 0) out.push(x, y);
		else if ((complexity & ~1) === 0) out.push(addDown(e, x), addDown(f, y));
		else if ((complexity & ~3) === 0) out.push(addDown(mul(a, x), e), addDown(mul(d, y), f));
		else out.push(addDown(addDown(mul(x, a), mul(y, c)), e), addDown(addDown(mul(x, b), mul(y, d)), f));
	}
	return out;
}

/** The points `DrvDrawImage` hands the driver: the source rectangle's corners sent through M. */
export function driverPoints(points: readonly number[], src: readonly number[]): number[] | null {
	const m = inferPointsMatrix(points, src);
	if (!m) return null;
	const [x, y, w, h] = src;
	return transformPoints(m, [x, y, addDown(x, w), y, x, addDown(y, h)]);
}

/** `N * W` as `DpDriver::DrawImage` multiplies the inferred matrix by the world-to-device matrix. */
export function multiplyDown(n: Mat6, w: readonly number[]): Mat6 {
	const [a, b, c, d, e, f] = n;
	const [wa, wb, wc, wd, we, wf] = w;
	return [
		addDown(mul(a, wa), mul(b, wc)),
		addDown(mul(a, wb), mul(b, wd)),
		addDown(mul(c, wa), mul(d, wc)),
		addDown(mul(c, wb), mul(d, wd)),
		addDown(addDown(mul(e, wa), mul(f, wc)), we),
		addDown(addDown(mul(e, wb), mul(f, wd)), wf),
	];
}

/** The device matrix of a points draw: `N * W` with N inferred from the driver's points. Null when degenerate. */
export function drawImagePointsDeviceMatrix(points: readonly number[], src: readonly number[], world: readonly number[]): Mat6 | null {
	const pts = driverPoints(points, src);
	if (!pts) return null;
	const n = inferPointsMatrix(pts, src);
	return n ? multiplyDown(n, world) : null;
}

/** `GpMatrix::Invert`, every operation rounded down. Null when singular. */
export function invertDown(m: readonly number[]): Mat6 | null {
	const [a, b, c, d, e, f] = m;
	const det = sub(mul(a, d), mul(b, c));
	if (!Number.isFinite(det) || det === 0) return null;
	const r = div(1, det);
	return [
		mul(d, r),
		mul(-b, r),
		mul(-c, r),
		mul(a, r),
		mul(sub(mul(c, f), mul(d, e)), r),
		mul(sub(mul(b, e), mul(a, f)), r),
	];
}

/**
 * The source position of every pixel of a run of `n` covered pixels from `x0` on device row `y`
 * (`DpOutputBilinearSpan::OutputSpan`): the two end pixels `x0` and `x0 + n` go through the inverse, the difference over
 * `n` is the step, added once per pixel.
 */
export function spanPositions(inv: Mat6, x0: number, y: number, n: number, us: Float64Array, vs: Float64Array): void {
	const [a, b, c, d, e, f] = inv;
	const at = (x: number): [number, number] => [
		addDown(addDown(mul(a, x), mul(c, y)), e),
		addDown(addDown(mul(b, x), mul(d, y)), f),
	];
	const [u0, v0] = at(x0);
	const [u1, v1] = at(x0 + n);
	const su = div(sub(u1, u0), n);
	const sv = div(sub(v1, v0), n);
	let u = u0;
	let v = v0;
	for (let i = 0; i < n; i++) {
		us[i] = u;
		vs[i] = v;
		u = addDown(u, su);
		v = addDown(v, sv);
	}
}
