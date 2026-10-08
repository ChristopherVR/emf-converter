/**
 * The source images behind `__fixtures__/gdi/halftone-boundary.json.gz`: boundary sweeps of the
 * native HALFTONE enlargement branch choice (`scripts/gdi-fixtures/HalftoneBoundaryProbe.cs`,
 * `generate-halftone-boundary.ts`). Everything here is deterministic, so the capture stores only
 * the label (replicated `R` or filtered `F`) of each image and the test regenerates the images.
 *
 * Colours are drawn from a fixed pool of pseudo-random 24-bit values none of which has equal red and
 * blue; image `ids` are 0 for black and `k` for pool colour `k - 1`.
 */

export interface BoundaryImage { w: number; h: number; rgb: () => Uint8Array }
export interface BoundaryGroup { name: string; description: string; images: BoundaryImage[] }

/** The linear congruential generator every sweep seeds explicitly. */
export function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

let poolCache: number[] | undefined;
/** 24-bit values `r << 16 | g << 8 | b`, unique, non-black, red never equal to blue. */
export function colourPool(): number[] {
	if (poolCache) return poolCache;
	const next = lcg(5);
	const seen = new Set<number>([0]);
	const out: number[] = [];
	while (out.length < 3000) {
		const raw = Math.floor(next() * 0xffffff) + 1;
		// The pool stores the colour as b | g << 8 | r << 16 where the draw is read as bgr.
		if (seen.has(raw)) continue;
		seen.add(raw);
		if ((raw & 255) !== (raw >> 16)) out.push(raw);
	}
	poolCache = out;
	return out;
}

/** An RGB byte triple array for colour ids. */
export function rgbFromIds(ids: ArrayLike<number>): Uint8Array {
	const pool = colourPool();
	const out = new Uint8Array(ids.length * 3);
	for (let i = 0; i < ids.length; i++) {
		const colour = ids[i] === 0 ? 0 : pool[ids[i] - 1];
		out[i * 3] = colour >> 16;
		out[i * 3 + 1] = (colour >> 8) & 255;
		out[i * 3 + 2] = colour & 255;
	}
	return out;
}

const fromIds = (w: number, h: number, ids: () => ArrayLike<number>): BoundaryImage => ({ w, h, rgb: () => rgbFromIds(ids()) });

/** Colour ids 1..C (each repeated `k` times) in the first pixels, black everywhere else. */
export function blockFirst(w: number, h: number, colours: number, k = 1): Uint16Array {
	const ids = new Uint16Array(w * h);
	for (let i = 0; i < colours * k; i++) ids[i] = Math.floor(i / k) + 1;
	return ids;
}

/** Bands of `bandRows` rows; band `b` has `counts[b]` colours cycled over the row (bands past the list reuse band 0). */
export function bands(w: number, h: number, bandRows: number, counts: number[]): Uint16Array {
	const ids = new Uint16Array(w * h);
	for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) {
		const b = Math.floor(r / bandRows);
		const start = counts.slice(0, Math.min(b, counts.length)).reduce((p, c) => p + c, 0);
		ids[r * w + x] = (b >= counts.length ? x % counts[0] : start + (x % counts[b])) + 1;
	}
	return ids;
}

