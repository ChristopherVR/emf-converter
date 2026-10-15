/**
 * Test-only candidate for the arithmetic of per-vertex path gradients (not used by the converter).
 *
 * `emf-plus-path-gradient-vertices.ts` interpolates in 16.16 fixed point. The span probe
 * (`PathGradientSpanProbe.cs`) and the 320 per-vertex captures show native working in single
 * precision with every operation rounded toward minus infinity: an edge colour is
 * `a * w0 + b * w1` (`w1 = down(k / steps)`, `w0 = down(1 - w1)`, the products and their sum not
 * rounded separately) and a pixel of an `n`-pixel span is `l * w0 + r * w1` with both weights
 * rounded down on their own (`w0 = down((n - j) / n)`, `w1 = down(j / n)`), so the weights sum to
 * less than one unless `n` is a power of two. It lifts the 320 captures from 98.34% to 99.24% of
 * their pixels exact and every group improves, but it makes 14 of the 120 per-vertex alpha controls
 * worse (7 of them exact before) and it is therefore not shipped; see docs/outstanding-work.md.
 * The fan geometry (spans, edge walk, 28.4 vertices) is the converter's own.
 */

import { prepareVertexGradient, type VertexGradient } from '../emf-plus-path-gradient-vertices';

export { prepareVertexGradient };
export type { VertexGradient };

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

function edgeChannel(ax: number, ay: number, bx: number, by: number, ca: number, cb: number, x: number, y: number): number {
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
	const w1 = down(k / steps);
	const w0 = down(1 - w1);
	return down(ca * w0 + cb * w1);
}

/** Non-premultiplied ARGB of pixel (`px`, `py`) or `null`, like `vertexGradientColorAt` with the single-precision arithmetic above. */
export function candidateColorAt(g: VertexGradient, px: number, py: number): number | null {
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
		const w0 = down((span - (px - xs)) / span);
		const w1 = down((px - xs) / span);
		for (let q = 0; q < 4; q++) {
			const colors = [Math.fround(g.cc[q]), Math.fround(g.vc[f * 4 + q]), Math.fround(g.vc[f1 * 4 + q])];
			const cL = edgeChannel(tx[left], ty[left], tx[lj], ty[lj], colors[left], colors[lj], xs, py);
			const cR = edgeChannel(tx[right], ty[right], tx[rj], ty[rj], colors[right], colors[rj], xe, py);
			out[q] = Math.max(0, Math.min(255, Math.floor(down(cL * w0 + cR * w1) + 0.5)));
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
