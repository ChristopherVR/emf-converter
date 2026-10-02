import { describe, expect, it } from 'vitest';
import {
	ditherQuantize,
	ditherStartX,
	ditherStartY,
	ditherThreshold,
	paletteLevel,
} from './emf-gdi-halftone-dither';
import { stretchHalftone } from './emf-gdi-stretch';

describe('halftone ordered dither (native captures)', () => {
	it('uses the 32-level palette round(n * 255 / 31)', () => {
		expect([0, 1, 2, 3, 12, 13, 31].map(paletteLevel)).toEqual([0, 8, 16, 25, 99, 107, 255]);
	});

	it('reads the threshold matrix at the blit origin', () => {
		// Measured with flat patches at destination (2, 2): thr = 255 * level - 31 * v.
		expect([0, 1, 2, 3].map(x => ditherThreshold(0, 0, x, 0))).toEqual([238, 110, 198, 70]);
		expect([0, 1, 2, 3].map(y => ditherThreshold(0, 0, 0, y))).toEqual([238, 46, 209, 18]);
	});

	it('repeats the last column of a row three times and the last row twice (66 x 65 period)', () => {
		expect(ditherThreshold(0, 0, 14, 0)).toBe(ditherThreshold(0, 0, 62, 0));
		expect(ditherThreshold(0, 0, 14, 0)).toBe(ditherThreshold(0, 0, 63, 0));
		expect(ditherThreshold(0, 0, 14, 0)).toBe(ditherThreshold(0, 0, 64, 0));
		expect(ditherThreshold(0, 0, 15, 0)).toBe(ditherThreshold(0, 0, 65, 0));
		expect(ditherThreshold(0, 0, 66, 0)).toBe(ditherThreshold(0, 0, 0, 0));
		expect(ditherThreshold(0, 0, 0, 14)).toBe(ditherThreshold(0, 0, 0, 63));
		expect(ditherThreshold(0, 0, 0, 65)).toBe(ditherThreshold(0, 0, 0, 0));
	});

	it('quantises a channel to floor((31 v + threshold) / 255)', () => {
		// Grey 100 sits 0.157 of the way from level 12 (99) to 13 (107): about 15.6% of pixels round up.
		let high = 0;
		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				high += ditherQuantize(100, ditherThreshold(0, 0, x, y)) === 107 ? 1 : 0;
			}
		}
		expect(high).toBe(40);
		expect(ditherQuantize(0, 254)).toBe(0);
		expect(ditherQuantize(255, 0)).toBe(255);
		expect(ditherQuantize(99, 245)).toBe(99);
		expect(ditherQuantize(99, 246)).toBe(107);
	});

	it('starts the pattern at the destination rectangle minus the brush origin', () => {
		// Native phase of the first pixel for destination left 0..4 (columns skip the repeated 63).
		expect([0, 1, 2, 3, 4].map(d => ditherStartX(d, 0))).toEqual([64, 65, 0, 1, 2]);
		expect([63, 64, 65, 66, 67].map(d => ditherStartX(d, 0))).toEqual([61, 62, 64, 65, 0]);
		expect([0, 1, 2, 3, 66, 67].map(d => ditherStartY(d, 0))).toEqual([63, 64, 0, 1, 64, 0]);
		// A brush origin shifts the pattern the other way.
		expect(ditherStartX(2, 1)).toBe(65);
		expect(ditherStartX(2, 3)).toBe(62);
		expect(ditherStartY(2, 4)).toBe(61);
	});
});

describe('halftone dither of mirrored and mixed-axis stretches (native captures)', () => {
	// Flat grey 100 through the palette only (an illuminant-free adjustment is the identity on the
	// quantised colour), so the output shows the threshold decision of every destination pixel.
	const flat = (w: number, h: number, dw: number, dh: number, startX = 0, startY = 0): Int32Array => {
		const data = new Uint8ClampedArray(w * h * 4).fill(100);
		const out = stretchHalftone(
			{ width: w, height: h, data },
			0, 0, w, h, dw, dh,
			() => undefined,
			false, false,
			{ startX, startY },
		);
		return Int32Array.from({ length: out.width * out.height }, (_, i) => out.data[i * 4]);
	};
	const expectedAt = (sx: number, sy: number, px: number, py: number): number => ditherQuantize(100, ditherThreshold(sx, sy, px, py));

	it('runs a vertically mirrored 2x enlargement down the rows, shifted by the added rows', () => {
		// Native: rows start at H - SH = 8 for 8 -> 16, and each source row spans two destination rows.
		const out = flat(8, 8, 16, -16);
		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				expect(out[y * 16 + x]).toBe(expectedAt(0, 0, Math.floor(x / 2), 8 + Math.floor(y / 2)));
			}
		}
	});

	it('flips the pattern with a horizontally mirrored enlargement', () => {
		const out = flat(8, 8, -16, 16);
		for (let y = 0; y < 16; y++) {
			for (let x = 0; x < 16; x++) {
				expect(out[y * 16 + x]).toBe(expectedAt(0, 0, 7 - Math.floor(x / 2), Math.floor(y / 2)));
			}
		}
	});

	it('follows the destination pixel when the destination is not larger than the source in area', () => {
		// 16 -> 12 x 20 (area 240 < 256): both axes follow the destination pixel.
		const out = flat(16, 16, 12, 20);
		for (let y = 0; y < 20; y++) {
			for (let x = 0; x < 12; x++) {
				expect(out[y * 12 + x]).toBe(expectedAt(0, 0, x, y));
			}
		}
	});
});