function blockSweeps(): BoundaryGroup[] {
	const groups: BoundaryGroup[] = [];
	const shapes: [number, number][] = [[1, 3000], [1, 6000], [2, 1500], [4, 800], [8, 512], [16, 200], [16, 146], [16, 145], [32, 128], [64, 64], [64, 38], [64, 37], [100, 100], [128, 32], [256, 16], [256, 12], [256, 11], [256, 10], [512, 16], [1024, 16], [3, 1000], [7, 500], [17, 300], [48, 100], [200, 30], [384, 16], [768, 16], [640, 16]];
	const colourScan: BoundaryImage[] = [];
	for (const [w, h] of shapes) for (let c = 100; c <= 330; c += w * h > 20000 ? 4 : 1) colourScan.push(fromIds(w, h, () => blockFirst(w, h, c)));
	groups.push({ name: 'block-first colour sweeps', description: 'C distinct colours then black, C = 100..330, in 28 shapes from 3,000 to 16,384 pixels: where each shape flips', images: colourScan });
	const runs: BoundaryImage[] = [];
	for (const [w, h] of [[1, 3000], [1, 4000], [64, 64], [64, 37], [256, 16]] as [number, number][]) for (const k of [2, 3, 4, 6, 8, 12]) {
		for (let c = 100; c <= 330; c += 2) if (c * k <= w * h) runs.push(fromIds(w, h, () => blockFirst(w, h, c, k)));
	}
	groups.push({ name: 'block-first runs', description: 'every colour repeated k times in a row: repeats inside a run do not move the flip', images: runs });
	const bandImages: BoundaryImage[] = [];
	const counts = [[160], [100, 60], [80, 80], [54, 53, 53], [40, 60, 60], [100, 30, 30], [40, 40, 40, 40], [32, 32, 32, 32, 32], [81, 80], [80, 200], [155, 5], [159, 1], [160, 1], [10, 150], [80, 79], [161], [159]];
	for (const bandRows of [1, 2, 3, 4, 5, 6, 8]) for (const ms of counts) {
		bandImages.push(fromIds(256, 16, () => bands(256, 16, bandRows, ms)));
		for (let r = 0; r < 16; r++) for (const x of [0, 255]) bandImages.push(fromIds(256, 16, () => { const ids = bands(256, 16, bandRows, ms); ids[r * 256 + x] = colourPool().length; return ids; }));
	}
	groups.push({ name: 'banded fresh-pixel sweeps', description: '256x16 bands of new colours; one extra colour placed in every row at x = 0 and 255: which rows still count', images: bandImages });
	return groups;
}

function samplingGroups(): BoundaryGroup[] {
	const next = lcg(2024);
	const images: BoundaryImage[] = [];
	const shapes: [number, number][] = [[1, 20000], [2, 10000], [3, 6000], [5, 4000], [8, 2500], [16, 1100], [32, 600], [64, 300], [100, 200], [128, 130], [200, 100], [256, 80], [320, 60], [512, 40]];
	for (const [w, h] of shapes) for (const k of [10, 18, 19, 20, 21, 25]) for (const r of [0, 1, 5, 6, 7, 12, 30]) {
		if (r >= h) continue;
		images.push(fromIds(w, h, () => { const ids = new Uint16Array(w * h); for (let x = 0; x < w; x++) ids[r * w + x] = 1 + (x % k); return ids; }));
	}
	for (const [w, h] of shapes) for (const k of [5, 15, 19, 20, 21, 40, 100]) {
		const draws = Array.from({ length: w * h }, () => 1 + Math.floor(next() * k));
		images.push(fromIds(w, h, () => Uint16Array.from(draws)));
	}
	for (const [w, h] of [[256, 80], [64, 300], [512, 40]] as [number, number][]) for (const a of [1, 2, 4, 8, 20]) for (const b of [1, 2, 3, 5, 8, 10, 16, 20, 40]) {
		if (a <= w && b <= h) images.push(fromIds(w, h, () => Uint16Array.from({ length: w * h }, (_, i) => 1 + (i % w) % a + a * (Math.floor(i / w) % b))));
	}
	for (const [w, h] of [[64, 300], [256, 80], [1, 20000]] as [number, number][]) for (const count of [30, 60]) {
		images.push(fromIds(w, h, () => {
			const ids = new Uint16Array(w * h);
			for (let i = 0; i < Math.min(count, w * h); i++) {
				const r = 1 + (i % 5), x = Math.floor(i / 5);
				if (x < w) ids[r * w + x] = 1 + i; else ids[(1 + (i % 5)) * w + (i % w)] = 1 + i;
			}
			return ids;
		}));
	}
	return [{ name: 'above 16,384 pixels', description: 'colours confined to rows 0, 6, 12... or to other rows, random k-colour images, grids: only every sixth row counts, 20 colours', images }];
}

