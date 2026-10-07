import { describe, expect, it } from 'vitest';
import nativeCurves from './__fixtures__/gdi/curve-widen.json';
import { GdiRasterPath, axisBox, fillPolygonSpans, type SpanList } from './gdi-raster';
import { arcRasterPath } from './emf-gdi-raster-shapes';
import { widenPath } from './gdi-raster-widen';

function nativePolygons(points: number[]): number[][] {
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

/** Pixels in which Windows' `WidenPath` outline and the converter's differ. */
function differingPixels(c: (typeof nativeCurves)[number]): number {
	const path = new GdiRasterPath();
	if (c.kind === 'bezier') {
		path.addBeziers((c.points as number[]).map((v) => v * 16), true);
	} else {
		const [l, t, r, b] = (c.box as number[]).map((v) => v * 16);
		const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) =>
			(b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
		const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
		const radials = c.radials as number[];
		arcRasterPath(axisBox(l, t, r - 16, b - 16), radial(radials[0], radials[1]), radial(radials[2], radials[3]), false, c.kind as 'arc' | 'chord' | 'pie', undefined, path);
	}
	const ours = pixelSet(fillPolygonSpans(widenPath(path, {
		width: c.width * 16, cap: (['round', 'square', 'flat'] as const)[c.cap], join: (['round', 'bevel', 'miter'] as const)[c.join], miterLimit: 10,
	}), true));
	const native = pixelSet(fillPolygonSpans(nativePolygons(c.expected), true));
	let diff = 0;
	for (const v of ours) if (!native.has(v)) diff++;
	for (const v of native) if (!ours.has(v)) diff++;
	return diff;
}

describe('native WidenPath of wide curves', () => {
	it('matches every Bezier under flat, square and round caps and every join', () => {
		const beziers = nativeCurves.filter((c) => c.kind === 'bezier');
		expect(beziers).toHaveLength(80);
		const exact = beziers.filter((c) => differingPixels(c) === 0).length;
		expect(exact).toBeGreaterThanOrEqual(80);
	});

	it('matches arcs and pies exactly except for one arc, and chords except for four near-reversals', () => {
		const rest = nativeCurves.filter((c) => c.kind !== 'bezier');
		expect(rest).toHaveLength(240);
		const perKind: Record<string, { differing: number; total: number }> = {};
		for (const c of rest) {
			const d = differingPixels(c);
			const k = (perKind[c.kind] ??= { differing: 0, total: 0 });
			k.total += d;
			if (d > 0) k.differing++;
		}
		// Measured: 5 of 240 curves differ in 316 pixels (before: 148 in 1,437). A curve end's square-cap extension is its end
		// tangent cut down to whole pixels (the dash measure), a line meeting a curve end takes the curve's tangent perpendicular,
		// and the join inside one flattened cubic keeps its own pen vertices. Remaining: a chord whose arc nearly retraces it
		// (three cases, 284 pixels) and one square-capped miter arc (32 pixels).
		expect(perKind.pie).toEqual({ differing: 0, total: 0 });
		expect(perKind.arc.differing).toBeLessThanOrEqual(1);
		expect(perKind.arc.total).toBeLessThanOrEqual(32);
		expect(perKind.chord.differing).toBeLessThanOrEqual(4);
		expect(perKind.chord.total).toBeLessThanOrEqual(284);
	});
});
