/**
 * GDI+'s nominal-width lines, reproduced exactly: every pen whose device
 * width is at most 1.5 pixels (and which has a solid dash style and no
 * anchor or custom caps) is drawn one pixel wide whatever its width.
 *
 * Read from gdiplus.dll (`DpDriver::StrokePath`, `SolidStrokePathOnePixel`,
 * `DrawSolidLineOnePixelAliased`, `OnePixelLineDDAAliased`,
 * `InitializeNominal`, `FixedPointPathEnumerate`, `RasterizerCeiling`) and
 * confirmed on thousands of random figures drawn by GDI+ itself:
 *
 * - The path is enumerated in 28.4 fixed point: every vertex and Bezier
 *   control point goes through the world-to-device matrix in single
 *   precision and `RasterizerCeiling`, which is
 *   `(floor(v * 256 + 0.5) + 15) >> 4` for a device coordinate `v`, i.e.
 *   rounded to 1/256 pixel first and then up to the next 1/16 (see
 *   {@link gdiplusFix}); Beziers are then flattened by GDI+'s `Bezier32`
 *   ({@link flattenBezierGdiplus}), and the points reach the drawing code
 *   in batches of 32.
 * - SmoothingMode None/HighSpeed, an opaque solid brush and a path without
 *   curves (lines, rectangles, polygons): each segment
 *   is drawn by an integer Bresenham DDA (`OnePixelLineDDAAliased`),
 *   normalised to run in the positive major direction, whose first and
 *   last pixels follow a diamond rule (a pixel whose half-pixel diamond
 *   holds an end point is drawn or skipped depending on where in it the
 *   point lies), with the start of the minor coordinate taken from the
 *   float slope at the first major pixel centre (see {@link ddaSegment}).
 *   Every segment includes its end pixel. When the path's bounds are not
 *   wholly inside the visible area, every segment is first cut to it and
 *   drawn by the clipping DDA, which also stops at the end point's minor
 *   pixel: pixels near the cut move.
 * - Any other case (antialiased, a translucent or non-solid brush, or any
 *   path with a curve, aliased or not): the
 *   figure is swept by the half-pixel diamond `|dx| + |dy| <= 1/2`: an
 *   outline polygon (`InitializeNominal`) runs along both sides of the
 *   polyline offset by the diamond vertex perpendicular to each segment's
 *   major axis, turns round the diamond at both ends, and at a joint whose
 *   quadrant changes adds one diamond vertex on the outer side and the
 *   joint itself on the inner side. It is built per batch of 32 points (a
 *   long figure gets caps at each seam) and filled nonzero by GDI+'s
 *   ordinary scan converter (`rasterizePlusFill`: one sample per pixel, or
 *   the 8 x 4 antialiasing grid).
 *
 * Measured against GDI+ on 2400 fresh random paths (1 to 100 segments,
 * straight, curved, closed and multi-figure; pens 0, 0.5, 1 and 1.5 px;
 * identity and random rotation with scale; aliased and antialiased, opaque
 * and translucent, PixelOffsetMode None and Half): 2399 exact, one with two
 * pixels off. Single aliased segments: 11 of 12000 differ by one pixel,
 * each where the exact line passes through a 1/16 grid point (GDI+'s
 * single-precision rounding there is not reproduced).
 *
 * PixelOffsetMode Half/HighQuality moves the device grid half a pixel,
 * which is the `half` option of both paths.
 *
 * @module emf-plus-nominal-line
 */

import { arcBeziers } from './emf-plus-flatten';
import { rasterizePlusFill, type DeviceFigure } from './emf-plus-raster';
import type { CanvasContext, TransformMatrix } from './emf-types';

const f32 = Math.fround;

/**
 * GDI+'s float to 28.4 conversion of a device coordinate
 * (`RasterizerCeiling`): the value times 256 (exact in single precision)
 * plus a half, floored, then rounded up to a whole 1/16. Pure.
 */
export function gdiplusFix(v: number): number {
	return (Math.floor(f32(f32(v) * 256 + 0.5)) + 15) >> 4;
}

