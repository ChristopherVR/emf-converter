/**
 * Axis-aligned HighQuality DrawImage of cropped and mirrored sources against native captures:
 *
 * - `hq-crop-impulse.json.gz` (probe `HighQualityCropImpulseProbe.cs`, mode `hq-crop-impulse`): one white row or
 *   column of an opaque black bitmap per draw, so the destination red is 255 x the weight of that texel at every
 *   destination pixel along the draw's axis and the alpha is the share of the kernel on texels that exist. 22
 *   source rectangles (whole bitmaps, inner crops, crops against an edge), both kernels, both record forms
 *   (DrawImagePoints, and DrawImage with a destination rectangle, negative-width when mirrored), scales 0.5 to 3
 *   and five fractional offsets.
 * - `hq-crop-alpha.json.gz` (`HighQualityCropAlphaProbe.cs`): 65,536 white draws read at their edges.
 * - `hq-crop-height.json.gz` (`HighQualityCropHeightProbe.cs`): the unit-scale vertical margin of the rectangle form.
 *
 * What they establish:
 * - A scaled draw's vertical pass reads the source rectangle's rows plus a margin of the kernel's radius (rounded up,
 *   in texels) on each side, and drops every tap past it (alpha 251 instead of 255 in the last row of a 3x tent draw).
 * - A mirrored unit-scale axis is an exact mirror for a DrawImage destination rectangle, and for DrawImagePoints only
 *   when the source rectangle's width and height are both powers of two.
 * - Which margin a unit-scale vertical axis gets is a float32 coin toss that the model does not reproduce.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import type { TransformMatrix } from './emf-types';

const load = <T>(name: string): T => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString()) as T;

interface ImpulseDraw {
	kernel: number;
	form: number;
	axis: number;
	mirror: number;
	layout: number;
	s: number;
	o: number;
	t: number;
	red: string;
	alpha: string;
}

const impulse = load<{ layouts: number[][]; draws: ImpulseDraw[] }>('hq-crop-impulse');

/** The converter's red and alpha along the capture's line for one impulse draw. */
function model(c: ImpulseDraw): { red: number[]; alpha: number[] } {
	const [bw, bh, sx, sy, sw, sh] = impulse.layouts[c.layout];
	const rgba = new Uint8ClampedArray(bw * bh * 4);
	for (let y = 0; y < bh; y++) {
		for (let x = 0; x < bw; x++) {
			const on = (c.axis === 0 ? x : y) === c.t;
			const o = (y * bw + x) * 4;
			rgba[o] = rgba[o + 1] = rgba[o + 2] = on ? 255 : 0;
			rgba[o + 3] = 255;
		}
	}
	let a = 1;
	let d = 1;
	let e = 8;
	let f = 8;
	if (c.axis === 0) {
		if (c.mirror === 0) {
			a = c.s;
			e = 8 + c.o - a * sx;
		} else {
			a = -c.s;
			e = 8 + c.o + c.s * (sx + sw);
		}
	} else {
		d = c.s;
		f = 8 + c.o - d * sy;
	}
	const fr = Math.fround;
	const toDevice: TransformMatrix = [fr(a), 0, 0, fr(d), fr(e), fr(f)];
	const block = resampleImage(
		rgba,
		bw,
		bh,
		{ srcX: sx, srcY: sy, srcW: sw, srcH: sh, toDevice, kernel: c.kernel === 6 ? 'hq-bilinear' : 'hq-bicubic', halfPixelOffset: false, pointsForm: c.form === 0 },
		{ w: 96, h: 96 },
	);
	const red = new Array<number>(96).fill(0);
	const alpha = new Array<number>(96).fill(0);
	if (block) {
		const line = c.axis === 0 ? 8 + sy + Math.floor(sh / 2) : 8 + sx + Math.floor(sw / 2);
		for (let i = 0; i < 96; i++) {
			const px = c.axis === 0 ? i : line;
			const py = c.axis === 0 ? line : i;
			if (px >= block.x && px < block.x + block.w && py >= block.y && py < block.y + block.h) {
				const o = ((py - block.y) * block.w + px - block.x) * 4;
				alpha[i] = block.rgba[o + 3];
				red[i] = Math.round((block.rgba[o] * block.rgba[o + 3]) / 255);
			}
		}
	}
	return { red, alpha };
}

