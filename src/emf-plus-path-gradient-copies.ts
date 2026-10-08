/**
 * The nested copies of a uniform path gradient, rasterised the way GDI+ rasterises them.
 *
 * A path gradient whose surround colour is the same at every vertex is `N` nested copies of
 * the boundary (`pathGradientQuantum`), each a step nearer the centre colour, and a pixel
 * takes the colour of the innermost copy that holds it. Which copy holds a pixel is decided
 * by scan-converting the copy, and two details of that decide the pixels the smooth ratio
 * rounds the wrong way (the half-step ties and near-ties):
 *
 * - The boundary's vertices and the centre are rounded to the nearest 1/16 pixel in device
 *   space (28.4 fixed point) before anything is scaled. Each copy is then the exact scale of
 *   those rounded points about the rounded centre, by `(m + 1/2) / N` for copy `m`, with no
 *   rounding of its own. (Rounding the copies as well, to 1/16 or to any finer grid, or
 *   rounding the original points up or down, all score lower.)
 * - A pixel is in copy `m` when the exact ratio of its distance to the boundary is at most
 *   `(m + 1/2) / N`, and takes the innermost such copy.
 *
 * With both, 107,809 of 107,809 pixels of 64 rotated, scaled and sheared captures with
 * fractional geometry are reproduced to the level, where the smooth ratio rounds about 9% of them
 * the wrong way. An isotropic focus scales each copy by `f + (1 - f) (m + 1/2) / N`.
 *
 * A pixel exactly on a copy's edge (the integer-sized shapes of the earlier captures have them)
 * is not decided by one rule: horizontal top and bottom ties of a rectangle fall outside the copy
 * for most of the edge and inside near its left end (row 24 of a 60 x 40 rectangle: columns
 * 34 to 38 inside, 39 to 63 outside), and slanted ties are 293 inside to 160 outside. Native's
 * edge arithmetic is not reproduced, so a tie takes the colour half way between the two
 * steps, which is within a level of either answer. (Strict containment with a float32 scale
 * `m * step + step / 2` reproduces all 116 ties of the whole-row captures and then only 40% of the
 * vertical and 45% of the horizontal ties of the 14 rectangles in `path-gradient-ties.json.gz`.)
 *
 * @module emf-plus-path-gradient-copies
 */

import { pathGradientRatio } from './emf-plus-brush-gradient';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/** A uniform path gradient in device space, ready to answer which copy holds a pixel. */
export interface CopiesGradient {
	cx: number;
	cy: number;
	vx: Float64Array;
	vy: Float64Array;
	/** Number of copies (`pathGradientQuantum`). */
	steps: number;
	/** Isotropic focus scale (0 when there is none). */
	focus: number;
	/** The rounded device-space shape, when the focus scales differ per axis (the ratio then comes from the strip solver). */
	anisotropic: EmfPlusPathGradientShape | null;
}

/** Rounds to the nearest 1/16 pixel, half up. */
const fix = (v: number): number => Math.floor(v * 16 + 0.5) / 16;
/** A copy index this close to a whole number puts the pixel on that copy's edge. */
const TIE = 1e-6;
/** The strip solver of an anisotropic focus lands within about 0.002 of a step of native's edge, so that close is a tie too. */
const STRIP_TIE = 0.005;
const CEIL_EPSILON = 1e-9;

/**
 * Device-space geometry of `shape` under `full` (brush space to device pixels), or `null` for
 * a boundary with fewer than three points.
 */
export function prepareCopies(shape: EmfPlusPathGradientShape, full: TransformMatrix, steps: number): CopiesGradient | null {
	const n = shape.boundary.length;
	if (n < 3 || steps <= 0) return null;
	const isotropic = !shape.focus || Math.abs(shape.focus.x - shape.focus.y) <= 1e-9;
	const focus = shape.focus && isotropic ? Math.min(1, Math.max(0, shape.focus.x)) : 0;
	const vx = new Float64Array(n);
	const vy = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const p = shape.boundary[i];
		vx[i] = fix(full[0] * p.x + full[2] * p.y + full[4]);
		vy[i] = fix(full[1] * p.x + full[3] * p.y + full[5]);
	}
	const c = shape.center;
	const cx = fix(full[0] * c.x + full[2] * c.y + full[4]);
	const cy = fix(full[1] * c.x + full[3] * c.y + full[5]);
	const anisotropic: EmfPlusPathGradientShape | null = isotropic ? null : {
		...shape,
		boundary: Array.from(vx, (x, i) => ({ x, y: vy[i] })),
		center: { x: cx, y: cy },
		boundaryArgb: shape.boundaryArgb,
		blend: null,
		preset: null,
		transform: null,
	};
	return { cx, cy, vx, vy, steps, focus, anisotropic };
}

