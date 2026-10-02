/**
 * The converter's EMF+ image effects against GDI+'s own results.
 *
 * GDI+ writes the bitmap it computed for every `DrawImage` with an effect
 * into the metafile, right after the effect draw (see
 * `__fixtures__/emf-plus-effect-baked.ts`), so each `plus-effect-*`
 * fixture carries the source pixels, the effect and GDI+'s exact output.
 * Each case applies the effect with `applyImageEffectToRect` and bounds
 * the share of source-rectangle pixels whose largest channel (alpha
 * included) differs from GDI+'s by more than `tolerance`.
 *
 * The comments give the share of pixels off at tolerance 0 before the
 * algorithms were measured against these bitmaps and now. The playback of
 * the same fixtures (what Windows paints) is covered by
 * `gdi-parity.fixture.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import { diffBakedEffects } from './__fixtures__/emf-plus-effect-baked-diff';
import { readBakedEffects } from './__fixtures__/emf-plus-effect-baked';
import { applyImageEffectToRect } from './emf-plus-image-effects';

describe('native expanded blur regions', () => {
	it('matches 504 draws across radii, edge positions, fractional rectangles and alpha to one level', async () => {
		const cases = await readBakedEffects('effect-blur-expanded');
		expect(cases).toHaveLength(504);
		// Share of compared pixels that match exactly, for radii below and from 20.
		const exact = { small: [0, 0], large: [0, 0] };
		for (const { source, effect, srcRect, baked } of cases) {
			expect(effect.kind).toBe('blur');
			if (effect.kind !== 'blur') throw new Error('not a blur capture');
			const [x, y, w, h] = srcRect;
			const region = applyImageEffectToRect(source.data, source.width, source.height, effect, { x, y, w, h })!;
						let maximum = 0;
			for (let yy = 0; yy < Math.ceil(h); yy++) for (let xx = 0; xx < Math.ceil(w); xx++) {
				const i = (yy * region.width + xx) * 4, j = (yy * baked.width + xx) * 4;
				let pixel = Math.abs(region.rgba[i + 3] - baked.data[j + 3]);
				if (region.rgba[i + 3] || baked.data[j + 3]) for (let ch = 0; ch < 3; ch++) {
					pixel = Math.max(pixel, Math.abs(region.rgba[i + ch] - baked.data[j + ch]));
				}
				maximum = Math.max(maximum, pixel);
				exact[effect.radius < 20 ? 'small' : 'large'][0] += pixel === 0 ? 1 : 0;
				exact[effect.radius < 20 ? 'small' : 'large'][1]++;
			}
			expect(maximum, `radius ${effect.radius}, rectangle ${srcRect}`).toBeLessThanOrEqual(1);
		}
		expect(exact.small[0] / exact.small[1]).toBeGreaterThan(0.9995);
		expect(exact.large[0] / exact.large[1]).toBeGreaterThan(0.9995);
	}, 60000);

	it('matches 150 narrow and edge-reaching draws exactly, including a lone reduced sample', async () => {
		// One reduced sample (rectangles up to a block wide) is continued toward a transparent neighbour from
		// its block's middle, or from just past its last pixel in a shorter block; samples beyond the buffer
		// are transparent, not reflected; only a rectangle's own reduced samples are enlarged.
		const cases = await readBakedEffects('effect-blur-narrow');
		expect(cases).toHaveLength(150);
		for (const { source, effect, srcRect, baked } of cases) {
			if (effect.kind !== 'blur') throw new Error('not a blur capture');
			const [x, y, w, h] = srcRect;
			const region = applyImageEffectToRect(source.data, source.width, source.height, effect, { x, y, w, h })!;
			for (let yy = 0; yy < Math.ceil(h); yy++) for (let xx = 0; xx < Math.ceil(w); xx++) {
				const i = (yy * region.width + xx) * 4, j = (yy * baked.width + xx) * 4;
				const label = `radius ${effect.radius}, rectangle ${srcRect}, pixel ${xx},${yy}`;
				expect(region.rgba[i + 3], label).toBe(baked.data[j + 3]);
				if (baked.data[j + 3]) for (let ch = 0; ch < 3; ch++) expect(region.rgba[i + ch], label).toBe(baked.data[j + ch]);
			}
		}
	}, 60000);
});

interface EffectCase {
	name: string;
	tolerance: number;
	maxMismatch: number;
}

/** Pixel-exact against GDI+. */
const exact = (name: string): EffectCase => ({ name: `plus-effect-${name}`, tolerance: 0, maxMismatch: 0 });
/** Every pixel within `tolerance` levels of GDI+ (default one: rounding of a float kernel or spline). */
const within = (name: string, tolerance = 1): EffectCase => ({ name: `plus-effect-${name}`, tolerance, maxMismatch: 0 });
/** At most `maxMismatch` of the pixels more than `tolerance` levels off. */
const bounded = (name: string, tolerance: number, maxMismatch: number): EffectCase => ({
	name: `plus-effect-${name}`,
	tolerance,
	maxMismatch,
});

