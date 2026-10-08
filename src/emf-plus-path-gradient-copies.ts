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
 * What decides the pixels exactly on a copy's edge, and all the others, is float32 arithmetic rounded toward minus
 * infinity (`floatCopyIndex`). Native finds the ratio of a pixel by meeting the ray from the centre with the boundary edge
 * of its fan triangle and dividing, and the copy is `floor(N r + 1/2)` in the same arithmetic: a ratio that is a
 * binary fraction stays exact and puts the pixel outside copy `q`, any other ratio falls short and puts it inside, and
 * the rounding of the boundary point moves slanted and along-the-edge pixels either way. This reproduces every pixel of
 * the single-edge captures (`path-gradient-edges.json.gz`: 176,400 of 176,400 of the clockwise sweep, where the earlier
 * binary-fraction rule gave 176,222 and the half-way colour 164,684), of the sheared rectangles and corner triangles
 * (`path-gradient-slopes.json.gz`, `path-gradient-corners.json.gz`: 404,004 of 404,004) and of the tip sweep
 * (`path-gradient-tips.json.gz`). A boundary edge that runs through the centre (the corner triangles) leaves the pixels on
 * it to the boundary's own scan conversion.
 *
 * With an isotropic focus the old rules stay (`tieSide`: the binary-fraction rule for the pixels that read the exact
 * coordinate of an axis-aligned edge, the position along the edge for the others, the half-way colour for the rest). A
 * float32 version (the ray also meets the focus polygon, `t = (d - F) / (b - F)`) reproduces 407 of 420 labelled focus
 * ties and cuts the differing pixels of the focus-tie captures from 903 to 287, but it turns two one-level pixels of
 * alpha control 151 into two-level ones, so it is not shipped (see docs/outstanding-work.md). Independent focus scales (`anisotropicTieStep`): each copy is the
 * boundary scaled per axis about the centre point, so a pixel on a vertical or horizontal edge of it follows the same
 * rules; a pixel on a fully focused axis's edge is a tie of every copy at once and takes the innermost copy whose other
 * extent holds it (the span rule: left and top edges in, right and bottom out); a pixel near an edge but not on it is
 * decided by the scaled boundary's own span rule.
 *
 * @module emf-plus-path-gradient-copies
 */

import { pathGradientRatio } from './emf-plus-brush-gradient';
import { down32 } from './float32-down';
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
	/** A fan triangle (centre, vertex, vertex) has no area: a boundary edge runs through the centre, so a pixel on it is decided by the boundary's scan conversion, not by its copy. */
	degenerate: boolean;
}

/** Rounds to the nearest 1/16 pixel, half up. */
const fix = (v: number): number => Math.floor(v * 16 + 0.5) / 16;
/** A copy index this close to a whole number puts the pixel on that copy's edge. */
const TIE = 1e-6;
/** The strip solver of an anisotropic focus lands within about 0.002 of a step of native's edge, so that close is a tie too. */
const STRIP_TIE = 0.005;
/** Within this many steps of a whole one the scaled copy's own geometry decides which side a pixel not on an edge is (76 of 76 right below 0.0005 in the focus-shape captures, 8 of 626 wrong from there to 0.005). */
const CONTAINMENT_TIE = 0.0005;
/** A pixel this close (in pixels) to a slanted edge of a scaled copy counts as on it (the exact tie of rational scales lands within a few millionths). */
const SLANTED_NEAR = 5e-6;
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
	let degenerate = false;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		if ((vx[i] - cx) * (vy[j] - cy) - (vy[i] - cy) * (vx[j] - cx) === 0) degenerate = true;
	}
	return { cx, cy, vx, vy, steps, focus, anisotropic, degenerate };
}

