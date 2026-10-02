import { describe, expect, it } from 'vitest';
import nativeDashes from './__fixtures__/gdi/curve-dash.json';
import { GdiRasterPath, axisBox, fillPolygonSpans, geometricStyle, type SpanList } from './gdi-raster';
import { arcRasterPath } from './emf-gdi-raster-shapes';
import { widenPath } from './gdi-raster-widen';

type Sample = (typeof nativeDashes)[number];

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

/** Pixels in which Windows' `WidenPath` outline of the dashed pen and the converter's differ. */
function differingPixels(c: Sample, wholePixelDashVectors: boolean): number {
	const path = new GdiRasterPath();
	if (c.kind === 'bezier') {
		path.addBeziers((c.points as number[]).map((v) => v * 16), true);
	} else {
		const [l, t, r, b] = (c.box as number[]).map((v) => v * 16);
		const onBox = (x: number, r0: number, r1: number, b0: number, b1: number) =>
			(b0 + b1) / 2 + (r1 !== r0 ? ((x - (r0 + r1) / 2) * (b1 - b0)) / (r1 - r0) : x - (r0 + r1) / 2);
		const radial = (x: number, y: number): [number, number] => [onBox(x * 16, l, r, l, r - 16), onBox(y * 16, t, b, t, b - 16)];
		const radials = c.radials as number[];
		arcRasterPath(axisBox(l, t, r - 16, b - 16), radial(radials[0], radials[1]), radial(radials[2], radials[3]), false, 'arc', undefined, path);
	}
	const dashes = geometricStyle(0x10000 | c.style, c.width, c.dashes as number[]);
	const ours = pixelSet(fillPolygonSpans(widenPath(path, {
		width: c.width * 16,
		cap: (['round', 'square', 'flat'] as const)[c.cap],
		join: 'round',
		miterLimit: 10,
		dashes: dashes ? dashes.map((v) => v * 16) : null,
		shortenDashes: c.style !== 7,
		wholePixelDashVectors,
	}), true));
	const native = pixelSet(fillPolygonSpans(nativePolygons(c.expected), true));
	let diff = 0;
	for (const v of ours) if (!native.has(v)) diff++;
	for (const v of native) if (!ours.has(v)) diff++;
	return diff;
}

function summary(cap: number | null, wholePixelDashVectors: boolean): { differing: number; total: number } {
	let differing = 0;
	let total = 0;
	for (const c of nativeDashes) {
		if (cap !== null && c.cap !== cap) continue;
		const d = differingPixels(c, wholePixelDashVectors);
		total += d;
		if (d > 0) differing++;
	}
	return { differing, total };
}

describe('native WidenPath of dashed wide pens on curves', () => {
	it('captures 300 Beziers and arcs under every stock and user dash style and cap', () => {
		expect(nativeDashes).toHaveLength(300);
	});

	it('is exact for round caps, which only needs the whole-pixel segment measure', () => {
		// Windows measures each segment of a flattened curve from its vector cut down to whole pixels;
		// measured exactly, nearly every one of the 300 differs (tens of thousands of pixels in all).
		const exact = summary(null, false);
		expect(exact.differing).toBeGreaterThanOrEqual(290);
		expect(exact.total).toBeGreaterThan(50000);
		expect(summary(0, true)).toEqual({ differing: 0, total: 0 });
	});

	it('keeps flat and square caps within a few pixels of the native outlines', () => {
		// Flat: 14 of 100 differ by 48 pixels, almost all arcs. Square: 78 of 100 by 524 (path-end caps and arcs remain).
		const flat = summary(2, true);
		expect(flat.differing).toBeLessThanOrEqual(14);
		expect(flat.total).toBeLessThanOrEqual(48);
		const square = summary(1, true);
		expect(square.differing).toBeLessThanOrEqual(78);
		expect(square.total).toBeLessThanOrEqual(524);
	});
});
