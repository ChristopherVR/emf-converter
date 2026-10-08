import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { flattenBezierGdiplus, gdiplusFix } from './emf-plus-bezier';
import { pathGradientQuantum } from './emf-plus-brush-gradient';
import { pathGradientSampler } from './emf-plus-exact-fill';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/**
 * GDI+ paints a path gradient as nested copies of its boundary, so its colour
 * is one of `ceil(2 * hypot(w, h))` steps for the device-space bounds `w` x `h`
 * (`pathGradientQuantum`). `PathGradientStepProbe.cs` captured whole rows
 * through white-to-black rectangles and 100x80 images of rectangles, triangles
 * and ellipses over colour/alpha pairs, a Blend curve, an InterpolationColors
 * preset, a focus, and world/brush scales (`path-gradient-steps.json.gz`).
 */
interface Capture {
	kind: 'row' | 'image';
	shape: string | number;
	variant?: string;
	world?: number;
	brushScale?: number;
	w?: number;
	h?: number;
	row?: number;
	center: [number, number];
	a: number;
	b: number;
	blend?: { positions: number[]; factors: number[] };
	preset?: { positions: number[]; argb: number[] };
	focus?: [number, number];
	points: [number, number][];
	types: string;
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-steps.json.gz', import.meta.url))).toString());

/** The flattened boundary: curves flatten at GDI+'s flatness in device pixels. */
function boundaryOf(c: Capture, scale: number): { x: number; y: number }[] {
	const types = Buffer.from(c.types, 'base64');
	const boundary: { x: number; y: number }[] = [];
	for (let k = 0; k < c.points.length; k++) {
		if ((types[k] & 7) === 3 && k > 0 && k + 2 < c.points.length) {
			const curve = c.points.slice(k - 1, k + 3).flatMap(([x, y]) => [gdiplusFix(x * scale), gdiplusFix(y * scale)]);
			const flat: number[] = [];
			boundary[boundary.length - 1] = { x: curve[0] / 16 / scale, y: curve[1] / 16 / scale };
			flattenBezierGdiplus(curve, flat);
			for (let p = 0; p < flat.length; p += 2) boundary.push({ x: flat[p] / 16 / scale, y: flat[p + 1] / 16 / scale });
			k += 2;
		} else {
			boundary.push({ x: c.points[k][0], y: c.points[k][1] });
		}
		if (types[k] & 128) break;
	}
	if (boundary.length > 1 && boundary[0].x === boundary[boundary.length - 1].x && boundary[0].y === boundary[boundary.length - 1].y) boundary.pop();
	return boundary;
}

function render(c: Capture): { exact: number; overOne: number; pixels: number } {
	const world = c.world ?? 1;
	const brush = c.brushScale ?? 1;
	const boundary = boundaryOf(c, world * brush);
	const shape: EmfPlusPathGradientShape = {
		boundary,
		center: { x: c.center[0], y: c.center[1] },
		centerArgb: c.a,
		boundaryArgb: boundary.map(() => c.b),
		focus: c.focus ? { x: c.focus[0], y: c.focus[1] } : null,
		blend: c.blend ?? null,
		preset: c.preset ?? null,
		transform: brush !== 1 ? ([brush, 0, 0, brush, 0, 0] as TransformMatrix) : null,
	};
	const sampler = pathGradientSampler(shape, 'clamp', [world, 0, 0, world, 0, 0])!;
	const width = c.kind === 'row' ? c.w! : 100;
	const height = c.kind === 'row' ? 1 : 80;
	const rgba = new Uint8ClampedArray(width * height * 4);
	sampler(0, c.kind === 'row' ? c.row! : 0, width, height, rgba);
	const native = Buffer.from(c.bgra, 'base64');
	let exact = 0;
	let overOne = 0;
	for (let p = 0; p < width * height; p++) {
		let difference = 0;
		for (let channel = 0; channel < 4; channel++) {
			const k = p * 4;
			const actual = channel === 3 ? rgba[k + 3] : Math.round(rgba[k + channel] * rgba[k + 3] / 255);
			difference = Math.max(difference, Math.abs(actual - native[k + (channel === 3 ? 3 : 2 - channel)]));
		}
		if (difference === 0) exact++;
		if (difference > 1) overOne++;
	}
	return { exact, overOne, pixels: width * height };
}

describe('path-gradient step quantisation', () => {
	it('counts steps from the device-space bounding box', () => {
		const rectangle = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 80 }, { x: 0, y: 80 }];
		// 4 * half the diagonal, rounded up.
		expect(pathGradientQuantum(rectangle)).toBe(1211);
		// Scales act on the device size.
		expect(pathGradientQuantum(rectangle, [0.5, 0, 0, 0.5, 0, 0])).toBe(606);
		expect(pathGradientQuantum(rectangle, [2, 0, 0, 2, 5, 7])).toBe(2422);
		// A diagonal that is a whole number of quarter pixels is not rounded past itself.
		expect(pathGradientQuantum([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 800 }, { x: 0, y: 800 }])).toBe(2000);
		expect(pathGradientQuantum([])).toBe(0);
	});

	// Exact pixels / pixels per group, and pixels more than one level off. Pixels
	// that are not exact sit where the ratio is exactly half way between two steps
	// (which side native paints depends on its float edge arithmetic) or within a
	// hundredth of a level of a rounding boundary; the over-one rows are the same
	// half-way ties in rectangles so small that one step is several levels.
	const pinned: Record<string, [number, number, number]> = {
		rows: [25394, 25568, 20],
		'image 0 plain': [31770, 32000, 0],
		'image 0 world2': [31770, 32000, 0],
		'image 0 world0.5': [15885, 16000, 0],
		'image 0 brush2': [15885, 16000, 0],
		'image 0 focus': [16000, 16000, 0],
		'image 0 blend': [7945, 8000, 0],
		'image 0 preset': [7940, 8000, 0],
		'image 1 plain': [31996, 32000, 0],
		'image 1 world2': [31996, 32000, 0],
		'image 1 world0.5': [15998, 16000, 0],
		'image 1 brush2': [15998, 16000, 0],
		'image 1 focus': [15996, 16000, 0],
		'image 1 blend': [7999, 8000, 0],
		'image 1 preset': [7999, 8000, 0],
		'image 2 plain': [31992, 32000, 0],
		'image 2 world2': [31992, 32000, 0],
		'image 2 world0.5': [15996, 16000, 0],
		'image 2 brush2': [15996, 16000, 0],
		'image 2 focus': [16000, 16000, 0],
		'image 2 blend': [7998, 8000, 0],
		'image 2 preset': [7998, 8000, 0],
		'image 3 plain': [32000, 32000, 0],
		'image 3 world2': [32000, 32000, 0],
		'image 3 world0.5': [16000, 16000, 0],
		'image 3 brush2': [16000, 16000, 0],
		'image 3 focus': [16000, 16000, 0],
		'image 3 blend': [7962, 8000, 0],
		'image 3 preset': [8000, 8000, 0],
	};

	it('reproduces native rows and images of rectangles, triangles and ellipses', () => {
		expect(captures).toHaveLength(72 + 64);
		const groups: Record<string, [number, number, number]> = {};
		for (const c of captures) {
			const key = c.kind === 'row' ? 'rows' : `image ${c.shape} ${c.variant}`;
			const result = render(c);
			const group = (groups[key] ??= [0, 0, 0]);
			group[0] += result.exact;
			group[1] += result.pixels;
			group[2] += result.overOne;
		}
		expect(Object.keys(groups).sort()).toEqual(Object.keys(pinned).sort());
		for (const [key, [exact, pixels, overOne]] of Object.entries(pinned)) {
			expect(groups[key][1], key).toBe(pixels);
			expect(groups[key][0], key).toBeGreaterThanOrEqual(exact);
			expect(groups[key][2], key).toBeLessThanOrEqual(overOne);
		}
	});
});

