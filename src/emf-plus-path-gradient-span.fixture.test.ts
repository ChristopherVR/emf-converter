import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { prepareVertexGradient, vertexGradientColorAt } from './emf-plus-path-gradient-vertices';
import { candidateColorAt } from './__fixtures__/path-gradient-vertices-candidate';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/**
 * The span of a per-vertex path gradient, isolated (`PathGradientSpanProbe.cs`, `path-gradient-span.json.gz`).
 *
 * The probe draws fan triangles whose edge colours are exact in any arithmetic (colours in multiples of 64, edges
 * 256 and 512 rows tall in y-major steps) so a scanline's two end colours `cL`, `cR` and its length `n` are known
 * without trusting a model of the edges, and only the span between them can be inexact: 60 random colour triples
 * and start fractions, and 48 "flat" fans (centre 64, p0 192, p1 128) whose end colours are equal on every row, so
 * the span is one colour and only the rounding of equal values shows. What it shows:
 *
 * - Every pixel of every span is painted (no span the model paints is empty natively), and every pixel that is not an
 *   exact half-level tie of the exact interpolation `cL + (cR - cL) j / n` has the native level nearest to it: 2,631,233
 *   of 2,631,233. No accumulating step (a 16.16 or a single-precision DDA) leaves a trace larger than that: the
 *   16.16 span of the converter differs on 33 of them.
 * - A flat span's pixels are not all the same level. With the colour exactly half way (x.5): a span of 2^k pixels is
 *   entirely x + 1, a span of an odd length n is x + 1 at j = 0 and x everywhere else, and an even one the same or
 *   entirely x + 1; no other pattern occurs in 2,976 spans. A value that never changes cannot do that when computed
 *   as `l + (r - l) t` or by stepping a delta: the span weights the two ends separately, `l w0 + r w1`, and the
 *   weights (single precision rounded down) sum to less than one except when `n` is a power of two.
 */
interface Capture { name: string; w: number; h: number; center: [number, number]; centerArgb: number; points: [number, number][]; colors: number[]; ra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-span.json.gz', import.meta.url))).toString());

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];
const snap = (v: number): number => Math.ceil(v * 16 - 1e-9) / 16;

function shapeOf(c: Capture): EmfPlusPathGradientShape {
	return {
		boundary: c.points.map(([x, y]) => ({ x, y })), center: { x: c.center[0], y: c.center[1] }, centerArgb: c.centerArgb, boundaryArgb: c.colors,
		focus: null, blend: null, preset: null, transform: null,
	} as EmfPlusPathGradientShape;
}

interface Tally {
	spans: number; pixels: number; unpainted: number; nonTie: number; nonTieNativeOff: number; ties: number;
	productionOff: number; productionNonTieOff: number; candidateOff: number; candidateNonTieOff: number;
	flat: Record<string, number>;
}

function tally(): Tally {
	const t: Tally = { spans: 0, pixels: 0, unpainted: 0, nonTie: 0, nonTieNativeOff: 0, ties: 0, productionOff: 0, productionNonTieOff: 0, candidateOff: 0, candidateNonTieOff: 0, flat: {} };
	for (const c of captures) {
		const ra = Buffer.from(c.ra, 'base64');
		const red = (x: number, y: number): number => (ra[(y * c.w + x) * 2 + 1] ? ra[(y * c.w + x) * 2] : -1);
		const g = prepareVertexGradient(shapeOf(c), IDENTITY)!;
		const P = c.points.map(([x, y]) => [snap(x), snap(y)]);
		const C = [snap(c.center[0]), snap(c.center[1])];
		// Fan 0 (centre, p0, p1); edge i runs from point i to point i + 1.
		const tx = [C[0], P[0][0], P[1][0]];
		const ty = [C[1], P[0][1], P[1][1]];
		const lv = [(c.centerArgb >>> 16) & 255, (c.colors[0] >>> 16) & 255, (c.colors[1] >>> 16) & 255];
		for (let y = 0; y < c.h; y++) {
			let left = -1, right = -1, xl = Infinity, xr = -Infinity;
			for (let i = 0; i < 3; i++) {
				const j = (i + 1) % 3;
				if (!((ty[i] <= y && ty[j] > y) || (ty[j] <= y && ty[i] > y))) continue;
				const x = tx[i] + ((y - ty[i]) / (ty[j] - ty[i])) * (tx[j] - tx[i]);
				if (x < xl) { xl = x; left = i; }
				if (x > xr) { xr = x; right = i; }
			}
			if (left < 0 || right < 0 || left === right) continue;
			const xs = Math.ceil(xl - 1e-9), xe = Math.ceil(xr - 1e-9);
			const edgeValue = (e: number, at: number): number => {
				const j = (e + 1) % 3;
				const dx = tx[j] - tx[e], dy = ty[j] - ty[e];
				const xMajor = Math.abs(dx) > Math.abs(dy);
				const steps = Math.trunc(Math.abs(xMajor ? dx : dy));
				const k = Math.abs(xMajor ? at - Math.floor(tx[e]) : y - Math.floor(ty[e]));
				return steps > 0 ? lv[e] + ((lv[j] - lv[e]) * k) / steps : lv[e];
			};
			// Both ends are multiples of 1/8 of a level (64 / 512).
			const q8L = Math.round(edgeValue(left, xs) * 8), q8R = Math.round(edgeValue(right, xe) * 8);
			const n = xe - xs;
			t.spans++;
			for (let j = 0; j < n; j++) {
				const x = xs + j;
				t.pixels++;
				const native = red(x, y);
				if (native < 0) { t.unpainted++; continue; }
				const num = q8L * n + (q8R - q8L) * j; // 8 n times the exact value
				const tie = num % (8 * n) === 4 * n;
				const nearest = Math.floor((num + 4 * n) / (8 * n));
				const production = vertexGradientColorAt(g, x, y);
				const candidate = candidateColorAt(g, x, y);
				const productionRed = production === null ? -1 : (production >>> 16) & 255;
				const candidateRed = candidate === null ? -1 : (candidate >>> 16) & 255;
				if (tie) t.ties++;
				else {
					t.nonTie++;
					if (native !== nearest) t.nonTieNativeOff++;
					if (productionRed !== native) t.productionNonTieOff++;
					if (candidateRed !== native) t.candidateNonTieOff++;
				}
				if (productionRed !== native) t.productionOff++;
				if (candidateRed !== native) t.candidateOff++;
			}
			// Flat spans of the "const" fans: equal ends exactly half way between two levels.
			if (c.name.startsWith('const_') && q8L === q8R && q8L % 8 === 4 && y <= 306 && n >= 3) {
				const lo = Math.floor(q8L / 8);
				let pattern = '';
				for (let j = 0; j < n; j++) pattern += red(xs + j, y) === lo + 1 ? 'U' : red(xs + j, y) === lo ? 'd' : '?';
				const shape = pattern === 'U'.repeat(n) ? 'allUp' : pattern === 'U' + 'd'.repeat(n - 1) ? 'up-then-down' : 'other';
				const kind = (n & (n - 1)) === 0 ? 'pow2' : n % 2 ? 'odd' : 'even';
				t.flat[`${kind} ${shape}`] = (t.flat[`${kind} ${shape}`] ?? 0) + 1;
			}
		}
	}
	return t;
}

