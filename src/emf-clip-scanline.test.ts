/**
 * Exactness coverage for the scanline clip-combination fallback.
 *
 * Every combined region is verified by point sampling at device pixel
 * centres against an independent oracle: each operand shape is replayed onto
 * a real `@napi-rs/canvas` context and queried with `isPointInPath`, so the
 * expected membership comes from Skia's own fill-rule evaluation rather
 * than from the code under test. A final block also clips a real canvas with
 * the combined region and checks the filled pixels.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { canvasGetImageData, createTempCanvas, ensureNodeCanvasModule } from './emf-canvas-helpers';
import {
	applyClipShapes,
	combineClip,
	combineClipRegions,
	rectClipShape,
	replayClipCmds,
	type ClipCombineOp,
	type ClipPathCmd,
	type ClipRegion,
	type ClipShape,
} from './emf-clip-region';
import { deriveClipDomain, flattenClipCmds, scanlineCombineRegions } from './emf-clip-scanline';
import type { CanvasContext } from './emf-types';

const SIZE = 64;
const DOMAIN = { x: 0, y: 0, w: SIZE, h: SIZE };

let oracle: CanvasContext;

beforeAll(async () => {
	await ensureNodeCanvasModule();
	const c = createTempCanvas(SIZE, SIZE);
	if (!c) {
		throw new Error('@napi-rs/canvas backend unavailable');
	}
	oracle = c.ctx;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rect = (x: number, y: number, w: number, h: number) => rectClipShape(x, y, w, h);

function poly(points: Array<[number, number]>, fillRule: CanvasFillRule, simple = false): ClipShape {
	const cmds: ClipPathCmd[] = points.map(([x, y], i) =>
		i === 0 ? { op: 'moveTo', x, y } : { op: 'lineTo', x, y },
	);
	cmds.push({ op: 'closePath' });
	return { cmds, fillRule, simple };
}

/** A self-intersecting five-point star (pentagram) centred at (cx, cy). */
function star(cx: number, cy: number, r: number, fillRule: CanvasFillRule): ClipShape {
	const pts: Array<[number, number]> = [];
	for (let i = 0; i < 5; i++) {
		const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
		pts.push([cx + r * Math.cos(a) + 0.13, cy + r * Math.sin(a) + 0.21]);
	}
	return poly(pts, fillRule);
}

/** A circle built from four cubic Béziers (the classic kappa construction). */
function bezierCircle(cx: number, cy: number, r: number): ClipShape {
	const k = 0.5522847498 * r;
	return {
		cmds: [
			{ op: 'moveTo', x: cx + r, y: cy },
			{ op: 'bezierCurveTo', cp1x: cx + r, cp1y: cy + k, cp2x: cx + k, cp2y: cy + r, x: cx, y: cy + r },
			{ op: 'bezierCurveTo', cp1x: cx - k, cp1y: cy + r, cp2x: cx - r, cp2y: cy + k, x: cx - r, y: cy },
			{ op: 'bezierCurveTo', cp1x: cx - r, cp1y: cy - k, cp2x: cx - k, cp2y: cy - r, x: cx, y: cy - r },
			{ op: 'bezierCurveTo', cp1x: cx + k, cp1y: cy - r, cp2x: cx + r, cp2y: cy - k, x: cx + r, y: cy },
			{ op: 'closePath' },
		],
		fillRule: 'nonzero',
		simple: true,
	};
}

function shapeContains(shape: ClipShape, x: number, y: number): boolean {
	oracle.beginPath();
	replayClipCmds(oracle, shape.cmds);
	return oracle.isPointInPath(x, y, shape.fillRule);
}

function regionContains(region: ClipRegion, x: number, y: number): boolean {
	return !region || region.every((s) => shapeContains(s, x, y));
}

const OPS: Record<ClipCombineOp, (a: boolean, b: boolean) => boolean> = {
	replace: (_a, b) => b,
	intersect: (a, b) => a && b,
	union: (a, b) => a || b,
	xor: (a, b) => a !== b,
	exclude: (a, b) => a && !b,
	complement: (a, b) => b && !a,
};