/**
 * GDI+'s Bezier flattener (`Bezier32::bInit` / `cFlatten`), bit exact: the
 * same fixed-point hybrid forward differencing GDI uses, with GDI+'s own
 * error bounds (0x6000 while setting up, 0x30000 to halve the step, and a
 * parent error of 0xC000 to double it again). `p` is the curve's four
 * 28.4 points (x, y pairs); the points after the first are appended to
 * `out`. With `cull` (the visible bounds, in pixels, which GDI+ passes when
 * a path is only partly visible) a curve whose box, grown by a pixel, lies
 * wholly outside is not subdivided at all: it becomes its chord. A curve
 * too large for 32-bit arithmetic (a coordinate span of 1024 pixels or
 * more) goes to GDI+'s `Bezier64` there; it is evaluated by the same steps
 * here in exact arithmetic. Pure apart from `out`.
 */
export function flattenBezierGdiplus(
	p: ReadonlyArray<number>,
	out: number[],
	cull?: { x: number; y: number; w: number; h: number },
): void {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let i = 0; i < 8; i += 2) {
		minX = Math.min(minX, p[i]);
		maxX = Math.max(maxX, p[i]);
		minY = Math.min(minY, p[i + 1]);
		maxY = Math.max(maxY, p[i + 1]);
	}
	const left = minX - 16;
	const top = minY - 16;
	const X = [p[0] - left, p[2] - left, p[4] - left, p[6] - left];
	const Y = [p[1] - top, p[3] - top, p[5] - top, p[7] - top];
	const sar = (v: number, n: number): number => Math.floor(v / 2 ** n);
	// e0 = p0, e1 = p3 - p0, e2 = 6 (p1 - 2 p2 + p3), e3 = 6 (p0 - 2 p1 + p2), scaled by 2^10.
	const ex = [X[0] * 1024, (X[3] - X[0]) * 1024, 3 * (X[1] - 2 * X[2] + X[3]) * 2048, 3 * (X[0] - 2 * X[1] + X[2]) * 2048];
	const ey = [Y[0] * 1024, (Y[3] - Y[0]) * 1024, 3 * (Y[1] - 2 * Y[2] + Y[3]) * 2048, 3 * (Y[0] - 2 * Y[1] + Y[2]) * 2048];
	let steps = 1;
	let shift = 0;
	const outside =
		!!cull &&
		(minX - 16 >= (cull.x + cull.w) * 16 ||
			minY - 16 >= (cull.y + cull.h) * 16 ||
			maxX + 16 <= cull.x * 16 ||
			maxY + 16 <= cull.y * 16);
	const maxAbs = (a: number, b: number): number => (Math.abs(a) > Math.abs(b) ? Math.abs(a) : Math.abs(b));
	if (!outside) {
		for (let guard = 0; guard < 40; guard++) {
			const limit = 0x6000 * 2 ** shift;
			if (maxAbs(ex[2], ex[3]) <= limit && maxAbs(ey[2], ey[3]) <= limit) {
				break;
			}
			shift += 2;
			for (const e of [ex, ey]) {
				e[2] = sar(e[2] + e[3], 1);
				e[1] = sar(e[1] - sar(e[2], shift), 1);
			}
			steps *= 2;
		}
	}
	for (const e of [ex, ey]) {
		e[0] *= 8;
		e[1] *= 8;
		const l = shift - 3;
		if (l >= 0) {
			e[2] = sar(e[2], l);
			e[3] = sar(e[3], l);
		} else {
			e[2] *= 2 ** -l;
			e[3] *= 2 ** -l;
		}
	}
	const step = (e: number[]): void => {
		e[0] += e[1];
		const t = e[2];
		e[1] += t;
		e[2] = t + t - e[3];
		e[3] = t;
	};
	// bInit already takes the first step.
	step(ex);
	step(ey);
	steps--;
	for (let guard = 0; guard < 1 << 22; guard++) {
		out.push(sar(ex[0] + 0x1000, 13) + left, sar(ey[0] + 0x1000, 13) + top);
		if (steps === 0) {
			return;
		}
		if (Math.max(maxAbs(ex[2], ex[3]), maxAbs(ey[2], ey[3])) > 0x30000) {
			for (const e of [ex, ey]) {
				e[2] = sar(e[2] + e[3], 3);
				e[1] = sar(e[1] - e[2], 1);
				e[3] = sar(e[3], 2);
			}
			steps *= 2;
		}
		while (
			steps % 2 === 0 &&
			maxAbs(ex[3], 2 * ex[2] - ex[3]) <= 0xc000 &&
			maxAbs(ey[3], 2 * ey[2] - ey[3]) <= 0xc000
		) {
			for (const e of [ex, ey]) {
				e[3] *= 4;
				e[1] = e[2] + 2 * e[1];
				e[2] = e[2] * 8 - e[3];
			}
			steps /= 2;
		}
		steps--;
		step(ex);
		step(ey);
	}
}

