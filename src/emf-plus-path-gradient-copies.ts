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
 * A pixel exactly on a copy's edge is decided by `tieSide`, from the single-edge captures in
 * `path-gradient-edges.json.gz` (`PathGradientEdgeProbe.cs`: 176,222 of 176,400 pixels of the clockwise
 * sweep are exact, where the half-way colour gave 164,684). It is not a float32 edge test (that fits the
 * 116 ties of the whole-row captures and 40 to 45% of the rectangle ties of `path-gradient-ties.json.gz`):
 * - The ratio of the tie is `(2q + 1) / (2N)`. Native holds the ratio in binary fixed point, and the copy
 *   index is its product with `N` rounded half up, so a ratio that is a binary fraction (the odd part of
 *   `N` divides `2q + 1`) puts the pixel outside copy `q` and any other ratio, truncated, inside it. This is
 *   exact for every pixel that reads the exact coordinate of its edge (an x-major pixel on a vertical edge, a
 *   y-major one on a horizontal edge): none of 38,872 such ties differs.
 * - A pixel that reads the other coordinate goes through its position along the edge. On an edge directed to
 *   the right or straight down the half before the centre's foot is inside unless that position (a fraction
 *   of the copy's edge from its first vertex) is a binary fraction, and the half after it is outside; any
 *   other edge follows the first rule. The winding matters (a counter-clockwise rectangle mirrors a clockwise
 *   one), the first vertex does not, and translation by whole pixels changes nothing. The same holds for 45
 *   degree edges and for the same-axis pixels of other slopes; the other pixels of a slanted edge keep the
 *   colour half way between the two steps, which is within a level of either answer.
 * Left open: about a tenth of the along-the-edge pixels of an edge directed up or left (the decision there follows
 * something finer, and clusters at a copy's vertex rows) and the other pixels of slanted edges.
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

/**
 * Whether a pixel exactly on the edge of copy `q` is inside it (`true`), outside (`false`), or not decided by
 * a measured rule (`null`). See the header.
 */
function tieSide(g: CopiesGradient, edge: number, dx: number, dy: number, q: number): boolean | null {
	const n = g.vx.length;
	const ex = g.vx[(edge + 1) % n] - g.vx[edge];
	const ey = g.vy[(edge + 1) % n] - g.vy[edge];
	if (ex === 0 && ey === 0) return null;
	const adx = Math.abs(dx);
	const ady = Math.abs(dy);
	let odd = g.steps;
	while (odd % 2 === 0) odd /= 2;
	// The ratio (2q + 1) / (2N) of the tie in lowest terms is a binary fraction (exact in fixed point) when the odd part
	// of N divides 2q + 1; native then puts the pixel outside the copy and otherwise inside (the truncated ratio falls short).
	const fractional = (2 * q + 1) % odd !== 0;
	// The axis the edge runs along most and the axis the pixel lies along most from the centre. An axis-aligned edge has
	// one exact coordinate, which a pixel along the other axis reads; on a slanted edge neither coordinate is exact.
	const axisAligned = ex === 0 || ey === 0;
	const alike = axisAligned
		? (ex === 0 ? adx <= ady : ady <= adx)
		: Math.abs(ex) === Math.abs(ey) || (Math.abs(ex) > Math.abs(ey)) === (adx > ady);
	if (!alike) return axisAligned ? fractional : null;
	// Otherwise the ratio goes through the inexact coordinate. An edge directed to the right, or straight down, puts the
	// part of it before the centre's foot inside; any other edge keeps the binary-fraction rule.
	const forward = ex > 0 || (ex === 0 && ey > 0);
	if (!forward) return fractional;
	if (dx * ex + dy * ey < 0) return fractional || !edgeParameterIsBinary(g, edge, dx, dy, q);
	return fractional && adx === ady;
}

function gcd(a: number, b: number): number {
	while (b) [a, b] = [b, a % b];
	return a;
}

/**
 * Whether the pixel's position along the edge of copy `q`, as a fraction of the edge from its first vertex, is a binary
 * fraction (a power-of-two denominator in lowest terms). Native walks that parameter in fixed point: a fraction that
 * is not exact falls short, which puts a tie before the centre's foot inside, and one that is exact leaves it outside.
 */
function edgeParameterIsBinary(g: CopiesGradient, edge: number, dx: number, dy: number, q: number): boolean {
	const n = g.vx.length;
	const k = 16;
	const ex = Math.round((g.vx[(edge + 1) % n] - g.vx[edge]) * k);
	const ey = Math.round((g.vy[(edge + 1) % n] - g.vy[edge]) * k);
	const ax = Math.round((g.vx[edge] - g.cx) * k);
	const ay = Math.round((g.vy[edge] - g.cy) * k);
	// Copy q is the edge scaled by S / D about the centre: u = (P - A S / D) / (E S / D) with P the pixel's and A the
	// first vertex's projection on the edge vector and E its squared length.
	const S = 2 * q + 1;
	const D = 2 * g.steps;
	const P = Math.round(dx * k) * ex + Math.round(dy * k) * ey;
	const A = ax * ex + ay * ey;
	const numerator = P * D - A * S;
	const denominator = (ex * ex + ey * ey) * S;
	if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return false;
	if (numerator === 0) return true;
	let d = Math.abs(denominator / gcd(Math.abs(numerator), Math.abs(denominator)));
	while (d % 2 === 0) d /= 2;
	return d === 1;
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
	let edge = -1;
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
		edge = i;
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
		const tie = Math.round(q);
		const decided = edge >= 0 && !g.anisotropic && f === 0 ? tieSide(g, edge, dx, dy, tie) : null;
		if (decided !== null) return g.steps - tie - (decided ? 0 : 1);
		// Exactly on copy `round(q)`'s edge: half way between the two steps (see the header).
		return g.steps - tie - 0.5;
	}
	const m = Math.max(0, Math.ceil(q));
	// The outermost ring is the boundary itself: a pixel on its right or bottom edge is not painted.
	if (m >= g.steps && !insideCopy(g, 1, px, py)) return null;
	return g.steps - Math.min(m, g.steps);
}