interface SetCapture {
	points: [number, number][];
	types?: string;
	center: [number, number];
	focus?: [number, number];
	wrap?: number;
	a: number;
	b?: number;
	boundaryArgb?: number[];
	varying?: number;
	color?: number;
	bgra: string;
}

function readSet(name: string): SetCapture[] {
	return JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
}

/** Pixels the sampler reproduces to the level, compared the way each earlier test compares its capture. */
function exactPixels(
	c: SetCapture,
	centerArgb: number,
	surround: number[],
	mode: 'premultiplied' | 'red' | 'rgb',
): number {
	const boundary = c.types
		? boundaryOf(c as unknown as Capture, 1)
		: c.points.map(([x, y]) => ({ x, y }));
	const wraps = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy', 'clamp'] as const;
	const sampler = pathGradientSampler({
		boundary,
		center: { x: c.center[0], y: c.center[1] },
		centerArgb,
		boundaryArgb: surround.length ? surround : boundary.map(() => c.b!),
		focus: c.focus ? { x: c.focus[0], y: c.focus[1] } : null,
		blend: null, preset: null, transform: null,
	}, wraps[c.wrap ?? 4], [1, 0, 0, 1, 0, 0])!;
	const rgba = new Uint8ClampedArray(100 * 80 * 4);
	sampler(0, 0, 100, 80, rgba);
	const native = Buffer.from(c.bgra, 'base64');
	let exact = 0;
	for (let p = 0; p < 8000; p++) {
		const k = p * 4;
		let difference = 0;
		if (mode === 'premultiplied') {
			for (let channel = 0; channel < 4; channel++) {
				const actual = channel === 3 ? rgba[k + 3] : Math.round(rgba[k + channel] * rgba[k + 3] / 255);
				difference = Math.max(difference, Math.abs(actual - native[k + (channel === 3 ? 3 : 2 - channel)]));
			}
		} else if (mode === 'red') {
			difference = Math.abs((rgba[k + 3] ? rgba[k] : 255) - native[k]);
		} else {
			for (let channel = 0; channel < 3; channel++) {
				difference = Math.max(difference, Math.abs((rgba[k + 3] ? rgba[k + channel] : 255) - native[k + 2 - channel]));
			}
		}
		if (difference === 0) exact++;
	}
	return exact;
}

