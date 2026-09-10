import { describe, it, expect } from 'vitest';

import {
	classifyRop3,
	applyRop3Bitwise,
	invertImageDataRgb,
	clampPositiveRect,
} from './emf-rop3';
import {
	ROP3_SRCCOPY,
	ROP3_SRCPAINT,
	ROP3_SRCAND,
	ROP3_SRCINVERT,
	ROP3_SRCERASE,
	ROP3_NOTSRCCOPY,
	ROP3_NOTSRCERASE,
	ROP3_PATCOPY,
	ROP3_DSTINVERT,
	ROP3_BLACKNESS,
	ROP3_WHITENESS,
	ROP3_MERGEPAINT,
	ROP3_MERGECOPY,
} from './emf-constants';

function makeImageData(pixels: Array<[number, number, number, number]>, width: number): ImageData {
	const data = new Uint8ClampedArray(pixels.length * 4);
	pixels.forEach(([r, g, b, a], i) => {
		data[i * 4] = r;
		data[i * 4 + 1] = g;
		data[i * 4 + 2] = b;
		data[i * 4 + 3] = a;
	});
	return { data, width, height: pixels.length / width, colorSpace: 'srgb' } as ImageData;
}

describe('classifyRop3', () => {
	it.each([
		[ROP3_SRCCOPY, { kind: 'copy' }],
		[ROP3_BLACKNESS, { kind: 'solid', color: 'black' }],
		[ROP3_WHITENESS, { kind: 'solid', color: 'white' }],
		[ROP3_PATCOPY, { kind: 'pattern' }],
		[ROP3_NOTSRCCOPY, { kind: 'invert-source' }],
		[ROP3_DSTINVERT, { kind: 'invert-dest' }],
		[ROP3_SRCPAINT, { kind: 'bitwise', op: 'or' }],
		[ROP3_SRCAND, { kind: 'bitwise', op: 'and' }],
		[ROP3_SRCINVERT, { kind: 'bitwise', op: 'xor' }],
		[ROP3_SRCERASE, { kind: 'bitwise', op: 'src-and-not-dst' }],
		[ROP3_NOTSRCERASE, { kind: 'bitwise', op: 'not-src-and-not-dst' }],
		[ROP3_MERGEPAINT, { kind: 'bitwise', op: 'not-src-or-dst' }],
	] as const)('classifies 0x%s correctly', (rop, expected) => {
		expect(classifyRop3(rop)).toEqual(expected);
	});

	it('degrades an unrecognised code to a plain copy', () => {
		expect(classifyRop3(0x12345678)).toEqual({ kind: 'copy' });
	});

	it('degrades MERGECOPY (a pattern-bitmap op this converter does not realise) to a plain copy', () => {
		expect(classifyRop3(ROP3_MERGECOPY)).toEqual({ kind: 'copy' });
	});
});

