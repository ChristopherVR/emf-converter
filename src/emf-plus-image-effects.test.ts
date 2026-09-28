import { describe, it, expect } from 'vitest';

import {
	blurObject,
	COLOR_MATRIX_GUID,
	colorMatrixObject,
	fixtureBuffer,
	serializableObject,
	TINT_GUID,
	withEffect,
} from './__fixtures__/emf-plus-effect-records';
import {
	applyImageEffect,
	applyImageEffectToRect,
	blurKernel,
	CurveAdjustment,
	CurveChannel,
	parseSerializableObject,
	sharpenGain,
	type EmfPlusImageEffect,
} from './emf-plus-image-effects';
import { decodePng } from './png-decoder';
import { convertMetafileToDataUrl, convertMetafileToSvg } from './index';

/** Straight RGBA pixels from `[r, g, b, a]` tuples. */
function px(...pixels: number[][]): Uint8ClampedArray {
	return new Uint8ClampedArray(pixels.flat());
}

/** One opaque grey row. */
function greyRow(...values: number[]): Uint8ClampedArray {
	return px(...values.map((v) => [v, v, v, 255]));
}

/** Applies `effect` to a single-row image. */
function apply(src: Uint8ClampedArray, effect: EmfPlusImageEffect, width = src.length / 4, height = 1): number[] {
	const out = applyImageEffect(src, width, height, effect);
	expect(out).not.toBeNull();
	return Array.from(out!);
}

/** The red channel of every pixel. */
const reds = (rgba: number[]): number[] => rgba.filter((_, i) => i % 4 === 0);

const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
/** Swaps red and blue: output red reads input blue and vice versa. */
const SWAP_RB = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];

describe('ColorMatrix', () => {
	it('maps [r g b a 1] through the matrix, normalised to 0..1', () => {
		const src = px([255, 128, 0, 255], [10, 20, 30, 128]);
		expect(apply(src, { kind: 'colorMatrix', matrix: IDENTITY }, 2)).toEqual(Array.from(src));
		expect(apply(src, { kind: 'colorMatrix', matrix: SWAP_RB }, 2)).toEqual([0, 128, 255, 255, 30, 20, 10, 128]);
	});

	it('uses the fifth row as a translation and scales alpha, clamping', () => {
		const m = IDENTITY.slice();
		m[18] = 0.5; // alpha * 0.5
		m[20] = 0.2; // red + 0.2
		m[21] = -1; // green - 1
		// Red: 200/255 + 0.2 = 0.984 -> 251; green clamps to 0; alpha 255 -> 128.
		expect(apply(px([200, 200, 200, 255]), { kind: 'colorMatrix', matrix: m })).toEqual([251, 0, 200, 128]);
	});

	it('makes grey from luminance weights in the columns', () => {
		const m = new Array(25).fill(0);
		for (const j of [0, 1, 2]) {
			m[j] = 0.3;
			m[5 + j] = 0.59;
			m[10 + j] = 0.11;
		}
		m[18] = 1;
		// 0.3 * 200 + 0.59 * 100 + 0.11 * 50 = 124.5 -> 125 (rounded in 0..1 space: 0.48824 * 255).
		expect(apply(px([200, 100, 50, 255]), { kind: 'colorMatrix', matrix: m })).toEqual([125, 125, 125, 255]);
	});
});

describe('ColorLookupTable', () => {
	it('maps each channel through its own table', () => {
		const inv = new Uint8Array(256).map((_, i) => 255 - i);
		const id = new Uint8Array(256).map((_, i) => i);
		const zero = new Uint8Array(256);
		const effect: EmfPlusImageEffect = { kind: 'colorLookupTable', b: zero, g: id, r: inv, a: id };
		expect(apply(px([10, 20, 30, 40]), effect)).toEqual([245, 20, 0, 40]);
	});
});

