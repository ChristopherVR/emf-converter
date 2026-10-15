/**
 * Native image effects on translucent pixels (`EffectAlphaProbe.cs`,
 * `effect-alpha.json.gz`; regenerate with `generate.ps1 effect-alpha`).
 *
 * Each capture draws a 256 x 256 source (x = grey level, y = alpha) 1:1 through
 * `GdipDrawImageFX`. The straight-ARGB captures pin the compositing the
 * converter's canvas already does (premultiply with rounding, add the
 * backdrop's share). The 32bppPARGB captures are drawn over black, so they hold
 * the premultiplied colour GDI+ produced; they show that the effect sees the
 * premultiplied bitmap's colours restored by truncation
 * (`premultipliedPlaybackSource`), the step that the 96 half-transparent bar
 * pixels of every `plus-effect-*` fixture exposed.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyImageEffect, premultipliedPlaybackSource, type EmfPlusImageEffect } from './emf-plus-image-effects';

interface Capture {
	name: string;
	kind: string;
	premultiplied: boolean;
	backdrop: number;
	bgra: string;
}

const captures: Capture[] = JSON.parse(
	gunzipSync(readFileSync(new URL('./__fixtures__/gdi/effect-alpha.json.gz', import.meta.url))).toString(),
);

const lut = (f: (v: number) => number): Uint8Array => Uint8Array.from({ length: 256 }, (_, v) => f(v));
const effects: Record<string, EmfPlusImageEffect | null> = {
	none: null,
	'brightnesscontrast-b0-c50': { kind: 'brightnessContrast', brightness: 0, contrast: 50 },
	'brightnesscontrast-b30-c40': { kind: 'brightnessContrast', brightness: 30, contrast: 40 },
	'tint-h60-an50': { kind: 'tint', hue: 60, amount: -50 },
	'levels-h100-m50-s0': { kind: 'levels', highlight: 100, midtone: 50, shadow: 0 },
	'colorbalance-100': { kind: 'colorBalance', cyanRed: 100, magentaGreen: 100, yellowBlue: 100 },
	'colormatrix-sepia': {
		kind: 'colorMatrix',
		matrix: [
			0.393, 0.349, 0.272, 0, 0, 0.769, 0.686, 0.534, 0, 0, 0.189, 0.168, 0.131, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1,
		],
	},
	'colorlut-mixed': {
		kind: 'colorLookupTable',
		b: lut((v) => v),
		g: lut((v) => Math.round(255 * Math.sqrt(v / 255))),
		r: lut((v) => 255 - v),
		a: lut((v) => v),
	},
	'hsl-h30-sn30-l20': { kind: 'hueSaturationLightness', hue: 30, saturation: -30, lightness: 20 },
};

const source = new Uint8ClampedArray(256 * 256 * 4);
for (let a = 0; a < 256; a++) {
	for (let c = 0; c < 256; c++) source.set([c, c, c, a], (a * 256 + c) * 4);
}

/** Per-channel counts of native bytes the model reproduces, and the number compared. */
function compare(capture: Capture, model: (effected: Uint8ClampedArray, i: number, ch: number) => number, input: Uint8ClampedArray) {
	const effect = effects[capture.name];
	const effected = effect ? applyImageEffect(input, 256, 256, effect)! : input;
	const native = Buffer.from(capture.bgra, 'base64');
	let same = 0;
	let compared = 0;
	let alpha128 = 0;
	for (let a = 0; a < 256; a++) {
		for (let c = 0; c < 256; c++) {
			for (let ch = 0; ch < 3; ch++) {
				const i = (a * 256 + c) * 4;
				const equal = model(effected, i, ch) === native[i + 2 - ch];
				compared++;
				if (equal) same++;
				if (a === 128 && !equal) alpha128++;
			}
		}
	}
	return { same, compared, alpha128 };
}

describe('native effects on translucent pixels', () => {
	const names = Object.keys(effects);

	it('has every effect captured with both source formats', () => {
		expect(captures).toHaveLength(names.length * 2);
		for (const name of names) {
			expect(captures.filter((c) => c.name === name).map((c) => c.premultiplied).sort()).toEqual([false, true]);
		}
	});

	describe('a straight ARGB source is effected as it is, then composited with rounded premultiplication', () => {
		it.each(names)('%s', (name) => {
			const capture = captures.find((c) => c.name === name && !c.premultiplied)!;
			const backdrop = [(capture.backdrop >>> 16) & 255, (capture.backdrop >>> 8) & 255, capture.backdrop & 255];
			const result = compare(
				capture,
				(effected, i, ch) =>
					Math.round((effected[i + ch] * effected[i + 3]) / 255) + Math.round((backdrop[ch] * (255 - effected[i + 3])) / 255),
				source,
			);
			expect(result.same).toBe(result.compared);
		});
	});

	describe('a premultiplied source is effected after a premultiply-and-restore round trip', () => {
		it.each(names)('%s', (name) => {
			const capture = captures.find((c) => c.name === name && c.premultiplied)!;
			const premultiplied = (effected: Uint8ClampedArray, i: number, ch: number): number =>
				Math.round((effected[i + ch] * effected[i + 3]) / 255);
			// With no effect the converter draws the source untouched.
			const modelled = compare(capture, premultiplied, name === 'none' ? source : premultipliedPlaybackSource(source));
			// The pixels of every fixture's half-transparent bar (alpha 128) are exact, and so are
			// opaque and transparent ones; truncating the restore leaves under 1.5% of bytes a level or two low.
			expect(modelled.alpha128).toBe(0);
			expect(modelled.same / modelled.compared).toBeGreaterThan(0.985);
			// Without the round trip (the converter before this probe) more bytes differ for every real effect.
			if (name !== 'none') {
				const straight = compare(capture, premultiplied, source);
				expect(straight.same).toBeLessThan(modelled.same);
			}
		});
	});
});
