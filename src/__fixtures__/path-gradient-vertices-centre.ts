/**
 * Test-only candidate (round 9, workstream W5) for the arithmetic of per-vertex path gradients: every colour is
 * measured from the colour of the fan's centre, in single precision with the operations rounded toward minus
 * infinity, the way the span probe (`PathGradientSpanProbe.cs`) and the edge probes show native doing it. It is not
 * used by the converter.
 *
 * Measured with synthetic fans (see `src/emf-plus-path-gradient-centre.fixture.test.ts`):
 * - A pixel of an `n` pixel span is `C + qa (n - j) + qb j`, with `qa = (cL - C) / n` and `qb = (cR - C) / n` rounded toward
 *   zero (`C` the centre colour, `cL` and `cR` the colours of the span's two edges) and the first pixel is `cL`
 *   (659,630 of 659,630 pixels of the flat spans with a non-negative offset from the centre, every non-tie pixel of
 *   54,932 spans).
 * - The colour of an edge is `C + (P - C) t` for an edge that starts at the centre (`t = down(k / steps)`), `C + (P - C)
 *   down(1 - down(k / steps))` for one that ends there, and `(C + (a - C) down(1 - t)) + (b - C) t` for an edge between two
 *   vertices, every product and sum rounded down (49,464 + 7,336 + 12,584 rows of native edges, none differs).
 *
 * Fitted to the 240 alpha controls and the 320 captures, not isolated by a probe:
 * - the premultiplied vertex colours are floored to 1/65536;
 * - the right edge of a span adds its (toward zero) product to the centre with a nearest-rounded sum, and takes the weight
 *   of an edge that ends at the centre as `down((steps - k) / steps)`;
 * - both edge colours are floored to 1/65536 before the span.
 *
 * Against the production module: the 320 per-vertex captures go from 171,194 to 172,969 of 174,084 pixels exact (98.34% to
 * 99.36%), the five `grad-path-triangle-*` fixtures from 13, 54, 54, 54, 54 to 4, 16, 18, 18, 16 differing pixels, and the
 * 240 alpha controls from 784 to 613 differing pixels in total (55 ceilings tighten), but control #137 goes from exact to
 * one differing pixel, which is why it is not shipped.
 */

import type { VertexGradient } from '../emf-plus-path-gradient-vertices';

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

/** Non-premultiplied ARGB of pixel (`px`, `py`) or `null`. */
export function centreColorAt(g: VertexGradient, px: number, py: number): number | null {
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
		const xs = Math.ceil(xl - 1e-9);
		const xe = Math.ceil(xr - 1e-9);
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