describe('BrightnessContrast', () => {
	it('adds brightness', () => {
		expect(reds(apply(greyRow(0, 100, 250), { kind: 'brightnessContrast', brightness: 20, contrast: 0 }))).toEqual([
			20, 120, 255,
		]);
	});

	it('scales about mid-grey: gain 100 / (100 - c) above zero, (100 + c) / 100 below', () => {
		// (100 - 127.5) * 2 + 127.5 = 72.5 -> 73; (200 - 127.5) * 2 + 127.5 = 272.5 -> 255.
		expect(reds(apply(greyRow(100, 200), { kind: 'brightnessContrast', brightness: 0, contrast: 50 }))).toEqual([
			73, 255,
		]);
		// (100 - 127.5) * 0.5 + 127.5 = 113.75 -> 114.
		expect(reds(apply(greyRow(100), { kind: 'brightnessContrast', brightness: 0, contrast: -50 }))).toEqual([114]);
		expect(reds(apply(greyRow(0, 255), { kind: 'brightnessContrast', brightness: 0, contrast: -100 }))).toEqual([
			128, 128,
		]);
	});

	it('adds half the brightness before the contrast gain and half after', () => {
		// Gain 100 / 60: (34 + 15 - 127.5) * 5 / 3 + 127.5 + 15 = 11.67 -> 12; 128 -> 168.33 -> 168.
		expect(reds(apply(greyRow(34, 128), { kind: 'brightnessContrast', brightness: 30, contrast: 40 }))).toEqual([12, 168]);
	});

	it('leaves alpha alone', () => {
		expect(apply(px([100, 100, 100, 77]), { kind: 'brightnessContrast', brightness: 10, contrast: 0 })[3]).toBe(77);
	});
});

describe('ColorBalance', () => {
	it('scales each channel by 1 + t / 100', () => {
		const effect: EmfPlusImageEffect = { kind: 'colorBalance', cyanRed: 50, magentaGreen: -50, yellowBlue: 0 };
		expect(apply(px([100, 100, 100, 255]), effect)).toEqual([150, 50, 100, 255]);
		expect(apply(px([200, 16, 0, 255]), { kind: 'colorBalance', cyanRed: 60, magentaGreen: 60, yellowBlue: 60 })).toEqual([
			255, 26, 0, 255,
		]);
	});
});

describe('ColorCurve', () => {
	const curve = (adjustment: number, intensity: number, channel: number = CurveChannel.All): EmfPlusImageEffect => ({
		kind: 'colorCurve',
		adjustment,
		channel,
		intensity,
	});

	it('WhiteSaturation maps [0, t] onto [0, 255] through the 23-point spline', () => {
		// The spline through x * 255 / 128 dips a little below the line at 64 (127.5 -> 127).
		expect(reds(apply(greyRow(64, 200), curve(CurveAdjustment.WhiteSaturation, 128)))).toEqual([127, 255]);
	});

	it('BlackSaturation maps [t, 255] onto [0, 255], on the chosen channel only', () => {
		expect(apply(px([192, 192, 192, 255], [64, 0, 0, 255]), curve(CurveAdjustment.BlackSaturation, 128, CurveChannel.Red), 2)).toEqual(
			[129, 192, 192, 255, 0, 0, 0, 255],
		);
	});

	it('Exposure and Density both add t', () => {
		expect(reds(apply(greyRow(0, 100, 200, 255), curve(CurveAdjustment.Exposure, 64)))).toEqual([64, 164, 255, 255]);
		expect(reds(apply(greyRow(0, 100, 200), curve(CurveAdjustment.Density, -64)))).toEqual([0, 36, 136]);
	});

	it('Midtone is a gamma curve fixing black and white (exponent 0.5 at +50, 2 at -50)', () => {
		expect(reds(apply(greyRow(0, 64, 255), curve(CurveAdjustment.Midtone, 50)))).toEqual([0, 128, 255]);
		expect(reds(apply(greyRow(0, 64, 255), curve(CurveAdjustment.Midtone, -50)))).toEqual([0, 16, 255]);
	});

	it('Highlight moves only values above 128, Shadow only values below', () => {
		expect(reds(apply(greyRow(64, 128, 191, 255), curve(CurveAdjustment.Highlight, 50)))).toEqual([64, 128, 225, 255]);
		expect(reds(apply(greyRow(0, 64, 128, 200), curve(CurveAdjustment.Shadow, -50)))).toEqual([0, 30, 128, 200]);
	});

	it('Contrast is an S-curve about mid-grey, half as strong at 25 as at 50', () => {
		expect(reds(apply(greyRow(0, 64, 128, 191, 255), curve(CurveAdjustment.Contrast, 50)))).toEqual([0, 27, 129, 228, 255]);
		expect(reds(apply(greyRow(64, 191), curve(CurveAdjustment.Contrast, 25)))).toEqual([46, 209]);
	});

	it('is not applied for an unknown adjustment or channel', () => {
		expect(applyImageEffect(greyRow(1), 1, 1, curve(99, 10))).toBeNull();
		expect(applyImageEffect(greyRow(1), 1, 1, curve(CurveAdjustment.Exposure, 10, 7))).toBeNull();
	});
});