/**
 * Blur: GDI+ blurs each row with `exp(-(1.4 * offset / radius)^2)` (taps to
 * `ceil(radius)`, rows reflected at their ends) and only the top row down
 * its column; expandEdge blurs transparency in. The one-level differences
 * are float rounding.
 */
const BLUR: EffectCase[] = [
	exact('blur-r1'), // 5.615% before
	exact('blur-r2p5'), // 39.880% before, 0.212% one level off now
	exact('blur-r3'), // 54.517% before; rounding rows before the vertical pass removes the residue
	exact('blur-r3-expand'), // 68.673% before
	exact('blur-r10'), // 83.138%, 0.191%
	exact('blur-r10-expand'), // 99.972%, 0.118%
	exact('blur-r4-subrect'), // 84.719%
	exact('blur-r4-subrect-expand'), // 96.044% before
	exact('blur-r3-scale2'), // 71.126% before
	exact('blur-r3-rotate30'), // 79.590% before
];

/** Sharpen: an unsharp mask along rows against GDI+'s 8-bit row blur. */
const SHARPEN: EffectCase[] = [
	exact('sharpen-r0p5-a100'), // 0.391% before
	exact('sharpen-r1-a50'), // 2.051%
	exact('sharpen-r2-a0'), // 0.391%
	exact('sharpen-r3-a100'), // 44.132%
	exact('sharpen-r6-a30'), // 62.516%
];

/** Per-channel tables: BrightnessContrast, ColorBalance, Levels, ColorMatrix, ColorLUT. */
const TONE: EffectCase[] = [
	exact('brightnesscontrast-b50-c0'),
	exact('brightnesscontrast-bn80-c0'),
	exact('brightnesscontrast-b0-c50'),
	exact('brightnesscontrast-b0-cn50'),
	exact('brightnesscontrast-b0-c100'),
	exact('brightnesscontrast-b0-cn100'),
	exact('brightnesscontrast-b30-c40'), // 65.588% before
	exact('colorbalance-cr60-mg0-yb0'), // 87.891%
	exact('colorbalance-cr0-mgn40-yb0'),
	exact('colorbalance-cr0-mg0-yb80'), // 79.134%
	exact('colorbalance-crn100-mg50-ybn20'), // 87.467%
	exact('colorbalance-cr100-mg100-yb100'), // 78.483%
	exact('levels-h80-m0-s0'), // 25.781%
	exact('levels-h100-m0-s20'), // 18.685%
	exact('levels-h100-m50-s0'), // 86.747%
	exact('levels-h100-mn50-s0'), // 86.747%
	exact('levels-h90-mn30-s10'), // 75.549%
	exact('colormatrix-grayscale'),
	exact('colormatrix-sepia'),
	exact('colormatrix-swap-translate'),
	exact('colormatrix-invert'),
	exact('colormatrix-alpha-half'),
	exact('colorlut-mixed'),
	exact('colorlut-posterize'),
	exact('colorlut-alpha'),
];