/**
 * Count pixel centres where `result` disagrees with `current op incoming`
 * according to the canvas oracle.
 */
function mismatches(
	current: ClipRegion,
	incoming: ClipRegion,
	op: ClipCombineOp,
	result: ClipRegion,
): number {
	let bad = 0;
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			const px = x + 0.5;
			const py = y + 0.5;
			const want = OPS[op](regionContains(current, px, py), regionContains(incoming, px, py));
			if (want !== regionContains(result, px, py)) {
				bad++;
			}
		}
	}
	return bad;
}

/** Combine via combineClipRegions and assert an exact, sample-perfect result. */
function expectExact(
	current: ClipRegion,
	incoming: ClipRegion,
	op: ClipCombineOp,
	tolerance = 0,
): ClipRegion {
	const res = combineClipRegions(current, incoming, op, DOMAIN);
	expect(res.exact).toBe(true);
	expect(mismatches(current, incoming, op, res.region)).toBeLessThanOrEqual(tolerance);
	return res.region;
}

const multi = (): ClipShape[] => [rect(4, 4, 36, 36), rect(16, 12, 40, 40)];

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

describe('flattenClipCmds', () => {
	it('closes rect subpaths and restarts at the rect origin', () => {
		const polys = flattenClipCmds([
			{ op: 'rect', x: 1, y: 2, w: 3, h: 4 },
			{ op: 'lineTo', x: 10, y: 2 },
			{ op: 'lineTo', x: 10, y: 10 },
		]);
		expect(polys).toHaveLength(2);
		expect(polys[0]).toEqual([1, 2, 4, 2, 4, 6, 1, 6]);
		expect(polys[1]).toEqual([1, 2, 10, 2, 10, 10]);
	});

	it('treats a leading lineTo as moveTo and drops degenerate subpaths', () => {
		expect(flattenClipCmds([{ op: 'lineTo', x: 1, y: 1 }])).toEqual([]);
		expect(
			flattenClipCmds([
				{ op: 'moveTo', x: 0, y: 0 },
				{ op: 'lineTo', x: 5, y: 5 },
			]),
		).toEqual([]);
	});

	it('flattens Béziers to within tolerance of the true curve', () => {
		const [p] = flattenClipCmds(bezierCircle(32, 32, 20).cmds);
		expect(p.length / 2).toBeGreaterThan(16);
		for (let i = 0; i < p.length; i += 2) {
			// The kappa circle deviates from a true circle by < 0.03% of r.
			expect(Math.abs(Math.hypot(p[i] - 32, p[i + 1] - 32) - 20)).toBeLessThan(0.02);
		}
	});
});

// ---------------------------------------------------------------------------
// Exact combinations that previously degraded
// ---------------------------------------------------------------------------