describe('Levels', () => {
	it('stretches [shadow%, highlight%] onto [0, 255], rounding halves down', () => {
		// White point 127.5: 64 -> 128.0, 200 -> 255, 2 -> 4.
		expect(reds(apply(greyRow(64, 200, 2), { kind: 'levels', highlight: 50, midtone: 0, shadow: 0 }))).toEqual([128, 255, 4]);
		// Black point 51: 51 -> 0, 153 -> 127.5 -> 127.
		expect(reds(apply(greyRow(51, 153), { kind: 'levels', highlight: 100, midtone: 0, shadow: 20 }))).toEqual([0, 127]);
	});

	it('raises to 1 / (1 + m / 50) for a positive midtone and 1 - m / 50 for a negative one', () => {
		// 255 * (64 / 255) ^ 0.5 = 127.75 -> 128; 255 * (128 / 255) ^ 1.6 = 84.6 -> 85.
		expect(reds(apply(greyRow(64, 128), { kind: 'levels', highlight: 100, midtone: 50, shadow: 0 }))).toEqual([128, 181]);
		expect(reds(apply(greyRow(128), { kind: 'levels', highlight: 100, midtone: -30, shadow: 0 }))).toEqual([85]);
	});

	it('is the identity at its defaults', () => {
		const src = greyRow(0, 17, 128, 255);
		expect(apply(src, { kind: 'levels', highlight: 100, midtone: 0, shadow: 0 })).toEqual(Array.from(src));
	});
});

describe('HueSaturationLightness', () => {
	const hsl = (hue: number, saturation: number, lightness: number): EmfPlusImageEffect => ({
		kind: 'hueSaturationLightness',
		hue,
		saturation,
		lightness,
	});

	it('rotates hue counter-clockwise (red to green at +120), in integer HSL (full red has lightness 127)', () => {
		expect(apply(px([255, 0, 0, 255]), hsl(120, 0, 0))).toEqual([0, 254, 0, 255]);
		expect(apply(px([255, 0, 0, 255]), hsl(-120, 0, 0))).toEqual([0, 0, 254, 255]);
	});

	it('removes saturation at -100 and moves lightness by 2.55 t levels', () => {
		expect(apply(px([255, 0, 0, 255]), hsl(0, -100, 0))).toEqual([127, 127, 127, 255]);
		expect(apply(px([255, 0, 0, 255]), hsl(0, 0, 100))).toEqual([255, 255, 255, 255]);
		// Lightness 127 - 127.5 rounds to 0: black.
		expect(apply(px([255, 0, 0, 255]), hsl(0, 0, -50))).toEqual([0, 0, 0, 255]);
		// 0 + 127.5 and 128 + 127.5 round up.
		expect(apply(px([0, 0, 0, 255], [128, 128, 128, 255]), hsl(0, 0, 50), 2)).toEqual([128, 128, 128, 255, 255, 255, 255, 255]);
	});

	it('scales saturation, keeping lightness', () => {
		// Lightness 143, saturation 95 / 223 * 1.6: the minimum 66.7 rounds to 67, the maximum 286 - 67.
		expect(apply(px([191, 96, 96, 255]), hsl(0, 60, 0))).toEqual([219, 67, 67, 255]);
		// Lightness 16: the maximum 16 * (1 + 95 / 223) = 22.8 truncates to 22, the minimum 32 - 22.
		expect(apply(px([191, 96, 96, 255]), hsl(0, 0, -50))).toEqual([22, 10, 10, 255]);
	});
});