function denseGroups(): BoundaryGroup[] {
	const next = lcg(31337);
	const images: BoundaryImage[] = [];
	for (const [w, h] of [[256, 16], [128, 32], [64, 64], [100, 40], [200, 20], [48, 90], [32, 128], [512, 16], [1024, 16], [16, 256], [8, 512], [24, 170], [320, 12], [384, 40]] as [number, number][]) {
		for (const a of [1, 2, 3, 5, 8, 16, 40, 100]) for (const b of [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16, 19, 24, 37, 40, 73]) {
			if (a <= w && b <= h && w * h > 2304 && w * h <= 16384) images.push(fromIds(w, h, () => Uint16Array.from({ length: w * h }, (_, i) => 1 + (i % w) % a + a * (Math.floor(i / w) % b))));
		}
	}
	for (const [w, h] of [[256, 16], [64, 64], [100, 40], [200, 20], [48, 90], [32, 128], [512, 16], [16, 256], [8, 512], [320, 12], [1, 4000], [3, 1200], [7, 600]] as [number, number][]) {
		for (const k of [2, 20, 100, 130, 150, 170, 200, 400]) if (w * h > 2304 && w * h <= 16384) for (let rep = 0; rep < 2; rep++) {
			const draws = Array.from({ length: w * h }, () => 1 + Math.floor(next() * k));
			images.push(fromIds(w, h, () => Uint16Array.from(draws)));
		}
	}
	for (const [w, h] of [[256, 16], [64, 64], [128, 32], [100, 40]] as [number, number][]) for (let rep = 0; rep < 40; rep++) {
		const bandRows = 1 + Math.floor(next() * 6), per = 5 + Math.floor(next() * 80), runLength = 1 + Math.floor(next() * 5);
		const ids = (): Uint16Array => Uint16Array.from({ length: w * h }, (_, i) => 1 + Math.floor(Math.floor(i / w) / bandRows) * per + (Math.floor((i % w) / runLength) % per));
		if (Math.max(...ids()) <= colourPool().length) images.push(fromIds(w, h, ids));
	}
	return [{ name: 'between 2,304 and 16,384 pixels', description: 'grids of repeated row patterns, random k-colour images, random banded images: every row is scanned, a colour limit and a give-up rule decide', images }];
}

function fewRowGroups(): BoundaryGroup[] {
	const next = lcg(8675309);
	const images: BoundaryImage[] = [];
	for (const w of [60, 100, 150, 200, 300, 400, 512, 600, 800, 1000, 1200, 1300, 2000, 2400, 3000]) {
		const rows = Math.floor(2304 / w) + 1;
		for (const h of [rows, rows + 1, rows + 2, rows + 3]) {
			if (h < 1 || w * h > 16384) continue;
			for (const per of [2, 5, 20, 50, 100, 200, 400]) {
				if (per > w) continue;
				if (h * per <= colourPool().length) images.push(fromIds(w, h, () => Uint16Array.from({ length: w * h }, (_, i) => 1 + Math.floor(i / w) * per + ((i % w) % per))));
				images.push(fromIds(w, h, () => Uint16Array.from({ length: w * h }, (_, i) => 1 + ((i % w) % per))));
				images.push(fromIds(w, h, () => Uint16Array.from({ length: w * h }, (_, i) => 1 + (((i % w) + Math.floor(i / w) * 3) % per))));
			}
			for (const k of [10, 25, 60, 150, 300, 600, 1200]) {
				const draws = Array.from({ length: w * h }, () => 1 + Math.floor(next() * k));
				images.push(fromIds(w, h, () => Uint16Array.from(draws)));
			}
			for (const c of [15, 19, 20, 21, 100, 140, 160, 200, 320, 640]) if (c <= w * h) images.push(fromIds(w, h, () => blockFirst(w, h, c)));
		}
	}
	return [{ name: 'one to four rows past the area limit', description: 'rows = least row count with rows * w > 2304, heights rows..rows+3 over widths 60..3000: the colour limit is 289 + floor(o / 8) at rows and 145 + floor(o / 16) beyond', images }];
}

