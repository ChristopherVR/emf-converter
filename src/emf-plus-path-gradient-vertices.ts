/**
 * Path gradients whose surround colours differ from vertex to vertex.
 *
 * Native GDI+ does not draw these as nested boundary copies (that is how it
 * draws a uniform surround, see `pathGradientQuantum`). It fans the boundary
 * into triangles (centre, vertex i, vertex i + 1) and Gouraud-shades each one
 * with a scan converter that interpolates in whole pixels:
 *
 * - A scanline of a triangle runs from `xs = ceil(xLeft)` to `xe = ceil(xRight)`
 *   (left-inclusive, right-exclusive) at the integer row, with no sub-pixel
 *   correction: the colour at `xs` is the left edge's colour, not the colour
 *   at the edge crossing, and the right edge's colour belongs to `xe`, the
 *   first pixel past the span.
 * - Each edge is walked along its major axis (x when |dx| > |dy|, else y) in
 *   whole steps from `floor` of its first vertex over `trunc(|d|)` steps, so
 *   the parameter at column or row `u` is `|u - floor(a)| / trunc(|b - a|)`.
 *   The edges are taken in the order centre -> vertex i, vertex i -> vertex
 *   i + 1, vertex i + 1 -> centre.
 * - The span interpolates in 16.16 fixed point: both end colours truncate to
 *   16 fractional bits, the per-pixel step is `floor((cR - cL) / (xe - xs))`
 *   and the pixel rounds half up.
 * - Alpha and the premultiplied colour channels interpolate together (the
 *   native value is premultiplied).
 * - Device vertices reach the scan converter rounded up to 1/16 pixel
 *   (28.4 fixed point); that is what makes scaled and rotated gradients agree.
 *
 * Measured on 320 captures (`path-gradient-vertices.json.gz`): 98.8% of the
 * pixels of 120 random polygons exact and none beyond a level; scaled and
 * rotated polygons 96-99%. The residual is rounding ties and the pixels of a
 * vertex's own row. A focus, Blend or preset curve keeps the previous model.
 *
 * @module emf-plus-path-gradient-vertices
 */

import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/** A path gradient in device space, ready for per-pixel evaluation. */
export interface VertexGradient {
	cx: number;
	cy: number;
	vx: Float64Array;
	vy: Float64Array;
	/** Per-vertex surround channels (alpha, premultiplied r, g, b), four per vertex. */
	vc: Float64Array;
	/** Centre channels (alpha, premultiplied r, g, b). */
	cc: [number, number, number, number];
}

/** Fixed-point fraction bits of the span interpolation. */
const FRACTION_BITS = 16;
const ONE = 2 ** FRACTION_BITS;
/** Guards `ceil` against float noise in an edge crossing that is a whole pixel. */
const CEIL_EPSILON = 1e-9;

/** Device coordinates reach the scan converter as 28.4 fixed point, rounded up. */
const snap = (v: number): number => Math.ceil(v * 16 - 1e-9) / 16;

/** Alpha and premultiplied colour channels of a packed ARGB colour. */
function premultiplied(argb: number): [number, number, number, number] {
	const a = argb >>> 24;
	return [a, (((argb >>> 16) & 0xff) * a) / 255, (((argb >>> 8) & 0xff) * a) / 255, ((argb & 0xff) * a) / 255];
}

/**
 * Device-space geometry of a non-uniform path gradient with no Blend or preset
 * curve (FocusScales change nothing here: native ignores them for per-vertex
 * surrounds, 14,577 of 14,766 pixels of 40 captures with scales exact), or `null` when the previous model has to
 * answer. `full` maps brush space to device pixels.
 */