/** Whether device pixel (`px`, `py`) lies in the polygon scaled by `scale` about the centre. */
function insideCopy(g: CopiesGradient, scale: number, px: number, py: number): boolean {
	const n = g.vx.length;
	let xl = Infinity;
	let xr = -Infinity;
	let ax = g.cx + (g.vx[n - 1] - g.cx) * scale;
	let ay = g.cy + (g.vy[n - 1] - g.cy) * scale;
	for (let i = 0; i < n; i++) {
		const bx = g.cx + (g.vx[i] - g.cx) * scale;
		const by = g.cy + (g.vy[i] - g.cy) * scale;
		if ((ay <= py && by > py) || (by <= py && ay > py)) {
			const x = ax + ((py - ay) / (by - ay)) * (bx - ax);
			if (x < xl) xl = x;
			if (x > xr) xr = x;
		}
		ax = bx;
		ay = by;
	}
	return xl !== Infinity && px >= Math.ceil(xl - CEIL_EPSILON) && px < Math.ceil(xr - CEIL_EPSILON);
}

/**
 * The step count from the boundary (0 on the outermost ring, `steps` at the centre colour) of
 * device pixel (`px`, `py`), or `null` outside the boundary.
 */
export function copiesStepAt(g: CopiesGradient, px: number, py: number, nudge = 0): number | null {
	const n = g.vx.length;
	let s = -1;
	const dx = px - g.cx;
	const dy = py - g.cy;
	for (let i = 0; i < n; i++) {
		const ax = g.vx[i] - g.cx;
		const ay = g.vy[i] - g.cy;
		const ex = g.vx[(i + 1) % n] - g.vx[i];
		const ey = g.vy[(i + 1) % n] - g.vy[i];
		const det = ax * ey - ay * ex;
		if (Math.abs(det) < 1e-12) continue;
		const alpha = (dx * ey - dy * ex) / det;
		const beta = (ax * dy - ay * dx) / det;
		if (alpha < -1e-9 || beta < -1e-9 || beta > alpha + 1e-9 || alpha > 1 + 1e-9) continue;
		s = alpha;
	}
	if (g.anisotropic) {
		// Independent focus scales: the strip solver gives the ratio (already focus-adjusted). On or outside the
		// boundary its folded strips answer for a copy far inside, and native's answer there is not a whole
		// step (one pixel of the focus-contour captures is black where the strips say half way), so those
		// pixels keep the unquantised ratio.
		const edge = s > 1 - 1e-9;
		const ratio = pathGradientRatio(g.anisotropic, px + nudge, py, { x: px, y: py });
		if (ratio === null) return null;
		if (edge) return Math.max(0, g.steps * (1 - ratio));
		s = ratio;
	}
	if (s < 0) return null;
	const f = g.focus;
	// The copy scale of a pixel at ratio s is s = f + (1 - f)(m + 1/2)/N, so the innermost copy
	// holding it is the smallest m at least q.
	const q = s <= f ? 0 : ((s - f) / (1 - f)) * g.steps - 0.5;
	if (q > 0 && Math.abs(q - Math.round(q)) < (g.anisotropic ? STRIP_TIE : TIE)) {
		// Exactly on copy `round(q)`'s edge: half way between the two steps (see the header).
		return g.steps - Math.round(q) - 0.5;
	}
	const m = Math.max(0, Math.ceil(q));
	// The outermost ring is the boundary itself: a pixel on its right or bottom edge is not painted.
	if (m >= g.steps && !insideCopy(g, 1, px, py)) return null;
	return g.steps - Math.min(m, g.steps);
}
