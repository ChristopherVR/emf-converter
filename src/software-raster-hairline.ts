/**
 * Anti-aliased hairlines for the pure-JavaScript rasteriser, reproducing
 * Skia's treatment of thin strokes.
 *
 * Skia (the rasteriser behind Chromium, both its CPU and GPU paths, and
 * behind `@napi-rs/canvas`) does not outline a stroke that is at most one
 * device pixel wide: it draws it as a HAIRLINE whose opacity is scaled by
 * the stroke's width (`SkDrawTreatAsHairline`). A 1px GDI cosmetic pen,
 * by far the most common pen in metafiles, is such a stroke, and a hairline
 * spreads its ink differently from a one-pixel-wide polygon: a diagonal
 * hairline puts one pixel's worth of coverage in each column, split between
 * the two rows around the line, where the polygon's exact area coverage is
 * `1 / cos(angle)` per column. Rendering it as a polygon would leave the
 * rasteriser's thin lines consistently darker than every Skia-based renderer
 * the SVG or PNG output is viewed in.
 *
 * {@link hairlineCoverage} is Skia's thin-stroke test and
 * {@link drawHairline} its anti-aliased line walker (`SkScan_Antihair.cpp`):
 * endpoints on a 1/64 pixel grid, 16.16 fixed-point stepping, the first and
 * last column (or row) scaled by how much of it the segment spans, lines
 * longer than 511 pixels split in half, and each segment blended on its own
 * (so the pixels where two segments meet are painted twice, as in Skia).
 * Curves are subdivided into Skia's number of hairline segments
 * ({@link hairlineCubicSegments}).
 *
 * @module software-raster-hairline
 */

import type { Matrix } from './canvas-path';

/** Skia's `fast_len`: an overestimate of a vector's length. */
function fastLen(x: number, y: number): number {
	let a = Math.abs(x);
	let b = Math.abs(y);
	if (a < b) {
		const t = a;
		a = b;
		b = t;
	}
	return a + b / 2;
}

/**
 * The opacity a stroke of `lineWidth` under `m` is drawn with as a hairline,
 * or `null` when it is wide enough to be outlined (Skia's
 * `SkDrawTreatAsHairline` for an anti-aliased stroke).
 */
export function hairlineCoverage(m: Readonly<Matrix>, lineWidth: number): number | null {
	const len0 = fastLen(m[0] * lineWidth, m[1] * lineWidth);
	const len1 = fastLen(m[2] * lineWidth, m[3] * lineWidth);
	if (len0 <= 1 && len1 <= 1) {
		return (len0 + len1) / 2;
	}
	return null;
}

/**
 * Skia's hairline subdivision of a device-space cubic: `2^i` lines for the
 * smallest `i` whose tolerance (`1/8 * 4^i`) exceeds the control points'
 * deviation from the chord's thirds.
 */
export function hairlineCubicSegments(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x3: number,
	y3: number,
): number {
	const p13x = x3 / 3 + (2 * x0) / 3;
	const p13y = y3 / 3 + (2 * y0) / 3;
	const p23x = x0 / 3 + (2 * x3) / 3;
	const p23y = y0 / 3 + (2 * y3) / 3;
	const diff = Math.max(Math.abs(x1 - p13x), Math.abs(y1 - p13y), Math.abs(x2 - p23x), Math.abs(y2 - p23y));
	let tol = 1 / 8;
	for (let i = 0; i < 9; i++) {
		if (diff < tol) {
			return 1 << i;
		}
		tol *= 4;
	}
	return 1 << 9;
}

/** Receives one blended pixel: device (`x`, `y`) at coverage `alpha` (0..255). */
export type HairlinePlot = (x: number, y: number, alpha: number) => void;

const FIXED_HALF = 0x8000;

/** 16.16 division, clamped to one unit (Skia's `fastfixdiv` for |a| <= |b|). */
function fixDiv(a: number, b: number): number {
	return Math.trunc((a * 65536) / b);
}

function dot6Scale(value: number, mod64: number): number {
	return (value * mod64) >> 6;
}

/**
 * Draws one anti-aliased hairline segment between device points
 * (`ax`,`ay`) and (`bx`,`by`), reporting each touched pixel to `plot`. The
 * segment is first clipped to the surface (`width` x `height`, plus a
 * pixel of margin), which keeps the fixed-point walk in range.
 */
