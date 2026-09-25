/**
 * Stroke-to-polygon conversion for the pure-JavaScript rasteriser
 * (`software-raster.ts`), following Canvas 2D stroking semantics.
 *
 * A Canvas stroke is computed in the USER space current at `stroke()` time
 * (line width, dashes and joins scale and shear with the transform), while
 * the path itself was fixed in device space as it was built. So the
 * flattened device-space path is mapped back through the inverse of the
 * stroke-time transform, dashed and outlined there, and the outline mapped
 * forward again.
 *
 * Outlining follows Skia's stroker (the rasteriser behind Chromium's canvas
 * and `@napi-rs/canvas`): each subpath becomes one closed contour (open
 * subpaths: left side, end cap, right side reversed, start cap) or two
 * (closed subpaths: the left and the reversed right side). On the outer side
 * of a turn the join geometry (miter tip within `miterLimit`, round arc, or
 * bevel) is inserted; on the inner side the contour detours through the
 * vertex itself, which leaves small self-overlapping loops that all wind the
 * same way, so a nonzero fill of the contours is exactly the union of the
 * segment bodies, joins and caps. Interior vertices of a flattened curve are
 * joined round, which is what the smooth offset curve reduces to.
 *
 * @module software-raster-stroke
 */

import { invertMatrix, type Matrix, type Polyline } from './canvas-path';

/** The stroke parameters of a Canvas 2D context. */
export interface StrokeParams {
	lineWidth: number;
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	miterLimit: number;
	/** Canvas's dash list (already even-length), in user units. */
	lineDash: ReadonlyArray<number>;
	lineDashOffset: number;
}

/** An open run of the path to outline, in user space. */
interface Piece {
	pts: number[];
	smooth: boolean[];
	closed: boolean;
	/** Tangent of a zero-length piece (a dot), for its cap's orientation. */
	dir?: [number, number];
}

const EPS = 1e-9;

/** Removes repeated points; a closed piece also drops a final copy of its first point. */
function dedupe(poly: Polyline): Piece {
	const pts: number[] = [];
	const smooth: boolean[] = [];
	const p = poly.pts;
	for (let i = 0; i < p.length; i += 2) {
		const n = pts.length;
		if (n >= 2 && Math.abs(pts[n - 2] - p[i]) < EPS && Math.abs(pts[n - 1] - p[i + 1]) < EPS) {
			continue;
		}
		pts.push(p[i], p[i + 1]);
		smooth.push(poly.smooth[i >> 1] ?? false);
	}
	if (poly.closed && pts.length >= 4) {
		const n = pts.length;
		if (Math.abs(pts[n - 2] - pts[0]) < EPS && Math.abs(pts[n - 1] - pts[1]) < EPS) {
			pts.length -= 2;
			smooth.length -= 1;
		}
	}
	smooth[0] = false;
	return { pts, smooth, closed: poly.closed };
}

