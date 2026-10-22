import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * Independent FocusScales on a slanted edge, swept (`PathGradientFocusScaleSweepProbe.cs`,
 * `path-gradient-focus-scale-sweep.json.gz`): two integer-vertex triangles painted white to black with FocusScales
 * (f, 0.25) and (0.25, f), f = 0.6 + k 2e-6 for k = -150..150, so a pixel flips copy at the f where the scaled copy's
 * edge crosses it. Of the 217 flips more than 10 pixels from the centre, the exact model (the copy's edge crossing the
 * pixel's row at `ax + (py - ay)(bx - ax)/(by - ay)`, the copy scale `f + (1 - f)(m + 1/2)/N`) flips at the same sweep
 * step, and at no other, for 169. The rest are native's own noise of up to a few 1e-5 pixels perpendicular to the edge
 * (float32 rounding of the scaled vertices, the scale or the crossing does not explain them: the best of 54 variants
 * gets 172), which is why a few one-level pixels remain near the span end (a band that kept the half-way colour there
 * was replaced by plain containment in round 10).
 */
interface Capture { name: string; focus: number[]; center: number[]; points: number[][]; ra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-focus-scale-sweep.json.gz', import.meta.url))).toString());

function crossing(c: Capture, f: number[], m: number, n: number, e: number, py: number): number {
	const sx = f[0] + (1 - f[0]) * (m + 0.5) / n;
	const sy = f[1] + (1 - f[1]) * (m + 0.5) / n;
	const k = c.points.length;
	const a = c.points[(e + k - 1) % k];
	const b = c.points[e];
	const ax = c.center[0] + (a[0] - c.center[0]) * sx;
	const ay = c.center[1] + (a[1] - c.center[1]) * sy;
	const bx = c.center[0] + (b[0] - c.center[0]) * sx;
	const by = c.center[1] + (b[1] - c.center[1]) * sy;
	return ax + ((py - ay) / (by - ay)) * (bx - ax);
}

describe('independent focus scales swept at integer vertices', () => {
	it('flips at the exact model\'s step for 169 of 217 pixels', () => {
		const series = new Map<string, Capture[]>();
		for (const c of captures) {
			const key = c.name.split('-').slice(0, 2).join('-');
			if (!series.has(key)) series.set(key, []);
			series.get(key)!.push(c);
		}
		expect(series.size).toBe(4);
		let flips = 0;
		let exact = 0;
		for (const list of series.values()) {
			const c0 = list[0];
			const xs = c0.points.map((p) => p[0]);
			const ys = c0.points.map((p) => p[1]);
			const n = Math.ceil(2 * Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
			const data = list.map((c) => Buffer.from(c.ra, 'base64'));
			for (let p = 0; p < 8000; p++) {
				const x = p % 100;
				const y = Math.floor(p / 100);
				if (Math.hypot(x - c0.center[0], y - c0.center[1]) < 10) continue;
				for (let i = 0; i + 1 < list.length; i++) {
					if (data[i][p * 2 + 1] === 0 || data[i + 1][p * 2 + 1] === 0 || data[i][p * 2] === data[i + 1][p * 2]) continue;
					flips++;
					const mid = [(list[i].focus[0] + list[i + 1].focus[0]) / 2, (list[i].focus[1] + list[i + 1].focus[1]) / 2];
					let best: { m: number; e: number; d: number } | null = null;
					for (let m = 0; m < n; m++) {
						const sx = mid[0] + (1 - mid[0]) * (m + 0.5) / n;
						const sy = mid[1] + (1 - mid[1]) * (m + 0.5) / n;
						for (let e = 0; e < c0.points.length; e++) {
							const a = c0.points[(e + c0.points.length - 1) % c0.points.length];
							const b = c0.points[e];
							const ay = c0.center[1] + (a[1] - c0.center[1]) * sy;
							const by = c0.center[1] + (b[1] - c0.center[1]) * sy;
							if (!((ay <= y && by > y) || (by <= y && ay > y))) continue;
							const d = Math.abs(x - crossing(c0, mid, m, n, e, y));
							if (best === null || d < best.d) best = { m, e, d };
						}
					}
					const g = (k: number) => Math.sign(x - crossing(c0, list[k].focus, best!.m, n, best!.e, y));
					const ref = g(i);
					let good = ref !== 0 && g(i + 1) !== ref;
					for (let k = 0; good && k < list.length; k++) if (k <= i ? g(k) !== ref : g(k) === ref) good = false;
					if (good) exact++;
				}
			}
		}
		expect(flips).toBe(217);
		expect(exact).toBe(169);
	});
});