describe('exact pixels across the earlier path-gradient captures', () => {
	// Exact pixel counts before the step quantisation are in the comments.
	it('keeps the colour captures exact to the step', () => {
		const colors = readSet('path-gradient-colors.json.gz');
		let opaque = 0;
		let translucent = 0;
		for (const c of colors) {
			const exact = exactPixels(c, c.a, [], 'premultiplied');
			if (c.color! <= 1) opaque += exact; else translucent += exact;
		}
		expect(opaque).toBeGreaterThanOrEqual(596053); // 595655 with the smooth tie, 497349 of 640000 before the steps
		expect(translucent).toBeGreaterThanOrEqual(218385); // 217832, then 197700 of 320000 before
	});

	it('keeps the alpha captures exact to the step', () => {
		const alpha = readSet('path-gradient-alpha.json.gz');
		const totals: Record<string, number> = {};
		for (const c of alpha) {
			const anisotropic = !!c.focus && c.focus[0] !== c.focus[1];
			const key = `${c.varying ? 'varying' : 'uniform'} ${anisotropic ? 'anisotropic' : c.focus && c.focus[0] > 0 ? 'isotropic' : 'no'} focus`;
			totals[key] = (totals[key] ?? 0) + exactPixels(c, c.a, c.boundaryArgb!, 'premultiplied');
		}
		expect(totals['uniform no focus']).toBeGreaterThanOrEqual(319858); // 318577, then 282949 before
		expect(totals['uniform isotropic focus']).toBeGreaterThanOrEqual(319785); // 318583, then 292048 before
		// Varying surrounds are Gouraud fan triangles (246132, 246030 and 245704 before).
		expect(totals['uniform anisotropic focus']).toBeGreaterThanOrEqual(319529); // 289797 before the copies
		expect(totals['varying no focus']).toBeGreaterThanOrEqual(319926);
		expect(totals['varying isotropic focus']).toBeGreaterThanOrEqual(319913);
		expect(totals['varying anisotropic focus']).toBeGreaterThanOrEqual(319600);
	});

	it('keeps the focus contours exact to the step when the focus is isotropic', () => {
		const contours = readSet('path-gradient-focus-contours.json.gz');
		let isotropic = 0;
		let anisotropic = 0;
		for (const c of contours) {
			const exact = exactPixels(c, 0xffffffff, [0xff000000, 0xff000000, 0xff000000], 'red');
			if (c.focus![0] === c.focus![1]) isotropic += exact; else anisotropic += exact;
		}
		expect(isotropic).toBeGreaterThanOrEqual(287982); // 269712 of 288000 before
		expect(anisotropic).toBeGreaterThanOrEqual(1725250); // 1594271 before the copies
		const lines = readSet('path-gradient-vertical-focus-line.json.gz');
		let line = 0;
		for (const c of lines) line += exactPixels(c, 0xffc06020, [0xff2080c0, 0xff2080c0, 0xff2080c0], 'rgb');
		expect(line).toBeGreaterThanOrEqual(863072); // 811118 before the copies
	});
});
