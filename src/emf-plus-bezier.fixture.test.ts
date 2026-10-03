import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { flattenBezierGdiplus, gdiplusFix } from './emf-plus-bezier';
import { parseEmfPlusBrushObject } from './emf-plus-brush-parser';

type Point = [number, number, number];
const cases = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/gdiplus-bezier-flatten.json.gz', import.meta.url))).toString()) as Array<{ source: Point[]; flat: Point[] }>;

it('matches every native GraphicsPath.Flatten vertex in 64 random curves and an ellipse', () => {
	let vertices = 0;
	for (const item of cases) {
		const fixed = item.source.flatMap(([x, y]) => [gdiplusFix(x), gdiplusFix(y)]);
		const actual = fixed.slice(0, 2);
		for (let i = 0; i + 6 < fixed.length; i += 6) {
			const parameters: number[] = [];
			const segment: number[] = [];
			flattenBezierGdiplus(fixed.slice(i, i + 8), segment, undefined, parameters);
			expect(parameters.length).toBe(segment.length / 2);
			expect(parameters.at(-1)).toBe(1);
			for (let j = 0; j < parameters.length; j++) expect(parameters[j]).toBeGreaterThan(j ? parameters[j - 1] : 0);
			actual.push(...segment);
		}
		expect(actual.map((v) => v / 16)).toEqual(item.flat.flatMap(([x, y]) => [x, y]));
		vertices += actual.length / 2;
	}
	expect(vertices).toBe(1556);
});

it('parses native flattened curve boundaries into path-gradient brushes', () => {
	for (const item of cases) {
		const count = item.source.length;
		const pathSize = 12 + count * 9;
		const view = new DataView(new ArrayBuffer(40 + pathSize));
		view.setUint32(0, 0xdbc01002, true);
		view.setUint32(4, 3, true); // PathGradient
		view.setUint32(8, 1, true); // Embedded path
		view.setUint32(12, 4, true); // Clamp
		view.setUint32(16, 0xffffffff, true);
		view.setUint32(28, 1, true);
		view.setUint32(32, 0xff000000, true);
		view.setUint32(36, pathSize, true);
		view.setUint32(40, 0xdbc01002, true);
		view.setUint32(44, count, true);
		for (let i = 0; i < count; i++) {
			view.setFloat32(52 + i * 8, item.source[i][0], true);
			view.setFloat32(56 + i * 8, item.source[i][1], true);
			view.setUint8(52 + count * 8 + i, item.source[i][2]);
		}
		const brush = parseEmfPlusBrushObject(view, 0, view.byteLength)!;
		expect(brush.gradient?.type).toBe('radial');
		if (brush.gradient?.type !== 'radial') throw new Error('Missing path gradient');
		const expected = item.flat.map(([x, y]) => ({ x, y }));
		if (expected.length > 1 && expected[0].x === expected.at(-1)!.x && expected[0].y === expected.at(-1)!.y) expected.pop();
		expect(brush.gradient.shape!.boundary).toEqual(expected);
		expect(brush.gradient.shape!.boundaryArgb).toEqual(expected.map(() => 0xff000000));
	}
});
