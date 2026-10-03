import { describe, expect, it } from 'vitest';
import { diffImages, inkOutside, type Rgba } from './__fixtures__/gdi-parity-harness';

function row(colors: number[], originX = 0, originY = 0): Rgba {
	return { width: colors.length, height: 1, originX, originY, data: new Uint8ClampedArray(colors.flatMap(c => [c, c, c, 255])) };
}

describe('native fixture extent coverage', () => {
	it('detects clipped reference ink despite an exact overlap', () => {
		const reference = row([255, 0, 0]);
		const render = row([255, 0]);
		expect(diffImages(reference, render, 0, 0).mismatched).toBe(0);
		expect(inkOutside(reference, render)).toBe(1);
		expect(inkOutside(render, reference)).toBe(0);
	});

	it('distinguishes uncaptured drawing from harmless white margins', () => {
		const reference = row([255, 0]);
		expect(inkOutside(row([0, 255, 0], -1), reference)).toBe(1);
		expect(inkOutside(row([255, 255, 0], -1), reference)).toBe(0);
	});

	it('aligns both device coordinates and counts nonoverlapping rows', () => {
		expect(inkOutside(row([0, 255, 0], 5, -2), row([0], 7, -2))).toBe(1);
		expect(inkOutside(row([0, 255, 0], 5, -2), row([0], 7, -1))).toBe(2);
	});
});
