import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { convertMetafileToSvg } from './index';
import {
	buildLinearRampTable,
	foldRampCoordinate,
	linearRampIntervals,
	linearRampOf,
	linearRampSampler,
	linearRampStops,
	writeRampColor,
} from './emf-plus-linear-ramp';
import type { EmfPlusLinearGradient, EmfPlusLinearRamp } from './emf-types';

const BLACK = 0xff000000;
const WHITE = 0xffffffff;

function ramp(overrides: Partial<EmfPlusLinearRamp> = {}): EmfPlusLinearRamp {
	return { startArgb: BLACK, endArgb: WHITE, preset: null, blend: null, gammaCorrected: false, ...overrides };
}

/** Red channel of knot `k`. */
function knotR(table: ReturnType<typeof buildLinearRampTable>, k: number): number {
	return table.knots[k * 4];
}

describe('linearRampIntervals', () => {
	it('uses 16 intervals for a ramp of at most three points', () => {
		expect(linearRampIntervals(2, { x: 0, y: 0, w: 8000, h: 10 })).toBe(16);
		expect(linearRampIntervals(3, { x: 0, y: 0, w: 8000, h: 10 })).toBe(16);
	});

	it('sizes a longer ramp by the brush rectangle w + h (measured thresholds 128 and 512)', () => {
		expect(linearRampIntervals(5, { x: 0, y: 0, w: 64, h: 64 })).toBe(16);
		expect(linearRampIntervals(5, { x: 0, y: 0, w: 64, h: 64.5 })).toBe(64);
		expect(linearRampIntervals(5, { x: 0, y: 0, w: 256, h: 256 })).toBe(64);
		expect(linearRampIntervals(5, { x: 0, y: 0, w: 256, h: 257 })).toBe(256);
	});
});

describe('buildLinearRampTable', () => {
	it('rounds a plain two-colour ramp to knots at k/16, halves up', () => {
		const t = buildLinearRampTable(ramp(), { x: 0, y: 0, w: 100, h: 10 });
		expect(t.intervals).toBe(16);
		expect(knotR(t, 1)).toBe(16); // 15.94
		expect(knotR(t, 8)).toBe(128); // 127.5
		expect(knotR(t, 9)).toBe(143); // 143.44
		expect(knotR(t, 16)).toBe(255);
	});

	it('never reaches a preset peak that falls between knots', () => {
		const t = buildLinearRampTable(
			ramp({ preset: { positions: [0, 0.3, 1], argb: [BLACK, WHITE, BLACK] } }),
			{ x: 0, y: 0, w: 100, h: 10 },
		);
		const peak = Math.max(...Array.from({ length: 17 }, (_, k) => knotR(t, k)));
		// Knot 5 (t = 0.3125) is the nearest: 255 * (1 - 0.0125 / 0.7) = 250.45.
		expect(peak).toBe(250);
	});

	it('evaluates a gamma-corrected ramp in linear light', () => {
		const t = buildLinearRampTable(ramp({ gammaCorrected: true }), { x: 0, y: 0, w: 100, h: 10 });
		expect(knotR(t, 1)).toBe(72); // 255 * (1/16)^(1/2.2)
		expect(knotR(t, 8)).toBe(186);
	});

	it('forms Blend knots the way GDI+ tips exact halves', () => {
		// Blend 0 -> 0.8 at 0.3: knot 1 is factor 1/6, R 212.5 and B 42.5 exactly,
		// which GDI+ paints as 212 and 42.
		const t = buildLinearRampTable(
			ramp({
				startArgb: 0xffff0000,
				endArgb: 0xff0000ff,
				// As recorded: float32 positions and factors.
				blend: { positions: [0, Math.fround(0.3), 1], factors: [0, Math.fround(0.8), 1] },
			}),
			{ x: 0, y: 0, w: 100, h: 10 },
		);
		expect(t.knots[4]).toBe(212);
		expect(t.knots[6]).toBe(42);
	});

	it('premultiplies translucent knots', () => {
		const t = buildLinearRampTable(ramp({ startArgb: 0x00ff0000, endArgb: 0xff0000ff }), { x: 0, y: 0, w: 10, h: 1 });
		expect(Array.from(t.knots.subarray(0, 4))).toEqual([0, 0, 0, 0]);
		expect(Array.from(t.knots.subarray(8 * 4, 8 * 4 + 4))).toEqual([0, 0, 128, 128]);
	});
});

describe('linearRampOf / linearRampStops', () => {
	it('rebuilds a two-colour ramp from hand-built stops', () => {
		const grad: EmfPlusLinearGradient = {
			type: 'linear',
			x1: 0,
			y1: 0,
			x2: 10,
			y2: 0,
			stops: [
				{ offset: 0, color: 'black', argb: BLACK },
				{ offset: 1, color: 'white', argb: WHITE },
			],
			wrapMode: 'tile',
		};
		expect(linearRampOf(grad)).toEqual(ramp());
	});

	it('emits one stop per knot', () => {
		const stops = linearRampStops(buildLinearRampTable(ramp(), { x: 0, y: 0, w: 10, h: 1 }));
		expect(stops).toHaveLength(17);
		expect(stops[8]).toMatchObject({ offset: 0.5, color: 'rgba(128,128,128,1)' });
	});
});

describe('fixed-point sampling', () => {
	it('folds a TileFlipX coordinate into a doubled period read through the mirrored table', () => {
		const one = 65536;
		expect(foldRampCoordinate(-one, 16, 'tile')).toBe(15 * one);
		expect(foldRampCoordinate(17 * one, 16, 'tile-flip-x')).toBe(17 * one);
		const t = buildLinearRampTable(ramp(), { x: 0, y: 0, w: 16, h: 1 });
		const out = new Uint8ClampedArray(4);
		writeRampColor(t, 17 * one, out, 0);
		// Mirrored: knot 17 reads knot 15.
		expect(out[0]).toBe(knotR(t, 15));
	});

	it('interpolates knots per pixel with 8 fraction bits, as GDI+ does', () => {
		// 8192 px wide ramp: level 1 starts at x = 16, level 128 at 4080, level 144 at 4624.
		const grad: EmfPlusLinearGradient = {
			type: 'linear',
			x1: 0,
			y1: 0,
			x2: 8192,
			y2: 0,
			stops: [],
			wrapMode: 'tile',
			rect: { x: 0, y: 0, w: 8192, h: 1 },
			ramp: ramp(),
		};
		const sampler = linearRampSampler(grad, [1, 0, 0, 1, 0, 0], false)!;
		const px = (x: number): number => {
			const out = new Uint8ClampedArray(4);
			sampler(x, 0, 1, 1, out);
			return out[0];
		};
		expect([px(15), px(16)]).toEqual([0, 1]);
		expect([px(4079), px(4080)]).toEqual([127, 128]);
		expect([px(4623), px(4624)]).toEqual([143, 144]);
	});
});

describe('SVG output of a linear gradient', () => {
	it('keeps a vector <linearGradient> whose stops are GDI+ table knots', async () => {
		const b = readFileSync(fixturePath('gpx-lin-preset5-large.emf'));
		const svg = (await convertMetafileToSvg(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))!;
		expect(svg).toContain('<linearGradient');
		expect(svg).not.toContain('<image');
		// Five presets on a 120 x 40 rectangle: a 64-interval table, 65 knots.
		const stops = svg.match(/<stop /g) ?? [];
		expect(stops.length).toBeGreaterThanOrEqual(65);
	});
});
