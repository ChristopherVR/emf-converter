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
 * - Every colour is measured from the colour of the fan's centre, in single precision with the operations rounded toward minus
 *   infinity (round 9, `PathGradientSpanProbe.cs` grids and edge probes): a pixel of an `n` pixel span is
 *   `C + qa (n - j) + qb j` with `qa = (cL - C) / n` and `qb = (cR - C) / n` rounded toward zero, the first pixel is `cL`,
 *   and an edge is `C + (P - C) t` (`t = down(k / steps)`, `down(1 - down(k / steps))` towards the centre) or, between two
 *   vertices, `(C + (a - C) (1 - t)) + (b - C) t`. Fitted to the controls rather than isolated: the premultiplied vertex colours
 *   and both edge colours are floored to 1/65536, and the right edge rounds its sum to nearest.
 * - Alpha and the premultiplied colour channels interpolate together (the
 *   native value is premultiplied).
 * - Device vertices reach the scan converter rounded up to 1/16 pixel
 *   (28.4 fixed point); that is what makes scaled and rotated gradients agree.
 *
 * Measured on 320 captures (`path-gradient-vertices.json.gz`): 99.36% of the pixels exact (98.34% before round 9); alpha
 * control #137 is one pixel off by the owner's decision (see docs/outstanding-work.md, round 9, W5). A focus, Blend or preset
 * curve keeps the previous model.
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

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** The largest single-precision value not above `x`. */
export function down(x: number): number {
	const r = Math.fround(x);
	if (r <= x || r !== r) return r;
	f32[0] = r;
	if (r > 0) u32[0] -= 1;
	else if (r < 0) u32[0] += 1;
	else u32[0] = 0x80000001;
	return f32[0];
}

/** The single-precision value nearest to `x` among those not further from zero. */
export function toward0(x: number): number {
	const r = Math.fround(x);
	if (Math.abs(r) <= Math.abs(x) || r !== r) return r;
	f32[0] = r;
	u32[0] -= 1;
	return f32[0];
}

/** A premultiplied channel floored to 1/65536 (the alpha channel is a whole number already). */
const fixed = (v: number): number => Math.floor(v * 65536) / 65536;

/**
 * One edge's channel value. `e` is the edge's index in the fan (0 centre to vertex, 1 vertex to vertex, 2 vertex to centre),
 * `right` whether it is the span's right edge.
 */
export function edgeValue(
	right: boolean, e: number, centre: number, ax: number, ay: number, bx: number, by: number,
	ca: number, cb: number, x: number, y: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	let k: number;
	let steps: number;
	if (Math.abs(dx) > Math.abs(dy)) {
		steps = Math.trunc(Math.abs(dx));
		k = Math.abs(x - Math.floor(ax));
	} else {
		steps = Math.trunc(Math.abs(dy));
		k = Math.abs(y - Math.floor(ay));
	}
	if (steps <= 0) return ca;
	if (e === 1) {
		const wb = down(k / steps);
		const wa = down(1 - wb);
		return down(down(centre + down((ca - centre) * wa)) + down((cb - centre) * wb));
	}
	if (e === 0) {
		const t = down(k / steps);
		return right ? Math.fround(ca + toward0((cb - ca) * t)) : down(ca + down((cb - ca) * t));
	}
	return right
		? Math.fround(cb + down((ca - cb) * down((steps - k) / steps)))
		: down(cb + down((ca - cb) * down(1 - down(k / steps))));
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
			if (x < xl) { xl = x; left = i; }
			if (x > xr) { xr = x; right = i; }
		}
		if (left < 0 || right < 0 || left === right) continue;
		const xs = Math.ceil(xl - CEIL_EPSILON);
		const xe = Math.ceil(xr - CEIL_EPSILON);
		if (px < xs || px >= xe) continue;
		const lj = (left + 1) % 3;
		const rj = (right + 1) % 3;
		const span = xe - xs;
		const j = px - xs;
		for (let q = 0; q < 4; q++) {
			const centre = fixed(g.cc[q]);
			const colors = [centre, fixed(g.vc[f * 4 + q]), fixed(g.vc[f1 * 4 + q])];
			const cL = fixed(edgeValue(false, left, centre, tx[left], ty[left], tx[lj], ty[lj], colors[left], colors[lj], xs, py));
			const cR = fixed(edgeValue(true, right, centre, tx[right], ty[right], tx[rj], ty[rj], colors[right], colors[rj], xe, py));
			let value: number;
			if (j === 0) value = cL;
			else {
				const qa = toward0((cL - centre) / span);
				const qb = toward0((cR - centre) / span);
				value = down(centre + toward0(toward0(qa * (span - j)) + toward0(qb * j)));
			}
			out[q] = Math.max(0, Math.min(255, Math.floor(value + 0.5)));
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
