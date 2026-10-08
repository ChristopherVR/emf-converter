/**
 * Renders parsed EMF+ gradient brushes (MS-EMFPLUS LinearGradientBrushData /
 * PathGradientBrushData) to Canvas 2D paint styles, the way GDI+ paints them.
 *
 * GDI+ defines both brushes in their own "brush space", mapped to world space
 * by the brush transform (which is also where GDI+ encodes a linear
 * gradient's angle, usually as a shear rather than a rotation):
 *
 * - A linear gradient varies along the x axis of its rectangle only. Its
 *   WrapMode repeats that rectangle as a tile (TileFlipX mirrors alternate
 *   columns; TileFlipY mirrors rows, which a horizontal ramp cannot show).
 * - A path gradient interpolates, along each ray from its centre point, from
 *   the boundary polygon's surround colours to the centre colour, shaped by
 *   the boundary itself (not a circle). Clamp paints the boundary and
 *   independently scaled focus contours; the tile modes repeat the boundary's
 *   bounding box. GDI+ draws it as nested copies of the boundary, so the ratio
 *   is rounded to one of `pathGradientQuantum` steps (see there).
 *
 * Both are rasterised once into a brush-space tile at device resolution and
 * installed as a `CanvasPattern` whose matrix is the full brush transform,
 * so any angle, shear or scale is exact up to bilinear sampling. The pattern
 * is also offset by half a device pixel: GDI+ (PixelOffsetMode None) samples
 * a pixel at its integer coordinate, Canvas at its centre.
 *
 * For a path gradient that pattern is now the FALLBACK paint only: every
 * tested canvas backend filters a `CanvasPattern` even at an identity
 * matrix, which left a residual at tile seams, so shape fills go through
 * the exact per-device-pixel path in `emf-plus-exact-fill.ts` (built on
 * {@link pathGradientColorAt}). Linear gradients stay a plain
 * `CanvasGradient`, which is already exact.
 *
 * @module emf-plus-brush-gradient
 */

import {
	canvasCreatePattern,
	canvasPutImageData,
	createImageDataCompat,
	createTempCanvas,
} from './emf-canvas-helpers';
import { down32 } from './float32-down';
import { emfLog } from './emf-logging';
import { buildLinearRampTable, linearRampOf, linearRampStops } from './emf-plus-linear-ramp';
import type {
	CanvasContext,
	EmfPlusGradient,
	EmfPlusGradientStop,
	EmfPlusGradientWrapMode,
	EmfPlusLinearGradient,
	EmfPlusPathGradientShape,
	EmfPlusRadialGradient,
	EmfPlusRectF,
	TransformMatrix,
} from './emf-types';

// ---------------------------------------------------------------------------
// Affine helpers
// ---------------------------------------------------------------------------

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

/** `a · b`: apply `b` first, then `a`. */
export function mulMatrix(a: TransformMatrix, b: TransformMatrix): TransformMatrix {
	return [
		a[0] * b[0] + a[2] * b[1],
		a[1] * b[0] + a[3] * b[1],
		a[0] * b[2] + a[2] * b[3],
		a[1] * b[2] + a[3] * b[3],
		a[0] * b[4] + a[2] * b[5] + a[4],
		a[1] * b[4] + a[3] * b[5] + a[5],
	];
}

function invertLinear(m: TransformMatrix): [number, number, number, number] | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return null;
	}
	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/** Packed ARGB linear interpolation. */
