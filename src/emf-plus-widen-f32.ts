/**
 * GDI+'s pen widener in single precision, rounded toward minus infinity: the arithmetic of `getDashData`, `CalculateGradients` and
 * `GpPathWidener::SetRoundCap` / `SetDoubleRoundCap`, operation for operation, so a dash cut point or a cap's Bezier control point is the
 * float GDI+ holds (the shared MXCSR of GDI+ rounds every float operation down, see `float32-down.ts`). The double precision widener of
 * `emf-plus-widen.ts` lands within 1e-5 pixel of these values, which is enough to move a 28.4 coordinate whenever a value is within that of a
 * rounding tie (the cap of a dash on an Inset pen at 206.4696, 99.18945 is 99.5002 of a 1/256 step: native holds it below the tie).
 *
 * Verified bit for bit against `GraphicsPath.Widen` of 54 dashed lines with Round caps (`dash-widen.json.gz`, 239 dashes, 1,673 cap points).
 *
 * @module emf-plus-widen-f32
 */

import { down32 } from './float32-down';

export interface PointF {
	x: number;
	y: number;
}

const f = Math.fround;
const add = (a: number, b: number): number => down32(a + b);
const sub = (a: number, b: number): number => down32(a - b);
const mul = (a: number, b: number): number => down32(a * b);
const div = (a: number, b: number): number => down32(a / b);

/** 2^-23, the float tolerance GDI+ compares lengths and coordinates against. */
const EPSILON = 1.1920928955078125e-7;

/** The unit direction of the segment a to b and its length (`CalculateGradientArray`): the length is the single precision square root of the sum of squares. */
export function gradientF32(a: PointF, b: PointF): { gx: number; gy: number; len: number } {
	let gx = sub(f(b.x), f(a.x));
	let gy = sub(f(b.y), f(a.y));
	const sum = add(mul(gy, gy), mul(gx, gx));
	let len = 0;
	if (sum > 0) {
		len = down32(Math.sqrt(sum));
		gx = div(gx, len);
		gy = div(gy, len);
	}
	return { gx, gy, len };
}

/** `GpVector2D::Norm`: the length of (dx, dy) in double precision, narrowed with the rounding mode (0 below 1.2e-7). */
function normF32(dx: number, dy: number): number {
	const len = Math.sqrt(dx * dx + dy * dy);
	return len < EPSILON ? 0 : down32(len);
}

/** The control points of the semicircle `SetRoundCap` builds, as the unit circle scaled by the half width: (x, y) pairs of a unit semicircle of two Beziers. */
const KAPPA = f(0.552284777);
const SEMICIRCLE: ReadonlyArray<readonly [number, number]> = [
	[1, 0],
	[1, KAPPA],
	[KAPPA, 1],
	[0, 1],
	[-KAPPA, 1],
	[-1, KAPPA],
	[-1, 0],
];

/** The transform `SetRoundCap` and `SetDoubleRoundCap` apply to their unit templates: scaled by half the width, turned to the direction, centred. */
function capTransform(p: PointF, g: { gx: number; gy: number }, a: number, b: number, start: boolean): (x: number, y: number) => PointF {
	const gx = start ? -g.gx : g.gx;
	const gy = start ? -g.gy : g.gy;
	const sum = add(a, b);
	const half = mul(sub(a, b), 0.5);
	const cx = add(mul(mul(sum, g.gy), 0.5), p.x);
	const cy = sub(p.y, mul(mul(sum, g.gx), 0.5));
	const hy = mul(half, gy);
	const nhx = mul(-half, gx);
	return (x, y) => ({ x: add(sub(mul(x, hy), mul(y, nhx)), cx), y: add(add(mul(y, hy), mul(x, nhx)), cy) });
}

/**
 * The 7 points (two Beziers) of `GpPathWidener::SetRoundCap` at the end `p` of a dash running along the unit direction `g`, between the offsets
 * `a` (the far side along the left normal) and `b`; `start` is the cap at the start of the dash (the direction negated). The first point is on the
 * `b` side of an end cap, on the `a` side of a start cap.
 */
export function roundCapF32(p: PointF, g: { gx: number; gy: number }, a: number, b: number, start: boolean): PointF[] {
	const at = capTransform(p, g, a, b, start);
	return SEMICIRCLE.map(([x, y]) => at(x, y));
}

/**
 * The 14 points of `GpPathWidener::SetDoubleRoundCap`: two semicircles of a quarter of the width, centred a quarter either side of the centre
 * line (the cap of an Inset stroke's doubled pen). Same arguments as {@link roundCapF32}.
 */