function oneDimensionalGroups(): BoundaryGroup[] {
	const images: BoundaryImage[] = [];
	const segments = (n: number, parts: [number, number][]): BoundaryImage => fromIds(1, n, () => {
		const ids = new Uint16Array(n).fill(1);
		let p = 0, next = 1;
		for (const [m, repeats] of parts) { for (let i = 0; i < m; i++) ids[p++] = next++; for (let i = 0; i < repeats; i++) ids[p++] = 1; }
		return ids;
	});
	for (const repeats of [0, 100, 500, 1000, 1500, 1600, 1650, 1690, 1694, 1695, 1696, 1697, 1700, 1750, 2000, 3000]) images.push(segments(4000, [[81, repeats], [81, 0]]));
	for (const repeats of [0, 500, 1000, 1500, 1690, 1694, 1695, 1696, 1750, 3000]) images.push(segments(4000, [[100, repeats], [100, 0]]));
	for (const sum of [[800, 800], [847, 847], [848, 848], [900, 900], [850, 850], [1000, 1000], [1600, 1600], [1694, 1694]]) images.push(segments(4000, [[50, sum[0]], [50, sum[1]], [50, 0]]));
	for (const each of [400, 450, 500]) images.push(segments(4000, [[30, each], [30, each], [30, each], [30, each], [30, 0]]));
	images.push(segments(4000, [[150, 1000], [50, 0]]), segments(4000, [[150, 1694], [50, 0]]), segments(4000, [[150, 1695], [50, 0]]));
	return [{ name: 'one-pixel-wide images', description: 'colour segments separated by repeats of one colour: repeats before the last needed colour are budgeted cumulatively, not per gap', images }];
}

function naturalGroups(): BoundaryGroup[] {
	const images: BoundaryImage[] = [];
	const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
	const shapes: [number, number][] = [[32, 32], [48, 48], [49, 49], [50, 50], [64, 40], [100, 100], [127, 127], [128, 128], [129, 128], [128, 129], [129, 129], [160, 100], [200, 150], [256, 64], [300, 200], [320, 240], [640, 100], [17, 300], [300, 17], [45, 52], [48, 49], [2, 2500], [2500, 2], [3, 1300], [1300, 3], [1, 5000], [5000, 1], [3000, 4], [4, 3000], [96, 300], [2400, 1], [2305, 1], [1300, 2], [1200, 2], [1153, 2], [1152, 2], [800, 3], [769, 3], [768, 3], [770, 3], [576, 5], [577, 4], [256, 10], [256, 9], [64, 37], [64, 36], [16, 145], [24, 97], [24, 96], [100, 24], [100, 23], [150, 16], [151, 16], [111, 150], [123, 133], [7, 2400], [20000, 1], [10000, 2], [4000, 5], [1, 20000], [2, 10000], [130, 130], [1000, 17], [2000, 9], [5000, 4], [300, 60], [640, 480]];
	for (const seed of [90210, 1, 777, 3]) {
		const next = lcg(seed);
		for (const [w, h] of shapes) {
			const levels = [4, 16, 64, 256][Math.floor(next() * 4)];
			const make = (pixel: (x: number, y: number) => [number, number, number]): BoundaryImage => ({
				w, h,
				rgb: () => { const out = new Uint8Array(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(pixel(x, y), (y * w + x) * 3); return out; },
			});
			images.push(make((x) => { const v = Math.floor((x / Math.max(1, w - 1)) * (levels - 1)) * 255 / (levels - 1); return [clamp(v), clamp(v * 0.5), clamp(255 - v)]; }));
			images.push(make((x, y) => { const v = Math.floor(((x + y) / Math.max(1, w + h - 2)) * (levels - 1)) * 255 / (levels - 1); return [clamp(v), clamp(v), clamp(v)]; }));
			images.push(make((_, y) => { const v = Math.floor((y / Math.max(1, h - 1)) * (levels - 1)) * 255 / (levels - 1); return [clamp(v), clamp(255 - v), clamp(v / 2)]; }));
			const colours = [2, 5, 16, 40, 120, 200][Math.floor(next() * 6)];
			const palette = Array.from({ length: colours }, () => [Math.floor(next() * 256), Math.floor(next() * 256), Math.floor(next() * 256)] as [number, number, number]);
			const block = 1 + Math.floor(next() * 12);
			images.push(make((x, y) => palette[(Math.floor(x / block) * 7 + Math.floor(y / block) * 13) % colours]));
			// A smooth field with noise; each image keeps its own noise stream so the draws stay lazy.
			const noiseSeed = Math.floor(next() * 4294967296);
			images.push({
				w, h,
				rgb: () => {
					const draw = lcg(noiseSeed);
					const out = new Uint8Array(w * h * 3);
					for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
						const base = 128 + 100 * Math.sin(x / 9) * Math.cos(y / 7);
						for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = clamp(base + draw() * 20);
					}
					return out;
				},
			});
			const greyLevels = [3, 10, 30][Math.floor(next() * 3)];
			images.push(make((x, y) => { const on = ((x >> 2) ^ (y >> 3)) & 1; const g = on ? 255 : (x * 3 + y * 5) % greyLevels * Math.floor(255 / greyLevels); return [g, g, g]; }));
			images.push(make((x, y) => { const b = (x * 11 + y * 3) % 64 * 4; return [b, (x + y * 2) % 32 * 8, b]; }));
		}
	}
	return [{ name: 'gradients, palettes, noise, text-like and equal-red-blue images', description: 'held-out natural-looking sources in 67 shapes from 32x32 to 20000x1, four seeds', images }];
}