export function prepareVertexGradient(shape: EmfPlusPathGradientShape, full: TransformMatrix): VertexGradient | null {
	const n = shape.boundary.length;
	if (n < 3 || shape.preset || shape.blend || shape.boundaryArgb.length < n) {
		return null;
	}
	if (shape.boundaryArgb.every((color) => color === shape.boundaryArgb[0])) {
		return null;
	}
	const vx = new Float64Array(n);
	const vy = new Float64Array(n);
	const vc = new Float64Array(n * 4);
	for (let i = 0; i < n; i++) {
		const p = shape.boundary[i];
		vx[i] = snap(full[0] * p.x + full[2] * p.y + full[4]);
		vy[i] = snap(full[1] * p.x + full[3] * p.y + full[5]);
		vc.set(premultiplied(shape.boundaryArgb[i]), i * 4);
	}
	const c = shape.center;
	return {
		cx: snap(full[0] * c.x + full[2] * c.y + full[4]),
		cy: snap(full[1] * c.x + full[3] * c.y + full[5]),
		vx,
		vy,
		vc,
		cc: premultiplied(shape.centerArgb),
	};
}

/** One edge's channel value at column `x` (x-major edges) or row `y`, in fixed point. */
function edgeChannel(
	ax: number, ay: number, bx: number, by: number, ca: number, cb: number, x: number, y: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	let t = 0;
	if (Math.abs(dx) > Math.abs(dy)) {
		const steps = Math.trunc(Math.abs(dx));
		if (steps > 0) t = Math.abs(x - Math.floor(ax)) / steps;
	} else {
		const steps = Math.trunc(Math.abs(dy));
		if (steps > 0) t = Math.abs(y - Math.floor(ay)) / steps;
	}
	return Math.trunc((ca + (cb - ca) * t) * ONE);
}

/**
 * The (non-premultiplied) ARGB colour of device pixel (`px`, `py`), or `null`
 * when no fan triangle's span holds it. Later fan triangles paint over earlier
 * ones.
 */
export function vertexGradientColorAt(g: VertexGradient, px: number, py: number): number | null {
	const n = g.vx.length;
	let result: number | null = null;
	const tx = [0, 0, 0];
	const ty = [0, 0, 0];
	const out = [0, 0, 0, 0];
	for (let f = 0; f < n; f++) {
		const f1 = (f + 1) % n;
		// Triangle (centre, vertex f, vertex f + 1); edge i runs from point i to point i + 1.
		tx[0] = g.cx; tx[1] = g.vx[f]; tx[2] = g.vx[f1];
		ty[0] = g.cy; ty[1] = g.vy[f]; ty[2] = g.vy[f1];
		let left = -1;
		let right = -1;
		let xl = Infinity;
		let xr = -Infinity;
		for (let i = 0; i < 3; i++) {
			const j = (i + 1) % 3;
			const ay = ty[i];
			const by = ty[j];
			if (!((ay <= py && by > py) || (by <= py && ay > py))) continue;
			const x = tx[i] + ((py - ay) / (by - ay)) * (tx[j] - tx[i]);
			if (x < xl) {
				xl = x;
				left = i;
			}
			if (x > xr) {
				xr = x;
				right = i;
			}
		}
		if (left < 0 || right < 0 || left === right) continue;
		const xs = Math.ceil(xl - CEIL_EPSILON);
		const xe = Math.ceil(xr - CEIL_EPSILON);
		if (px < xs || px >= xe) continue;
		const li = left;
		const lj = (left + 1) % 3;
		const ri = right;
		const rj = (right + 1) % 3;
		for (let q = 0; q < 4; q++) {
			const colors = [g.cc[q], g.vc[f * 4 + q], g.vc[f1 * 4 + q]];
			const cL = edgeChannel(tx[li], ty[li], tx[lj], ty[lj], colors[li], colors[lj], xs, py);
			const cR = edgeChannel(tx[ri], ty[ri], tx[rj], ty[rj], colors[ri], colors[rj], xe, py);
			const step = Math.floor((cR - cL) / (xe - xs));
			const v = cL + step * (px - xs);
			out[q] = Math.max(0, Math.min(255, Math.floor((v + ONE / 2) / ONE)));
		}
		const alpha = out[0];
		if (alpha === 0) {
			result = 0;
			continue;
		}
		const ch = (premult: number): number => Math.min(255, Math.round((premult * 255) / alpha));
		result = ((alpha << 24) | (ch(out[1]) << 16) | (ch(out[2]) << 8) | ch(out[3])) >>> 0;
	}
	return result;
}