describe('applyRop3Bitwise', () => {
	it('computes OR (SRCPAINT) per channel and forces alpha to 255', () => {
		const dst = makeImageData([[0b1100, 0, 0, 128]], 1);
		const src = makeImageData([[0b1010, 0, 0, 0]], 1);
		applyRop3Bitwise(dst, src, 'or');
		expect(Array.from(dst.data)).toEqual([0b1110, 0, 0, 255]);
	});

	it('computes AND (SRCAND) per channel', () => {
		const dst = makeImageData([[0b1100, 255, 0, 255]], 1);
		const src = makeImageData([[0b1010, 0, 255, 255]], 1);
		applyRop3Bitwise(dst, src, 'and');
		expect(Array.from(dst.data)).toEqual([0b1000, 0, 0, 255]);
	});

	it('computes XOR (SRCINVERT)', () => {
		const dst = makeImageData([[0b1100, 0, 0, 255]], 1);
		const src = makeImageData([[0b1010, 0, 0, 255]], 1);
		applyRop3Bitwise(dst, src, 'xor');
		expect(dst.data[0]).toBe(0b0110);
	});

	it('computes src & ~dst (SRCERASE)', () => {
		const dst = makeImageData([[0b1100, 0, 0, 255]], 1);
		const src = makeImageData([[0b1010, 0, 0, 255]], 1);
		applyRop3Bitwise(dst, src, 'src-and-not-dst');
		// src=1010, ~dst=~1100=...0011 (mod 256) -> 1010 & 0x03 low bits considered via &0xff
		expect(dst.data[0]).toBe(0b1010 & (~0b1100 & 0xff));
	});

	it('computes ~src | dst (MERGEPAINT)', () => {
		const dst = makeImageData([[0b1100, 0, 0, 255]], 1);
		const src = makeImageData([[0b1010, 0, 0, 255]], 1);
		applyRop3Bitwise(dst, src, 'not-src-or-dst');
		expect(dst.data[0]).toBe((~0b1010 & 0xff) | 0b1100);
	});

	it('computes ~(src | dst) (NOTSRCERASE)', () => {
		const dst = makeImageData([[0b1100, 0, 0, 255]], 1);
		const src = makeImageData([[0b1010, 0, 0, 255]], 1);
		applyRop3Bitwise(dst, src, 'not-src-and-not-dst');
		expect(dst.data[0]).toBe(~(0b1010 | 0b1100) & 0xff);
	});

	it('combines every pixel when src/dst have more than one', () => {
		const dst = makeImageData(
			[
				[255, 0, 0, 255],
				[0, 255, 0, 255],
			],
			2,
		);
		const src = makeImageData(
			[
				[0, 255, 0, 255],
				[255, 0, 0, 255],
			],
			2,
		);
		applyRop3Bitwise(dst, src, 'or');
		expect(Array.from(dst.data)).toEqual([255, 255, 0, 255, 255, 255, 0, 255]);
	});
});

describe('invertImageDataRgb', () => {
	it('inverts RGB and leaves alpha untouched', () => {
		const data = makeImageData([[0, 100, 255, 200]], 1);
		invertImageDataRgb(data);
		expect(Array.from(data.data)).toEqual([255, 155, 0, 200]);
	});

	it('inverts every pixel', () => {
		const data = makeImageData(
			[
				[0, 0, 0, 255],
				[255, 255, 255, 255],
			],
			2,
		);
		invertImageDataRgb(data);
		expect(Array.from(data.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
	});
});

describe('clampPositiveRect', () => {
	it('leaves an already-positive, in-bounds rect unchanged', () => {
		expect(clampPositiveRect(10, 20, 30, 40, 200, 200)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
	});

	it('normalises a horizontally flipped rect (negative width)', () => {
		expect(clampPositiveRect(50, 20, -30, 10, 200, 200)).toEqual({ x: 20, y: 20, w: 30, h: 10 });
	});

	it('normalises a vertically flipped rect (negative height)', () => {
		expect(clampPositiveRect(10, 50, 30, -20, 200, 200)).toEqual({ x: 10, y: 30, w: 30, h: 20 });
	});

	it('clamps a rect extending past the canvas bounds', () => {
		expect(clampPositiveRect(180, 180, 50, 50, 200, 200)).toEqual({
			x: 180,
			y: 180,
			w: 20,
			h: 20,
		});
	});

	it('clamps a rect starting before the canvas origin', () => {
		expect(clampPositiveRect(-10, -10, 30, 30, 200, 200)).toEqual({ x: 0, y: 0, w: 20, h: 20 });
	});

	it('returns null when the rect has no on-canvas area', () => {
		expect(clampPositiveRect(300, 300, 10, 10, 200, 200)).toBeNull();
		expect(clampPositiveRect(10, 10, 0, 10, 200, 200)).toBeNull();
	});

	it('rounds fractional coordinates', () => {
		expect(clampPositiveRect(10.4, 10.6, 20.5, 20.5, 200, 200)).toEqual({
			x: 10,
			y: 11,
			w: 21,
			h: 21,
		});
	});
});
