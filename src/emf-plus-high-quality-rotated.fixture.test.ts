/**
 * Rotated and sheared HighQualityBilinear/HighQualityBicubic `DrawImage`, and
 * the axis-aligned phase arithmetic it rests on, against native GDI+ output
 * (`hq-rotated`, `hq-rotated-fine`, `hq-axis-noise` captures; probes
 * `HighQualityRotatedProbe.cs`, `HighQualityRotatedFineProbe.cs`,
 * `HighQualityAxisNoiseProbe.cs`, mode `hq-rotated` and `hq-axis`).
 *
 * Native facts the captures establish (asserted from the capture data alone):
 * - a rotated PixelOffsetMode None draw equals, byte for byte, the same source
 *   scaled axis-aligned to the rounded-up device length of each edge and then
 *   drawn rotated with the plain Bicubic/Bilinear kernel (`twoDiff3` counts the
 *   differing bytes);
 * - an edge within a pixel of the source length skips the first step;
 * - a quad that is axis-aligned to within a hair draws as the axis-aligned draw.
 * The converter's model is then pinned per group by its mismatching pixel counts.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import type { TransformMatrix } from './emf-types';

const load = (name: string): any[] =>
	JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());

function straight(base64: string): Uint8ClampedArray {
	const s = Buffer.from(base64, 'base64');
	const out = new Uint8ClampedArray(s.length);
	for (let p = 0; p < s.length; p += 4) {
		out[p] = s[p + 2];
		out[p + 1] = s[p + 1];
		out[p + 2] = s[p];
		out[p + 3] = s[p + 3];
	}
	return out;
}

interface Tally {
	n: number;
	px: number;
	max: number;
	over8: number;
	exact: number;
}

const tally = (): Tally => ({ n: 0, px: 0, max: 0, over8: 0, exact: 0 });

/** Counts the pixels (any premultiplied channel) that differ between a model block and a native 96 x 96 capture. */
function add(t: Tally, block: ReturnType<typeof resampleImage>, nativeBase64: string): void {
	const native = Buffer.from(nativeBase64, 'base64');
	let px = 0;
	for (let y = 0; y < 96; y++) {
		for (let x = 0; x < 96; x++) {
			const inside = !!block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
			const o = inside ? ((y - block!.y) * block!.w + x - block!.x) * 4 : 0;
			let d = 0;
			for (let ch = 0; ch < 4; ch++) {
				const v = inside ? (ch === 3 ? block!.rgba[o + 3] : Math.round((block!.rgba[o + ch] * block!.rgba[o + 3]) / 255)) : 0;
				d = Math.max(d, Math.abs(v - native[(y * 96 + x) * 4 + (ch === 3 ? 3 : 2 - ch)]));
			}
			if (d) {
				px++;
				t.max = Math.max(t.max, d);
				if (d > 8) t.over8++;
			}
		}
	}
	t.n++;
	t.px += px;
	if (!px) t.exact++;
}

/**
 * Draws `size` x `size` source pixels to the capture's three points (p0, p1, p2). GDI+ records a
 * Half-mode draw with its source rectangle shifted by -0.5, which the converter replays.
 */
function draw(c: { p: number[]; kernel: number; pom: number }, rgba: Uint8ClampedArray, size: number): ReturnType<typeof resampleImage> {
	const [x0, y0, x1, y1, x2, y2] = c.p;
	const half = c.pom === 4;
	const shift = half ? -0.5 : 0;
	const a = (x1 - x0) / size;
	const b = (y1 - y0) / size;
	const cc = (x2 - x0) / size;
	const d = (y2 - y0) / size;
	const toDevice: TransformMatrix = [a, b, cc, d, x0 - shift * (a + cc), y0 - shift * (b + d)];
	return resampleImage(
		rgba,
		size,
		size,
		{ srcX: shift, srcY: shift, srcW: size, srcH: size, toDevice, kernel: c.kernel === 7 ? 'hq-bicubic' : 'hq-bilinear', halfPixelOffset: half },
		{ w: 96, h: 96 },
	);
}