/**
 * The copy a pixel belongs to, counted from the centre, computed the way native computes it: in float32 with every
 * operation rounded toward minus infinity. The ray from the centre through the pixel meets edge `edge` of the boundary
 * at parameter `u` of the edge, the ratio `r` is the pixel's distance over the boundary point's along the boundary
 * point's larger coordinate (the x coordinate when the two are equal after rounding), and the copy is
 * `floor(N r + 1/2)`. Every pixel exactly on a copy's edge is decided by the rounding of these operations (what the
 * single-edge sweeps found: a ratio that is a binary fraction stays exact and puts the pixel outside the copy, any
 * other ratio falls short and puts it inside, and a boundary point that is not exact moves a slanted or along-the-edge
 * pixel either way). Returns `null` for the centre or a ray parallel to the edge.
 */
function floatCopyIndex(g: CopiesGradient, edge: number, dx: number, dy: number): number | null {
	const n = g.vx.length;
	const ax = g.vx[edge] - g.cx;
	const ay = g.vy[edge] - g.cy;
	const ex = g.vx[(edge + 1) % n] - g.vx[edge];
	const ey = g.vy[(edge + 1) % n] - g.vy[edge];
	const denominator = down32(down32(ex * dy) - down32(ey * dx));
	if (denominator === 0) return null;
	const u = down32(down32(down32(ay * dx) - down32(ax * dy)) / denominator);
	const bx = down32(ax + down32(u * ex));
	const by = down32(ay + down32(u * ey));
	const useX = Math.abs(bx) >= Math.abs(by);
	const boundary = useX ? bx : by;
	if (boundary === 0) return null;
	const r = Math.abs(down32((useX ? dx : dy) / boundary));
	return Math.max(0, Math.floor(down32(down32(g.steps * r) + 0.5)));
}

/**
 * The copy of a pixel under an isotropic focus, computed in float32 the way native does it. Unlike the focus-free
 * ratio (relative to the centre), the focus is applied in ABSOLUTE device coordinates: the boundary point `O` and the
 * point `I` where the ray meets the focus polygon (the boundary scaled by `f` about the centre, its vertices rounded as
 * absolute coordinates) are positions on the pixel grid, and the copy is `floor(N t + 1/2)` with
 * `t = (P - I) / (O - I)` along the larger coordinate of the boundary point. That is what makes a tie fall on one side
 * at the right/bottom of the centre and the other at the left/top for a focus that is not a binary fraction
 * (`path-gradient-focus-thresholds.json.gz`: the focus swept over float32 neighbours of 0.6, 0.3, 0.1, 0.7, 0.2 and
 * 0.4, with the tie threshold depending on the mantissa of the boundary distance). On the axis-aligned edges of a
 * rectangle this reproduces every pixel of the focus-edge captures bar a few dozen. On a slanted edge the
 * larger coordinate of the boundary point is inexact, the chain is right for about 92% of the pixels within float
 * noise of a copy's edge, and the three pixels of alpha control 151 that it puts on the wrong side lie within three
 * ulps of `t` of the edge: those return `null` and keep the measured tie rules (`tieSide`).
 */