const result = tally();

describe('per-vertex path gradient span (native, exact end colours)', () => {
	it('has 108 images, none a uniform surround', () => {
		expect(captures).toHaveLength(108);
		expect(captures.every((c) => new Set(c.colors).size > 1)).toBe(true);
		expect(result.spans).toBe(55188);
		expect(result.pixels).toBe(2974721);
	});

	it('paints every pixel of every span', () => {
		expect(result.unpainted).toBe(0);
	});

	it('rounds every pixel that is not a half-level tie to the nearest level of the exact interpolation', () => {
		expect(result.nonTie).toBe(2631233);
		expect(result.nonTieNativeOff).toBe(0);
		expect(result.ties).toBe(343488);
	});

	it('flat spans at a half level: 2^k pixels all up, odd lengths up then down, even ones either', () => {
		expect(result.flat).toEqual({
			'pow2 allUp': 208,
			'odd up-then-down': 1516,
			'even allUp': 71,
			'even up-then-down': 1181,
		});
	});

	it('has the converter right at every non-tie pixel and measures its tie misses', () => {
		expect(result.productionNonTieOff).toBeLessThanOrEqual(0);
		// the centre-relative model (round 9) is right at every non-tie pixel and misses 10,137 of the 343,488 ties (245,641 before)
		expect(result.productionOff).toBeLessThanOrEqual(10137);
	});

	it('is matched at every non-tie pixel by the single-precision weights candidate, which misses 24% of the ties (not shipped)', () => {
		expect(result.candidateNonTieOff).toBe(0);
		expect(result.candidateOff).toBeLessThanOrEqual(81123);
		expect(result.candidateOff).toBeGreaterThan(80000);
	});
});

describe('per-vertex path gradient captures: the candidate against the converter', () => {
	interface VertexCapture { name: string; w: number; h: number; world: number; rotate: number; center: [number, number]; centerArgb: number; points: [number, number][]; colors: number[]; bgra: string }
	const vertexCaptures: VertexCapture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-vertices.json.gz', import.meta.url))).toString());
	function deviceMatrix(c: VertexCapture): TransformMatrix {
		const rad = (c.rotate * Math.PI) / 180;
		const cs = Math.cos(rad), sn = Math.sin(rad), w = c.world;
		return [cs * w, sn * w, -sn * w, cs * w, c.w / 2 - (cs * c.w) / 2 + (sn * c.h) / 2, c.h / 2 - (sn * c.w) / 2 - (cs * c.h) / 2];
	}
	it('lifts the 174,084 painted pixels from 171,194 to 172,759 exact (98.34% to 99.24%)', () => {
		let native = 0, exactProduction = 0, exactCandidate = 0;
		for (const c of vertexCaptures) {
			const shape = { ...shapeOf({ ...c, ra: '' }), focus: null } as EmfPlusPathGradientShape;
			const g = prepareVertexGradient(shape, deviceMatrix(c));
			if (!g) continue;
			const nat = Buffer.from(c.bgra, 'base64');
			for (let y = 0; y < c.h; y++) {
				for (let x = 0; x < c.w; x++) {
					const k = (y * c.w + x) * 4;
					if (nat[k + 3] === 0) continue;
					native++;
					const same = (v: number | null): boolean => {
						if (v === null || v >>> 24 === 0) return false;
						const a = v >>> 24;
						return a === nat[k + 3] && Math.round((((v >>> 16) & 255) * a) / 255) === nat[k + 2] && Math.round((((v >>> 8) & 255) * a) / 255) === nat[k + 1] && Math.round(((v & 255) * a) / 255) === nat[k];
					};
					if (same(vertexGradientColorAt(g, x, y))) exactProduction++;
					if (same(candidateColorAt(g, x, y))) exactCandidate++;
				}
			}
		}
		expect(native).toBe(174084);
		expect(exactProduction).toBeGreaterThanOrEqual(172969); // 171,194 before round 9
		expect(exactCandidate).toBe(172759);
	});
});