function lerpArgb(a: number, b: number, t: number): number {
	const ch = (shift: number): number => {
		const ca = (a >>> shift) & 0xff;
		const cb = (b >>> shift) & 0xff;
		return Math.round(ca + (cb - ca) * t);
	};
	return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/** Native uniform-surround path gradients interpolate premultiplied channels. */
function lerpUniformPathArgb(a: number, b: number, t: number): number {
	const aa = (a >>> 24) & 0xff;
	const ab = (b >>> 24) & 0xff;
	if (aa === ab) return lerpArgb(a, b, t);
	const alpha = Math.round(aa + (ab - aa) * t);
	if (alpha === 0) return 0;
	const ch = (shift: number): number => {
		const ca = ((a >>> shift) & 0xff) * aa / 255;
		const cb = ((b >>> shift) & 0xff) * ab / 255;
		// Rounded alpha can be smaller than its floating value. Clamp before
		// packing so a saturated channel cannot overflow into its neighbour.
		return Math.min(255, Math.max(0, Math.round((ca + (cb - ca) * t) * 255 / alpha)));
	};
	return ((alpha << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/**
 * Number of distance steps GDI+ quantises a path gradient's centre-to-boundary
 * ratio into: `ceil(|M(w, h)| + |M(w, -h)|)` for the `w` x `h` bounding box
 * of the boundary in brush space and the linear part `M` of the brush-to-device
 * matrix, that is the sum of the two device-space diagonals of the bounds. With
 * no rotation or shear both diagonals are `hypot(w sx, h sy)`, so this is
 * `ceil(2 * hypot(w, h))` for the device-space size `w` x `h` (`4 * L` rounded
 * up for the half diagonal `L`, so the ratio moves in quarter-pixel steps along
 * the longest possible ray). Measured on rectangle path gradients of every size
 * (a row through the centre is `round(255 * k / N)` for the step count `k`); the
 * same count reproduces triangles and ellipses, a 2x world or brush scale
 * doubles it, and a rotation leaves it alone (the diagonals keep their length;
 * the device bounding box of the rotated shape would grow it, which native does
 * not do). Under shear the two diagonals differ and their sum is the count that
 * scores best against every one of the 70 rotated, scaled and sheared captures
 * (no other count within 12 steps of it does).
 *
 * `matrix` maps the boundary's brush space to device pixels.
 */
export function pathGradientQuantum(
	boundary: ReadonlyArray<{ x: number; y: number }>,
	matrix: TransformMatrix = IDENTITY,
): number {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of boundary) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x);
		y1 = Math.max(y1, p.y);
	}
	const w = x1 - x0;
	const h = y1 - y0;
	const first = Math.hypot(matrix[0] * w + matrix[2] * h, matrix[1] * w + matrix[3] * h);
	const second = Math.hypot(matrix[0] * w - matrix[2] * h, matrix[1] * w - matrix[3] * h);
	const steps = Math.ceil(first + second);
	return Number.isFinite(steps) && steps > 0 ? steps : 0;
}

/** A level within this of an exact half counts as a tie (float noise of the colour arithmetic). */
const TIE_LEVEL = 1e-9;

/** A ratio within this of an exact half step counts as a tie (float noise of the geometry). */
const TIE_EPSILON = 1e-7;

/**
 * The ratio of brush-space point (`x`, `y`) (0 at the centre or inside the focus, 1 on the boundary,
 * the focus scales applied, a folded focus strip included), or `null` outside the boundary.
 */
export function pathGradientRatio(
	shape: EmfPlusPathGradientShape,
	x: number,
	y: number,
	// A coverage nudge may move `x`; the focus lines are still read at this location.
	focusPoint?: { x: number; y: number },
): number | null {
	const report = { s: NaN };
	return pathGradientColorAt(shape, x, y, focusPoint, 0, report) === null ? null : report.s;
}

/**
 * The path-gradient colour at share `t` of the centre colour (0 boundary,
 * 1 centre) once GDI+ has quantised the ratio into `quantum` steps.
 *
 * GDI+ paints a path gradient as `quantum` nested copies of the boundary,
 * each a step smaller and a step closer to the centre colour, so a pixel
 * takes the colour of the innermost copy that holds it and the ratio rounds
 * to a whole step. The ramp is accumulated from the centre colour in float32
 * (see {@link centreWeight}); the premultiplied channels and alpha are
 * interpolated together and rounded to nearest, a tie toward the centre colour.
 *
 * A ratio exactly half way between two steps lies on a copy's edge, and which
 * side native paints it depends on that edge's float arithmetic (the same
 * geometry traversed in the opposite vertex order flips about half of them), so
 * the tie keeps the unquantised ratio, which is within a level of either answer.
 */
function quantisedPathArgb(surround: number, centre: number, t: number, quantum: number): number {
	const scaled = t * quantum;
	const tie = Math.abs(scaled - Math.floor(scaled) - 0.5) < TIE_EPSILON;
	return quantisedStepArgb(surround, centre, tie ? scaled : Math.floor(scaled + 0.5), quantum, t < 0.5);
}

/** Rounds `v` to the nearest level, a tie (within `TIE_LEVEL`) toward `target`. */
function roundTowards(v: number, target: number): number {
	const floor = Math.floor(v);
	const fraction = v - floor;
	if (Math.abs(fraction - 0.5) < TIE_LEVEL) return target > v ? floor + 1 : floor;
	return fraction > 0.5 ? floor + 1 : floor;
}

const centreWeightTables = new Map<number, Float64Array>();

/**
 * The position of ring j counted from the centre colour (0 at the centre, just under 1 at the boundary) of
 * `quantum` rings. Native builds the ramp by accumulation: the step 1 / quantum and the running sum are
 * float32 rounded toward minus infinity, so the position falls a little short of j / quantum (about
 * 6e-6 levels per ring, 0.007 levels at the boundary of a 1,000-ring gradient). That shortfall is why a
 * value exactly half way between two levels rounds toward the centre colour, and why 24 steps of the large
 * captures, 0.0005 to 0.009 of a level under a half, round up.
 */
function centreWeight(quantum: number, j: number): number {
	let table = centreWeightTables.get(quantum);
	if (!table) {
		table = new Float64Array(quantum + 1);
		const step = down32(1 / quantum);
		let w = 0;
		for (let i = 1; i <= quantum; i++) {
			w = down32(w + step);
			table[i] = w;
		}
		if (centreWeightTables.size > 64) centreWeightTables.clear();
		centreWeightTables.set(quantum, table);
	}
	return table[j];
}

/** The colour of whole step k of quantum rings, interpolated from the centre colour by {@link centreWeight}. */
function centreWeightArgb(surround: number, centre: number, k: number, quantum: number): number {
	const w = centreWeight(quantum, quantum - k);
	const aS = (surround >>> 24) & 0xff;
	const aC = (centre >>> 24) & 0xff;
	const level = (s: number, c: number): number => roundTowards(c + (s - c) * w, c);
	const alpha = level(aS, aC);
	if (alpha <= 0) return 0;
	const ch = (shift: number): number => {
		const p = level(((surround >>> shift) & 0xff) * aS / 255, ((centre >>> shift) & 0xff) * aC / 255);
		return Math.min(255, Math.max(0, Math.round(p * 255 / alpha)));
	};
	return ((alpha << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/** The colour of step `k` of `quantum` (0 the boundary colour, `quantum` the centre colour); see {@link quantisedPathArgb}. */
function quantisedStepArgb(surround: number, centre: number, k: number, quantum: number, fromBoundary: boolean): number {
	if (Number.isInteger(k)) return centreWeightArgb(surround, centre, k, quantum);
	const w = (fromBoundary ? k : quantum - k) / quantum;
	const aS = (surround >>> 24) & 0xff;
	const aC = (centre >>> 24) & 0xff;
	const mix = (s: number, c: number): number => (fromBoundary ? s + (c - s) * w : c + (s - c) * w);
	// A value exactly half way between two levels rounds toward the centre colour (a fractional step, the
	// half-way colour of a pixel on a copy's edge, keeps plain rounding).
	const whole = Number.isInteger(k);
	const level = (s: number, c: number): number => (whole ? roundTowards(mix(s, c), c) : Math.floor(mix(s, c) + 0.5));
	const alpha = level(aS, aC);
	if (alpha <= 0) return 0;
	const ch = (shift: number): number => {
		const p = level(((surround >>> shift) & 0xff) * aS / 255, ((centre >>> shift) & 0xff) * aC / 255);
		return Math.min(255, Math.max(0, Math.round(p * 255 / alpha)));
	};
	return ((alpha << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}

/**
 * The position (0 boundary, 1 centre) once rounded to a whole step of `quantum`
 * (see {@link quantisedPathArgb}); a Blend or InterpolationColors curve is read at
 * this position, so a custom curve steps exactly as the plain ramp does. An exact
 * half step keeps its unquantised position.
 */
function quantisedPosition(pos: number, quantum: number): number {
	const scaled = pos * quantum;
	const tie = Math.abs(scaled - Math.floor(scaled) - 0.5) < TIE_EPSILON;
	return (tie ? scaled : Math.floor(scaled + 0.5)) / quantum;
}

/**
 * The colour of step `k` (0 the boundary, `quantum` the centre) of a uniform path gradient, the
 * way {@link pathGradientColorAt} colours a pixel whose step it has rounded: the preset curve and
 * the Blend curve are read at `k / quantum`, and the plain ramp rounds from whichever end is nearer.
 */
export function pathGradientStepColor(shape: EmfPlusPathGradientShape, k: number, quantum: number): number {
	const pos = k / quantum;
	if (shape.preset && shape.preset.positions.length > 0) {
		const { positions, argb } = shape.preset;
		if (pos <= positions[0]) return argb[0];
		for (let i = 1; i < positions.length; i++) {
			if (pos <= positions[i]) {
				const span = positions[i] - positions[i - 1];
				return lerpArgb(argb[i - 1], argb[i], span > 0 ? (pos - positions[i - 1]) / span : 1);
			}
		}
		return argb[positions.length - 1];
	}
	const surround = shape.boundaryArgb[0] ?? shape.centerArgb;
	if (!shape.blend) return quantisedStepArgb(surround, shape.centerArgb, k, quantum, k * 2 < quantum);
	const t = Math.min(1, Math.max(0, piecewise(shape.blend.positions, shape.blend.factors, pos)));
	return (surround >>> 24) !== (shape.centerArgb >>> 24) ? lerpUniformPathArgb(surround, shape.centerArgb, t) : lerpArgb(surround, shape.centerArgb, t);
}

/** Piecewise-linear lookup of `ys` at `x` over ascending `xs` (clamped at both ends). */
function piecewise(xs: readonly number[], ys: readonly number[], x: number): number {
	const n = Math.min(xs.length, ys.length);
	if (n === 0) {
		return x;
	}
	if (x <= xs[0]) {
		return ys[0];
	}
	for (let i = 1; i < n; i++) {
		if (x <= xs[i]) {
			const span = xs[i] - xs[i - 1];
			const f = span > 0 ? (x - xs[i - 1]) / span : 1;
			return ys[i - 1] + (ys[i] - ys[i - 1]) * f;
		}
	}
	return ys[n - 1];
}

/** Colour of a stop list at `t` (0..1), or null when a stop lacks packed ARGB. */
export function stopColorAt(stops: readonly EmfPlusGradientStop[], t: number): number | null {
	if (stops.length === 0 || stops.some((s) => s.argb === undefined)) {
		return null;
	}
	if (t <= stops[0].offset) {
		return stops[0].argb as number;
	}
	for (let i = 1; i < stops.length; i++) {
		const b = stops[i];
		if (t <= b.offset) {
			const a = stops[i - 1];
			const span = b.offset - a.offset;
			return lerpArgb(a.argb as number, b.argb as number, span > 0 ? (t - a.offset) / span : 1);
		}
	}
	return stops[stops.length - 1].argb as number;
}

// ---------------------------------------------------------------------------
// Path-gradient colour (pure)
// ---------------------------------------------------------------------------

/**
 * The GDI+ path-gradient colour at brush-space point (`x`, `y`), or `null`
 * outside the boundary. The boundary is fanned into triangles
 * (centre, v[i], v[i+1]); inside one, the point sits at fraction `s` of the
 * way from the centre to the boundary (0 = centre, 1 = boundary) and at
 * parameter `u` along the edge. The surround colour interpolates along the
 * edge by `u`, then blends toward the centre colour by the blend curve at
 * position `1 - s` (GDI+ blend positions run boundary 0 to centre 1).
 */
export function pathGradientColorAt(
	shape: EmfPlusPathGradientShape,
	x: number,
	y: number,
	// Scanline coverage may nudge x, but a collapsed focus line keeps the
	// original sample location. Direct callers already supply that location.
	focusPoint?: { x: number; y: number },
	// Distance steps GDI+ quantises the ratio into (see pathGradientQuantum).
	quantum?: number,
	// Receives the ratio (0 at the centre or inside the focus, 1 on the boundary) the colour is read at.
	report?: { s: number },
): number | null {
	const { center, boundary, boundaryArgb } = shape;
	const n = boundary.length;
	const px = x - center.x;
	const py = y - center.y;
	const ux = (focusPoint?.x ?? x) - center.x;
	const uy = (focusPoint?.y ?? y) - center.y;
	let found = -1;
	let bestS = 0;
	let bestU = 0;
	const eps = 1e-9;
	for (let i = 0; i < n; i++) {
		const v0 = boundary[i];
		const v1 = boundary[(i + 1) % n];
		const ax = v0.x - center.x;
		const ay = v0.y - center.y;
		const ex = v1.x - v0.x;
		const ey = v1.y - v0.y;
		const det = ax * ey - ay * ex;
		if (Math.abs(det) < 1e-12) {
			continue;
		}
		const alpha = (px * ey - py * ex) / det;
		const beta = (ax * py - ay * px) / det;
		if (alpha < -eps || beta < -eps || beta > alpha + eps || alpha > 1 + eps) {
			continue;
		}
		// Later triangles paint over earlier ones, as GDI+ fills them in order.
		found = i;
		// The quantised ratio is taken at the unnudged sample location.
		const alphaU = quantum ? (ux * ey - uy * ex) / det : alpha;
		const betaU = quantum ? (ax * uy - ay * ux) / det : beta;
		bestS = Math.max(0, alphaU);
		bestU = alphaU > 0 ? Math.min(1, Math.max(0, betaU / alphaU)) : 0;
	}
	let s = found < 0 ? Infinity : bestS;
	if (shape.focus) {
		// The constant-colour focus boundary is scaled independently along
		// x/y. Its contours expand to the outer boundary by interpolating
		// those scales; a radial intersection is only equivalent when fx=fy.
		const fx = Math.min(1, Math.max(0, shape.focus.x));
		const fy = Math.min(1, Math.max(0, shape.focus.y));
		if (fx === fy) {
			s = s <= fx ? 0 : (s - fx) / (1 - fx);
		} else if (s > 0) {
			const dx = 1 - fx;
			const dy = 1 - fy;
			let distance = Infinity;
			let inFocus = false;
			for (let i = 0; i < n; i++) {
				const a = boundary[i];
				const b = boundary[(i + 1) % n];
				const ax = a.x - center.x;
				const ay = a.y - center.y;
				const ex = b.x - a.x;
				const ey = b.y - a.y;
				const cross = ax * ey - ay * ex;
				if (Math.abs(cross) < 1e-12) continue;
				// At zero x focus, the strip extending right from the focus line
				// includes that line. A scanline's coverage nudge must not move it
				// out of the constant-colour focus region.
				if (fx === 0 && fy > 0 && Math.abs((focusPoint?.x ?? x) - center.x) < eps &&
					ex > 0 && Math.max(ax, ax + ex) > 0 && Math.abs(ey) > eps) {
					const u = (((focusPoint?.y ?? y) - center.y) / fy - ay) / ey;
					if (u >= -eps && u <= 1 + eps) inFocus = true;
				}
				if ((fx > 0 || Math.abs(px) < eps) && (fy > 0 || Math.abs(py) < eps)) {
					const x = fx > 0 ? px / fx : 0;
					const y = fy > 0 ? py / fy : 0;
					const alpha = (x * ey - y * ex) / cross;
					const beta = (ax * y - ay * x) / cross;
					if (alpha >= -eps && alpha <= 1 + eps && beta >= -eps && beta <= alpha + eps) {
						inFocus = true;
						if (found < 0) found = i;
					}
				}
				// cross(P / scale(t), edge) = cross(vertex, edge).
				const qa = cross * dx * dy;
				const qb = cross * (fx * dy + fy * dx) - px * ey * dy + py * ex * dx;
				const qc = cross * fx * fy - px * ey * fy + py * ex * fx;
				const disc = qb * qb - 4 * qa * qc;
				const roots = Math.abs(qa) < 1e-12 ? (Math.abs(qb) > 1e-12 ? [-qc / qb] : [])
					: disc >= 0 ? [(-qb - Math.sqrt(disc)) / (2 * qa), (-qb + Math.sqrt(disc)) / (2 * qa)] : [];
				let hits = 0;
				let hitT = 0;
				let hitU = 0;
				for (const t of roots) {
					if (t < -eps || t > 1 + eps) continue;
					const sx = fx + dx * t;
					const sy = fy + dy * t;
					// A collapsed horizontal focus edge belongs to the expanding strip
					// below this scanline; strips wholly above it do not cover it.
					if (sy === 0 && sx > 0 && Math.abs(py) < eps && ey > 0 && Math.max(ay, ay + ey) > 0 && Math.abs(ex) > eps) {
						const u = (px / sx - ax) / ex;
						if (u >= -eps && u <= 1 + eps) {
							hits = 1;
							hitT = 0;
							hitU = Math.min(1, Math.max(0, u));
							break;
						}
					}
					if (sx <= 0 || sy <= 0) continue;
					const u = Math.abs(ex) > Math.abs(ey) ? (px / sx - ax) / ex : (py / sy - ay) / ey;
					if (u >= -eps && u <= 1 + eps) {
						hits++;
						hitT = Math.max(0, t);
						hitU = Math.min(1, Math.max(0, u));
					}
				}
				// Folded strips use odd coverage: two intersections cancel.
				// Later boundary strips paint over earlier ones.
				if (hits === 1) {
					distance = hitT;
					found = i;
					bestU = hitU;
				}
			}
			s = inFocus ? 0 : Number.isFinite(distance) ? distance : s;
		}
	}
	if (found < 0 || !Number.isFinite(s)) return null;
	if (report) report.s = s;
	const exactPos = 1 - s;
	const pos = quantum && quantum > 0 ? quantisedPosition(exactPos, quantum) : exactPos;
	if (shape.preset && shape.preset.positions.length > 0) {
		const { positions, argb } = shape.preset;
		if (pos <= positions[0]) {
			return argb[0];
		}
		for (let k = 1; k < positions.length; k++) {
			if (pos <= positions[k]) {
				const span = positions[k] - positions[k - 1];
				return lerpArgb(argb[k - 1], argb[k], span > 0 ? (pos - positions[k - 1]) / span : 1);
			}
		}
		return argb[positions.length - 1];
	}
	const c0 = boundaryArgb[found] ?? shape.centerArgb;
	const c1 = boundaryArgb[(found + 1) % n] ?? c0;
	const surround = lerpArgb(c0, c1, bestU);
	const factor = shape.blend ? piecewise(shape.blend.positions, shape.blend.factors, pos) : pos;
	const t = Math.min(1, Math.max(0, factor));
	if (quantum && quantum > 0 && !shape.blend && boundaryArgb.every((color) => color === boundaryArgb[0])) {
		return quantisedPathArgb(surround, shape.centerArgb, Math.min(1, Math.max(0, exactPos)), quantum);
	}
	// Independent native alpha captures confirm the uniform-surround path.
	// Varying surrounds follow a different, still unmodelled interpolation.
	return (surround >>> 24) !== (shape.centerArgb >>> 24) && boundaryArgb.every((color) => color === boundaryArgb[0])
		? lerpUniformPathArgb(surround, shape.centerArgb, t)
		: lerpArgb(surround, shape.centerArgb, t);
}

// ---------------------------------------------------------------------------
// Tile rasterisation
// ---------------------------------------------------------------------------

/** Cap on a tile's texel count per axis. */
const MAX_TILE = 2048;

function mirrorFlags(wrap: EmfPlusGradientWrapMode): { x: boolean; y: boolean } {
	return {
		x: wrap === 'tile-flip-x' || wrap === 'tile-flip-xy',
		y: wrap === 'tile-flip-y' || wrap === 'tile-flip-xy',
	};
}

/** How a tile's texels sample the brush (see {@link buildPattern}). */
export interface TileSampling {
	/**
	 * Extra texel offset along x at which texels sample. 0.5 samples each
	 * texel at its right edge, so a point exactly on a period boundary reads
	 * the END of the period, as GDI+ does for a tiled linear gradient.
	 */
	phaseX: number;
	/**
	 * Brush-space lag of a mirrored tile. GDI+ mirrors a path gradient's
	 * rasterised tile texel-for-texel, so the mirrored copy is offset by one
	 * device pixel from a mathematical mirror; linear gradients mirror exactly.
	 */
	lagX: number;
	lagY: number;
}

/**
 * Builds a `CanvasPattern` from a tile of `tw` x `th` texels covering the
 * brush-space rectangle `rect`, with texel colours from `colorAt` (packed
 * ARGB, or null for transparent), mirrored per `wrap`, and mapped to user
 * space through `brush` plus the GDI+ half-pixel offset `delta`.
 */
export function buildPattern(
	ctx: CanvasContext,
	rect: EmfPlusRectF,
	tw: number,
	th: number,
	wrap: EmfPlusGradientWrapMode,
	brush: TransformMatrix,
	delta: { x: number; y: number },
	sampling: TileSampling,
	colorAt: (bx: number, by: number) => number | null,
): CanvasPattern | null {
	if (typeof ctx.createPattern !== 'function') {
		return null;
	}
	const mirror = wrap === 'clamp' ? { x: false, y: false } : mirrorFlags(wrap);
	const w = tw * (mirror.x ? 2 : 1);
	const h = th * (mirror.y ? 2 : 1);
	const temp = createTempCanvas(w, h);
	if (!temp) {
		return null;
	}
	const stepX = rect.w / tw;
	const stepY = rect.h / th;
	// Brush-space offset (from the tile origin) that texel `i` / row `j` samples.
	const offX = (i: number): number => {
		const d = (i % tw) * stepX + (0.5 + sampling.phaseX) * stepX;
		return i < tw ? d : rect.w - sampling.lagX - (d - (0.5 + sampling.phaseX) * stepX) - 0.5 * stepX;
	};
	const offY = (j: number): number => {
		const d = ((j % th) + 0.5) * stepY;
		return j < th ? d : rect.h - sampling.lagY - d;
	};
	const data = new Uint8ClampedArray(w * h * 4);
	for (let j = 0; j < h; j++) {
		const by = rect.y + offY(j);
		for (let i = 0; i < w; i++) {
			const c = colorAt(rect.x + offX(i), by);
			if (c === null) {
				continue;
			}
			const o = (j * w + i) * 4;
			data[o] = (c >>> 16) & 0xff;
			data[o + 1] = (c >>> 8) & 0xff;
			data[o + 2] = c & 0xff;
			data[o + 3] = (c >>> 24) & 0xff;
		}
	}
	canvasPutImageData(temp.ctx, createImageDataCompat(data, w, h), 0, 0);
	const pattern = canvasCreatePattern(ctx, temp.canvas, wrap === 'clamp' ? 'no-repeat' : 'repeat');
	if (!pattern || typeof pattern.setTransform !== 'function') {
		return null;
	}
	const place: TransformMatrix = [stepX, 0, 0, stepY, rect.x + sampling.phaseX * stepX, rect.y];
	const m = mulMatrix([1, 0, 0, 1, delta.x, delta.y], mulMatrix(brush, place));
	try {
		pattern.setTransform({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
	} catch {
		emfLog('buildPattern: pattern.setTransform rejected');
		return null;
	}
	return pattern;
}

/**
 * World-space offset equivalent to half a device pixel, so a canvas pixel
 * centre samples the brush where GDI+ would (at the pixel's integer origin).
 */
export function halfPixelDelta(device: TransformMatrix): { x: number; y: number } {
	const inv = invertLinear(device);
	if (!inv) {
		return { x: 0, y: 0 };
	}
	return { x: inv[0] * 0.5 + inv[2] * 0.5, y: inv[1] * 0.5 + inv[3] * 0.5 };
}

/**
 * Texels per device pixel. Supersampling keeps bilinear pattern filtering
 * from smearing a tile seam (a hard edge in GDI+) across a whole pixel.
 */
const SUPERSAMPLE = 4;

/** Texels needed along a brush axis for {@link SUPERSAMPLE} texels per device pixel. */
function texelsFor(full: TransformMatrix, axis: 'x' | 'y', length: number): number {
	const scale = axis === 'x' ? Math.hypot(full[0], full[1]) : Math.hypot(full[2], full[3]);
	return Math.max(2, Math.min(MAX_TILE, Math.ceil(Math.abs(length) * scale * SUPERSAMPLE)));
}

// ---------------------------------------------------------------------------
// Linear gradients
// ---------------------------------------------------------------------------

/**
 * Pure: world-space endpoints of a plain `CanvasGradient` reproducing a
 * linear brush over one period, for any affine brush transform. Isolines are
 * the images of the rectangle's vertical lines, so the gradient vector is
 * the normal to that image direction (not simply the image of the x axis,
 * which a shear would tilt).
 */
export function linearGradientEndpoints(
	rect: EmfPlusRectF,
	transform: TransformMatrix | null | undefined,
): { x1: number; y1: number; x2: number; y2: number } {
	const m = transform ?? IDENTITY;
	const map = (x: number, y: number) => ({
		x: m[0] * x + m[2] * y + m[4],
		y: m[1] * x + m[3] * y + m[5],
	});
	const p1 = map(rect.x, rect.y + rect.h / 2);
	const pe = map(rect.x + rect.w, rect.y + rect.h / 2);
	const nx = m[3];
	const ny = -m[2];
	const nn = nx * nx + ny * ny;
	if (nn < 1e-12) {
		return { x1: p1.x, y1: p1.y, x2: pe.x, y2: pe.y };
	}
	const t = ((pe.x - p1.x) * nx + (pe.y - p1.y) * ny) / nn;
	return { x1: p1.x, y1: p1.y, x2: p1.x + nx * t, y2: p1.y + ny * t };
}

function plainLinear(ctx: CanvasContext, grad: EmfPlusLinearGradient): CanvasGradient | null {
	if (typeof ctx.createLinearGradient !== 'function') {
		return null;
	}
	const pts = grad.rect ? linearGradientEndpoints(grad.rect, grad.transform) : grad;
	if (pts.x1 === pts.x2 && pts.y1 === pts.y2) {
		return null;
	}
	const g = ctx.createLinearGradient(pts.x1, pts.y1, pts.x2, pts.y2);
	for (const stop of grad.stops) {
		g.addColorStop(stop.offset, stop.color);
	}
	return g;
}

/** Fraction of a period the unrolled ramp is shifted by (see {@link tiledLinear}). */
const SEAM_BIAS = 1e-5;

/** Most gradient periods one tiled linear brush is unrolled into. */
const MAX_PERIODS = 2048;

/** The drawing surface size, when the context exposes its canvas. */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * A tiled linear brush as ONE `CanvasGradient`: its period is unrolled
 * (mirrored on alternate periods for TileFlipX/XY) across every period the
 * drawing surface can show, so colours stay exact and seams stay hard. The
 * endpoints come from {@link linearGradientEndpoints} (exact for any affine
 * brush transform) shifted by GDI+'s half-pixel sampling offset.
 */
function tiledLinear(
	ctx: CanvasContext,
	grad: EmfPlusLinearGradient,
	rect: EmfPlusRectF,
	device: TransformMatrix,
): CanvasGradient | null {
	const size = surfaceSize(ctx);
	const inv = invertLinear(device);
	if (!size || !inv || typeof ctx.createLinearGradient !== 'function') {
		return null;
	}
	const e = linearGradientEndpoints(rect, grad.transform);
	const delta = halfPixelDelta(device);
	const dx = e.x2 - e.x1;
	const dy = e.y2 - e.y1;
	// A pixel exactly on a period boundary reads the END of the period in
	// GDI+; nudge the ramp a hair forward so Canvas agrees.
	const x1 = e.x1 + delta.x + dx * SEAM_BIAS;
	const y1 = e.y1 + delta.y + dy * SEAM_BIAS;
	const len2 = dx * dx + dy * dy;
	if (!(len2 > 1e-12)) {
		return null;
	}
	// Period index range covering the surface's corners, in world space.
	let tMin = Infinity;
	let tMax = -Infinity;
	for (const [cx, cy] of [
		[0, 0],
		[size.w, 0],
		[0, size.h],
		[size.w, size.h],
	]) {
		const px = cx - device[4];
		const py = cy - device[5];
		const wx = inv[0] * px + inv[2] * py;
		const wy = inv[1] * px + inv[3] * py;
		const t = ((wx - x1) * dx + (wy - y1) * dy) / len2;
		tMin = Math.min(tMin, t);
		tMax = Math.max(tMax, t);
	}
	const k0 = Math.floor(tMin);
	const k1 = Math.max(k0 + 1, Math.ceil(tMax));
	if (k1 - k0 > MAX_PERIODS) {
		return null;
	}
	const g = ctx.createLinearGradient(x1 + dx * k0, y1 + dy * k0, x1 + dx * k1, y1 + dy * k1);
	const span = k1 - k0;
	const mirrorX = mirrorFlags(grad.wrapMode).x;
	const reversed = [...grad.stops].reverse();
	for (let k = k0; k < k1; k++) {
		const mirrored = mirrorX && ((k % 2) + 2) % 2 === 1;
		for (const stop of mirrored ? reversed : grad.stops) {
			const local = mirrored ? 1 - stop.offset : stop.offset;
			g.addColorStop(Math.min(1, Math.max(0, (k - k0 + local) / span)), stop.color);
		}
	}
	return g;
}

/**
 * The stops a linear gradient is painted with: GDI+'s own interpolation
 * table as one stop per knot (see `emf-plus-linear-ramp.ts`) when the
 * recorded ramp is known, else the descriptor's stops as given.
 */
export function effectiveLinearStops(grad: EmfPlusLinearGradient): EmfPlusGradientStop[] {
	const ramp = grad.rect ? linearRampOf(grad) : null;
	return ramp && grad.rect ? linearRampStops(buildLinearRampTable(ramp, grad.rect)) : grad.stops;
}

function linearPaint(
	ctx: CanvasContext,
	recorded: EmfPlusLinearGradient,
	device: TransformMatrix,
): CanvasGradient | CanvasPattern | null {
	const grad = { ...recorded, stops: effectiveLinearStops(recorded) };
	const rect = grad.rect;
	if (grad.wrapMode !== 'clamp' && rect && rect.w !== 0) {
		const unrolled = tiledLinear(ctx, grad, rect, device);
		if (unrolled) {
			return unrolled;
		}
		if (stopColorAt(grad.stops, 0) !== null) {
			const brush = grad.transform ?? IDENTITY;
			const tw = texelsFor(mulMatrix(device, brush), 'x', rect.w);
			const pattern = buildPattern(
				ctx,
				rect,
				tw,
				1,
				grad.wrapMode,
				brush,
				halfPixelDelta(device),
				{ phaseX: 0.5, lagX: 0, lagY: 0 },
				(bx) => stopColorAt(grad.stops, (bx - rect.x) / rect.w),
			);
			if (pattern) {
				return pattern;
			}
		}
		emfLog('createBrushGradient: linear gradient could not be tiled');
	}
	return plainLinear(ctx, grad);
}

// ---------------------------------------------------------------------------
// Path gradients
// ---------------------------------------------------------------------------

function boundaryBox(points: ReadonlyArray<{ x: number; y: number }>): EmfPlusRectF | null {
	if (points.length < 3) {
		return null;
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of points) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x);
		y1 = Math.max(y1, p.y);
	}
	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function pathPaint(
	ctx: CanvasContext,
	shape: EmfPlusPathGradientShape,
	wrap: EmfPlusGradientWrapMode,
	device: TransformMatrix,
): CanvasPattern | null {
	const box = boundaryBox(shape.boundary);
	if (!box) {
		return null;
	}
	const brush = shape.transform ?? IDENTITY;
	const full = mulMatrix(device, brush);
	const pxX = Math.hypot(full[0], full[1]);
	const pxY = Math.hypot(full[2], full[3]);
	return buildPattern(
		ctx,
		box,
		texelsFor(full, 'x', box.w),
		texelsFor(full, 'y', box.h),
		wrap,
		brush,
		halfPixelDelta(device),
		{ phaseX: 0, lagX: pxX > 0 ? 1 / pxX : 0, lagY: pxY > 0 ? 1 / pxY : 0 },
		(bx, by) => pathGradientColorAt(shape, bx, by),
	);
}

function radialFallback(ctx: CanvasContext, grad: EmfPlusRadialGradient): CanvasGradient | null {
	if (!(grad.r > 0) || typeof ctx.createRadialGradient !== 'function') {
		return null;
	}
	const g = ctx.createRadialGradient(grad.cx, grad.cy, 0, grad.cx, grad.cy, grad.r);
	for (const stop of grad.stops) {
		g.addColorStop(stop.offset, stop.color);
	}
	return g;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Builds a Canvas 2D paint style from a parsed EMF+ gradient. `device` is
 * the world-to-device matrix the fill will run under (see
 * `plusWorldMatrix`); it sizes the tile and places the half-pixel offset.
 * Returns `null` when the context lacks gradient support (e.g. test stubs)
 * or the geometry is degenerate, in which case callers fall back to the
 * flat brush colour.
 */
export function createBrushGradient(
	ctx: CanvasContext,
	grad: EmfPlusGradient,
	device: TransformMatrix = IDENTITY,
): CanvasGradient | CanvasPattern | null {
	try {
		if (grad.type === 'linear') {
			return linearPaint(ctx, grad, device);
		}
		if (grad.shape) {
			const pattern = pathPaint(ctx, grad.shape, grad.wrapMode, device);
			if (pattern) {
				return pattern;
			}
			emfLog('createBrushGradient: path gradient pattern unavailable, using the radial approximation');
		}
		return radialFallback(ctx, grad);
	} catch {
		return null;
	}
}
