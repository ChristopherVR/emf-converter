import { describe, expect, it } from 'vitest';
import { pathGradientQuantum, pathGradientStepColor } from './emf-plus-brush-gradient';
import { copiesStepAt, prepareCopies } from './emf-plus-path-gradient-copies';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

function shapeOf(boundary: [number, number][], center: [number, number], focus: [number, number] | null = null): EmfPlusPathGradientShape {
	return {
		boundary: boundary.map(([x, y]) => ({ x, y })),
		center: { x: center[0], y: center[1] },
		centerArgb: 0xffffffff,
		boundaryArgb: boundary.map(() => 0xff000000),
		focus: focus ? { x: focus[0], y: focus[1] } : null,
		blend: null,
		preset: null,
		transform: null,
	};
}

describe('nested copies of a uniform path gradient', () => {
	// A 60 x 40 rectangle has 145 copies; the centre pixel is the innermost copy.
	const rectangle = shapeOf([[20, 15], [80, 15], [80, 55], [20, 55]], [50.3, 35.4]);
	const steps = pathGradientQuantum(rectangle.boundary, IDENTITY);

	it('numbers the copies from the boundary (0) to the centre (steps)', () => {
		expect(steps).toBe(145);
		const g = prepareCopies(rectangle, IDENTITY, steps)!;
		expect(copiesStepAt(g, 50, 35)).toBeGreaterThan(steps - 5);
		const middle = prepareCopies(shapeOf([[20, 15], [80, 15], [80, 55], [20, 55]], [50, 35]), IDENTITY, steps)!;
		expect(copiesStepAt(middle, 50, 35)).toBe(steps);
		// The first column inside the left edge is the second ring, the pixel past the right edge is outside.
		expect(copiesStepAt(g, 21, 35)).toBeLessThan(10);
		expect(copiesStepAt(g, 20, 35)).toBeLessThan(10);
		expect(copiesStepAt(g, 80, 35)).toBeNull();
		expect(copiesStepAt(g, 19, 35)).toBeNull();
	});

	it('rounds the boundary and the centre to 1/16 pixel before scaling', () => {
		// 50.3 rounds to 50.3125; the same shape with the centre given as 50.3125 steps identically.
		const exact = shapeOf([[20, 15], [80, 15], [80, 55], [20, 55]], [50.3125, 35.4]);
		const a = prepareCopies(rectangle, IDENTITY, steps)!;
		const b = prepareCopies(exact, IDENTITY, steps)!;
		for (let x = 20; x < 80; x += 7) expect(copiesStepAt(a, x, 30)).toBe(copiesStepAt(b, x, 30));
	});

	describe('a pixel exactly on a copy edge', () => {
		// A 4 x 20 rectangle drawn clockwise about (7, 15) has 41 copies; copy 20 (half scale) has its right edge on column 8.
		const tall = shapeOf([[5, 5], [9, 5], [9, 25], [5, 25]], [7, 15]);
		const g = prepareCopies(tall, IDENTITY, 41)!;
		const inside = 41 - 20;
		const outside = 41 - 21;

		it('is outside when it reads the exact coordinate and the ratio is a binary fraction, inside when not', () => {
			// Tie ratio 41 / 82 = 1/2 is exact in fixed point: the pixels of column 8 level with the centre are outside.
			expect(copiesStepAt(g, 8, 15)).toBe(outside);
			// The 12 x 22 rectangle has 51 copies; copy 42 is at scale 85 / 102 = 5/6 (not a binary fraction), so column 11 is inside.
			const wide = shapeOf([[0, 0], [12, 0], [12, 22], [0, 22]], [6, 11]);
			expect(pathGradientQuantum(wide.boundary, IDENTITY)).toBe(51);
			const w = prepareCopies(wide, IDENTITY, 51)!;
			expect(copiesStepAt(w, 11, 11)).toBe(51 - 42);
		});

		it('is inside above the centre and outside below it on an edge directed down, past the 45 degree line', () => {
			for (let y = 11; y <= 14; y++) expect(copiesStepAt(g, 8, y)).toBe(inside);
			for (let y = 15; y <= 19; y++) expect(copiesStepAt(g, 8, y)).toBe(outside);
		});

		it('follows the winding: the same rectangle counter-clockwise has the inside half on its left edge', () => {
			const reversed = shapeOf([[5, 5], [5, 25], [9, 25], [9, 5]], [7, 15]);
			const r = prepareCopies(reversed, IDENTITY, 41)!;
			for (let y = 11; y <= 14; y++) expect(copiesStepAt(r, 6, y)).toBe(inside);
			for (let y = 11; y <= 14; y++) expect(copiesStepAt(r, 8, y)).toBe(outside);
		});
	});

	it('treats the edge column of a fully focused axis as inside every copy that holds the next column', () => {
		// FocusScale x = 1: every copy keeps the boundary's left and right edges, so the left edge column (a tie of every
		// copy at once, decided by the span rule: left edge in) takes the step of its neighbour on every row.
		const focused = shapeOf([[50, 35], [150, 35], [150, 85], [50, 85]], [100, 60], [1, 0.25]);
		const n = pathGradientQuantum(focused.boundary, IDENTITY);
		const g = prepareCopies(focused, IDENTITY, n)!;
		for (let y = 36; y < 85; y++) expect(copiesStepAt(g, 50, y)).toBe(copiesStepAt(g, 51, y));
		// The right edge column is outside the boundary (right edge out).
		expect(copiesStepAt(g, 150, 60)).toBeNull();
	});

	it('scales each axis by its own focus', () => {
		const focused = shapeOf([[50, 35], [150, 35], [150, 85], [50, 85]], [100, 60], [0.75, 0.25]);
		const n = pathGradientQuantum(focused.boundary, IDENTITY);
		const g = prepareCopies(focused, IDENTITY, n)!;
		// Inside 75% of the half width and 25% of the half height the centre colour is untouched.
		expect(copiesStepAt(g, 100 + 37, 60)).toBe(n);
		expect(copiesStepAt(g, 100, 60 + 6)).toBe(n);
		expect(copiesStepAt(g, 100 + 40, 60)).toBeLessThan(n);
		expect(copiesStepAt(g, 100, 60 + 8)).toBeLessThan(n);
	});
});

describe('colour of a step', () => {
	const shape: EmfPlusPathGradientShape = {
		boundary: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
		center: { x: 7, y: 3 },
		centerArgb: 0xffad2b06,
		boundaryArgb: [0xff9b7d7b, 0xff9b7d7b, 0xff9b7d7b],
		focus: null,
		blend: null,
		preset: null,
		transform: null,
	};

	it('rounds a value exactly half way between two levels toward the centre colour', () => {
		// Green runs 125 -> 43 over 164 steps: step 17 is 116.5 exactly, which native paints 116.
		const color = pathGradientStepColor(shape, 17, 164);
		expect((color >>> 8) & 0xff).toBe(116);
		// Blue runs 123 -> 6; step 82 of 164 is 64.5 and rounds toward the centre colour (down).
		expect(pathGradientStepColor(shape, 82, 164) & 0xff).toBe(64);
	});

	it('keeps plain rounding for the half-way colour of a pixel on a copy edge', () => {
		// Step 17.5: green 112.5 + ... plain half-up rounding, not the tie rule.
		const color = pathGradientStepColor(shape, 17.5, 164);
		expect((color >>> 8) & 0xff).toBe(Math.floor(125 - (82 * 17.5) / 164 + 0.5));
	});
});
