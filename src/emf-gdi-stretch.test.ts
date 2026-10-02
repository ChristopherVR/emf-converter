import { describe, it, expect } from 'vitest';

import {
	axisSamples,
	gdiNearest,
	halftoneAxis,
	halftoneDespeckle,
	halftoneEnlargeTaps,
	halftoneNearest,
	halftoneReduceTaps,
	halftoneSharpen,
	stretchGdi,
	stretchHalftone,
	BLACKONWHITE,
	COLORONCOLOR,
	WHITEONBLACK,
} from './emf-gdi-stretch';

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

describe('halftoneNearest', () => {
	it('takes the pixel under the destination centre, an exact tie going to the lower index', () => {
		// 64 -> 88 (emfrec-halftone-ramp-1p37x): pixel 5's centre lands exactly on source 4.0.
		expect([0, 1, 2, 3, 4, 5, 6].map((i) => halftoneNearest(i, 64, 88))).toEqual([0, 1, 1, 2, 3, 3, 4]);
		expect([0, 1, 2, 3].map((i) => halftoneNearest(i, 2, 4))).toEqual([0, 0, 1, 1]);
	});
});

describe('halftoneAxis', () => {
	it('weights each overlapped source pixel by its 16.16 overlap on a reduction', () => {
		// 3 -> 2: step ceil(3 * 65536 / 2) = 98304.
		expect(halftoneAxis(0, 3, 2, false)).toEqual([
			[[0, 65536], [1, 32768]],
			[[1, 32768], [2, 65536]],
		]);
	});

	it('rounds the step up, tipping a near-even split towards the lower source pixel', () => {
		// 16 -> 11, destination 5 (emfrec-coloradjustment-off): rows 7 and 8.
		expect(halftoneAxis(0, 16, 11, false)[5]).toEqual([[7, 47658], [8, 47668]]);
	});

	it('picks one source pixel per destination pixel when enlarging', () => {
		expect(halftoneAxis(5, 2, 4, false)).toEqual([[[5, 1]], [[5, 1]], [[6, 1]], [[6, 1]]]);
	});

	it('walks the source backwards for a mirrored blit', () => {
		expect(halftoneAxis(0, 2, 2, true)).toEqual([[[1, 1]], [[0, 1]]]);
	});
});

describe('halftoneReduceTaps', () => {
	it('splits an exact 3x reduction as 21844 + 21846 + 21846, the first tap lightest', () => {
		expect(halftoneReduceTaps(12, 4, false)[1]).toEqual([[3, 21844], [4, 21846], [5, 21846]]);
	});

	it('keeps weights that are exact in 16.16 exact and always sums to 65536', () => {
		// 16 -> 5: every destination pixel spans 3.2 source pixels.
		expect(halftoneReduceTaps(16, 5, false)[1]).toEqual([[3, 16384], [4, 20480], [5, 20480], [6, 8192]]);
		for (const taps of halftoneReduceTaps(17, 8, false)) {
			expect(taps.reduce((sum, [, w]) => sum + w, 0)).toBe(65536);
		}
	});

	it('picks one source pixel per destination pixel when enlarging, and mirrors by reversing the destination order', () => {
		expect(halftoneReduceTaps(2, 4, false)).toEqual(halftoneAxis(0, 2, 4, false));
		expect(halftoneReduceTaps(7, 3, true)).toEqual(halftoneReduceTaps(7, 3, false).reverse());
	});
});

describe('halftoneEnlargeTaps', () => {
	it('normalises every destination pixel and stays on the nearby source pixels', () => {
		for (const [src, dst] of [[16, 43], [17, 46], [12, 32], [13, 35]]) {
			const taps = halftoneEnlargeTaps(src, dst);
			expect(taps).toHaveLength(dst);
			taps.forEach((run, x) => {
				expect(run.reduce((sum, [, w]) => sum + w, 0)).toBeCloseTo(1, 9);
				const centre = (x + 0.5) * src / dst;
				for (const [j] of run) expect(Math.abs(j + 0.5 - centre)).toBeLessThan(2.5);
			});
		}
	});

	it('is symmetric about the middle of the row', () => {
		const taps = halftoneEnlargeTaps(16, 43);
		for (let x = 0; x < 43; x++) {
			const mirror = new Map(taps[42 - x].map(([j, w]) => [15 - j, w]));
			for (const [j, w] of taps[x]) expect(mirror.get(j) ?? 0).toBeCloseTo(w, 9);
		}
	});
});

describe('halftoneSharpen', () => {
	it('adds an eighth of the four-neighbour Laplacian, floored and clamped', () => {
		// emfrec-halftone-ramp-0p5x: 74 between 66 and 83 becomes 73.
		const px = new Int32Array([66, 66, 66, 74, 74, 74, 83, 83, 83]);
		halftoneSharpen(px, 3, 1);
		expect([...px.slice(3, 6)]).toEqual([73, 73, 73]);
		// emfrec-halftone-checker-0p5x: a 1-pixel red/blue checker saturates.
		const red = [0xe0, 0x30, 0x20];
		const blue = [0x30, 0x50, 0xd0];
		const blueMiddle = new Int32Array([...blue, ...red, ...blue, ...red, ...blue, ...red, ...blue, ...red, ...blue]);
		halftoneSharpen(blueMiddle, 3, 3);
		expect([...blueMiddle.slice(12, 15)]).toEqual([0x00, 0x60, 0xff]);
		const redMiddle = new Int32Array([...red, ...blue, ...red, ...blue, ...red, ...blue, ...red, ...blue, ...red]);
		halftoneSharpen(redMiddle, 3, 3);
		expect([...redMiddle.slice(12, 15)]).toEqual([0xff, 0x20, 0x00]);
	});
});

