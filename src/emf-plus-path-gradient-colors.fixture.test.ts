import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { gdiplusFix, flattenBezierGdiplus } from './emf-plus-bezier';
import { pathGradientSampler } from './emf-plus-exact-fill';
import type { EmfPlusGradientWrapMode } from './emf-types';

interface Capture {
	points: [number, number][];
	types: string;
	center: [number, number];
	focus?: [number, number];
	wrap?: number;
	a: number;
	b?: number;
	boundaryArgb?: number[];
	bgra: string;
}
const bounds: Record<string, [number, number, number, number][]> = JSON.parse(readFileSync(
	new URL('./__fixtures__/gdi/path-gradient-color-bounds.json', import.meta.url), 'utf8',
));

function boundaryOf(c: Capture): { x: number; y: number }[] {
	const types = Buffer.from(c.types, 'base64');
	const boundary: { x: number; y: number }[] = [];
	for (let k = 0; k < c.points.length; k++) {
		if ((types[k] & 7) === 3 && k > 0 && k + 2 < c.points.length) {
			const curve = c.points.slice(k - 1, k + 3).flatMap(([x, y]) => [gdiplusFix(x), gdiplusFix(y)]);
			const flat: number[] = [];
			boundary[boundary.length - 1] = { x: curve[0] / 16, y: curve[1] / 16 };
			flattenBezierGdiplus(curve, flat);
			for (let p = 0; p < flat.length; p += 2) boundary.push({ x: flat[p] / 16, y: flat[p + 1] / 16 });
			k += 2;
		} else {
			boundary.push({ x: c.points[k][0], y: c.points[k][1] });
		}
		if (types[k] & 128) break;
	}
	if (boundary.length > 1 && boundary[0].x === boundary[boundary.length - 1].x && boundary[0].y === boundary[boundary.length - 1].y) boundary.pop();
	return boundary;
}

function compare(c: Capture): [number, number, number, number] {
	const boundary = boundaryOf(c);
	const wraps: EmfPlusGradientWrapMode[] = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy', 'clamp'];
	const sampler = pathGradientSampler({
		boundary, center: { x: c.center[0], y: c.center[1] }, centerArgb: c.a,
		boundaryArgb: c.boundaryArgb ?? boundary.map(() => c.b!),
		focus: c.focus ? { x: c.focus[0], y: c.focus[1] } : null,
		blend: null, preset: null, transform: null,
	}, wraps[c.wrap ?? 4], [1, 0, 0, 1, 0, 0])!;
	const rgba = new Uint8ClampedArray(100 * 80 * 4);
	sampler(0, 0, 100, 80, rgba);
	const native = Buffer.from(c.bgra, 'base64');
	let count = 0, sum = 0, maximum = 0, overOne = 0;
	for (let p = 0; p < 8000; p++) {
		let difference = 0;
		for (let channel = 0; channel < 4; channel++) {
			const k = p * 4;
			const actual = channel === 3 ? rgba[k + 3] : Math.round(rgba[k + channel] * rgba[k + 3] / 255);
			difference = Math.max(difference, Math.abs(actual - native[k + (channel === 3 ? 3 : 2 - channel)]));
		}
		if (difference) count++;
		if (difference > 1) overOne++;
		sum += difference;
		maximum = Math.max(maximum, difference);
	}
	return [count, sum, maximum, overOne];
}

for (const [name, length] of [['colors', 120], ['alpha', 240]] as const) {
	it(`preserves per-case premultiplied native path-gradient bounds for ${length} ${name} controls`, () => {
		const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(
			new URL(`./__fixtures__/gdi/path-gradient-${name}.json.gz`, import.meta.url),
		)).toString());
		expect(captures).toHaveLength(length);
		expect(bounds[name]).toHaveLength(length);
		// Every ceiling is min(old, corrected). These retain opaque and varying
		// surrounds, reverse vertex orders, focus contours and all wrap modes.
		for (const [i, capture] of captures.entries()) {
			const metrics = compare(capture);
			for (let metric = 0; metric < 4; metric++) {
				expect(metrics[metric], `${name} capture ${i}, metric ${metric}`).toBeLessThanOrEqual(bounds[name][i][metric]);
			}
		}
	});
}
