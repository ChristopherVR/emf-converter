import { describe, expect, it } from 'vitest';
import nativePaths from './__fixtures__/gdi/wide-path-fix.json';
import nativeOutlines from './__fixtures__/gdi/wide-outline-fix.json';
import nativeMiterLimits from './__fixtures__/gdi/miter-limits.json';
import { GdiRasterPath, fillPolygonSpans } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';
import { ellipseRasterPath } from './emf-gdi-raster-shapes';
import { axisBox } from './gdi-raster';

function nativePolygons(points: number[]): number[][] {
	const polygons: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) polygons.push([]);
		polygons[polygons.length - 1].push(points[i], points[i + 1]);
	}
	return polygons;
}

it('bounds the remaining fill differences across all 2,136 native wide paths', () => {
	expect(nativePaths).toHaveLength(2136);
	let differences = 0;
	for (const c of nativePaths) {
		const path = new GdiRasterPath();
		path.moveTo(c.source[0], c.source[1]);
		for (let i = 2; i < c.source.length; i += 2) path.lineTo(c.source[i], c.source[i + 1]);
		const actual = fillPolygonSpans(widenPath(path, {
			width: c.width * 16, cap: (['round', 'square', 'flat'] as const)[c.cap],
			join: (['round', 'bevel', 'miter'] as const)[c.join], miterLimit: 10,
		}), true);
		const expected = fillPolygonSpans(nativePolygons(c.expected), true);
		if (actual.length !== expected.length || actual.data.subarray(0, actual.length * 3).some((v, i) => v !== expected.data[i])) differences++;
	}
	expect(differences).toBeLessThanOrEqual(2);
});

describe('native miter limits', () => {
	it('matches 766 of 768 decisions around measured thresholds in eight orientations', () => {
		expect(nativeMiterLimits).toHaveLength(384);
		let differences = 0;
		for (const c of nativeMiterLimits) {
			const path = new GdiRasterPath();
			for (const [index, point] of [[20, 100], [100, 100], [20, 100 + c.delta]].entries()) {
				let x = point[0] - 100, y = point[1] - 100;
				if (c.mirror) y = -y;
				for (let rotation = 0; rotation < c.rotation; rotation++) [x, y] = [-y, x];
				if (index === 0) path.moveTo((100 + x) * 16, (100 + y) * 16);
				else path.lineTo((100 + x) * 16, (100 + y) * 16);
			}
			for (const [limit, expectedCount] of [[c.below, c.belowCount], [c.above, c.aboveCount]]) {
				const outline = widenPath(path, { width: c.width * 16, cap: 'flat', join: 'miter', miterLimit: Math.fround(limit) });
				if (outline[0].length / 2 !== expectedCount) differences++;
			}
		}
		// The two retained decisions share the known 7px perpendicular error.
		expect(differences).toBeLessThanOrEqual(2);
	});

	for (const width of [2, 5]) for (const cap of [1, 2]) {
		it(`matches every ${width}px miter fill with cap ${cap}, including near reversals`, () => {
			const cases = nativePaths.filter(c => c.width === width && c.cap === cap && c.join === 2);
			expect(cases).toHaveLength(57);
			for (const c of cases) {
				const path = new GdiRasterPath();
				path.moveTo(c.source[0], c.source[1]);
				for (let i = 2; i < c.source.length; i += 2) path.lineTo(c.source[i], c.source[i + 1]);
				const actual = fillPolygonSpans(widenPath(path, { width: width * 16, cap: cap === 1 ? 'square' : 'flat', join: 'miter', miterLimit: 10 }), true);
				const expected = fillPolygonSpans(nativePolygons(c.expected), true);
				expect(Array.from(actual.data.subarray(0, actual.length * 3))).toEqual(Array.from(expected.data.subarray(0, expected.length * 3)));
			}
		});
	}

	it('rounds a negative miter half away from zero', () => {
		const c = nativePaths[35];
		const path = new GdiRasterPath();
		path.moveTo(c.source[0], c.source[1]);
		for (let i = 2; i < c.source.length; i += 2) path.lineTo(c.source[i], c.source[i + 1]);
		const actual = fillPolygonSpans(widenPath(path, { width: c.width * 16, cap: 'round', join: 'miter', miterLimit: 10 }), true);
		const expected = fillPolygonSpans(nativePolygons(c.expected), true);
		expect(Array.from(actual.data.subarray(0, actual.length * 3))).toEqual(Array.from(expected.data.subarray(0, expected.length * 3)));
	});
});

describe('wide round joins against native WidenPath at 1/16-pixel precision', () => {
	for (const width of [2, 5, 7, 8, 12, 16, 32, 64]) {
		it(`matches every round-cap, round-join fill at width ${width}`, () => {
			const cases = nativePaths.filter(c => c.width === width && c.cap === 0 && c.join === 0);
			expect(cases).toHaveLength(16);
			for (const c of cases) {
				const path = new GdiRasterPath();
				path.moveTo(c.source[0], c.source[1]);
				for (let i = 2; i < c.source.length; i += 2) path.lineTo(c.source[i], c.source[i + 1]);
				const actual = fillPolygonSpans(widenPath(path, { width: width * 16, cap: 'round', join: 'round', miterLimit: 10 }), true);
				const expected = fillPolygonSpans(nativePolygons(c.expected), true);
				expect(Array.from(actual.data.subarray(0, actual.length * 3)), `path ${c.source.join(',')}`).toEqual(Array.from(expected.data.subarray(0, expected.length * 3)));
			}
		});
	}
});

describe('native Ellipse WidenPath outlines', () => {
	for (const c of nativeOutlines.filter(c => c.shape === 1)) {
		it(`matches every outline vertex at width ${c.width}, cap ${c.cap}, join ${c.join}`, () => {
			const path = ellipseRasterPath(axisBox(110 * 16, 15 * 16, 184 * 16, 99 * 16));
			const actual = widenPath(path, {
				width: c.width * 16, cap: (['round', 'square', 'flat'] as const)[c.cap],
				join: (['round', 'bevel', 'miter'] as const)[c.join], miterLimit: 10,
			});
			expect(actual).toEqual(nativePolygons(c.expected));
		});
	}
});
