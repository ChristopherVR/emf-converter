import { describe, expect, it } from 'vitest';
import { halftoneBranch, halftoneColorKey } from './emf-gdi-halftone-branch';
import { halftoneFilterDouble, halftoneFilterEnlarge, halftoneFilterSupported, stretchHalftone } from './emf-gdi-stretch';

/** RGB triples of a w x h image whose pixel (x, y) is `colour(x, y)`. */
function image(w: number, h: number, colour: (x: number, y: number) => [number, number, number]): Int32Array {
	const out = new Int32Array(w * h * 3);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(colour(x, y), (y * w + x) * 3);
	return out;
}
/** A colour that is never grey-ish: distinct for distinct `n` below 65,536 and with red != blue. */
const distinct = (n: number): [number, number, number] => [(n * 7 + 1) & 255, (n >> 2) & 255, (n * 13 + 5) & 255].map((v, i) => (i === 2 && v === ((n * 7 + 1) & 255) ? v ^ 1 : v)) as [number, number, number];

describe('halftoneBranch', () => {
	it('always replicates up to 2,304 pixels, however many colours', () => {
		expect(halftoneBranch(image(48, 48, (x, y) => distinct(y * 48 + x)), 48, 48)).toBe('replicate');
		expect(halftoneBranch(image(2304, 1, (x) => distinct(x)), 2304, 1)).toBe('replicate');
	});
	it('counts 20 colours in every sixth row above 16,384 pixels', () => {
		const w = 128, h = 129;
		// Row 6 is sampled; row 5 is not.
		const rowWith = (row: number, colours: number) => image(w, h, (x, y) => (y === row && x < colours ? distinct(x + 1) : [0, 0, 0]));
		expect(halftoneBranch(rowWith(6, 18), w, h)).toBe('replicate'); // 18 colours + black = 19
		expect(halftoneBranch(rowWith(6, 19), w, h)).toBe('filter'); // 19 colours + black = 20
		expect(halftoneBranch(rowWith(5, 60), w, h)).toBe('replicate');
		expect(halftoneBranch(rowWith(0, 60), w, h)).toBe('filter');
	});
	it('needs 145 + floor(o / 16) colours in the dense regime and 20 colours with 2,304 coloured pixels', () => {
		// 256 x 16: rows = 10, o = 256, limit 161 colours counted in raster order.
		const block = (colours: number) => image(256, 16, (x, y) => (y * 256 + x < colours ? distinct(y * 256 + x + 1) : [0, 0, 0]));
		expect(halftoneBranch(block(159), 256, 16)).toBe('replicate'); // 159 + black = 160
		expect(halftoneBranch(block(160), 256, 16)).toBe('filter');
		// Ten rows that each introduce a colour make 2,560 coloured pixels: filtered with only 20 colours.
		const stripes = (rowsWithColour: number) => image(256, 16, (x, y) => (y < rowsWithColour ? distinct((y * 2 + (x & 1)) + 1) : distinct(1)));
		expect(halftoneBranch(stripes(9), 256, 16)).toBe('replicate');
		expect(halftoneBranch(stripes(10), 256, 16)).toBe('filter');
	});
	it('gives up once duplicate rows have used the budget', () => {
		// 256 x 16: 160 colours and then identical rows. Seven rows of repeats exhaust the budget before the 161st colour.
		const late = (row: number) => image(256, 16, (x, y) => (y === row && x === 0 ? distinct(900) : distinct(1 + (x % 160))));
		expect(halftoneBranch(late(6), 256, 16)).toBe('filter');
		expect(halftoneBranch(late(7), 256, 16)).toBe('replicate');
	});
	it('applies the exact-height rule when the height is the least row count past 2,304 pixels', () => {
		// 64 x 37: 297 colours filter; 64 x 36 is below 2,304 + 1 pixels.
		expect(halftoneBranch(image(64, 37, (x, y) => distinct(y * 64 + x)), 64, 37)).toBe('filter');
		expect(halftoneBranch(image(64, 36, (x, y) => distinct(y * 64 + x)), 64, 36)).toBe('replicate');
		// 100 x 24 with a hundred fresh colours in every row gives up after three rows (300 >= 300) before the 301st colour...
		expect(halftoneBranch(image(100, 24, (x, y) => distinct(y * 100 + x)), 100, 24)).toBe('replicate');
		// ...while a few fresh colours per row never use the budget and the 20-colour rule filters at the last row.
		expect(halftoneBranch(image(100, 24, (x, y) => distinct(y * 2 + (x % 2))), 100, 24)).toBe('filter');
		// One duplicate row before the colours that are needed already gives up: 200 x 12, 200 + 101 colours.
		const burst = (duplicates: number) => image(200, 12, (x, y) => (y === 0 ? distinct(x) : y <= duplicates ? distinct(x) : y === duplicates + 1 ? [(x * 3 + 2) & 255, 200, 19] : distinct(x)));
		expect(halftoneBranch(burst(0), 200, 12)).toBe('filter');
		expect(halftoneBranch(burst(1), 200, 12)).toBe('replicate');
	});
	it('identifies colours of equal red and blue by blue and green >> 2', () => {
		expect(halftoneColorKey(40, 60, 40)).toBe(halftoneColorKey(43, 63, 43));
		expect(halftoneColorKey(40, 60, 41)).not.toBe(halftoneColorKey(40, 60, 40));
	});
});

