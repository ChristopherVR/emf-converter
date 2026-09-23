import { describe, it, expect } from 'vitest';

import {
	classifyRop3,
	applyRop3,
	evalRop3,
	rop3Index,
	rop3Operands,
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
	ROP3_MERGECOPY,
	ROP3_MERGEPAINT,
	ROP3_PATCOPY,
	ROP3_PATPAINT,
	ROP3_PATINVERT,
	ROP3_DSTINVERT,
	ROP3_BLACKNESS,
	ROP3_WHITENESS,
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

const P = 0xf0;
const S = 0xcc;
const D = 0xaa;
const mask8 = (v: number): number => v & 0xff;

describe('evalRop3', () => {
	// Evaluating a code on the canonical operand bytes P=0xF0, S=0xCC, D=0xAA
	// must reproduce its own truth-table index: the defining identity of the
	// ROP3 encoding, so every one of the 256 functions is checked.
	it('reproduces the truth-table index for all 256 functions', () => {
		for (let index = 0; index < 256; index++) {
			expect(evalRop3(index, P, S, D, 0xff)).toBe(index);
		}
	});

	it.each([
		[ROP3_SRCCOPY, (p: number, s: number) => s],
		[ROP3_SRCPAINT, (_p: number, s: number, d: number) => s | d],
		[ROP3_SRCAND, (_p: number, s: number, d: number) => s & d],
		[ROP3_SRCINVERT, (_p: number, s: number, d: number) => s ^ d],
		[ROP3_SRCERASE, (_p: number, s: number, d: number) => s & ~d],
		[ROP3_NOTSRCCOPY, (_p: number, s: number) => ~s],
		[ROP3_NOTSRCERASE, (_p: number, s: number, d: number) => ~(s | d)],
		[ROP3_MERGECOPY, (p: number, s: number) => p & s],
		[ROP3_MERGEPAINT, (_p: number, s: number, d: number) => ~s | d],
		[ROP3_PATCOPY, (p: number) => p],
		[ROP3_PATPAINT, (p: number, s: number, d: number) => p | ~s | d],
		[ROP3_PATINVERT, (p: number, _s: number, d: number) => p ^ d],
		[ROP3_DSTINVERT, (_p: number, _s: number, d: number) => ~d],
		[ROP3_BLACKNESS, () => 0],
		[ROP3_WHITENESS, () => 0xff],
	] as const)('matches the documented expression of 0x%s', (rop, fn) => {
		const index = rop3Index(rop);
		for (const [p, s, d] of [
			[0x12, 0x34, 0x56],
			[0xff, 0x00, 0x5a],
			[0x0f, 0xf0, 0x99],
		]) {
			expect(evalRop3(index, p, s, d, 0xff)).toBe(mask8(fn(p, s, d)));
		}
	});

	it('evaluates all three packed channels at once', () => {
		expect(evalRop3(rop3Index(ROP3_SRCINVERT), 0, 0xff00ff, 0x0f0f0f)).toBe(0xf00ff0);
	});
});

describe('rop3Operands', () => {
	it('detects which operands a function reads', () => {
		expect(rop3Operands(rop3Index(ROP3_PATINVERT))).toEqual({ usesP: true, usesS: false, usesD: true });
		expect(rop3Operands(rop3Index(ROP3_MERGECOPY))).toEqual({ usesP: true, usesS: true, usesD: false });
		expect(rop3Operands(rop3Index(ROP3_SRCPAINT))).toEqual({ usesP: false, usesS: true, usesD: true });
		expect(rop3Operands(rop3Index(ROP3_BLACKNESS))).toEqual({ usesP: false, usesS: false, usesD: false });
	});
});

describe('classifyRop3', () => {
	it.each([
		[ROP3_SRCCOPY, { kind: 'copy' }],
		[ROP3_BLACKNESS, { kind: 'solid', color: 'black' }],
		[ROP3_WHITENESS, { kind: 'solid', color: 'white' }],
		[ROP3_DSTINVERT, { kind: 'invert-dest' }],
		[0x00aa0029, { kind: 'noop' }],
	] as const)('uses a Canvas-native plan for 0x%s', (rop, expected) => {
		expect(classifyRop3(rop)).toEqual(expected);
	});

	it('routes every other code, including the pattern ops, to the exact evaluator', () => {
		for (const rop of [ROP3_MERGECOPY, ROP3_PATPAINT, ROP3_PATINVERT, ROP3_SRCPAINT, ROP3_PATCOPY]) {
			const plan = classifyRop3(rop);
			expect(plan.kind).toBe('ternary');
		}
	});

	it('ignores the low word, as Windows does', () => {
		expect(classifyRop3(0x00cc0000)).toEqual({ kind: 'copy' });
		expect(classifyRop3(0x005a0000)).toEqual(classifyRop3(ROP3_PATINVERT));
	});
});

describe('applyRop3', () => {
	it('combines P, S and D per pixel and forces alpha opaque', () => {
		const dst = makeImageData([[0b1100, 0, 0x10, 0]], 1);
		const src = makeImageData([[0b1010, 0xff, 0x01, 0]], 1);
		applyRop3(dst, src, 0x0f00ff, rop3Index(ROP3_PATPAINT), 0, 0);
		// P | ~S | D per channel.
		expect(Array.from(dst.data)).toEqual([0x0f | (~0b1010 & 0xff) | 0b1100, 0, 0xff, 255]);
	});

	it('samples a pattern function at canvas coordinates offset by the rect origin', () => {
		const dst = makeImageData(
			[
				[0, 0, 0, 255],
				[0, 0, 0, 255],
			],
			2,
		);
		const seen: Array<[number, number]> = [];
		applyRop3(
			dst,
			null,
			(x, y) => {
				seen.push([x, y]);
				return x === 11 ? 0xffffff : 0;
			},
			rop3Index(ROP3_PATINVERT),
			10,
			5,
		);
		expect(seen).toEqual([
			[10, 5],
			[11, 5],
		]);
		expect(Array.from(dst.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
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