/** Splits a piece into its dashes (Canvas `setLineDash` / `lineDashOffset` semantics). */
function dashPiece(piece: Piece, dash: ReadonlyArray<number>, offset: number): Piece[] {
	const total = dash.reduce((s, d) => s + d, 0);
	if (!(total > 0)) {
		return [piece];
	}
	const p = piece.pts;
	const n = p.length >> 1;
	const segCount = piece.closed ? n : n - 1;
	if (segCount < 1) {
		return [piece];
	}
	// Position within the pattern at distance 0.
	let phase = offset % total;
	if (phase < 0) {
		phase += total;
	}
	let idx = 0;
	while (phase > 0 && phase >= dash[idx]) {
		phase -= dash[idx];
		idx = (idx + 1) % dash.length;
	}
	let remaining = dash[idx] - phase;
	let on = idx % 2 === 0;
	const out: Piece[] = [];
	let cur: Piece | null = on ? { pts: [p[0], p[1]], smooth: [false], closed: false } : null;
	const startsOn = on;
	for (let s = 0; s < segCount; s++) {
		const ax = p[s * 2];
		const ay = p[s * 2 + 1];
		const bi = (s + 1) % n;
		const bx = p[bi * 2];
		const by = p[bi * 2 + 1];
		const len = Math.hypot(bx - ax, by - ay);
		let pos = 0;
		while (len - pos > remaining) {
			pos += remaining;
			const t = pos / len;
			const x = ax + (bx - ax) * t;
			const y = ay + (by - ay) * t;
			if (on && cur) {
				cur.pts.push(x, y);
				cur.smooth.push(false);
				if (cur.pts.length === 4 && Math.abs(cur.pts[0] - x) < EPS && Math.abs(cur.pts[1] - y) < EPS) {
					cur.pts.length = 2;
					cur.smooth.length = 1;
					cur.dir = [(bx - ax) / len, (by - ay) / len];
				}
				out.push(cur);
				cur = null;
			} else {
				cur = { pts: [x, y], smooth: [false], closed: false, dir: [(bx - ax) / len, (by - ay) / len] };
			}
			on = !on;
			idx = (idx + 1) % dash.length;
			remaining = dash[idx];
		}
		remaining -= len - pos;
		if (on && cur) {
			cur.pts.push(bx, by);
			cur.smooth.push(bi === 0 ? false : piece.smooth[bi]);
		}
	}
	if (on && cur) {
		if (piece.closed && startsOn && out.length > 0) {
			// The dash running through the closing point continues into the first dash.
			const first = out.shift()!;
			cur.pts.push(...first.pts.slice(2));
			cur.smooth.push(...first.smooth.slice(1));
		}
		out.push(cur);
	}
	for (const d of out) {
		if (d.pts.length > 2) {
			delete d.dir;
		}
	}
	return out;
}

/** Appends an arc around (`cx`,`cy`) from angle `a0` sweeping `sweep` radians (endpoints excluded). */
function arcPoints(out: number[], cx: number, cy: number, r: number, a0: number, sweep: number, step: number): void {
	const n = Math.ceil(Math.abs(sweep) / step);
	for (let i = 1; i < n; i++) {
		const a = a0 + (sweep * i) / n;
		out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
	}
}

/**
 * Appends one side's join at vertex (`px`,`py`) between incoming direction
 * `d1` and outgoing `d2`, for the side whose unit normal is `n1`/`n2`.
 */
function joinSide(
	out: number[],
	px: number,
	py: number,
	d1x: number,
	d1y: number,
	d2x: number,
	d2y: number,
	n1x: number,
	n1y: number,
	n2x: number,
	n2y: number,
	hw: number,
	join: CanvasLineJoin,
	miterLimit: number,
	step: number,
): void {
	const ax = px + n1x * hw;
	const ay = py + n1y * hw;
	const bx = px + n2x * hw;
	const by = py + n2y * hw;
	const dot = d1x * d2x + d1y * d2y;
	const cross = d1x * d2y - d1y * d2x;
	out.push(ax, ay);
	if (Math.abs(cross) < 1e-12 && dot > 0) {
		return; // Straight on: both offsets coincide.
	}
	// This side is outer when the path turns away from it.
	const outer = n1x * d2x + n1y * d2y < 0 || (Math.abs(cross) < 1e-12 && dot < 0);
	if (!outer) {
		out.push(px, py);
		out.push(bx, by);
		return;
	}
	if (join === 'round') {
		const a0 = Math.atan2(n1y, n1x);
		let sweep = Math.atan2(n2y, n2x) - a0;
		// The short way round is the outer side: the normals turn with the path.
		while (sweep <= -Math.PI) {
			sweep += 2 * Math.PI;
		}
		while (sweep > Math.PI) {
			sweep -= 2 * Math.PI;
		}
		if (Math.abs(cross) < 1e-12) {
			// A full reversal: the half circle bulges forward, past the vertex.
			sweep = Math.PI * Math.sign(n1x * d1y - n1y * d1x);
		}
		arcPoints(out, px, py, hw, a0, sweep, step);
	} else if (join === 'miter') {
		// Distance from the vertex to the miter tip over half the line width
		// is 1 / cos(theta / 2), theta the angle between the two offsets.
		const cosTheta = n1x * n2x + n1y * n2y;
		const cosHalf = Math.sqrt(Math.max(0, (1 + cosTheta) / 2));
		if (cosHalf > 1e-12 && 1 / cosHalf <= miterLimit) {
			const mx = n1x + n2x;
			const my = n1y + n2y;
			const ml = Math.hypot(mx, my);
			if (ml > 1e-12) {
				const len = hw / cosHalf;
				out.push(px + (mx / ml) * len, py + (my / ml) * len);
			}
		}
	}
	out.push(bx, by);
}