/**
 * ColorCurve: a natural cubic spline through 23 control points. Contrast,
 * Highlight and Shadow use control points measured from these fixtures,
 * rounded to a tenth of a level, hence the one-level residue.
 */
const CURVE: EffectCase[] = [
	exact('colorcurve-exposure-64'), // 85.905% before
	exact('colorcurve-exposure-n64'), // 87.203%
	exact('colorcurve-exposure-64-red'), // 76.823%
	exact('colorcurve-density-64'), // 97.005%
	exact('colorcurve-density-n64'), // 93.681%
	within('colorcurve-contrast-50'), // 86.161%, 0.716% one level off now
	within('colorcurve-contrast-n50'), // 95.703%, 2.279%
	within('colorcurve-contrast-50-blue'), // 53.479%, 0.358%
	within('colorcurve-highlight-50'), // 48.206%, 1.953%
	within('colorcurve-highlight-n50'), // 48.271%, 0.781%
	within('colorcurve-shadow-50'), // 55.758%, 1.107%
	within('colorcurve-shadow-n50'), // 58.362%, 2.344%
	exact('colorcurve-midtone-50'), // 86.552%
	exact('colorcurve-midtone-n50'), // 86.747%
	exact('colorcurve-midtone-n50-green'), // 61.910%
	within('colorcurve-whitesat-200'), // 5.404%, 0.521%
	exact('colorcurve-blacksat-60'), // 1.107%
];

/**
 * HueSaturationLightness in GDI+'s integer HSL: lightness and saturation
 * rotation fixtures match exactly; saturation/mixed controls retain
 * one-level rounding differences.
 */
const HSL: EffectCase[] = [
	exact('hsl-h0-sn100-l0'), // 37.500% before
	exact('hsl-h0-s0-ln50'),
	exact('hsl-h0-s0-l50'),
	exact('hsl-h0-s60-l0'),
	exact('hsl-hn120-s0-l0'),
	exact('hsl-h90-s0-l0'),
	exact('hsl-h180-s0-l0'),
	exact('hsl-h30-sn30-l20'),
];

/** Tint in GDI+'s integer luma-preserving arithmetic: exact. */
const TINT: EffectCase[] = [
	exact('tint-h0-a50'), // 97.005% before, 60.543% within 2 levels
	exact('tint-h120-a100'), // 96.908% before
	exact('tint-h180-a100'), // 96.908% before
	exact('tint-hn90-a30'), // 97.005% before
	exact('tint-h60-an50'), // 93.066% before
];

/**
 * RedEyeCorrection: the sector model of `applyRedEyeCorrection` against GDI+.
 * Skin and the glow around pupils follow it closely; the pupils' own texture
 * and the red-ramp bands (a 256 x 64 gradient test image) are approximate.
 */
const RED_EYE: EffectCase[] = [
	bounded('redeye-left', 0, 0.0072), // 3.659% with the old fixed rule, 0.71% now
	bounded('redeye-both', 0, 0.015), // 6.860%, 1.49%
	bounded('redeye-whole', 0, 0.0352), // 46.227%, 3.51%
];

describe('EMF+ image effects against GDI+-computed bitmaps', () => {
	const groups: Array<[string, EffectCase[]]> = [
		['Blur', BLUR],
		['Sharpen', SHARPEN],
		['BrightnessContrast, ColorBalance, Levels, ColorMatrix, ColorLUT', TONE],
		['ColorCurve', CURVE],
		['HueSaturationLightness', HSL],
		['Tint', TINT],
		['RedEyeCorrection', RED_EYE],
	];
	for (const [title, cases] of groups) {
		describe(title, () => {
			it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
				const diff = await diffBakedEffects(c.name, c.tolerance);
				expect(diff.compared).toBeGreaterThan(0);
				expect(diff.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
			});
		});
	}
});