describe('exact combination of complex regions (scanline fallback)', () => {
	it('union of an intersection with a shape', () => {
		const region = expectExact(multi(), [rect(44, 2, 12, 50)], 'union');
		// Returned as a single simple rect-list shape, composable for later ops.
		expect(region).toHaveLength(1);
		expect(region![0].simple).toBe(true);
		expect(region![0].cmds.every((c) => c.op === 'rect')).toBe(true);
	});

	it('xor of a multi-shape clip with a shape', () => {
		expectExact(multi(), [rect(0, 30, 64, 10)], 'xor');
	});

	it('complement with a multi-shape clip', () => {
		expectExact(multi(), [rect(0, 0, 50, 50)], 'complement');
	});

	it('exclude of a self-overlapping nonzero shape (not invertible by parity)', () => {
		expectExact([rect(2, 2, 60, 60)], [star(32, 32, 28, 'nonzero')], 'exclude', 2);
	});

	it('union and xor with an evenodd self-intersecting shape', () => {
		expectExact(multi(), [star(32, 32, 28, 'evenodd')], 'union', 2);
		expectExact(multi(), [star(32, 32, 28, 'evenodd')], 'xor', 2);
	});

	it('xor of two evenodd shapes stays on the vector fast path and is exact', () => {
		const a = [star(32, 32, 28, 'evenodd')];
		const res = combineClipRegions(a, [star(30, 34, 20, 'evenodd')], 'xor', DOMAIN);
		expect(res.exact).toBe(true);
		expect(res.region![0].fillRule).toBe('evenodd');
		expect(mismatches(a, [star(30, 34, 20, 'evenodd')], 'xor', res.region)).toBeLessThanOrEqual(2);
	});

	it('Bézier shapes: union / xor / complement against a multi-shape clip', () => {
		const circle = bezierCircle(30, 30, 22);
		expectExact(multi(), [circle], 'union', 4);
		expectExact(multi(), [circle], 'xor', 4);
		expectExact(multi(), [circle], 'complement', 4);
	});

	it('arcTo and ellipse commands flatten like the canvas does', () => {
		const rounded: ClipShape = {
			cmds: [
				{ op: 'moveTo', x: 10, y: 6 },
				{ op: 'arcTo', x1: 54, y1: 6, x2: 54, y2: 58, radius: 12 },
				{ op: 'arcTo', x1: 54, y1: 58, x2: 6, y2: 58, radius: 12 },
				{ op: 'lineTo', x: 6, y: 58 },
				{ op: 'closePath' },
			],
			fillRule: 'nonzero',
			simple: false,
		};
		const oval: ClipShape = {
			cmds: [
				{
					op: 'ellipse',
					cx: 30,
					cy: 34,
					rx: 22,
					ry: 12,
					rotation: 0.4,
					startAngle: 0,
					endAngle: Math.PI * 2,
					ccw: false,
				},
			],
			fillRule: 'nonzero',
			simple: false,
		};
		expectExact([rounded], [oval], 'xor', 4);
		expectExact(multi(), [oval], 'union', 4);
	});

	it('path-bracket style clip (nonzero, not simple) combined with every op', () => {
		const path = [star(32, 32, 26, 'nonzero')];
		for (const op of ['union', 'xor', 'exclude', 'complement'] as const) {
			expectExact(path, [rect(10, 20, 44, 20)], op, 2);
		}
	});

	it('handles CLIP_HUGE inverted shapes (clamped to the domain)', () => {
		// rect minus hole, stored as [rect, huge-rect + hole (evenodd)]
		const withHole = combineClip([rect(4, 4, 56, 56)], rect(20, 20, 16, 16), 'exclude').region;
		expect(withHole).toHaveLength(2);
		expectExact(withHole, [rect(24, 0, 8, 64)], 'union');
		expectExact(withHole, [rect(24, 0, 8, 64)], 'xor');
		expectExact(withHole, [rect(0, 30, 64, 4)], 'complement');
		// Infinite XOR a complex region is its (domain-clamped) complement.
		expectExact(withHole, null, 'xor');
		expectExact(withHole, null, 'complement');
	});

	it('multi-shape incoming regions: union / xor / exclude / complement', () => {
		const incoming = [rect(30, 0, 30, 64), rect(0, 26, 64, 20)];
		for (const op of ['union', 'xor', 'exclude', 'complement'] as const) {
			expectExact(multi(), incoming, op);
		}
		// Unclipped current: xor / exclude against a multi-shape operand.
		expectExact(null, incoming, 'xor');
		expectExact(null, incoming, 'exclude');
	});

	it('chains: a scanline result stays composable for further fast-path ops', () => {
		const first = combineClipRegions(multi(), [rect(44, 2, 12, 50)], 'union', DOMAIN).region;
		const second = combineClip(first, rect(0, 0, 32, 64), 'xor', DOMAIN);
		expect(second.exact).toBe(true);
		expect(second.region![0].fillRule).toBe('evenodd'); // vector XOR fast path
		expect(mismatches(first, [rect(0, 0, 32, 64)], 'xor', second.region)).toBe(0);
	});

	it('returns the empty shape when the result is empty', () => {
		const res = combineClipRegions(multi(), [rect(0, 0, 64, 64)], 'exclude', DOMAIN);
		expect(res.exact).toBe(true);
		expect(mismatches(multi(), [rect(0, 0, 64, 64)], 'exclude', res.region)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Domain handling and rect output
// ---------------------------------------------------------------------------

describe('scanline domain and output', () => {
	it('emits y-banded, pairwise disjoint pixel rects', () => {
		const rects = scanlineCombineRegions([rect(0, 0, 10, 10)], [rect(5, 5, 10, 10)], 'union', DOMAIN);
		expect(rects).toEqual([
			{ x: 0, y: 0, w: 10, h: 5 },
			{ x: 0, y: 5, w: 15, h: 5 },
			{ x: 5, y: 10, w: 10, h: 5 },
		]);
	});

	it('samples pixel centres: fractional edges round to the covered pixels', () => {
		const rects = scanlineCombineRegions(null, [rect(0.4, 0.6, 2.2, 1.8)], 'intersect', DOMAIN);
		// Columns with centres in [0.4, 2.6): 0, 1, 2; rows in [0.6, 2.4): 1.
		expect(rects).toEqual([{ x: 0, y: 1, w: 3, h: 1 }]);
	});

	it('clamps results to the domain', () => {
		const rects = scanlineCombineRegions(multi(), null, 'xor', { x: 0, y: 0, w: 8, h: 8 });
		expect(rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 8 && r.y + r.h <= 8)).toBe(true);
	});

	it('derives a default domain from finite geometry, ignoring CLIP_HUGE', () => {
		const withHole = combineClip([rect(4, 4, 56, 56)], rect(20, 20, 16, 16), 'exclude').region;
		expect(deriveClipDomain(withHole)).toEqual({ x: 4, y: 4, w: 56, h: 56 });
		expect(deriveClipDomain(null)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
	});

	it('without a domain, bounded results are exact and unbounded ones are flagged', () => {
		const bounded = combineClip(multi(), rect(44, 2, 12, 50), 'union');
		expect(bounded.exact).toBe(true);
		expect(mismatches(multi(), [rect(44, 2, 12, 50)], 'union', bounded.region)).toBe(0);

		// NOT (nonzero star) is infinite: cut to the geometry box, so inexact.
		const unbounded = combineClip(null, star(32, 32, 20, 'nonzero'), 'xor');
		expect(unbounded.exact).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Real canvas application
// ---------------------------------------------------------------------------

describe('applying a scanline region to a real canvas', () => {
	it('clips a fill to exactly the combined pixels', () => {
		const current = multi();
		const incoming = [bezierCircle(40, 40, 16)];
		const { region } = combineClipRegions(current, incoming, 'xor', DOMAIN);

		const c = createTempCanvas(SIZE, SIZE);
		expect(c).not.toBeNull();
		const { ctx } = c!;
		ctx.save();
		applyClipShapes(ctx, region!);
		ctx.fillStyle = '#ff0000';
		ctx.fillRect(0, 0, SIZE, SIZE);
		ctx.restore();

		const data = canvasGetImageData(ctx, 0, 0, SIZE, SIZE).data;
		let bad = 0;
		for (let y = 0; y < SIZE; y++) {
			for (let x = 0; x < SIZE; x++) {
				const alpha = data[(y * SIZE + x) * 4 + 3];
				// Pixel-aligned rects clip without anti-aliasing: fully on or off.
				expect(alpha === 0 || alpha === 255).toBe(true);
				const want = OPS.xor(
					regionContains(current, x + 0.5, y + 0.5),
					regionContains(incoming, x + 0.5, y + 0.5),
				);
				if (want !== (alpha === 255)) {
					bad++;
				}
			}
		}
		expect(bad).toBeLessThanOrEqual(4);
	});
});
