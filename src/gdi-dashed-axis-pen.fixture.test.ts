/**
 * Native `WidenPath` of dashed geometric pens under unequal axis scales (`dashed-pen-axis-probe`, 2,160 outlines: stock dash
 * styles and a user style, every cap, three line directions, widths 2 to 8 at scales 0.5 to 4 on each axis). The dash
 * pattern is laid out in logical space (a horizontal dash scales with the x scale only) along an elliptical nib.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, geometricStyle } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface NativeCase {
	w: number;
	sx: number;
	sy: number;
	cap: number;
	style: number;
	shape: number;
	points: number[];
}
const cases: NativeCase[] = JSON.parse(gunzipSync(readFileSync(fixturePath('dashed-pen-axis-scales.json.gz'))).toString());
const SOURCES = [
	[
		[10, 10],
		[70, 10],
	],
	[
		[10, 10],
		[10, 70],
	],
	[
		[10, 10],
		[60, 40],
	],
];

function ours(c: NativeCase): number[][] {
	const path = new GdiRasterPath();
	SOURCES[c.shape].forEach(([x, y], i) => (i === 0 ? path.moveTo(x * c.sx * 16, y * c.sy * 16) : path.lineTo(x * c.sx * 16, y * c.sy * 16)));
	const dashes = geometricStyle(0x10000 | c.style, c.w, [6, 3, 2, 3], 1);
	return widenPath(path, {
		width: c.w * c.sx * 16,
		height: c.w * c.sy * 16,
		cap: (['round', 'square', 'flat'] as const)[c.cap],
		join: 'round',
		miterLimit: 10,
		dashes: dashes ? dashes.map((v) => v * 16) : null,
		shortenDashes: c.style !== 7,
		dashMetric: [c.sx, c.sy],
	});
}
function nativePolygons(c: NativeCase): number[][] {
	const polygons: number[][] = [];
	for (let i = 0; i < c.points.length; i += 3) {
		if (c.points[i + 2] === 6) polygons.push([]);
		polygons[polygons.length - 1].push(c.points[i], c.points[i + 1]);
	}
	return polygons;
}

it('matches every one of the 2,160 native dashed axis-scaled outlines', () => {
	expect(cases).toHaveLength(2160);
	for (const c of cases) {
		const a = fillPolygonSpans(ours(c), true);
		const n = fillPolygonSpans(nativePolygons(c), true);
		const key = JSON.stringify({ w: c.w, sx: c.sx, sy: c.sy, cap: c.cap, style: c.style, shape: c.shape });
		expect(n.length, key).toBeGreaterThan(0);
		if (a.length === n.length && a.data.subarray(0, a.length * 3).every((v, i) => v === n.data[i])) {
			continue;
		}
		expect(a.data.subarray(0, a.length * 3), key).toEqual(n.data.subarray(0, n.length * 3));
	}
});