function focusCopyIndex(g: CopiesGradient, edge: number, px: number, py: number): number | null {
	const n = g.vx.length;
	const dx = px - g.cx;
	const dy = py - g.cy;
	const f = Math.fround(g.focus);
	const j = (edge + 1) % n;
	const ax = g.vx[edge] - g.cx;
	const ay = g.vy[edge] - g.cy;
	const ex = g.vx[j] - g.vx[edge];
	const ey = g.vy[j] - g.vy[edge];
	const denominator = down32(down32(ex * dy) - down32(ey * dx));
	if (denominator === 0) return null;
	const u = down32(down32(down32(ay * dx) - down32(ax * dy)) / denominator);
	const bx = down32(ax + down32(u * ex));
	const by = down32(ay + down32(u * ey));
	const useX = Math.abs(bx) >= Math.abs(by);
	const b = useX ? bx : by;
	if (b === 0) return null;
	const c = useX ? g.cx : g.cy;
	const p = useX ? px : py;
	const outer = down32(c + b);
	// The focus polygon's vertices in absolute coordinates, and the ray against its edge.
	const scaled = (c0: number, v: number): number => down32(c0 + down32(f * (v - c0)));
	const f0x = scaled(g.cx, g.vx[edge]);
	const f0y = scaled(g.cy, g.vy[edge]);
	const f1x = scaled(g.cx, g.vx[j]);
	const f1y = scaled(g.cy, g.vy[j]);
	const fax = down32(f0x - g.cx);
	const fay = down32(f0y - g.cy);
	const fex = down32(f1x - f0x);
	const fey = down32(f1y - f0y);
	const focusDenominator = down32(down32(fex * dy) - down32(fey * dx));
	if (focusDenominator === 0) return null;
	const fu = down32(down32(down32(fay * dx) - down32(fax * dy)) / focusDenominator);
	const inner = down32((useX ? f0x : f0y) + down32(fu * (useX ? fex : fey)));
	const span = Math.fround(outer - inner);
	if (span === 0) return null;
	const t = down32(Math.fround(p - inner) / span);
	const position = Math.fround(down32(g.steps * t) + 0.5);
	if (ex !== 0 && ey !== 0) {
		// The float noise of the chain: an ulp of each absolute position, as a share of the span, scaled by the step count.
		const ulp = (v: number): number => 2 ** (Math.floor(Math.log2(Math.abs(v) || 1)) - 23);
		const slack = g.steps * (ulp(inner) + ulp(outer)) / Math.abs(span);
		const short = Math.ceil(position) - position;
		if (short > 0 && short <= slack) return null;
	}
	return Math.max(0, Math.floor(position));
}

/**
 * Whether a pixel exactly on the edge of copy `q` is inside it (`true`), outside (`false`), or not decided by
 * a measured rule (`null`). See the header.
 */