export function drawHairline(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	width: number,
	height: number,
	plot: HairlinePlot,
): void {
	// Liang-Barsky clip against [-1, width + 1] x [-1, height + 1].
	let t0 = 0;
	let t1 = 1;
	const dx = bx - ax;
	const dy = by - ay;
	const edges: Array<[number, number]> = [
		[-dx, ax + 1],
		[dx, width + 1 - ax],
		[-dy, ay + 1],
		[dy, height + 1 - ay],
	];
	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) {
				return;
			}
		} else {
			const r = q / p;
			if (p < 0) {
				t0 = Math.max(t0, r);
			} else {
				t1 = Math.min(t1, r);
			}
		}
	}
	if (t0 > t1) {
		return;
	}
	// Skia works in 26.6 fixed point.
	antiHairline(
		Math.round((ax + dx * t0) * 64),
		Math.round((ay + dy * t0) * 64),
		Math.round((ax + dx * t1) * 64),
		Math.round((ay + dy * t1) * 64),
		plot,
	);
}

function antiHairline(x0: number, y0: number, x1: number, y1: number, plot: HairlinePlot): void {
	// Lines longer than 511 pixels are split so 16.16 slopes cannot overflow.
	if (Math.abs(x1 - x0) > 511 * 64 || Math.abs(y1 - y0) > 511 * 64) {
		const hx = (x0 >> 1) + (x1 >> 1);
		const hy = (y0 >> 1) + (y1 >> 1);
		antiHairline(x0, y0, hx, hy, plot);
		antiHairline(hx, hy, x1, y1, plot);
		return;
	}
	if (Math.abs(x1 - x0) > Math.abs(y1 - y0)) {
		// Mostly horizontal: walk columns, splitting coverage between two rows.
		if (x0 > x1) {
			[x0, x1] = [x1, x0];
			[y0, y1] = [y1, y0];
		}
		const istart = x0 >> 6;
		const istop = (x1 + 63) >> 6;
		let fstart = y0 << 10;
		const slope = y0 === y1 ? 0 : fixDiv(y1 - y0, x1 - x0);
		fstart += (slope * (32 - (x0 & 63)) + 32) >> 6;
		walk(istart, istop, fstart, slope, x1 - x0, x0 & 63, x1 & 63, (i, lower, a0, a1) => {
			if (a0) plot(i, lower - 1, a0);
			if (a1) plot(i, lower, a1);
		});
	} else {
		if (x0 === x1 && y0 === y1) {
			return;
		}
		// Mostly vertical: walk rows, splitting coverage between two columns.
		if (y0 > y1) {
			[x0, x1] = [x1, x0];
			[y0, y1] = [y1, y0];
		}
		const istart = y0 >> 6;
		const istop = (y1 + 63) >> 6;
		let fstart = x0 << 10;
		const slope = x0 === x1 ? 0 : fixDiv(x1 - x0, y1 - y0);
		fstart += (slope * (32 - (y0 & 63)) + 32) >> 6;
		walk(istart, istop, fstart, slope, y1 - y0, y0 & 63, y1 & 63, (i, lower, a0, a1) => {
			if (a0) plot(lower - 1, i, a0);
			if (a1) plot(lower, i, a1);
		});
	}
}

/**
 * The common column (or row) walk: `fstart` is the line's 16.16 position
 * across the walk at the first step's centre, `slope` its 16.16 change per
 * step; the first and last steps are scaled by the fraction of them the
 * segment covers (`len`, `startFrac`, `stopFrac` in 1/64 pixel).
 */
function walk(
	istart: number,
	istop: number,
	fstart: number,
	slope: number,
	len: number,
	startFrac: number,
	stopFrac: number,
	blit: (i: number, lower: number, a0: number, a1: number) => void,
): void {
	if (istop <= istart) {
		return;
	}
	let scaleStart: number;
	let scaleStop: number;
	if (istop - istart === 1) {
		scaleStart = len;
		scaleStop = 0;
	} else {
		scaleStart = 64 - startFrac;
		scaleStop = stopFrac;
	}
	const cap = (i: number, fy: number, mod64: number): number => {
		fy += FIXED_HALF;
		const lower = fy >> 16;
		const a = (fy >> 8) & 0xff;
		blit(i, lower, dot6Scale(255 - a, mod64), dot6Scale(a, mod64));
		return fy + slope - FIXED_HALF;
	};
	let fy = cap(istart, fstart, scaleStart);
	let i = istart + 1;
	const fullSpans = istop - i - (scaleStop > 0 ? 1 : 0);
	if (fullSpans > 0) {
		fy += FIXED_HALF;
		for (let k = 0; k < fullSpans; k++, i++) {
			const lower = fy >> 16;
			const a = (fy >> 8) & 0xff;
			blit(i, lower, 255 - a, a);
			fy += slope;
		}
		fy -= FIXED_HALF;
	}
	if (scaleStop > 0) {
		cap(istop - 1, fy, scaleStop);
	}
}