/** A figure of an enumerated path: 28.4 vertices as flat `x, y` pairs, and whether it was closed. */
export interface NominalFigure {
	pts: number[];
	closed: boolean;
	/** True when any part of the figure came from a Bezier curve. */
	curved?: boolean;
}

/**
 * Records the geometry `buildPath` issues (world coordinates, Canvas path
 * calls `moveTo`, `lineTo`, `bezierCurveTo`, `ellipse`, `rect`, `closePath`) as GDI+
 * enumerates a path for stroking: every point mapped by `device` in single
 * precision and converted by {@link gdiplusFix}, Beziers flattened from
 * their converted control points by GDI+'s HFD. Throws for any other path
 * call (the caller then keeps its fallback).
 */
export function recordNominalFigures(
	buildPath: (c: CanvasContext) => void,
	device: TransformMatrix,
	cull?: { x: number; y: number; w: number; h: number },
): NominalFigure[] {
	const m = device.map((v) => f32(v));
	const fx = (x: number, y: number): number => gdiplusFix(f32(f32(f32(m[0] * f32(x)) + f32(m[2] * f32(y))) + m[4]));
	const fy = (x: number, y: number): number => gdiplusFix(f32(f32(f32(m[1] * f32(x)) + f32(m[3] * f32(y))) + m[5]));
	const figures: NominalFigure[] = [];
	let fig: NominalFigure | null = null;
	let start: { x: number; y: number } | null = null;
	const moveTo = (x: number, y: number): void => {
		fig = { pts: [fx(x, y), fy(x, y)], closed: false, curved: false };
		figures.push(fig);
		start = { x, y };
	};
	const lineTo = (x: number, y: number): void => {
		if (!fig) {
			moveTo(x, y);
			return;
		}
		fig.pts.push(fx(x, y), fy(x, y));
	};
	const recorder = {
		beginPath(): void {
			fig = null;
			start = null;
		},
		moveTo,
		lineTo,
		bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
			if (!fig) {
				moveTo(c1x, c1y);
			}
			const f = fig as unknown as NominalFigure;
			f.curved = true;
			const n = f.pts.length;
			flattenBezierGdiplus(
				[f.pts[n - 2], f.pts[n - 1], fx(c1x, c1y), fy(c1x, c1y), fx(c2x, c2y), fy(c2x, c2y), fx(x, y), fy(x, y)],
				f.pts,
				cull,
			);
		},
		ellipse(cx: number, cy: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw?: boolean): void {
			// As recordDeviceFigures: GDI+'s arc Beziers (emf-plus-flatten.ts).
			let sweep = a1 - a0;
			if (ccw) {
				sweep = sweep > 0 ? sweep - 2 * Math.PI * Math.ceil(sweep / (2 * Math.PI)) : sweep;
				sweep = Math.max(sweep, -2 * Math.PI);
			} else {
				sweep = sweep < 0 ? sweep + 2 * Math.PI * Math.ceil(-sweep / (2 * Math.PI)) : sweep;
				sweep = Math.min(sweep, 2 * Math.PI);
			}
			const cos = Math.cos(rotation);
			const sin = Math.sin(rotation);
			const rot = (p: { x: number; y: number }): { x: number; y: number } =>
				rotation === 0 ? p : { x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos };
			const segs = arcBeziers(cx, cy, rx, ry, a0, sweep);
			if (segs.length === 0) {
				return;
			}
			const p0 = rot(segs[0][0]);
			if (fig) {
				lineTo(p0.x, p0.y);
			} else {
				moveTo(p0.x, p0.y);
			}
			for (const seg of segs) {
				const [, q1, q2, q3] = seg.map(rot);
				recorder.bezierCurveTo(q1.x, q1.y, q2.x, q2.y, q3.x, q3.y);
			}
		},
		rect(x: number, y: number, w: number, h: number): void {
			moveTo(x, y);
			lineTo(x + w, y);
			lineTo(x + w, y + h);
			lineTo(x, y + h);
			recorder.closePath();
		},
		closePath(): void {
			if (fig && start) {
				fig.closed = true;
				const s: { x: number; y: number } = start;
				moveTo(s.x, s.y);
			}
		},
	};
	buildPath(recorder as unknown as CanvasContext);
	return figures.filter((f) => f.pts.length >= 4);
}