describe('Tint', () => {
	const tint = (hue: number, amount: number): EmfPlusImageEffect => ({ kind: 'tint', hue, amount });

	it('moves toward the luma plus the tint chroma scaled by the largest channel', () => {
		// Grey 128, red: 128 + 128 * 0.985 * (0.7874, -0.2126, -0.2126) = (227.3, 101.2, 101.2).
		expect(apply(px([128, 128, 128, 255]), tint(0, 100))).toEqual([227, 101, 101, 255]);
		// Half the amount: half way there.
		expect(apply(px([128, 128, 128, 255]), tint(0, 50))).toEqual([178, 115, 115, 255]);
	});

	it('replaces other hues by the tint hue at full amount, keeping their luma', () => {
		// Red 200: luma 42.5 plus 200 * 0.985 * green's chroma (0.2848) on green, the rest negative.
		expect(apply(px([200, 0, 0, 255]), tint(120, 100))).toEqual([0, 99, 0, 255]);
		expect(apply(px([0, 0, 200, 255]), tint(120, 100))).toEqual([0, 71, 0, 255]);
	});

	it('strengthens the complementary colour for a negative amount', () => {
		// Yellow at -50 makes grey bluer and pushes red away from yellow (blue rises).
		expect(apply(px([128, 128, 128, 255]), tint(60, -50))).toEqual([123, 123, 186, 255]);
		expect(apply(px([200, 0, 0, 255]), tint(60, -50))).toEqual([255, 0, 70, 255]);
	});

	it('leaves alpha alone and is the identity at amount 0', () => {
		expect(apply(px([10, 20, 30, 77]), tint(0, 0))).toEqual([10, 20, 30, 77]);
	});
});

describe('RedEyeCorrection', () => {
	it('replaces a strong red with the mean of green and blue inside the areas only, leaving skin tones', () => {
		const src = px([200, 50, 60, 255], [50, 200, 60, 255], [200, 50, 60, 255], [216, 168, 136, 255]);
		const effect: EmfPlusImageEffect = { kind: 'redEyeCorrection', areas: [{ left: 0, top: 0, right: 2, bottom: 1 }, { left: 3, top: 0, right: 4, bottom: 1 }] };
		expect(apply(src, effect, 4)).toEqual([55, 50, 60, 255, 50, 200, 60, 255, 200, 50, 60, 255, 216, 168, 136, 255]);
	});
});

describe('Blur and Sharpen', () => {
	it('uses a Gaussian of radius / 1.98 truncated at ceil(radius) taps', () => {
		expect(Array.from(blurKernel(0))).toEqual([1]);
		const k = Array.from(blurKernel(1));
		expect(k).toHaveLength(3);
		expect(k[0]).toBeCloseTo(0.1099, 4);
		expect(k[1]).toBeCloseTo(0.7802, 4);
		expect(blurKernel(2.5)).toHaveLength(7);
		expect(Array.from(blurKernel(10)).reduce((a, b) => a + b)).toBeCloseTo(1, 12);
	});

	it('blurs along rows, reflecting at the ends', () => {
		expect(reds(apply(greyRow(255, 255, 0, 255, 255), { kind: 'blur', radius: 1, expandEdge: false }))).toEqual([
			255, 227, 56, 227, 255,
		]);
		// An impulse at the left end is reflected: 0.78 * 255 + 2 * 0.11 * 0 on pixel 0.
		expect(reds(apply(greyRow(0, 255, 255), { kind: 'blur', radius: 1, expandEdge: false }))).toEqual([56, 227, 255]);
	});

	it('blurs down the columns in the top row only', () => {
		// Two columns of alternating rows: the top row mixes with the (reflected) row below, the others do not.
		const src = greyRow(0, 0, 255, 255, 0, 0);
		expect(reds(apply(src, { kind: 'blur', radius: 1, expandEdge: false }, 2, 3))).toEqual([56, 56, 255, 255, 0, 0]);
	});

	it('blurs straight colour and alpha independently', () => {
		// The hidden red of a transparent pixel spreads, as it does in GDI+.
		const out = apply(px([255, 0, 0, 0], [0, 0, 255, 255], [0, 0, 255, 255]), { kind: 'blur', radius: 1, expandEdge: false });
		expect(out.slice(0, 8)).toEqual([199, 0, 56, 56, 28, 0, 227, 227]);
	});

	it('sharpens along rows with an unsharp mask against the 8-bit blur', () => {
		// Gain 2 at radius 3, amount 100.
		expect(sharpenGain(3, 100)).toBe(2);
		expect(sharpenGain(1, 50)).toBeCloseTo(1 / 3, 12);
		expect(sharpenGain(6, 30)).toBeCloseTo(5 / 32, 12);
		expect(reds(apply(greyRow(64, 64, 64, 192, 192, 192), { kind: 'sharpen', radius: 3, amount: 100 }))).toEqual([
			44, 26, 0, 255, 230, 212,
		]);
	});

	it('raises alpha to the largest colour channel when sharpening', () => {
		expect(apply(px([48, 80, 208, 128]), { kind: 'sharpen', radius: 2, amount: 0 })).toEqual([48, 80, 208, 208]);
	});
});