describe('the filtered 2x branch of stretchHalftone', () => {
	const ramp = (w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } => {
		const data = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...distinct(y * w + x), 255], (y * w + x) * 4);
		return { width: w, height: h, data };
	};
	it('interpolates sharpened samples 3:1 instead of replicating when the source has many colours', () => {
		const src = ramp(64, 40);
		const out = stretchHalftone(src, 0, 0, 64, 40, 128, 80);
		const rgb = new Int32Array(64 * 40 * 3);
		for (let i = 0; i < 64 * 40; i++) rgb.set([src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2]], i * 3);
		const expected = halftoneFilterDouble(rgb, 64, 40);
		for (let i = 0; i < 128 * 80; i++) {
			expect([out.data[i * 4], out.data[i * 4 + 1], out.data[i * 4 + 2], out.data[i * 4 + 3]]).toEqual([expected[i * 3], expected[i * 3 + 1], expected[i * 3 + 2], 255]);
		}
	});
	it('keeps replicating a source with few colours, a mirrored blit and a different ratio', () => {
		const flat = { width: 64, height: 40, data: new Uint8ClampedArray(64 * 40 * 4).fill(200) };
		const replicated = stretchHalftone(flat, 0, 0, 64, 40, 128, 80);
		expect([...replicated.data.subarray(0, 4)]).toEqual([200, 200, 200, 255]);
		const src = ramp(64, 40);
		const filtered = stretchHalftone(src, 0, 0, 64, 40, 128, 80);
		const mirrored = stretchHalftone(src, 0, 0, 64, 40, -128, 80);
		expect(mirrored.data).not.toEqual(filtered.data);
		// A 2.5x enlargement (a fractional ratio up to 5x) is still replicated: no destination
		// pixel is a colour the source does not hold.
		const fractional = stretchHalftone(src, 0, 0, 64, 40, 160, 100);
		const colours = new Set<number>();
		for (let i = 0; i < 64 * 40; i++) colours.add((src.data[i * 4] << 16) | (src.data[i * 4 + 1] << 8) | src.data[i * 4 + 2]);
		for (let i = 0; i < 160 * 100; i++) {
			expect(colours.has((fractional.data[i * 4] << 16) | (fractional.data[i * 4 + 1] << 8) | fractional.data[i * 4 + 2])).toBe(true);
		}
	});
	it('interpolates a 3x enlargement with the sharpened 1/16 weights', () => {
		const src = ramp(64, 40);
		const out = stretchHalftone(src, 0, 0, 64, 40, 192, 120);
		const rgb = new Int32Array(64 * 40 * 3);
		for (let i = 0; i < 64 * 40; i++) rgb.set([src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2]], i * 3);
		const expected = halftoneFilterEnlarge(rgb, 64, 40, 192, 120);
		for (let i = 0; i < 192 * 120; i++) {
			expect([out.data[i * 4], out.data[i * 4 + 1], out.data[i * 4 + 2]]).toEqual([expected[i * 3], expected[i * 3 + 1], expected[i * 3 + 2]]);
		}
		expect(halftoneFilterSupported(64, 40, 192, 120)).toBe(true);
		expect(halftoneFilterSupported(64, 40, 160, 100)).toBe(false);
		expect(halftoneFilterSupported(64, 40, 352, 220)).toBe(true);
	});
});