/** The 256 x 16 four-band source of the older probes: `levels` equal steps across, grey / red / green / blue bands of four rows. */
export function bandSource(levels: number): Uint8Array {
	const out = new Uint8Array(256 * 16 * 3);
	for (let y = 0; y < 16; y++) for (let x = 0; x < 256; x++) {
		const v = Math.floor(Math.floor(x * levels / 256) * 255 / (levels - 1));
		out.set([y < 8 ? v : 0, y < 4 || (y >= 8 && y < 12) ? v : 0, y < 4 || y >= 12 ? v : 0], (y * 256 + x) * 3);
	}
	return out;
}

function swapGroups(): BoundaryGroup[] {
	const swapped = (levels: number, a: [number, number], b: [number, number]): BoundaryImage => ({
		w: 256, h: 16,
		rgb: () => {
			const out = bandSource(levels);
			const ia = (a[1] * 256 + a[0]) * 3, ib = (b[1] * 256 + b[0]) * 3;
			const held = out.slice(ia, ia + 3);
			out.copyWithin(ia, ib, ib + 3);
			out.set(held, ib);
			return out;
		},
	});
	const plain = (levels: number): BoundaryImage => ({ w: 256, h: 16, rgb: () => bandSource(levels) });
	return [{
		name: 'single pixel swaps in the band sources',
		description: 'the 54-level band source replicates, swapping one pair of pixels filters it; the 55-level source filters; swaps within a run do not change anything',
		images: [plain(54), swapped(54, [193, 0], [16, 12]), plain(55), swapped(55, [193, 0], [16, 12]), swapped(54, [193, 0], [194, 0]), swapped(54, [193, 0], [193, 1]), swapped(54, [100, 5], [3, 14]), swapped(54, [255, 15], [0, 0])],
	}];
}

