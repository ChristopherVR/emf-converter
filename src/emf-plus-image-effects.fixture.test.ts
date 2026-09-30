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
	within('blur-r2p5'), // 39.880% before, 0.212% one level off now
	exact('blur-r3'), // 54.517% before; rounding rows before the vertical pass removes the residue
	exact('blur-r3-expand'), // 68.673% before
	within('blur-r10'), // 83.138%, 0.191%
	within('blur-r10-expand'), // 99.972%, 0.118%
	exact('blur-r4-subrect'), // 84.719%
	exact('blur-r4-subrect-expand'), // 96.044% before
	exact('blur-r3-scale2'), // 71.126% before
	exact('blur-r3-rotate30'), // 79.590% before; draw-edge sampling differences remain in playback
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
 * changes match; a hue rotation is within a few levels (GDI+ rounds some
 * hues differently, mostly near sextant boundaries).
 */
const HSL: EffectCase[] = [
	exact('hsl-h0-sn100-l0'), // 37.500% before
	within('hsl-h0-s0-ln50'), // 87.463%, 0.098% one level off now
	bounded('hsl-h0-s0-l50', 0, 0.0015), // 87.463%, 0.098% (4 levels at most)
	bounded('hsl-h0-s60-l0', 0, 0.01), // 76.298%, 0.879% (6 levels at most)
	bounded('hsl-hn120-s0-l0', 0, 0.0035), // 51.270%, 0.293% (6 levels at most)
	bounded('hsl-h90-s0-l0', 2, 0.07), // 58.720%, 10.189% (6.120% beyond 2 levels, 11 at most)
	bounded('hsl-h180-s0-l0', 2, 0.17), // 54.000%, 26.656% (16.305% beyond 2 levels, 6 at most)
	bounded('hsl-h30-sn30-l20', 2, 0.33), // 87.333%, 57.874% (31.966% beyond 2 levels, 6 at most)
];

/** Tint: toward luma plus the tint chroma scaled by the largest channel, a fitted chroma scale. */
const TINT: EffectCase[] = [
	within('tint-h0-a50', 2), // 97.005% before, 60.543% now (0.130% beyond 1 level)
	within('tint-h120-a100', 2), // 96.908%, 41.211% (0.651%)
	within('tint-h180-a100', 2), // 96.908%, 54.325% (2.962%)
	within('tint-hn90-a30', 2), // 97.005%, 73.889% (3.906%)
	bounded('tint-h60-an50', 2, 0.001), // 93.066%, 51.493% (0.065% three levels off)
];

/** RedEyeCorrection: GDI+ repaints detected pupils with a texture; approximated. */
const RED_EYE: EffectCase[] = [
	bounded('redeye-left', 0, 0.011), // 3.659% before, 0.948% now
	bounded('redeye-both', 0, 0.02), // 6.860%, 1.872%
	bounded('redeye-whole', 0, 0.17), // 46.227%, 16.787%
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