describe('cropped and mirrored high-quality draws (native impulse captures)', () => {
	const groups: Record<string, { draws: number; off: number }> = {};
	for (const c of impulse.draws) {
		const key = `${c.form === 0 ? 'points' : 'rect'} ${c.kernel === 6 ? 'tent' : 'cubic'} ${c.axis === 0 ? (c.mirror ? 'x mirrored' : 'x') : 'y'} ${c.s >= 1 ? (c.s === 1 ? 'unit' : 'upscale') : 'reduction'}`;
		const g = (groups[key] ??= { draws: 0, off: 0 });
		g.draws++;
		const nr = Buffer.from(c.red, 'base64');
		const na = Buffer.from(c.alpha, 'base64');
		const m = model(c);
		let bad = false;
		for (let i = 0; i < 96 && !bad; i++) bad = nr[i] !== m.red[i] || na[i] !== m.alpha[i];
		if (bad) g.off++;
	}

	it('has the expected draws', () => {
		expect(impulse.layouts).toHaveLength(22);
		expect(impulse.draws).toHaveLength(235620);
	});

	it('pins the draws off by any amount per group', () => {
		// `off` counts impulse draws (one texel each) whose red or alpha differs anywhere along the line; a group that
		// is not listed is exact in every draw: the mirrored x axis of the rectangle form at every scale (the unit scale
		// and its whole-edge copy included), the cubic's y axis of the rectangle form, the unit-scale x axis in both
		// forms, the y axis at every upscale in both forms, and the cubic's unit y axis of DrawImagePoints.
		// Off by one or two levels: the reductions (a texel edge exactly at the end of the kernel), one 1.5x tie at a
		// half-pixel offset, the cubic's y reduction, and the mirrored axes of DrawImagePoints (a unit of the float32
		// position, a coin toss). The tent's unit y axis is off by up to 18 levels: whether its margin is one texel or
		// two is a float32 coin toss (see `hq-crop-alpha`, `hq-crop-height`).
		expect(Object.fromEntries(Object.entries(groups).filter(([, g]) => g.off > 0).map(([k, g]) => [k, g.off]))).toEqual({
			'points cubic x mirrored reduction': 72,
			'points cubic x mirrored unit': 189,
			'points cubic x mirrored upscale': 617,
			'points cubic x reduction': 102,
			'points cubic x upscale': 32,
			'points cubic y reduction': 146,
			'points tent x mirrored reduction': 132,
			'points tent x mirrored unit': 256,
			'points tent x mirrored upscale': 552,
			'points tent x reduction': 103,
			'points tent x upscale': 32,
			'points tent y reduction': 402,
			'points tent y unit': 566,
			'rect cubic x reduction': 48,
			'rect cubic x upscale': 32,
			'rect tent x reduction': 48,
			'rect tent x upscale': 32,
			'rect tent y reduction': 252,
			'rect tent y unit': 438,
		});
		expect(Object.values(groups).reduce((t, g) => t + g.draws, 0)).toBe(235620);
	});

	it('keeps the unit-scale vertical margin of a rectangle draw a function of the height alone', () => {
		// The alpha of the last covered row says whether the tap one texel past the rectangle was read (255) or
		// dropped (less). For the rectangle form it is the same in every layout of equal height and offset (not
		// counting layouts whose rectangle ends at the bitmap's edge); for DrawImagePoints the width also decides in 2 of the 35 groups (more in the 65,536 draws of `hq-crop-alpha`).
		const lastAlpha = new Map<string, Set<number>>();
		for (const form of [0, 1]) {
			for (const c of impulse.draws) {
				if (c.t !== 0 || c.kernel !== 6 || c.axis !== 1 || c.s !== 1 || c.form !== form) continue;
				const [, bh, , sy, , sh] = impulse.layouts[c.layout];
				if (sy + sh >= bh) continue;
				const alpha = Buffer.from(c.alpha, 'base64');
				let last = 0;
				for (let i = 0; i < 96; i++) if (alpha[i]) last = i;
				const key = `${form} o${c.o} sh${sh}`;
				(lastAlpha.get(key) ?? lastAlpha.set(key, new Set()).get(key)!).add(alpha[last]);
			}
		}
		const disagree = (form: number): number => [...lastAlpha].filter(([k, v]) => k.startsWith(`${form} `) && v.size > 1).length;
		expect(disagree(1)).toBe(0);
		expect(disagree(0)).toBe(2);
		expect([...lastAlpha].filter(([k]) => k.startsWith('1 ')).length).toBe(35);
	});
});

describe('mirrored unit-scale DrawImagePoints against 65,536 white draws', () => {
	const alpha = load<{ draws: number[][] }>('hq-crop-alpha');
	const pow2 = (v: number): boolean => v > 0 && (v & (v - 1)) === 0;

	it('is an exact mirror (a fading right edge) exactly when the width and the height are powers of two', () => {
		// A draw [kernel, mirror, origin, scales, fraction, sw, sh, base, topRow, top, bottom, left, right]: with the
		// rectangle at the bitmap's origin the exact mirror ends in a fade, any other size reads two texels past the
		// bitmap's edge and keeps alpha 255.
		let draws = 0;
		let violations = 0;
		for (const d of alpha.draws) {
			const [, mirror, origin, scales, , sw, sh, , , , , , right] = d;
			if (mirror !== 1 || origin !== 0 || scales !== 0 || sw < 3) continue;
			draws++;
			if ((right !== 255) !== (pow2(sw) && pow2(sh))) violations++;
		}
		expect(draws).toBe(15360);
		expect(violations).toBe(0);
	});
});

describe('rotated high-quality draws at whole device lengths (native capture, open)', () => {
	it('keeps the 528 draws whose pre-scale size no float32 length formula predicts', () => {
		// The capture is the data the Half 45-degree 0.5x item needs (see "Round 5" in docs/outstanding-work.md): the
		// pre-scale size that best reproduces a draw differs from the rounded-up float32 length in 142 of the draws, and
		// no length formula tried predicts it for more than 222 of the 313 draws one size fits to within five pixels.
		const capture = load<{ srcBgra: string; draws: { pom: number; kernel: number; deg: number; su: number; sv: number; p: number[]; w: number; h: number }[] }>('hq-half-length');
		expect(capture.draws).toHaveLength(528);
		const count = (pom: number, kernel: number): number => capture.draws.filter((d) => d.pom === pom && d.kernel === kernel).length;
		expect([count(3, 6), count(3, 7), count(4, 6), count(4, 7)]).toEqual([132, 132, 132, 132]);
		expect(new Set(capture.draws.map((d) => d.deg)).size).toBe(11);
		expect(Buffer.from(capture.srcBgra, 'base64')).toHaveLength(16 * 16 * 4);
	});
});
