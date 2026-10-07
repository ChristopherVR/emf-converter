import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiRasterPath, fillPolygonSpans, type SpanList } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface Sweep {
	width: number;
	start: number;
	tenths: number;
	cap: number;
	join: number;
	source: number[];
	expected: number[];
}

const sweeps: Sweep[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/chord-sweep.json.gz', import.meta.url))).toString());

/** The native GetPath triples of a chord (`x, y, type`) as a closed path: a move, one Bezier, a closing line (`chord-sweep-probe`). */
function pathOf(source: number[]): GdiRasterPath {
	const pts: number[] = [];
	for (let i = 0; i < source.length; i += 3) pts.push(source[i], source[i + 1]);
	const path = new GdiRasterPath();
	path.addBeziers(pts, true);
	path.closeFigure();
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

function pixelSet(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) {
		for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	}
	return set;
}

describe('native WidenPath of chords on arcs of 1 to 15 degrees', () => {
	it('captures 1,044 chords: two widths, two start angles, 29 sweeps, every cap and join', () => {
		expect(sweeps).toHaveLength(1044);
	});

	it('fills every outline identically: a one-segment chord is a closed two-vertex polygon, joins and no caps', () => {
		let exactFills = 0;
		let exactVertices = 0;
		for (const c of sweeps) {
			const ours = widenPath(pathOf(c.source), {
				width: c.width * 16,
				cap: (['round', 'square', 'flat'] as const)[c.cap],
				join: (['round', 'bevel', 'miter'] as const)[c.join],
				miterLimit: 10,
				wholePixelDashVectors: true,
			});
			const native = outlines(c.expected);
			if (JSON.stringify(ours) === JSON.stringify(native)) exactVertices++;
			const a = pixelSet(fillPolygonSpans(ours, true));
			const n = pixelSet(fillPolygonSpans(native, true));
			let differing = 0;
			for (const v of a) if (!n.has(v)) differing++;
			for (const v of n) if (!a.has(v)) differing++;
			if (differing === 0) exactFills++;
		}
		// Before: the retraced two-vertex figure was an open polyline with caps (528 of the 1,044 fills differed, 35,105 pixels; 4 of the 240 curve-widen chords
		// differed). Native draws the same outline pieces in another order and start (and repeats a vertex), so only the
		// 248 chords of three or more flattened vertices are vertex for vertex identical.
		expect(exactFills).toBeGreaterThanOrEqual(1044);
		expect(exactVertices).toBeGreaterThanOrEqual(248);
	});
});