/**
 * The {@link NominalFigure}s of figures already recorded in device space by
 * `recordDeviceFigures` (emf-plus-raster.ts): straight vertices converted by
 * {@link gdiplusFix}, curve points (already on GDI+'s 1/16 grid) kept.
 * Exact for straight figures; a curve's control points were rounded by
 * `toPlusFix` there, which differs from {@link gdiplusFix} for a
 * coordinate within 1/512 pixel above a sixteenth (prefer
 * {@link recordNominalFigures}).
 */
export function nominalFiguresFromDevice(figures: ReadonlyArray<DeviceFigure>): NominalFigure[] {
	return figures.map((f) => ({ pts: f.pts.map((v) => gdiplusFix(v)), closed: f.closed, curved: f.curved }));
}

/** The figure's points with the closing segment's end appended when closed (as the enumerator hands them over). */
function strokePoints(f: NominalFigure): number[] {
	const p = f.pts;
	if (!f.closed || p.length < 4) {
		return p;
	}
	return [...p, p[0], p[1]];
}

/** Points per batch `FixedPointPathEnumerate` hands to its callback. */
const ENUM_BATCH = 32;

/**
 * A figure's points split the way GDI+'s path enumerator hands them over:
 * batches of at most 32 points, each starting with the previous batch's
 * last point. The nominal outline is built per batch, so a figure longer
 * than one batch has an end cap and a start cap at each seam. Pure.
 */
function enumeratorBatches(pts: ReadonlyArray<number>): number[][] {
	const n = pts.length / 2;
	const out: number[][] = [];
	for (let s = 0; s < n - 1; s += ENUM_BATCH - 1) {
		out.push(pts.slice(2 * s, 2 * Math.min(n, s + ENUM_BATCH)));
	}
	return out;
}

/**
 * GDI+'s aliased one-pixel line DDA (`OnePixelLineDDAAliased`) from
 * (`ax`, `ay`) to (`bx`, `by`) (28.4), calling `plot` for every pixel.
 * `last` is GDI+'s draw-last-pixel flag (its stroker always sets it);
 * `clip`, the visible bounds in pixels, selects `ClipRectangle` and the
 * clipping DDA (see {@link nominalLineCoverage}). Pure apart from `plot`.
 */