describe('applyImageEffectToRect', () => {
	const blur = (expandEdge: boolean, radius = 1): EmfPlusImageEffect => ({ kind: 'blur', radius, expandEdge });
	const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

	it('effects only the source rectangle, so pixels outside it do not bleed in', () => {
		const src = greyRow(255, 0, 0, 0, 0);
		// The whole image: the bright pixel spreads into pixel 1.
		expect(reds(apply(src, blur(false)))[1]).toBe(28);
		const region = applyImageEffectToRect(src, 5, 1, blur(false), rect(1, 0, 3, 1))!;
		expect([region.x, region.y, region.width, region.height]).toEqual([1, 0, 3, 1]);
		expect(reds(Array.from(region.rgba))).toEqual([0, 0, 0]);
		const sharpen: EmfPlusImageEffect = { kind: 'sharpen', radius: 1, amount: 100 };
		const sharpened = applyImageEffectToRect(greyRow(255, 64, 64, 64), 4, 1, sharpen, rect(1, 0, 3, 1))!;
		expect(reds(Array.from(sharpened.rgba))).toEqual([64, 64, 64]);
	});

	it('reads one column and row past the rectangle, as GDI+ does', () => {
		// The rectangle is pixels 0..1; pixel 2 is still read (it darkens pixel 1), pixel 3 is not.
		const region = applyImageEffectToRect(greyRow(255, 255, 0, 0), 4, 1, blur(false), rect(0, 0, 2, 1))!;
		expect([region.width, reds(Array.from(region.rgba))]).toEqual([2, [255, 227]]);
	});

	it('rounds a fractional rectangle outward and clamps it to the image', () => {
		const region = applyImageEffectToRect(greyRow(1, 2, 3, 4), 4, 1, blur(false, 0), rect(0.5, -3, 1.2, 9))!;
		expect([region.x, region.y, region.width, region.height]).toEqual([0, 0, 2, 1]);
		expect(reds(Array.from(region.rgba))).toEqual([1, 2]);
		expect(applyImageEffectToRect(greyRow(1, 2), 2, 1, blur(false), rect(5, 0, 2, 1))).toBeNull();
	});

	it('blurs transparency in at the edges for expandEdge, but keeps the rectangle', () => {
		const src = px(...new Array(9).fill([200, 100, 50, 255]));
		const plain = applyImageEffectToRect(src, 3, 3, blur(false, 2), rect(0, 0, 3, 3))!;
		expect(Array.from(plain.rgba)).toEqual(Array.from(src));
		const grown = applyImageEffectToRect(src, 3, 3, blur(true, 1), rect(0, 0, 3, 3))!;
		expect([grown.x, grown.y, grown.width, grown.height]).toEqual([0, 0, 3, 3]);
		// Every channel fades together toward the transparent edge (straight colour is blurred too).
		const edge = Array.from(grown.rgba.slice(0, 4));
		expect(edge).toEqual([178, 89, 45, 227]);
		expect(Array.from(grown.rgba.slice(4, 8))).toEqual([200, 100, 50, 255]);
	});

	it('moves red-eye areas into the cropped region', () => {
		const red = [200, 20, 20, 255];
		const effect: EmfPlusImageEffect = { kind: 'redEyeCorrection', areas: [{ left: 2, top: 0, right: 3, bottom: 1 }] };
		const region = applyImageEffectToRect(px(red, red, red), 3, 1, effect, rect(1, 0, 2, 1))!;
		expect(reds(Array.from(region.rgba))).toEqual([200, 20]);
	});
});

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