/** Outlines one piece (user space), returning its contour(s). */
function outlinePiece(piece: Piece, params: StrokeParams, step: number, hadSegment: boolean): number[][] {
	const hw = params.lineWidth / 2;
	const p = piece.pts;
	const n = p.length >> 1;
	const cap = params.lineCap;
	if (n === 1) {
		// A zero-length subpath or dash: only round and square caps paint it.
		if (!hadSegment || piece.closed || cap === 'butt') {
			return [];
		}
		const cx = p[0];
		const cy = p[1];
		const [dx, dy] = piece.dir ?? [1, 0];
		if (cap === 'round') {
			const ring: number[] = [cx + hw, cy];
			arcPoints(ring, cx, cy, hw, 0, 2 * Math.PI, step);
			return [ring];
		}
		const nx = -dy;
		const ny = dx;
		return [
			[
				cx + (dx + nx) * hw,
				cy + (dy + ny) * hw,
				cx + (-dx + nx) * hw,
				cy + (-dy + ny) * hw,
				cx + (-dx - nx) * hw,
				cy + (-dy - ny) * hw,
				cx + (dx - nx) * hw,
				cy + (dy - ny) * hw,
			],
		];
	}
	const segs = piece.closed ? n : n - 1;
	const dirs = new Float64Array(segs * 2);
	for (let s = 0; s < segs; s++) {
		const b = (s + 1) % n;
		const dx = p[b * 2] - p[s * 2];
		const dy = p[b * 2 + 1] - p[s * 2 + 1];
		const len = Math.hypot(dx, dy) || 1;
		dirs[s * 2] = dx / len;
		dirs[s * 2 + 1] = dy / len;
	}
	// Left normal of a direction (dx, dy) is (dy, -dx); right is its negation.
	const side = (sign: 1 | -1): number[] => {
		const out: number[] = [];
		const first = piece.closed ? 0 : 1;
		const last = piece.closed ? n - 1 : n - 2;
		if (!piece.closed) {
			out.push(p[0] + sign * dirs[1] * hw, p[1] - sign * dirs[0] * hw);
		}
		for (let k = first; k <= last; k++) {
			const s1 = (k - 1 + segs) % segs;
			const s2 = k % segs;
			const d1x = dirs[s1 * 2];
			const d1y = dirs[s1 * 2 + 1];
			const d2x = dirs[s2 * 2];
			const d2y = dirs[s2 * 2 + 1];
			const join = piece.smooth[k] ? 'round' : params.lineJoin;
			joinSide(
				out,
				p[k * 2],
				p[k * 2 + 1],
				d1x,
				d1y,
				d2x,
				d2y,
				sign * d1y,
				-sign * d1x,
				sign * d2y,
				-sign * d2x,
				hw,
				join,
				params.miterLimit,
				step,
			);
		}
		if (!piece.closed) {
			const s = segs - 1;
			out.push(p[(n - 1) * 2] + sign * dirs[s * 2 + 1] * hw, p[(n - 1) * 2 + 1] - sign * dirs[s * 2] * hw);
		}
		return out;
	};
	const left = side(1);
	const right = side(-1);
	const reverse = (pts: number[]): number[] => {
		const r: number[] = [];
		for (let i = pts.length - 2; i >= 0; i -= 2) {
			r.push(pts[i], pts[i + 1]);
		}
		return r;
	};
	if (piece.closed) {
		return [left, reverse(right)];
	}
	const ring = left.slice();
	const capAt = (x: number, y: number, dx: number, dy: number): void => {
		// Called between the left side (normal (dy,-dx)) and the right side, at an end facing (dx, dy).
		if (cap === 'square') {
			ring.push(x + (dy + dx) * hw, y + (-dx + dy) * hw);
			ring.push(x + (-dy + dx) * hw, y + (dx + dy) * hw);
		} else if (cap === 'round') {
			const a0 = Math.atan2(-dx, dy);
			arcPoints(ring, x, y, hw, a0, Math.PI, step);
		}
	};
	const e = n - 1;
	capAt(p[e * 2], p[e * 2 + 1], dirs[(segs - 1) * 2], dirs[(segs - 1) * 2 + 1]);
	ring.push(...reverse(right));
	capAt(p[0], p[1], -dirs[0], -dirs[1]);
	return [ring];
}