describe('rotated high-quality DrawImage (native captures)', () => {
	const captures = load('hq-rotated');

	it('draws a rotated None draw as its pre-scale plus plain-kernel draw, byte for byte', () => {
		expect(captures).toHaveLength(600);
		const rotatedNone = captures.filter((c) => c.deg !== 0 && c.pom === 3);
		expect(rotatedNone).toHaveLength(240);
		const exact = (kernel: number): number => rotatedNone.filter((c) => c.kernel === kernel && c.twoDiff3 === 0).length;
		// The rest differ by one to three bytes of a 36,864-byte frame (twenty at 1.1x).
		expect(exact(7)).toBe(115);
		expect(exact(6)).toBe(85);
		expect(Math.max(...rotatedNone.map((c) => c.twoDiff3))).toBe(24);
	});

	it('pins the model against every rotated capture (600 minus 150 axis-aligned controls)', () => {
		const stats: Record<string, Tally> = {};
		for (const c of captures) {
			if (c.deg === 0) continue;
			const key = `k${c.kernel} pom${c.pom} ${c.sx === 1.1 ? '1.1x' : '1.25x-3x'} ${c.pattern === 4 ? 'alpha noise' : c.pattern === 3 ? 'noise' : 'impulse'}`;
			add((stats[key] ??= tally()), draw(c, straight(c.srcBgra), 12), c.bgra);
		}
		// Before the two-pass model nearly every pixel of every upscaled group differed (12,773 to 12,860 in 20 noise draws), up to 255 levels.
		expect(stats).toEqual({
			'k6 pom3 1.1x alpha noise': { n: 4, px: 22, max: 1, over8: 0, exact: 0 },
			'k6 pom3 1.1x impulse': { n: 12, px: 31, max: 1, over8: 0, exact: 4 },
			'k6 pom3 1.1x noise': { n: 4, px: 28, max: 1, over8: 0, exact: 0 },
			'k6 pom3 1.25x-3x alpha noise': { n: 20, px: 154, max: 1, over8: 0, exact: 0 },
			'k6 pom3 1.25x-3x impulse': { n: 60, px: 217, max: 1, over8: 0, exact: 14 },
			'k6 pom3 1.25x-3x noise': { n: 20, px: 224, max: 1, over8: 0, exact: 0 },
			'k6 pom4 1.1x alpha noise': { n: 4, px: 18, max: 1, over8: 0, exact: 0 },
			'k6 pom4 1.1x impulse': { n: 12, px: 34, max: 1, over8: 0, exact: 0 },
			'k6 pom4 1.1x noise': { n: 4, px: 37, max: 1, over8: 0, exact: 0 },
			'k6 pom4 1.25x-3x alpha noise': { n: 20, px: 164, max: 1, over8: 0, exact: 0 },
			'k6 pom4 1.25x-3x impulse': { n: 60, px: 79, max: 1, over8: 0, exact: 22 },
			'k6 pom4 1.25x-3x noise': { n: 20, px: 180, max: 1, over8: 0, exact: 0 },
			'k7 pom3 1.1x alpha noise': { n: 4, px: 23, max: 3, over8: 0, exact: 0 },
			'k7 pom3 1.1x impulse': { n: 12, px: 0, max: 0, over8: 0, exact: 12 },
			'k7 pom3 1.1x noise': { n: 4, px: 19, max: 2, over8: 0, exact: 0 },
			'k7 pom3 1.25x-3x alpha noise': { n: 20, px: 61, max: 2, over8: 0, exact: 6 },
			'k7 pom3 1.25x-3x impulse': { n: 60, px: 7, max: 1, over8: 0, exact: 53 },
			'k7 pom3 1.25x-3x noise': { n: 20, px: 35, max: 1, over8: 0, exact: 8 },
			'k7 pom4 1.1x alpha noise': { n: 4, px: 21, max: 3, over8: 0, exact: 1 },
			'k7 pom4 1.1x impulse': { n: 12, px: 45, max: 3, over8: 0, exact: 9 },
			'k7 pom4 1.1x noise': { n: 4, px: 24, max: 3, over8: 0, exact: 0 },
			'k7 pom4 1.25x-3x alpha noise': { n: 20, px: 26, max: 4, over8: 0, exact: 6 },
			'k7 pom4 1.25x-3x impulse': { n: 60, px: 6, max: 5, over8: 0, exact: 54 },
			'k7 pom4 1.25x-3x noise': { n: 20, px: 88, max: 5, over8: 0, exact: 0 },
		});
	});
});

