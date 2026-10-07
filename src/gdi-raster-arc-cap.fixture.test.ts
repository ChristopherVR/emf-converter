import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiRasterPath } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface Sweep {
	width: number;
	start: number;
	sweep: number;
	source: number[];
	expected: number[];
}

const sweeps: Sweep[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/arc-cap-sweep.json.gz', import.meta.url))).toString());

/** The native GetPath triples (`x, y, type`) as a path: a move, then Beziers (`arc-cap-sweep-probe`). */
function pathOf(source: number[]): GdiRasterPath {
	const pts: number[] = [];
	for (let i = 0; i < source.length; i += 3) pts.push(source[i], source[i + 1]);
	const path = new GdiRasterPath();
	path.addBeziers(pts, true);
	return path;
}

function outlines(points: number[]): number[][] {
	const polygons: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) polygons.push([]);
		polygons[polygons.length - 1].push(points[i], points[i + 1]);
	}
	return polygons;
}

describe('native WidenPath of square-capped arcs swept over the end angle', () => {
	it('captures 1,436 arcs on a 100 px circle: two widths, two start angles, every whole-degree sweep', () => {
		expect(sweeps).toHaveLength(1436);
	});

	it('reproduces every outline vertex: the cap extension is the end tangent cut down to whole pixels', () => {
		// The extension is the tangent scaled to half the width over the length of its whole-pixel vector (components
		// shifted right by four, rounding toward minus infinity), ties rounded away from zero: it shortens by up to a fifth
		// on tiny arcs and by a few FIX on large ones, where the unrounded rule left only 576 start caps exact.
		let exact = 0;
		for (const c of sweeps) {
			const ours = widenPath(pathOf(c.source), { width: c.width * 16, cap: 'square', join: 'round', miterLimit: 10, wholePixelDashVectors: true });
			if (JSON.stringify(ours) === JSON.stringify(outlines(c.expected))) exact++;
		}
		expect(exact).toBeGreaterThanOrEqual(1436);
	});
});
