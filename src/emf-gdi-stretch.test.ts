import { describe, it, expect } from 'vitest';

import { axisSamples, gdiNearest, stretchGdi, BLACKONWHITE, COLORONCOLOR, WHITEONBLACK } from './emf-gdi-stretch';

function row(values: number[]): { width: number; height: number; data: Uint8ClampedArray } {
	const data = new Uint8ClampedArray(values.length * 4);
	values.forEach((v, i) => {
		data[i * 4] = (v >> 16) & 0xff;
		data[i * 4 + 1] = (v >> 8) & 0xff;
		data[i * 4 + 2] = v & 0xff;
		data[i * 4 + 3] = 255;
	});
	return { width: values.length, height: 1, data };
}

function unpack(p: { data: Uint8ClampedArray }): number[] {
	const out: number[] = [];
	for (let i = 0; i < p.data.length; i += 4) {
		out.push((p.data[i] << 16) | (p.data[i + 1] << 8) | p.data[i + 2]);
	}
	return out;
}

describe('gdiNearest', () => {
	it('resolves an exact 2.5x tie upward, as GDI does', () => {
		// dest 12 of 30 from 12 source rows: centre at exactly 5.0.
		expect(gdiNearest(12, 12, 30)).toBe(5);
		expect(gdiNearest(27, 12, 30)).toBe(11);
	});

	it('keeps the pixel under each destination centre when reducing', () => {
		expect([0, 1, 2, 3, 4].map((i) => gdiNearest(i, 13, 5))).toEqual([1, 3, 6, 9, 11]);
	});
});

describe('axisSamples', () => {
	it('absorbs eliminated pixels into the next kept pixel and drops the tail', () => {
		expect(axisSamples(0, 11, 4, false, true)).toEqual([[0, 1], [2, 3, 4], [5, 6], [7, 8, 9]]);
	});

	it('walks the source backwards for a mirrored blit', () => {
		expect(axisSamples(2, 3, 3, true, false)).toEqual([[4], [3], [2]]);
	});
});

describe('stretchGdi', () => {
	const src = row([0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);

	it('ANDs eliminated pixels under BLACKONWHITE and ORs them under WHITEONBLACK', () => {
		expect(unpack(stretchGdi(src, 0, 0, 4, 1, 2, 1, BLACKONWHITE))).toEqual([0x000000, 0x0000ff]);
		expect(unpack(stretchGdi(src, 0, 0, 4, 1, 2, 1, WHITEONBLACK))).toEqual([0xffff00, 0xffffff]);
	});

	it('keeps only the sampled pixel under COLORONCOLOR', () => {
		expect(unpack(stretchGdi(src, 0, 0, 4, 1, 2, 1, COLORONCOLOR))).toEqual([0x00ff00, 0xffffff]);
	});

	it('mirrors when exactly one of the extents is negative', () => {
		expect(unpack(stretchGdi(src, 0, 0, 4, 1, -4, 1, COLORONCOLOR))).toEqual([
			0xffffff, 0x0000ff, 0x00ff00, 0xff0000,
		]);
		expect(unpack(stretchGdi(src, 4, 0, -4, 1, -4, 1, COLORONCOLOR))).toEqual([
			0xff0000, 0x00ff00, 0x0000ff, 0xffffff,
		]);
	});
});