export function doubleRoundCapF32(p: PointF, g: { gx: number; gy: number }, a: number, b: number, start: boolean): PointF[] {
	const at = capTransform(p, g, a, b, start);
	const out: PointF[] = [];
	for (const shift of [0.5, -0.5]) {
		for (const [ux, uy] of SEMICIRCLE) {
			out.push(at(add(mul(ux, 0.5), shift), mul(uy, 0.5)));
		}
	}
	return out;
}

/**
 * The point `p` offset by `o` along the left normal of a segment with unit direction `g`. GDI+'s normal is (gy, -gx): a positive offset is
 * subtracted along it, a negative one added (`p + |o| n`; bit for bit the native start point of 239 dashes for the negative side).
 */
export function offsetPointF32(p: PointF, g: { gx: number; gy: number }, o: number): PointF {
	if (o < 0) {
		return { x: add(p.x, mul(-o, g.gy)), y: add(p.y, mul(-o, -g.gx)) };
	}
	return { x: sub(p.x, mul(o, g.gy)), y: sub(p.y, mul(o, -g.gx)) };
}

/**
 * `getDashData`: the dashes of the polyline `pts` (closed: from the last vertex along the closing segment, the first vertex being repeated at
 * the end is the caller's to drop) for the pattern `dash` (on, off, ...; already adjusted for the caps) starting `offset` into it. Every
 * length is single precision; a cut point is `cur + (next - cur) * (dashRemaining / segmentRemaining)` and the rest of the segment is
 * `segmentRemaining - dashRemaining`, not recomputed from the cut point.
 */
export function dashF32(pts: ReadonlyArray<PointF>, closed: boolean, dash: ReadonlyArray<number>, offset: number): PointF[][] {
	const n = pts.length;
	if (n < 2 || dash.length === 0) {
		return [];
	}
	let total = 0;
	for (const d of dash) {
		total = add(total, d);
	}
	if (!(total > 0)) {
		return [];
	}
	// GpModF(offset, total), then the element holding the offset and what is left of it.
	let rem = f(offset % total);
	if (rem < 0) {
		rem = add(rem, total);
	}
	let idx = 0;
	for (let guard = 0; guard < 1_000_000; guard++) {
		const d = dash[idx % dash.length];
		if (d > rem) {
			rem = sub(d, rem);
			break;
		}
		rem = sub(rem, d);
		idx++;
	}
	let on = idx % 2 === 0;
	let nextIdx = idx + 1;
	const lengths: number[] = [0];
	for (let i = 1; i < n; i++) {
		lengths.push(gradientF32(pts[i - 1], pts[i]).len);
	}
	let cur: PointF;
	let k: number;
	let segRem: number;
	if (closed) {
		cur = pts[n - 1];
		k = 0;
		segRem = normF32(sub(pts[0].x, cur.x), sub(pts[0].y, cur.y));
	} else {
		cur = pts[0];
		k = 1;
		segRem = lengths[1];
	}
	let dashRem = rem;
	const out: PointF[][] = [];
	let run: PointF[] | null = null;
	const tiny = (a: PointF, b: PointF): boolean => Math.abs(sub(a.x, b.x)) < EPSILON && Math.abs(sub(a.y, b.y)) < EPSILON;
	for (let guard = 0; k < n && guard < 10_000_000; guard++) {
		const next = pts[k];
		if (dashRem > segRem) {
			dashRem = sub(dashRem, segRem);
			if (on) {
				if (tiny(cur, next)) {
					// A repeated point ends the dash so far (GDI+ starts a new dash path at the next point it emits).
					if (run && run.length > 1) {
						out.push(run);
					}
					run = null;
				} else {
					run ??= [cur];
					run.push(next);
				}
			}
			cur = next;
			k++;
			if (k < n) {
				segRem = lengths[k];
			}
		} else {
			const t = div(dashRem, segRem);
			const q = { x: add(mul(sub(next.x, cur.x), t), cur.x), y: add(mul(sub(next.y, cur.y), t), cur.y) };
			segRem = sub(segRem, dashRem);
			if (on) {
				if (!tiny(cur, q)) {
					run ??= [cur];
					run.push(q);
					out.push(run);
				} else if (run && run.length > 1) {
					out.push(run);
				}
				run = null;
			}
			cur = q;
			dashRem = dash[nextIdx % dash.length];
			nextIdx++;
			on = !on;
		}
	}
	if (on && run && run.length > 1) {
		out.push(run);
	}
	return out;
}