describe('parseSerializableObject', () => {
	it('reads a ColorMatrix effect', () => {
		const data = colorMatrixObject(SWAP_RB);
		expect(parseSerializableObject(new DataView(data.buffer), 0, data.length)).toEqual({
			kind: 'colorMatrix',
			matrix: SWAP_RB,
		});
	});

	it('reads a Tint effect, clamping its parameters', () => {
		const buf = new Uint8Array(8);
		new DataView(buf.buffer).setInt32(0, 90, true);
		new DataView(buf.buffer).setInt32(4, 500, true);
		const data = serializableObject(TINT_GUID, buf);
		expect(parseSerializableObject(new DataView(data.buffer), 0, data.length)).toEqual({
			kind: 'tint',
			hue: 90,
			amount: 100,
		});
	});

	it('returns null for an unknown GUID or a truncated buffer', () => {
		const unknown = serializableObject(new Array(16).fill(0), new Uint8Array(8));
		expect(parseSerializableObject(new DataView(unknown.buffer), 0, unknown.length)).toBeNull();
		const short = serializableObject(COLOR_MATRIX_GUID, new Uint8Array(40));
		expect(parseSerializableObject(new DataView(short.buffer), 0, short.length)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// DrawImagePoints with flag E
// ---------------------------------------------------------------------------

async function renderPixels(bytes: ArrayBuffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
	const url = await convertMetafileToDataUrl(bytes, { dpiScale: 1 });
	expect(url).not.toBeNull();
	return (await decodePng(Buffer.from(url!.split(',')[1], 'base64')))!;
}

/** Every embedded image of an SVG, decoded. */
async function svgImages(svg: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }[]> {
	const found = [...svg.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
	return Promise.all(found.map(async (m) => (await decodePng(Buffer.from(m[1], 'base64')))!));
}

describe('DrawImagePoints with an image effect', () => {
	const FIXTURE = 'gpx-image-rotated-bilinear.emf';
	const fixture = (): ArrayBuffer => fixtureBuffer(FIXTURE);

	it('applies a red/blue swap ColorMatrix to the drawn pixels (PNG)', async () => {
		const plain = await renderPixels(fixture());
		const swapped = await renderPixels(withEffect(FIXTURE, colorMatrixObject(SWAP_RB)));
		expect(swapped.width).toBe(plain.width);
		let differing = 0;
		for (let i = 0; i < plain.data.length; i += 4) {
			// Resampling and compositing work per channel, so the swap commutes with them.
			expect([swapped.data[i], swapped.data[i + 1], swapped.data[i + 2]]).toEqual([
				plain.data[i + 2],
				plain.data[i + 1],
				plain.data[i],
			]);
			if (plain.data[i] !== plain.data[i + 2]) {
				differing++;
			}
		}
		expect(differing).toBeGreaterThan(0);
	});

	it('draws unchanged under the identity matrix, and without flag E ignores the effect', async () => {
		const plain = await renderPixels(fixture());
		const identity = await renderPixels(withEffect(FIXTURE, colorMatrixObject(IDENTITY)));
		expect(Array.from(identity.data)).toEqual(Array.from(plain.data));
		const noFlag = await renderPixels(withEffect(FIXTURE, colorMatrixObject(SWAP_RB), false));
		expect(Array.from(noFlag.data)).toEqual(Array.from(plain.data));
	});

	it('embeds the effected pixels in SVG output', async () => {
		const plain = await svgImages((await convertMetafileToSvg(fixture()))!);
		const swapped = await svgImages((await convertMetafileToSvg(withEffect(FIXTURE, colorMatrixObject(SWAP_RB))))!);
		expect(plain).toHaveLength(1);
		expect(swapped).toHaveLength(1);
		const [a] = plain;
		const [b] = swapped;
		expect([b.width, b.height]).toEqual([a.width, a.height]);
		for (let i = 0; i < a.data.length; i += 4) {
			expect([b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]]).toEqual([
				a.data[i + 2],
				a.data[i + 1],
				a.data[i],
				a.data[i + 3],
			]);
		}
	});
});

describe('DrawImagePoints with a blur effect', () => {
	// Draw 1 maps the 20x16 image onto (4, 4)-(56, 41.6): 2.6 device pixels per image pixel.
	const FIXTURE = 'gpx-image-nearestneighbor.emf';
	const pixel = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number): number[] =>
		Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

	it('draws no halo for an expandEdge blur in PNG output: the edges fade instead', async () => {
		const plain = await renderPixels(fixtureBuffer(FIXTURE));
		const grown = await renderPixels(withEffect(FIXTURE, blurObject(4, true)));
		const kept = await renderPixels(withEffect(FIXTURE, blurObject(4, false)));
		// Outside the image nothing is drawn, expanded or not (GDI+ draws no halo).
		for (const [x, y] of [
			[1, 22],
			[2, 10],
			[1, 60],
		]) {
			expect(pixel(grown, x, y)).toEqual(pixel(plain, x, y));
			expect(pixel(kept, x, y)).toEqual(pixel(plain, x, y));
		}
		// At the image's left edge the expanded blur mixes in transparency, so it differs from the plain blur.
		expect(pixel(grown, 5, 22)).not.toEqual(pixel(kept, 5, 22));
		// Away from the left and right edges the rows blur alike.
		pixel(grown, 30, 22).forEach((v, c) => expect(Math.abs(v - pixel(kept, 30, 22)[c])).toBeLessThanOrEqual(2));
		let inside = 0;
		for (let y = 5; y < 41; y++) {
			for (let x = 5; x < 55; x++) {
				if (pixel(kept, x, y).join() !== pixel(plain, x, y).join()) {
					inside++;
				}
			}
		}
		expect(inside).toBeGreaterThan(0);
	});

	it('embeds the effected bitmap at the image size in SVG output', async () => {
		const [grown] = await svgImages((await convertMetafileToSvg(withEffect(FIXTURE, blurObject(4, true))))!);
		const [kept] = await svgImages((await convertMetafileToSvg(withEffect(FIXTURE, blurObject(4, false))))!);
		expect([grown.width, grown.height]).toEqual([20, 16]);
		expect([kept.width, kept.height]).toEqual([20, 16]);
		// The expanded blur's edge column is partly transparent; the plain blur's is opaque.
		expect(grown.data[(8 * 20 + 0) * 4 + 3]).toBeGreaterThan(0);
		expect(grown.data[(8 * 20 + 0) * 4 + 3]).toBeLessThan(255);
		expect(kept.data[(8 * 20 + 0) * 4 + 3]).toBe(255);
	});

	it('blurs only the source rectangle', async () => {
		const [original] = await svgImages((await convertMetafileToSvg(fixtureBuffer(FIXTURE)))!);
		const [cropped] = await svgImages(
			(await convertMetafileToSvg(withEffect(FIXTURE, blurObject(4, false), true, [0, 0, 10, 16])))!,
		);
		expect([cropped.width, cropped.height]).toEqual([10, 16]);
		// The expected pixels: the left 10 columns plus the one GDI+ also reads cut out, blurred, then cut to 10.
		const left = new Uint8ClampedArray(11 * 16 * 4);
		for (let y = 0; y < 16; y++) {
			left.set(original.data.subarray(y * 20 * 4, (y * 20 + 11) * 4), y * 11 * 4);
		}
		const blurred = applyImageEffect(left, 11, 16, { kind: 'blur', radius: 4, expandEdge: false })!;
		const expected: number[] = [];
		for (let y = 0; y < 16; y++) {
			expected.push(...blurred.slice(y * 11 * 4, (y * 11 + 10) * 4));
		}
		expect(Array.from(cropped.data)).toEqual(expected);
		// Blurring the whole image would have pulled the right half into column 9.
		const whole = applyImageEffect(original.data, 20, 16, { kind: 'blur', radius: 4, expandEdge: false })!;
		const column9 = (d: Uint8ClampedArray, w: number): number[] =>
			Array.from({ length: 16 }, (_, y) => Array.from(d.slice((y * w + 9) * 4, (y * w + 9) * 4 + 4))).flat();
		expect(column9(cropped.data, 10)).not.toEqual(column9(whole, 20));
	});
});