describe('halftoneDespeckle', () => {
	it('flattens a one-pixel black/white checker to #808080', () => {
		const px = new Int32Array(4 * 4 * 3);
		for (let i = 0; i < 16; i++) {
			const v = ((i % 4) + Math.floor(i / 4)) % 2 === 0 ? 0 : 255;
			px.set([v, v, v], i * 3);
		}
		halftoneDespeckle(px, 4, 4);
		expect(new Set(px)).toEqual(new Set([128]));
	});

	it('pulls a lone diagonal pair of the brighter colour back to 3/4 (native capture)', () => {
		const px = new Int32Array(9 * 9 * 3);
		for (const [x, y] of [[4, 4], [5, 5]]) px.set([255, 255, 255], (y * 9 + x) * 3);
		halftoneDespeckle(px, 9, 9);
		expect([px[(4 * 9 + 4) * 3], px[(5 * 9 + 5) * 3], px[(4 * 9 + 5) * 3]]).toEqual([191, 191, 0]);
	});

	it('smooths each pixel once per checker block it belongs to (native capture)', () => {
		const px = new Int32Array(9 * 9 * 3);
		for (const [x, y] of [[3, 3], [4, 4], [5, 5]]) px.set([255, 255, 255], (y * 9 + x) * 3);
		halftoneDespeckle(px, 9, 9);
		expect([3, 4, 5].map((i) => px[(i * 9 + i) * 3])).toEqual([191, 143, 191]);
	});

	it('needs exactly equal diagonals (native capture)', () => {
		const px = new Int32Array(9 * 9 * 3);
		for (const [x, y] of [[4, 4], [5, 5]]) px.set([255, 255, 255], (y * 9 + x) * 3);
		px.set([100, 100, 100], (4 * 9 + 5) * 3);
		px.set([101, 101, 101], (5 * 9 + 4) * 3);
		const before = [...px];
		halftoneDespeckle(px, 9, 9);
		expect([...px]).toEqual(before);
	});

	it('leaves ramps and one-directional edges alone', () => {
		const px = new Int32Array(4 * 2 * 3);
		[100, 104, 108, 112, 255, 255, 255, 255].forEach((v, i) => px.set([v, v, v], i * 3));
		const before = [...px];
		halftoneDespeckle(px, 4, 2);
		expect([...px]).toEqual(before);
	});
});

describe('stretchHalftone', () => {
	it('replicates pixels on an integer enlargement, as Windows does', () => {
		const src = row([0xff0000, 0x00ff00]);
		expect(unpack(stretchHalftone(src, 0, 0, 2, 1, 6, 1))).toEqual([
			0xff0000, 0xff0000, 0xff0000, 0x00ff00, 0x00ff00, 0x00ff00,
		]);
	});

	it('area-averages on a reduction, rounding half up', () => {
		expect(unpack(stretchHalftone(row([0xffffff, 0x000000]), 0, 0, 2, 1, 1, 1))).toEqual([0x808080]);
		// 3 -> 2 along a row only (not sharpened): 2/3 of one pixel plus 1/3 of the next.
		expect(unpack(stretchHalftone(row([0x900000, 0x000090, 0x009000]), 0, 0, 3, 1, 2, 1))).toEqual([
			0x600030, 0x006030,
		]);
	});

	it('sharpens a reduction on both axes', () => {
		// 4x2 -> 2x1: a black and a white half, each pushed away from the other.
		const src = { width: 4, height: 2, data: new Uint8ClampedArray(32) };
		for (let i = 0; i < 8; i++) {
			const v = i % 4 < 2 ? 0x40 : 0xc0;
			src.data.set([v, v, v, 255], i * 4);
		}
		expect(unpack(stretchHalftone(src, 0, 0, 4, 2, 2, 1))).toEqual([0x303030, 0xd0d0d0]);
	});

	it('takes the nearest pixel on a non-integer enlargement', () => {
		expect(unpack(stretchHalftone(row([0x000000, 0xf0f0f0]), 0, 0, 2, 1, 3, 1))).toEqual([
			0x000000, 0x000000, 0xf0f0f0,
		]);
	});

	it('applies the colour adjustment to the source before resampling', () => {
		const invert = (rgb: Int32Array): void => {
			for (let i = 0; i < rgb.length; i++) {
				rgb[i] = 255 - rgb[i];
			}
		};
		expect(unpack(stretchHalftone(row([0x000000, 0xffffff]), 0, 0, 2, 1, 4, 1, invert))).toEqual([
			0xffffff, 0xffffff, 0x000000, 0x000000,
		]);
	});

	it('mirrors when exactly one of the extents is negative', () => {
		const src = row([0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);
		expect(unpack(stretchHalftone(src, 0, 0, 4, 1, -4, 1))).toEqual([0xffffff, 0x0000ff, 0x00ff00, 0xff0000]);
	});
});
