import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { diffImages, fixturePath, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface NativeCase { w: number; sx: number; sy: number; cap: number; join: number; shape: number; points: number[] }
const cases: NativeCase[] = JSON.parse(gunzipSync(readFileSync(fixturePath('wide-pen-axis-scales.json.gz'))).toString());
it('matches every one of the 3,600 native axis-scaled outlines', () => {
	expect(cases).toHaveLength(3600);
	let exact = 0;
	for (const c of cases) {
		const source = c.shape === 0 ? [[20, 20], [60, 20]] : c.shape === 1 ? [[20, 20], [20, 60]]
			: c.shape === 2 ? [[20, 20], [60, 40]] : [[20, 20], [45, 50], [70, 25]];
		const path = new GdiRasterPath();
		for (const [i, [x, y]] of source.entries()) {
			if (i === 0) path.moveTo(x * c.sx * 16, y * c.sy * 16);
			else path.lineTo(x * c.sx * 16, y * c.sy * 16);
		}
		const polygons: number[][] = [];
		for (let i = 0; i < c.points.length; i += 3) {
			if (c.points[i + 2] === 6) polygons.push([]);
			polygons[polygons.length - 1].push(c.points[i], c.points[i + 1]);
		}
		const native = fillPolygonSpans(polygons, true);
		const actual = fillPolygonSpans(widenPath(path, {
			width: c.w * c.sx * 16, height: c.w * c.sy * 16,
			cap: (['round', 'square', 'flat'] as const)[c.cap],
			join: (['round', 'bevel', 'miter'] as const)[c.join], miterLimit: 10,
		}), true);
		const key = [c.w, c.sx, c.sy, c.cap, c.join, c.shape].join(',');
		if (actual.length === native.length && actual.data.subarray(0, actual.length * 3).every((v, i) => v === native.data[i])) {
			exact++;
			continue;
		}
		expect(actual.data.subarray(0, actual.length * 3), key).toEqual(native.data.subarray(0, native.length * 3));
	}
	expect(exact).toBe(3600);
});

it('renders all 216 native solid axis-scaled pen controls exactly through the converter', async () => {
	for (const width of [4, 8]) for (const [sx, sy] of [[4, 1], [1, 4], [2, 3], [3, 2]]) {
		const name = `pen-axis-scale-${sx}x${sy}-w${width}`;
		const image = await renderFixture(`${name}.emf`);
		expect(image, name).not.toBeNull();
		expect(diffImages(image!, await loadReference(name), 0, 0).mismatched, name).toBe(0);
	}
});

interface DirectionCase extends NativeCase { dx: number; dy: number }
it('matches 16,128 independent native axis-scaled direction and corner controls', () => {
	const controls: DirectionCase[] = JSON.parse(gunzipSync(readFileSync(fixturePath('wide-pen-axis-directions.json.gz'))).toString());
	expect(controls).toHaveLength(16128);
	let exact = 0;
	for (const c of controls) {
		const path = new GdiRasterPath();
		path.moveTo(20 * c.sx * 16, 20 * c.sy * 16);
		path.lineTo((20 + c.dx * 4) * c.sx * 16, (20 + c.dy * 4) * c.sy * 16);
		if (c.shape) path.lineTo((20 + c.dx * 4 - c.dy * 4) * c.sx * 16, (20 + c.dy * 4 + c.dx * 4) * c.sy * 16);
		const polygons: number[][] = [];
		for (let i = 0; i < c.points.length; i += 3) {
			if (c.points[i + 2] === 6) polygons.push([]);
			polygons[polygons.length - 1].push(c.points[i], c.points[i + 1]);
		}
		const native = fillPolygonSpans(polygons, true);
		const actual = fillPolygonSpans(widenPath(path, {
			width: c.w * c.sx * 16, height: c.w * c.sy * 16,
			cap: c.cap === 0 ? 'round' : 'square', join: 'round', miterLimit: 10,
		}), true);
		const key = [c.w, c.sx, c.sy, c.cap, c.shape, c.dx, c.dy].join(',');
		// Fast exact comparison keeps the full native sweep affordable on CI.
		// Expand assertion diagnostics only for a failing control.
		if (actual.length === native.length && actual.data.subarray(0, actual.length * 3).every((v, i) => v === native.data[i])) {
			exact++;
			continue;
		}
		expect(actual.length, key).toBe(native.length);
		expect(actual.data.subarray(0, actual.length * 3), key).toEqual(native.data.subarray(0, native.length * 3));
	}
	expect(exact).toBe(16128);
});