function colourIdentityGroups(): BoundaryGroup[] {
	const next = lcg(4711);
	const images: BoundaryImage[] = [];
	const clamp = (v: number): number => Math.max(0, Math.min(255, v));
	for (let i = 0; i < 3000; i++) {
		const kind = i % 6;
		const b0 = Math.floor(next() * 256), g0 = Math.floor(next() * 256);
		let a: [number, number, number], b: [number, number, number]; // r, g, b
		if (kind === 0) { a = [b0, g0, b0]; const v = clamp(b0 + Math.floor(next() * 9) - 4); b = [v, clamp(g0 + Math.floor(next() * 9) - 4), v]; }
		else if (kind === 1) { a = [b0, g0, b0]; b = [b0, g0 ^ (1 << Math.floor(next() * 8)), b0]; }
		else if (kind === 2) { a = [b0, g0, b0]; b = [b0 ^ (1 << Math.floor(next() * 8)), g0, b0 ^ (1 << Math.floor(next() * 8))]; }
		else if (kind === 3) { const r0 = Math.floor(next() * 256); a = [r0, g0, b0]; b = [clamp(r0 + Math.floor(next() * 5) - 2), clamp(g0 + Math.floor(next() * 5) - 2), clamp(b0 + Math.floor(next() * 5) - 2)]; }
		else if (kind === 4) { a = [b0, g0, b0]; b = [clamp(b0 + (next() < 0.5 ? 1 : -1)), g0, b0]; }
		else { a = [b0, g0, b0]; b = [b0 ^ 1, g0, b0 ^ 1]; }
		images.push({
			w: 1, h: 2400,
			rgb: () => {
				// 143 distinct colours (the first replaced by a), black from pixel 143 on except the test colour b at pixel 143.
				const ids = new Uint16Array(2400);
				for (let k = 0; k < 143; k++) ids[k] = k + 1;
				const out = rgbFromIds(ids);
				out.set(a, 0);
				out.set(b, 143 * 3);
				return out;
			},
		});
	}
	return [{ name: 'colour identity pairs', description: 'a column of 143 colours (the first set to a) and black with the colour b at pixel 143: it filters exactly when b is a 144th distinct colour, which tells whether a and b are one colour to the count', images }];
}

/** All sweeps, in the order their labels are stored. */
export function boundaryGroups(): BoundaryGroup[] {
	return [...blockSweeps(), ...samplingGroups(), ...denseGroups(), ...fewRowGroups(), ...oneDimensionalGroups(), ...naturalGroups(), ...swapGroups(), ...colourIdentityGroups()];
}

/** A source rectangle inside a larger bitmap, stretched 2x by StretchBlt or StretchDIBits. */
export interface RectangleCase {
	name: string;
	bitmapWidth: number; bitmapHeight: number;
	x: number; y: number; width: number; height: number;
	dib: boolean;
	/** Colours inside the rectangle: many (250 colours) or few (2). */
	inside: 'many' | 'few';
	/** Colours outside the rectangle: many (250 colours) or flat black. */
	outside: 'many' | 'flat';
}