export function ddaSegment(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	last: boolean,
	plot: (x: number, y: number) => void,
	clip?: { x: number; y: number; w: number; h: number },
): void {
	// GDI+ hands the segment over as floats (the 28.4 values / 16).
	const fdx = f32(bx / 16 - ax / 16);
	const fdy = f32(by / 16 - ay / 16);
	if (fdx === 0 && fdy === 0) {
		return;
	}
	const adx = Math.abs(fdx);
	const ady = Math.abs(fdy);
	const xMajor = ady < adx;
	let reversed = false;
	let sign: number;
	if (xMajor) {
		sign = fdy >= 0 ? 1 : -1;
		if (fdx < 0) {
			reversed = true;
			[ax, ay, bx, by] = [bx, by, ax, ay];
			sign = -sign;
		}
	} else {
		sign = fdx >= 0 ? 1 : -1;
		if (fdy < 0) {
			reversed = true;
			[ax, ay, bx, by] = [bx, by, ax, ay];
			sign = -sign;
		}
	}
	let maj0 = xMajor ? ax : ay;
	let maj1 = xMajor ? bx : by;
	let min0 = xMajor ? ay : ax;
	let min1 = xMajor ? by : bx;
	// The float slope (minor over major delta, single precision), as
	// DrawSolidLineOnePixelAliased computes it.
	const slope = xMajor ? f32(f32(sign * ady) / adx) : f32(f32(sign * adx) / ady);
	const dMaj = maj1 - maj0;
	const dMin = (min1 - min0) * sign;
	let frac0 = 0;
	let frac1 = 0;
	let e0 = 0;
	if (clip) {
		// OnePixelLineDDAAliased::ClipRectangle: the segment cut to the
		// visible bounds (pixel edges at 16 n - 8), keeping the exact line.
		const inv = slope === 0 ? 0 : f32(1 / slope);
		const majLo = (xMajor ? clip.x : clip.y) * 16 - 8;
		const majHi = (xMajor ? clip.x + clip.w : clip.y + clip.h) * 16 - 8;
		const minLo = (xMajor ? clip.y : clip.x) * 16 - 8;
		const minHi = (xMajor ? clip.y + clip.h : clip.x + clip.w) * 16 - 8;
		if (maj0 < majLo || maj1 > majHi) {
			if (maj0 > majHi || maj1 < majLo) {
				return;
			}
			if (maj0 < majLo) {
				const v = f32(f32((majLo - maj0) * slope) + min0);
				const fl = Math.floor(v);
				min0 = fl;
				maj0 = majLo;
				frac0 = f32(v - fl);
			}
			if (maj1 > majHi) {
				const v = f32(f32((majHi - maj1) * slope) + min1);
				const fl = Math.floor(v);
				last = true;
				min1 = fl;
				maj1 = majHi;
				frac1 = f32(v - fl);
			}
		}
		const lowIsStart = sign === 1;
		const lo = lowIsStart ? min0 : min1;
		const hi = lowIsStart ? min1 : min0;
		if (lo < minLo || hi > minHi) {
			if (lo > minHi || hi < minLo) {
				return;
			}
			if (lo < minLo) {
				const t = Math.floor(f32(f32(minLo - f32(lo + (lowIsStart ? frac0 : frac1))) * inv));
				if (lowIsStart) {
					maj0 += t;
					min0 = minLo;
				} else {
					maj1 += t;
					min1 = minLo;
				}
			}
			if (hi > minHi) {
				const t = Math.floor(f32(f32(minHi - f32(hi + (lowIsStart ? frac1 : frac0))) * inv));
				if (lowIsStart) {
					maj1 += t;
					min1 = minHi;
				} else {
					maj0 += t;
					min0 = minHi;
				}
				last = true;
			}
		}
		if (frac1 !== 0 && (min1 & 15) === 8) {
			min1++;
		}
		if (frac0 !== 0) {
			e0 = Math.floor(f32(f32(2 * dMaj * sign) * frac0));
		}
	}
	const diag = xMajor && dMaj === dMin;
	const tieUp = diag && sign === 1;
	const k = tieUp ? 8 : 7;
	const inDiamond = (dj: number, dn: number): boolean => {
		const d = Math.abs(dj) + Math.abs(dn);
		if (d < 8) {
			return true;
		}
		if (d !== 8) {
			return false;
		}
		if ((dn === 0 && dj === (tieUp ? -8 : 8)) || (dj === 0 && dn === 8)) {
			return true;
		}
		return diag && (tieUp ? dj < 0 : dj > 0) && dn > 0;
	};
	let mcS = (maj0 + k) & ~15;
	let mcE = (maj1 + k) & ~15;
	const startIn = inDiamond(maj0 - mcS, min0 - ((min0 + 7) & ~15));
	const endIn = inDiamond(maj1 - mcE, min1 - ((min1 + 7) & ~15));
	const n0 = maj0 & 15;
	const n1 = maj1 & 15;
	if (reversed && !last) {
		if (startIn || n0 <= 8) {
			mcS += 16;
		}
	} else if (n0 <= 8 && !startIn) {
		mcS += 16;
	}
	if (!reversed && !last) {
		if (n1 > 8 || endIn) {
			mcE -= 16;
		}
	} else if (!endIn && n1 > 8) {
		mcE -= 16;
	}
	const colS = mcS >> 4;
	const colE = mcE >> 4;
	if (colE < colS) {
		return;
	}
	// The minor coordinate at the first major pixel centre from the float
	// slope. The product and sum are kept unrounded here: modelling them in
	// single precision, as the code reads, matched GDI+ on fewer segments
	// (15 against 11 of 12000 differ by one pixel, all where the exact line
	// meets a 1/16 grid point).
	const yS = Math.floor((mcS - maj0) * slope + min0 + frac0);
	const ycS = (yS + 7) & ~15;
	let y = ycS >> 4;
	let e = (e0 - ((ycS - yS) * sign + 8) * 2 * dMaj) >> 4;
	if (!clip) {
		// OnePixelLineDDAAliased::DrawXMajor / DrawYMajor.
		for (let col = colS; col <= colE; col++) {
			if (xMajor) {
				plot(col, y);
			} else {
				plot(y, col);
			}
			e += 2 * dMin;
			if (e > 0) {
				y += sign;
				e -= 2 * dMaj;
			}
		}
		return;
	}
	// DrawXMajorClip / DrawYMajorClip: the same steps, drawn only inside the
	// clip bounds and only until the minor coordinate passes the end
	// point's minor pixel.
	const yE = Math.floor((mcE - maj1) * slope + min1 + frac1);
	const minorEnd = (yE + 7) >> 4;
	const majLoPx = xMajor ? clip.x : clip.y;
	const majHiPx = (xMajor ? clip.x + clip.w : clip.y + clip.h) - 1;
	const minLoPx = xMajor ? clip.y : clip.x;
	const minHiPx = (xMajor ? clip.y + clip.h : clip.x + clip.w) - 1;
	let left = (minorEnd - y) * sign;
	for (let col = colS; col <= colE && left >= 0; col++) {
		if (col >= majLoPx && col <= majHiPx && y >= minLoPx && y <= minHiPx) {
			if (xMajor) {
				plot(col, y);
			} else {
				plot(y, col);
			}
		}
		e += 2 * dMin;
		if (e > 0) {
			y += sign;
			e -= 2 * dMaj;
			left--;
		}
	}
}