function tieSide(g: CopiesGradient, edge: number, dx: number, dy: number, q: number, focus = 0): boolean | null {
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
	// With a focus the noisy edges (those directed up or left, about a tenth of them on the other side) are left undecided
	// unless axis-aligned: one pixel of the 360 colour and alpha controls is two levels off with them.
	if (!forward) return focus > 0 && !axisAligned ? null : fractional;
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
function insideCopy(g: CopiesGradient, scale: number, px: number, py: number, scaleY = scale): boolean {
	const n = g.vx.length;
	let xl = Infinity;
	let xr = -Infinity;
	let ax = g.cx + (g.vx[n - 1] - g.cx) * scale;
	let ay = g.cy + (g.vy[n - 1] - g.cy) * scaleY;
	for (let i = 0; i < n; i++) {
		const bx = g.cx + (g.vx[i] - g.cx) * scale;
		const by = g.cy + (g.vy[i] - g.cy) * scaleY;
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

/** The edge of the boundary scaled by (`scaleX`, `scaleY`) that a pixel lies on, and whether that edge is vertical, horizontal or slanted. */
interface EdgeHit {
	kind: 'vertical' | 'horizontal' | 'slanted';
	edge: number;
}

/**
 * Which edge of the boundary scaled by (`scaleX`, `scaleY`) about the centre pixel (`px`, `py`) lies on, or `null` for none.
 * The row of a vertex counts as a slanted edge: the scan converter's vertex handling, not the span rule, decides it.
 */
function edgeAt(g: CopiesGradient, scaleX: number, scaleY: number, px: number, py: number): EdgeHit | null {
	const n = g.vx.length;
	const near = 1e-6;
	let hit: EdgeHit | null = null;
	let vertexRow = false;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const ax = g.cx + (g.vx[i] - g.cx) * scaleX;
		const ay = g.cy + (g.vy[i] - g.cy) * scaleY;
		const bx = g.cx + (g.vx[j] - g.cx) * scaleX;
		const by = g.cy + (g.vy[j] - g.cy) * scaleY;
		if (Math.abs(ax - bx) < near && Math.abs(px - ax) < near && py >= Math.min(ay, by) - near && py <= Math.max(ay, by) + near) return { kind: 'vertical', edge: i };
		if (Math.abs(ay - by) < near && Math.abs(py - ay) < near && px >= Math.min(ax, bx) - near && px <= Math.max(ax, bx) + near) return { kind: 'horizontal', edge: i };
		if (Math.abs(ay - py) < near) vertexRow = true;
		const length = Math.hypot(bx - ax, by - ay);
		if (length < near) continue;
		const across = ((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / length;
		const along = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / (length * length);
		if (Math.abs(across) < SLANTED_NEAR && along >= -near && along <= 1 + near) hit = { kind: 'slanted', edge: i };
	}
	return hit ?? (vertexRow ? { kind: 'slanted', edge: -1 } : null);
}

/**
 * A pixel on a vertical (horizontal) edge of the boundary whose axis has focus scale 1: every copy shares that edge, so
 * the pixel is a tie of every copy at once and takes the innermost copy whose other extent holds it, the span rule
 * deciding the edge itself (`undefined` for any other pixel).
 */
function focusedEdgeStep(g: CopiesGradient, px: number, py: number): number | null | undefined {
	const focus = g.anisotropic!.focus!;
	const full = 1 - 1e-9;
	if (focus.x < full && focus.y < full) return undefined;
	const n = g.vx.length;
	let onEdge = false;
	for (let i = 0; i < n && !onEdge; i++) {
		const j = (i + 1) % n;
		const near = 1e-6;
		if (focus.x >= full && Math.abs(g.vx[i] - g.vx[j]) < near && Math.abs(px - g.vx[i]) < near && py >= Math.min(g.vy[i], g.vy[j]) - near && py <= Math.max(g.vy[i], g.vy[j]) + near) onEdge = true;
		if (focus.y >= full && Math.abs(g.vy[i] - g.vy[j]) < near && Math.abs(py - g.vy[i]) < near && px >= Math.min(g.vx[i], g.vx[j]) - near && px <= Math.max(g.vx[i], g.vx[j]) + near) onEdge = true;
	}
	if (!onEdge) return undefined;
	const fx = Math.min(1, Math.max(0, focus.x));
	const fy = Math.min(1, Math.max(0, focus.y));
	for (let m = 0; m <= g.steps; m++) {
		const along = m === g.steps ? 1 : (m + 0.5) / g.steps;
		if (insideCopy(g, fx + (1 - fx) * along, px, py, fy + (1 - fy) * along)) return g.steps - m;
	}
	return null;
}

/**
 * The step of a pixel at ratio `q` (a copy index) within a tie of copy `tie` when the focus scales differ per axis. Copy
 * `tie` is the boundary scaled per axis about the centre. A pixel that lies on a vertical or horizontal edge of it reads
 * the same rules as the uniform copies: the binary-fraction rule when it reads the exact coordinate of its edge, and along
 * the edge an edge directed right or straight down is inside before the centre's foot unless the position along it is a
 * binary fraction (the pixel then takes the span rule's side if the edge is directed the other way). A pixel on a slanted
 * edge is a coin flip and keeps the half-way colour; one only near an edge (the strip solver is good to a few thousandths of
 * a step) is inside when the scaled boundary holds it.
 */
function anisotropicTieStep(g: CopiesGradient, q: number, tie: number, dx: number, dy: number, px: number, py: number): number {
	const focus = g.anisotropic!.focus!;
	const along = (tie + 0.5) / g.steps;
	const fx = Math.min(1, Math.max(0, focus.x));
	const fy = Math.min(1, Math.max(0, focus.y));
	const scaleX = fx + (1 - fx) * along;
	const scaleY = fy + (1 - fy) * along;
	const hit = edgeAt(g, scaleX, scaleY, px, py);
	const half = g.steps - tie - 0.5;
	if (hit?.kind === 'slanted') return half;
	if (hit === null && Math.abs(q - tie) >= CONTAINMENT_TIE) return half;
	if (hit === null) return g.steps - tie - (insideCopy(g, scaleX, px, py, scaleY) ? 0 : 1);
	let odd = g.steps;
	while (odd % 2 === 0) odd /= 2;
	const fractional = (2 * tie + 1) % odd !== 0;
	const vertical = hit.kind === 'vertical';
	if (vertical ? Math.abs(dx) > Math.abs(dy) : Math.abs(dy) > Math.abs(dx)) return g.steps - tie - (fractional ? 0 : 1);
	const n = g.vx.length;
	const ex = g.vx[(hit.edge + 1) % n] - g.vx[hit.edge];
	const ey = g.vy[(hit.edge + 1) % n] - g.vy[hit.edge];
	if (!(ex > 0 || (ex === 0 && ey > 0))) return g.steps - tie - (fractional ? 0 : 1);
	if (dx * ex + dy * ey >= 0) return g.steps - tie - (fractional && Math.abs(dx) === Math.abs(dy) ? 0 : 1);
	const ax = g.cx + (g.vx[hit.edge] - g.cx) * scaleX;
	const ay = g.cy + (g.vy[hit.edge] - g.cy) * scaleY;
	const u = vertical ? (py - ay) / (ey * scaleY) : (px - ax) / (ex * scaleX);
	const scaled = u * 2 ** 24;
	const binary = Math.abs(scaled - Math.round(scaled)) < 1e-4;
	return g.steps - tie - (fractional || !binary ? 0 : 1);
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
		const column = focusedEdgeStep(g, px, py);
		if (column !== undefined) return column;
		const ratio = pathGradientRatio(g.anisotropic, px + nudge, py, { x: px, y: py });
		if (ratio === null) return null;
		if (edge) return Math.max(0, g.steps * (1 - ratio));
		s = ratio;
	}
	if (s < 0) return null;
	if (g.degenerate && !insideCopy(g, 1, px, py)) return null;
	if (!g.anisotropic && g.focus === 0 && edge >= 0) {
		const m = floatCopyIndex(g, edge, dx, dy);
		if (m !== null) {
			// The outermost ring is the boundary itself: a pixel on its right or bottom edge is not painted.
			if (m >= g.steps && !insideCopy(g, 1, px, py)) return null;
			return g.steps - Math.min(m, g.steps);
		}
	}
	if (!g.anisotropic && g.focus > 0 && g.focus < 1 && edge >= 0 && !(px === g.cx && py === g.cy)) {
		const m = focusCopyIndex(g, edge, px, py);
		if (m !== null) {
			if (m >= g.steps && !insideCopy(g, 1, px, py)) return null;
			return g.steps - Math.min(m, g.steps);
		}
	}
	const f = g.focus;
	// The copy scale of a pixel at ratio s is s = f + (1 - f)(m + 1/2)/N, so the innermost copy
	// holding it is the smallest m at least q.
	const q = s <= f ? 0 : ((s - f) / (1 - f)) * g.steps - 0.5;
	if (q > 0 && Math.abs(q - Math.round(q)) < (g.anisotropic ? STRIP_TIE : TIE)) {
		const tie = Math.round(q);
		if (g.anisotropic) return anisotropicTieStep(g, q, tie, dx, dy, px, py);
		const decided = edge >= 0 ? tieSide(g, edge, dx, dy, tie, f) : null;
		if (decided !== null) return g.steps - tie - (decided ? 0 : 1);
		// Exactly on copy `round(q)`'s edge: half way between the two steps (see the header).
		return g.steps - tie - 0.5;
	}
	const m = Math.max(0, Math.ceil(q));
	// The outermost ring is the boundary itself: a pixel on its right or bottom edge is not painted.
	if (m >= g.steps && !insideCopy(g, 1, px, py)) return null;
	return g.steps - Math.min(m, g.steps);
}