/**
 * The centre lines a stroke of `polys` (device space) runs along after
 * dashing in the stroke-time user space `m`, back in device space: the
 * input for hairline drawing. Pieces keep their `closed` flag (an undashed
 * closed subpath stays closed).
 */
export function strokeCenterlines(polys: ReadonlyArray<Polyline>, m: Readonly<Matrix>, params: StrokeParams): Polyline[] {
	const inv = invertMatrix(m);
	if (!inv) {
		return [];
	}
	const out: Polyline[] = [];
	for (const poly of polys) {
		const user: Polyline = { pts: new Array(poly.pts.length), smooth: poly.smooth, closed: poly.closed };
		for (let i = 0; i < poly.pts.length; i += 2) {
			const x = poly.pts[i];
			const y = poly.pts[i + 1];
			user.pts[i] = inv[0] * x + inv[2] * y + inv[4];
			user.pts[i + 1] = inv[1] * x + inv[3] * y + inv[5];
		}
		const base = dedupe(user);
		const pieces = params.lineDash.length > 0 ? dashPiece(base, params.lineDash, params.lineDashOffset) : [base];
		for (const piece of pieces) {
			const pts = piece.pts;
			for (let i = 0; i < pts.length; i += 2) {
				const x = pts[i];
				const y = pts[i + 1];
				pts[i] = m[0] * x + m[2] * y + m[4];
				pts[i + 1] = m[1] * x + m[3] * y + m[5];
			}
			out.push({ pts, smooth: piece.smooth, closed: piece.closed });
		}
	}
	return out;
}

/**
 * Outlines `polys` (device space) as Canvas would stroke them under the
 * stroke-time transform `m`, returning closed device-space rings to fill
 * with the nonzero rule. `tolerance` bounds the device-space error of
 * round joins and caps.
 */
export function strokeToRings(
	polys: ReadonlyArray<Polyline>,
	m: Readonly<Matrix>,
	params: StrokeParams,
	tolerance: number,
): number[][] {
	const inv = invertMatrix(m);
	if (!inv || !(params.lineWidth > 0)) {
		return [];
	}
	// Largest device-space radius a user-space round join can have.
	const scale = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
	const rDev = Math.max(1e-6, (params.lineWidth / 2) * scale);
	const step = rDev <= tolerance ? Math.PI / 2 : Math.max(0.05, 2 * Math.acos(1 - tolerance / rDev));
	const rings: number[][] = [];
	for (const poly of polys) {
		const user: Polyline = { pts: new Array(poly.pts.length), smooth: poly.smooth, closed: poly.closed };
		for (let i = 0; i < poly.pts.length; i += 2) {
			const x = poly.pts[i];
			const y = poly.pts[i + 1];
			user.pts[i] = inv[0] * x + inv[2] * y + inv[4];
			user.pts[i + 1] = inv[1] * x + inv[3] * y + inv[5];
		}
		const hadSegment = poly.pts.length >= 4;
		const base = dedupe(user);
		const pieces = params.lineDash.length > 0 ? dashPiece(base, params.lineDash, params.lineDashOffset) : [base];
		for (const piece of pieces) {
			for (const ring of outlinePiece(piece, params, step, hadSegment)) {
				for (let i = 0; i < ring.length; i += 2) {
					const x = ring[i];
					const y = ring[i + 1];
					ring[i] = m[0] * x + m[2] * y + m[4];
					ring[i + 1] = m[1] * x + m[3] * y + m[5];
				}
				rings.push(ring);
			}
		}
	}
	return rings;
}