/** `InitializeNominal`'s diamond vertices, indexed by quadrant: (0,-8), (-8,0), (0,8), (8,0). */
const DIAMOND = [0, -8, -8, 0, 0, 8, 8, 0];

/** The quadrant of a segment direction: x-major rightwards 0, leftwards 2; y-major downwards 3, upwards 1. */
function quadrant(dx: number, dy: number): number {
	if (Math.abs(dy) > Math.abs(dx)) {
		return dy < 0 ? 1 : 3;
	}
	return dx < 0 ? 2 : 0;
}

/**
 * The outline GDI+ builds round a polyline (28.4) for a nominal-width
 * stroke through its scan converter (`InitializeNominal`), as one closed
 * polygon: see the module doc. Pure.
 */
export function nominalOutline(pts: ReadonlyArray<number>): number[] {
	const n = pts.length / 2;
	if (n < 2) {
		return [];
	}
	const fwd: number[] = [];
	const back: number[] = [];
	const px = (i: number): number => pts[2 * i];
	const py = (i: number): number => pts[2 * i + 1];
	let q = quadrant(px(1) - px(0), py(1) - py(0));
	const dxq = (qq: number): number => DIAMOND[2 * (qq & 3)];
	const dyq = (qq: number): number => DIAMOND[2 * (qq & 3) + 1];
	fwd.push(px(0) - dxq(q), py(0) - dyq(q), px(0) + dxq(q + 1), py(0) + dyq(q + 1));
	for (let i = 0; i + 1 < n; i++) {
		fwd.push(px(i) + dxq(q), py(i) + dyq(q), px(i + 1) + dxq(q), py(i + 1) + dyq(q));
		back.push(px(i) - dxq(q), py(i) - dyq(q), px(i + 1) - dxq(q), py(i + 1) - dyq(q));
		if (i + 2 >= n) {
			break;
		}
		const nq = quadrant(px(i + 2) - px(i + 1), py(i + 2) - py(i + 1));
		if (nq !== q) {
			const ax = px(i + 1) - px(i);
			const ay = py(i + 1) - py(i);
			const bx = px(i + 2) - px(i + 1);
			const by = py(i + 2) - py(i + 1);
			const x = px(i + 1);
			const y = py(i + 1);
			if (ax * by >= ay * bx) {
				const r = (q - 1) & 3;
				if (r !== nq) {
					fwd.push(x + dxq(r), y + dyq(r));
				}
				back.push(x, y);
			} else {
				const r = (q + 1) & 3;
				if (r !== nq) {
					back.push(x - dxq(r), y - dyq(r));
				}
				fwd.push(x, y);
			}
			q = nq;
		}
	}
	const ex = px(n - 1);
	const ey = py(n - 1);
	fwd.push(ex + dxq(q - 1), ey + dyq(q - 1), ex - dxq(q), ey - dyq(q));
	// The backward side, from the end to the start.
	const poly = fwd.slice();
	for (let i = back.length - 2; i >= 0; i -= 2) {
		poly.push(back[i], back[i + 1]);
	}
	return poly;
}