export function rectangleCases(): RectangleCase[] {
	const c = (name: string, bitmapWidth: number, bitmapHeight: number, x: number, y: number, width: number, height: number, inside: 'many' | 'few', outside: 'many' | 'flat', dib = false): RectangleCase => ({ name, bitmapWidth, bitmapHeight, x, y, width, height, inside, outside, dib });
	return [
		c('F-type rectangle, bitmap = rectangle', 256, 16, 0, 0, 256, 16, 'many', 'flat'),
		c('F-type rectangle in a 512x64 bitmap, flat outside', 512, 64, 0, 0, 256, 16, 'many', 'flat'),
		c('R-type rectangle in a 512x64 bitmap, many colours outside', 512, 64, 0, 0, 256, 16, 'few', 'many'),
		c('R-type rectangle, bitmap = rectangle', 256, 16, 0, 0, 256, 16, 'few', 'flat'),
		c('F-type rectangle at (100,20), flat outside', 512, 64, 100, 20, 256, 16, 'many', 'flat'),
		c('R-type rectangle at (100,20), many colours outside', 512, 64, 100, 20, 256, 16, 'few', 'many'),
		c('F-type rectangle, top half of 256x32, many colours below', 256, 32, 0, 0, 256, 16, 'many', 'many'),
		c('R-type rectangle, top half of 256x32, many colours below', 256, 32, 0, 0, 256, 16, 'few', 'many'),
		c('256x80 F-type rectangle, bitmap = rectangle', 256, 80, 0, 0, 256, 80, 'many', 'flat'),
		c('256x80 R-type rectangle, bitmap = rectangle', 256, 80, 0, 0, 256, 80, 'few', 'flat'),
		c('256x80 R-type rectangle in a 256x160 bitmap, many colours outside', 256, 160, 0, 0, 256, 80, 'few', 'many'),
		c('40x40 R-type rectangle in 512x64, many colours outside', 512, 64, 0, 0, 40, 40, 'few', 'many'),
		c('40x40 F-type colours in 512x64, flat outside', 512, 64, 0, 0, 40, 40, 'many', 'flat'),
		c('StretchDIBits, F-type rectangle at y 0 of a 512x64 bitmap, flat outside', 512, 64, 0, 0, 256, 16, 'many', 'flat', true),
		c('StretchDIBits, R-type rectangle at y 0 of a 512x64 bitmap, many colours outside', 512, 64, 0, 0, 256, 16, 'few', 'many', true),
	];
}

/** The bitmap pixels (RGB triples, top row first). */
export function rectangleBitmap(c: RectangleCase): Uint8Array {
	const ids = new Uint16Array(c.bitmapWidth * c.bitmapHeight);
	for (let y = 0; y < c.bitmapHeight; y++) for (let x = 0; x < c.bitmapWidth; x++) {
		const inside = x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height;
		ids[y * c.bitmapWidth + x] = inside
			? (c.inside === 'many' ? 1 + (((x - c.x) * 7 + (y - c.y) * 13) % 250) : 1 + ((x - c.x + y - c.y) % 2))
			: (c.outside === 'many' ? 1 + ((x * 7 + y * 13) % 250) : 0);
	}
	return rgbFromIds(ids);
}

/**
 * The rows the native engine stretches: StretchBlt counts the rectangle's y from the top row,
 * StretchDIBits from the bottom row even for a top-down DIB (the converter's `dibOrigin`
 * 'bottom-left' adjustment), so a DIB rectangle at y 0 is the bottom of the bitmap.
 */
export function rectangleSource(c: RectangleCase): { rgb: Uint8Array; width: number; height: number } {
	const bitmap = rectangleBitmap(c);
	const top = c.dib ? c.bitmapHeight - c.y - c.height : c.y;
	const out = new Uint8Array(c.width * c.height * 3);
	for (let y = 0; y < c.height; y++) {
		const from = ((top + y) * c.bitmapWidth + c.x) * 3;
		out.set(bitmap.subarray(from, from + c.width * 3), y * c.width * 3);
	}
	return { rgb: out, width: c.width, height: c.height };
}

/** Outer rows of the filtered branch: 128x160, row 0 = a, row 1 = b, rows 2.. = c (greys), 40 colours in row 6. */
export const EDGE_ROW_WIDTH = 128;
export const EDGE_ROW_HEIGHT = 160;
export const EDGE_ROW_TRIPLES: [number, number, number][] = [
	...[100, 50].flatMap(a => [0, 30, 60, 90, 100, 110, 140, 180, 220, 255].map((b): [number, number, number] => [a, b, a])),
	...[0, 50, 200].map((c): [number, number, number] => [100, 150, c]),
];
export function edgeRowImage(a: number, b: number, c: number): Uint8Array {
	const w = EDGE_ROW_WIDTH, h = EDGE_ROW_HEIGHT;
	const out = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.fill(y === 0 ? a : y === 1 ? b : c, (y * w + x) * 3, (y * w + x) * 3 + 3);
	for (let x = 0; x < 40; x++) out.set([30 + x * 2, 200 - x * 3, 10 + x * 5], (6 * w + x) * 3);
	return out;
}
