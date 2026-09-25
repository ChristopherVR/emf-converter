/**
 * GDI+-style curve flattening for aliased EMF+ rasterisation.
 *
 * GDI+ never rasterises a curve: an ellipse, arc or pie becomes cubic Bezier
 * segments (one per quarter turn at most, the usual `4/3 tan(sweep/4)`
 * control length), and every Bezier is flattened into a polygon before its
 * pixels are decided, by recursive halving until the control points lie
 * within `FlatnessDefault` (0.25 device pixels) of the chord (the same
 * flattening `flattenCubic` models for path-gradient boundaries). Without
 * antialiasing, whether a pixel on a curved edge is painted depends on that
 * polygon, not on the true curve, so an aliased fill or stroke builds its
 * geometry through {@link flatteningContext}, which replaces every curve
 * with the polygon GDI+ would use.
 *
 * @module emf-plus-flatten
 */

import { flattenCubic } from './emf-plus-brush-parser';
import type { CanvasContext, TransformMatrix } from './emf-types';

interface Pt {
	x: number;
	y: number;
}

/** Full affine inverse, or `null` for a singular matrix. */
function invert(m: TransformMatrix): TransformMatrix | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return null;
	}
	const a = m[3] / det;
	const b = -m[1] / det;
	const c = -m[2] / det;
	const d = m[0] / det;
	return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

function apply(m: TransformMatrix, p: Pt): Pt {
	return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/**
 * Cubic Bezier segments (world space) GDI+ builds for an elliptical arc:
 * centre (`cx`, `cy`), radii `rx`/`ry`, parametric angles from `start`
 * sweeping `sweep` radians (positive: increasing angle). As
 * `GraphicsPath.AddArc` returns them: whole quarter turns (in the
 * parametric angle) from the start, then whatever remains, each with the
 * usual `4/3 tan(step / 4)` control length. Pure.
 */
export function arcBeziers(
	cx: number,
	cy: number,
	rx: number,
	ry: number,
	start: number,
	sweep: number,
): Array<[Pt, Pt, Pt, Pt]> {
	const quarter = Math.PI / 2;
	const n = Math.max(1, Math.ceil(Math.abs(sweep) / quarter - 1e-9));
	const at = (a: number): Pt => ({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
	const tangent = (a: number): Pt => ({ x: -rx * Math.sin(a), y: ry * Math.cos(a) });
	const out: Array<[Pt, Pt, Pt, Pt]> = [];
	for (let i = 0; i < n; i++) {
		const a0 = start + i * Math.sign(sweep) * quarter;
		const step = i === n - 1 ? start + sweep - a0 : Math.sign(sweep) * quarter;
		const k = (4 / 3) * Math.tan(step / 4);
		const a1 = a0 + step;
		const p0 = at(a0);
		const p3 = at(a1);
		const t0 = tangent(a0);
		const t1 = tangent(a1);
		out.push([p0, { x: p0.x + k * t0.x, y: p0.y + k * t0.y }, { x: p3.x - k * t1.x, y: p3.y - k * t1.y }, p3]);
	}
	return out;
}

/**
 * Wraps a context so path building replaces curves (`bezierCurveTo`,
 * `ellipse`) with GDI+'s flattened polygon, flattened in device space
 * (`device` maps the world coordinates the caller issues to device
 * pixels). Every other member passes straight through. The wrapper tracks
 * the current point itself, which `bezierCurveTo` needs.
 */
export function flatteningContext(target: CanvasContext, device: TransformMatrix): CanvasContext {
	const inv = invert(device);
	if (!inv) {
		return target;
	}
	let cur: Pt | null = null;
	let start: Pt | null = null;
	// Vertices stay exact: snapping them to GDI+'s 1/16-pixel grid was
	// measured to match its edge pixels slightly worse, not better (its edge
	// stepping rounds in ways no simple vertex rule reproduces).
	const moveToWorld = (p: Pt): void => {
		target.moveTo(p.x, p.y);
		cur = p;
		start = p;
	};
	const lineToWorld = (p: Pt): void => {
		target.lineTo(p.x, p.y);
		cur = p;
	};
	const bezier = (p0: Pt, p1: Pt, p2: Pt, p3: Pt): void => {
		const flat: Array<Pt & { t: number }> = [];
		flattenCubic(apply(device, p0), apply(device, p1), apply(device, p2), apply(device, p3), flat);
		for (let i = 0; i < flat.length - 1; i++) {
			const w = apply(inv, flat[i]);
			target.lineTo(w.x, w.y);
		}
		// End exactly on the curve's own end point.
		lineToWorld(p3);
	};
	const overrides: Record<string, unknown> = {
		beginPath(): void {
			target.beginPath();
			cur = null;
			start = null;
		},
		moveTo(x: number, y: number): void {
			moveToWorld({ x, y });
		},
		lineTo(x: number, y: number): void {
			if (!cur) {
				// Canvas: lineTo with no current point acts as moveTo.
				moveToWorld({ x, y });
				return;
			}
			lineToWorld({ x, y });
		},
		closePath(): void {
			target.closePath();
			cur = start;
		},
		rect(x: number, y: number, w: number, h: number): void {
			// A closed four-point figure with snapped corners (a rotated
			// rectangle's corners snap independently, as GDI+'s do).
			moveToWorld({ x, y });
			lineToWorld({ x: x + w, y });
			lineToWorld({ x: x + w, y: y + h });
			lineToWorld({ x, y: y + h });
			target.closePath();
			cur = { x, y };
		},
		bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
			const p0 = cur ?? { x: c1x, y: c1y };
			if (!cur) {
				moveToWorld(p0);
			}
			bezier(p0, { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x, y });
		},
		ellipse(
			cx: number,
			cy: number,
			rx: number,
			ry: number,
			rotation: number,
			a0: number,
			a1: number,
			ccw?: boolean,
		): void {
			let sweep = a1 - a0;
			if (ccw) {
				sweep = sweep > 0 ? sweep - 2 * Math.PI * Math.ceil(sweep / (2 * Math.PI)) : sweep;
				if (sweep < -2 * Math.PI) {
					sweep = -2 * Math.PI;
				}
			} else {
				sweep = sweep < 0 ? sweep + 2 * Math.PI * Math.ceil(-sweep / (2 * Math.PI)) : sweep;
				if (sweep > 2 * Math.PI) {
					sweep = 2 * Math.PI;
				}
			}
			const cos = Math.cos(rotation);
			const sin = Math.sin(rotation);
			const rot = (p: Pt): Pt =>
				rotation === 0 ? p : { x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos };
			const segs = arcBeziers(cx, cy, rx, ry, a0, sweep).map((s) => s.map(rot) as [Pt, Pt, Pt, Pt]);
			if (segs.length === 0) {
				return;
			}
			const p0 = segs[0][0];
			if (cur) {
				lineToWorld(p0);
			} else {
				moveToWorld(p0);
			}
			for (const [q0, q1, q2, q3] of segs) {
				bezier(q0, q1, q2, q3);
			}
		},
	};
	return new Proxy(target as object, {
		get(t, prop) {
			if (typeof prop === 'string' && prop in overrides) {
				return overrides[prop];
			}
			const v = (t as Record<string | symbol, unknown>)[prop];
			return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
		},
		set(t, prop, value) {
			(t as Record<string | symbol, unknown>)[prop] = value;
			return true;
		},
	}) as CanvasContext;
}