/** Options of {@link nominalLineCoverage}. */
export interface NominalLineMode {
	/** GDI+'s 8 x 4 antialiasing (SmoothingMode AntiAlias/HighQuality). */
	antialias: boolean;
	/** PixelOffsetMode Half/HighQuality. */
	half: boolean;
	/**
	 * The brush is an opaque solid colour: aliased strokes then take GDI+'s
	 * one-pixel DDA; otherwise (and always when antialiased) the diamond
	 * outline goes through the scan converter.
	 */
	opaqueSolid: boolean;
	/**
	 * The device-pixel bounds of the visible area (the surface, or the clip
	 * region's bounding box): GDI+ cuts every one-pixel DDA segment to it
	 * (`OnePixelLineDDAAliased::ClipRectangle`), which moves the pixels of a
	 * segment that leaves it. Omitted: no cutting.
	 */
	clip?: { x: number; y: number; w: number; h: number };
}

/**
 * Per-pixel coverage (0..255, as `rasterizePlusFill` returns it) of a
 * nominal-width stroke of `figures` over `box`, exactly as GDI+ draws it
 * (see the module doc). Pure.
 */
export function nominalLineCoverage(
	figures: ReadonlyArray<NominalFigure>,
	mode: NominalLineMode,
	box: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
	// The one-pixel DDA draws aliased opaque solid strokes of straight
	// figures only: a path with any curve goes through the outline too.
	if (!mode.antialias && mode.opaqueSolid && !figures.some((f) => f.curved)) {
		const shift = mode.half ? 8 : 0;
		const out = new Uint8ClampedArray(box.w * box.h);
		const plot = (x: number, y: number): void => {
			const ix = x - box.x;
			const iy = y - box.y;
			if (ix >= 0 && iy >= 0 && ix < box.w && iy < box.h) {
				out[iy * box.w + ix] = 255;
			}
		};
		const clip = mode.clip && !pathInside(figures, mode.clip, shift) ? mode.clip : undefined;
		for (const f of figures) {
			const p = strokePoints(f);
			for (let i = 0; i + 3 < p.length; i += 2) {
				ddaSegment(p[i] - shift, p[i + 1] - shift, p[i + 2] - shift, p[i + 3] - shift, true, plot, clip);
			}
		}
		return out;
	}
	const polys: number[][] = [];
	for (const f of figures) {
		for (const batch of enumeratorBatches(strokePoints(f))) {
			const outline = nominalOutline(batch);
			if (outline.length >= 6) {
				polys.push(outline);
			}
		}
	}
	return rasterizePlusFill(polys, false, mode.antialias, mode.half, box);
}

/**
 * Whether GDI+ considers a path's drawing bounds wholly inside the visible
 * bounds (`DpRegion::GetRectVisibility` of the stroke bounds): the vertex
 * box grown by half a pixel, rounded out to whole pixels, plus one more
 * pixel on every side (fitted on 10000 random segments ending near an
 * edge). Only then does GDI+ draw the segments uncut; otherwise every
 * segment goes through `ClipRectangle` and the clipping DDA.
 */
function pathInside(
	figures: ReadonlyArray<NominalFigure>,
	clip: { x: number; y: number; w: number; h: number },
	shift: number,
): boolean {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const f of figures) {
		for (let i = 0; i + 1 < f.pts.length; i += 2) {
			const x = (f.pts[i] - shift) / 16;
			const y = (f.pts[i + 1] - shift) / 16;
			x0 = Math.min(x0, x);
			x1 = Math.max(x1, x);
			y0 = Math.min(y0, y);
			y1 = Math.max(y1, y);
		}
	}
	return (
		Math.floor(x0 - 0.5) - 1 >= clip.x &&
		Math.floor(y0 - 0.5) - 1 >= clip.y &&
		Math.ceil(x1 + 0.5) + 1 <= clip.x + clip.w - 1 &&
		Math.ceil(y1 + 0.5) + 1 <= clip.y + clip.h - 1
	);
}