describe('rotated high-quality DrawImage scale sweep (native captures)', () => {
	const fine = load('hq-rotated-fine');
	const scale = fine.filter((c) => c.set === 'scale');
	const edge = (len: number): number => Math.ceil(len * (1 - 1.5e-7));

	it('scales to the rounded-up device length, or skips the scale when an edge is within a pixel of the source', () => {
		expect(scale).toHaveLength(168);
		const none = scale.filter((c) => c.pom === 3);
		let sized = 0;
		for (const c of none) {
			const w = edge(c.lu);
			const h = edge(c.lv);
			const near = Math.abs(w - 16) <= 1 || Math.abs(h - 16) <= 1;
			const exact = c.two.filter((t: number[]) => t[2] === 0);
			if (near) {
				// Drawn straight from the source: no intermediate size reproduces it, except the source's own (a 1:1 copy).
				expect(exact.filter((t: number[]) => t[0] !== 16 || t[1] !== 16), `${c.kernel}/${c.deg}/${c.sx},${c.sy}`).toHaveLength(0);
			} else {
				// The rounded-up length is the one intermediate size that reproduces the draw (others may too, 1/16 px apart).
				expect(exact.some((t: number[]) => t[0] === w && t[1] === h), `${c.kernel}/${c.deg}/${c.sx},${c.sy}`).toBe(true);
				sized++;
			}
		}
		expect(none).toHaveLength(84);
		expect(sized).toBe(48);
	});

	it('draws an almost axis-aligned quad as an axis-aligned one', () => {
		const shear = fine.filter((c) => c.set === 'shear' || c.set === 'shear2');
		expect(shear).toHaveLength(124);
		// shear: far corner moved by 48 * shear pixels; shear2: by d pixels. Identical to the axis-aligned draw up to 0.02 px.
		for (const c of fine.filter((c) => c.set === 'shear2')) {
			expect(c.diff === 0, `oy ${c.oy} axis ${c.axis} d ${c.d}`).toBe(c.d <= 0.02);
		}
		for (const c of fine.filter((c) => c.set === 'shear')) {
			expect(c.diff === 0, `shear ${c.shear}`).toBe(c.shear <= 1e-4);
		}
	});

	it('pins the model against every scale in the sweep', () => {
		const src = straight(fine[0].srcBgra);
		const stats: Record<string, Tally> = {};
		for (const c of scale) {
			const lo = Math.min(c.sx, c.sy);
			const hi = Math.max(c.sx, c.sy);
			const near = (lo >= 0.9 && lo <= 1.06) || (hi >= 0.9 && hi <= 1.06);
			const cls = hi <= 0.75 ? 'reduction' : near ? 'near' : 'upscale';
			add((stats[`pom${c.pom} k${c.kernel} ${cls}`] ??= tally()), draw(c, src, 16), c.bgra);
		}
		// Reductions pre-scale with the float model (the exact reduction arithmetic is open): up to 31 levels at 0.5x under Half.
		expect(stats).toEqual({
			'pom3 k6 reduction': { n: 4, px: 197, max: 1, over8: 0, exact: 0 },
			'pom3 k6 near': { n: 18, px: 261, max: 1, over8: 0, exact: 0 },
			'pom3 k6 upscale': { n: 20, px: 191, max: 1, over8: 0, exact: 0 },
			'pom4 k6 reduction': { n: 4, px: 227, max: 23, over8: 24, exact: 0 },
			'pom4 k6 near': { n: 18, px: 291, max: 1, over8: 0, exact: 0 },
			'pom4 k6 upscale': { n: 20, px: 278, max: 1, over8: 0, exact: 0 },
			'pom3 k7 reduction': { n: 4, px: 285, max: 2, over8: 0, exact: 0 },
			'pom3 k7 near': { n: 18, px: 21, max: 4, over8: 0, exact: 12 },
			'pom3 k7 upscale': { n: 20, px: 54, max: 1, over8: 0, exact: 2 },
			'pom4 k7 reduction': { n: 4, px: 304, max: 31, over8: 40, exact: 0 },
			'pom4 k7 near': { n: 18, px: 18, max: 5, over8: 0, exact: 12 },
			'pom4 k7 upscale': { n: 20, px: 121, max: 1, over8: 0, exact: 1 },
		});
	});
});

describe('axis-aligned high-quality phase arithmetic (native noise captures)', () => {
	const noise = load('hq-axis-noise');
	const values = Buffer.from(noise[0].source, 'base64');
	const n = values.length;
	const rgba = new Uint8ClampedArray(n * 8 * 4);
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < n; x++) {
			const o = (y * n + x) * 4;
			rgba[o] = rgba[o + 1] = rgba[o + 2] = values[x];
			rgba[o + 3] = 255;
		}
	}

	it('reproduces the tent exactly and the cubic to 0.08% of values, one level, for every upscale', () => {
		const stats: Record<string, { n: number; px: number; bad: number; max: number }> = {};
		for (const c of noise.slice(1)) {
			const row = Buffer.from(c.row, 'base64');
			const block = resampleImage(
				rgba,
				n,
				8,
				{ srcX: 0, srcY: 0, srcW: n, srcH: 8, toDevice: [c.sx, 0, 0, 1, 0, 0], kernel: c.kernel === 7 ? 'hq-bicubic' : 'hq-bilinear', halfPixelOffset: false },
				{ w: c.w, h: 8 },
			)!;
			const g = (stats[`k${c.kernel} ${c.sx > 1 ? 'upscale' : 'reduction'}`] ??= { n: 0, px: 0, bad: 0, max: 0 });
			g.n++;
			for (let x = 3; x < c.w - 3; x++) {
				const by = 4 - block.y;
				const bx = x - block.x;
				if (by < 0 || by >= block.h || bx < 0 || bx >= block.w) continue;
				const v = Math.round((block.rgba[(by * block.w + bx) * 4 + 1] * block.rgba[(by * block.w + bx) * 4 + 3]) / 255);
				g.px++;
				if (v !== row[x]) {
					g.bad++;
					g.max = Math.max(g.max, Math.abs(v - row[x]));
				}
			}
		}
		// The reductions keep the float model (open): 1,161 and 987 values off, by up to two levels.
		expect(stats).toEqual({
			'k6 upscale': { n: 17, px: 46569, bad: 0, max: 0 },
			'k7 upscale': { n: 17, px: 46569, bad: 35, max: 1 },
			'k6 reduction': { n: 8, px: 4544, bad: 1161, max: 2 },
			'k7 reduction': { n: 8, px: 4544, bad: 987, max: 2 },
		});
	});
});
