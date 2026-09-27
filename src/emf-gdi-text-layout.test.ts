import { describe, it, expect } from 'vitest';

import {
	cumulativeGlyphOffsets,
	totalGlyphAdvance,
	applyTextJustification,
	alignmentStartOffset,
	escapementToCanvasRadians,
	resolveFontPixelHeight,
} from './emf-gdi-text-layout';

describe('cumulativeGlyphOffsets', () => {
	it('returns [0] for a single-entry Dx array', () => {
		expect(cumulativeGlyphOffsets([20])).toEqual([0]);
	});

	it('accumulates advances for each subsequent glyph', () => {
		expect(cumulativeGlyphOffsets([10, 20, 5])).toEqual([0, 10, 30]);
	});

	it('returns an empty array for an empty Dx array', () => {
		expect(cumulativeGlyphOffsets([])).toEqual([]);
	});
});

describe('applyTextJustification', () => {
	it('spreads positive extra over spaces using DDA rounding', () => {
		expect(applyTextJustification([4, 3, 4, 3, 4], [65, 32, 66, 32, 67], 5, 2)).toEqual([4, 6, 4, 5, 4]);
	});

	it('distributes negative extra with signed rounding and leaves non-breaks alone', () => {
		expect(applyTextJustification([4, 3, 4, 3, 4], [65, 32, 66, 32, 67], -5, 2)).toEqual([4, 1, 4, 0, 4]);
	});

	it('leaves advances untouched when there are no space breaks', () => {
		expect(applyTextJustification([7, 9], [65, 66], 10, 2)).toEqual([7, 9]);
	});

	it('does not mutate advances and preserves DDA shares when spaces exceed the count', () => {
		const dx = [2, 3, 4];
		expect(applyTextJustification(dx, [32, 32, 32], 2, 2)).toEqual([3, 4, 5]);
		expect(dx).toEqual([2, 3, 4]);
	});
});

describe('totalGlyphAdvance', () => {
	it('sums every entry, including the last', () => {
		expect(totalGlyphAdvance([10, 20, 5])).toBe(35);
	});

	it('returns 0 for an empty array', () => {
		expect(totalGlyphAdvance([])).toBe(0);
	});
});

describe('alignmentStartOffset', () => {
	it('is 0 for left alignment', () => {
		expect(alignmentStartOffset(100, 'left')).toBe(0);
	});

	it('is -half the width for center alignment', () => {
		expect(alignmentStartOffset(100, 'center')).toBe(-50);
	});

	it('is -the full width for right alignment', () => {
		expect(alignmentStartOffset(100, 'right')).toBe(-100);
	});
});

describe('escapementToCanvasRadians', () => {
	it('is 0 for 0 tenths of a degree', () => {
		// -0 in practice (0 negated), which is `=== 0` and thus a no-rotation
		// case for every caller, but toBe()'s Object.is would fail on it.
		expect(escapementToCanvasRadians(0)).toBeCloseTo(0, 10);
		expect(escapementToCanvasRadians(0) === 0).toBe(true);
	});

	it('negates a 90 degree (900 tenths) escapement to -PI/2', () => {
		expect(escapementToCanvasRadians(900)).toBeCloseTo(-Math.PI / 2, 10);
	});

	it('negates a 45 degree (450 tenths) escapement to -PI/4', () => {
		expect(escapementToCanvasRadians(450)).toBeCloseTo(-Math.PI / 4, 10);
	});

	it('handles a negative (clockwise-authored) escapement', () => {
		expect(escapementToCanvasRadians(-900)).toBeCloseTo(Math.PI / 2, 10);
	});

	it('does not wrap a full 360 degree (3600 tenths) escapement (no modulo applied)', () => {
		expect(escapementToCanvasRadians(3600)).toBeCloseTo(-2 * Math.PI, 10);
	});
});

describe('resolveFontPixelHeight', () => {
	it('returns 0 for a zero height (caller applies its own fallback)', () => {
		expect(resolveFontPixelHeight(0)).toBe(0);
	});

	it('returns the exact magnitude for a negative (character-height) value', () => {
		expect(resolveFontPixelHeight(-24)).toBe(24);
		expect(resolveFontPixelHeight(-1)).toBe(1);
	});

	it('divides a positive (cell-height) value by the documented approximation ratio', () => {
		// 23 / 1.15 = 20 exactly.
		expect(resolveFontPixelHeight(23)).toBeCloseTo(20, 10);
	});

	it('a positive cell-height value resolves smaller than the same magnitude character height', () => {
		expect(resolveFontPixelHeight(100)).toBeLessThan(resolveFontPixelHeight(-100));
	});
});
