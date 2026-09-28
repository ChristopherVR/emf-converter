import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { EMFPLUS_DRAWIMAGEPOINTS, EMFPLUS_SERIALIZABLEOBJECT, EMFPLUS_SIGNATURE, EMR_COMMENT } from './emf-constants';
import {
	applyImageEffect,
	boxRadiiForSigma,
	CurveAdjustment,
	CurveChannel,
	DRAWIMAGE_EFFECT_FLAG,
	parseSerializableObject,
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

	it('leaves alpha alone', () => {
		expect(apply(px([100, 100, 100, 77]), { kind: 'brightnessContrast', brightness: 10, contrast: 0 })[3]).toBe(77);
	});
});

describe('ColorBalance', () => {
	it('pushes each channel toward 255 or 0 by the given percentage', () => {
		const effect: EmfPlusImageEffect = { kind: 'colorBalance', cyanRed: 50, magentaGreen: -50, yellowBlue: 0 };
		// Red 100 + 155 * 0.5 = 177.5 -> 178; green 100 * 0.5 = 50.
		expect(apply(px([100, 100, 100, 255]), effect)).toEqual([178, 50, 100, 255]);
	});
});

describe('ColorCurve', () => {
	const curve = (adjustment: number, intensity: number, channel: number = CurveChannel.All): EmfPlusImageEffect => ({
		kind: 'colorCurve',
		adjustment,
		channel,
		intensity,
	});

	it('WhiteSaturation maps [0, t] onto [0, 255]', () => {
		// 64 * 255 / 128 = 127.5 -> 128.
		expect(reds(apply(greyRow(64, 200), curve(CurveAdjustment.WhiteSaturation, 128)))).toEqual([128, 255]);
	});

	it('BlackSaturation maps [t, 255] onto [0, 255], on the chosen channel only', () => {
		// (192 - 128) * 255 / 127 = 128.5 -> 129; green and blue untouched.
		expect(apply(px([192, 192, 192, 255], [64, 0, 0, 255]), curve(CurveAdjustment.BlackSaturation, 128, CurveChannel.Red), 2)).toEqual(
			[129, 192, 192, 255, 0, 0, 0, 255],
		);
	});

	it('Exposure scales by 1 + t / 255 and Density by 1 - t / 255', () => {
		expect(reds(apply(greyRow(100), curve(CurveAdjustment.Exposure, 255)))).toEqual([200]);
		expect(reds(apply(greyRow(100), curve(CurveAdjustment.Density, 255)))).toEqual([0]);
		expect(reds(apply(greyRow(100), curve(CurveAdjustment.Density, -51)))).toEqual([120]);
	});

	it('Midtone is a gamma curve fixing black and white', () => {
		// 255 * (64 / 255) ^ 0.5 = 127.75 -> 128.
		expect(reds(apply(greyRow(0, 64, 255), curve(CurveAdjustment.Midtone, 100)))).toEqual([0, 128, 255]);
	});

	it('Highlight moves only values above 128, Shadow only values below', () => {
		// The bump peaks mid-range: 191.5 is sin(pi/2), + 0.32 * 50 = 16.
		expect(reds(apply(greyRow(64, 128, 191, 255), curve(CurveAdjustment.Highlight, 50)))).toEqual([64, 128, 207, 255]);
		expect(reds(apply(greyRow(0, 64, 200), curve(CurveAdjustment.Shadow, -50)))).toEqual([0, 48, 200]);
	});

	it('Contrast matches BrightnessContrast', () => {
		expect(reds(apply(greyRow(100), curve(CurveAdjustment.Contrast, 50)))).toEqual([73]);
	});

	it('is not applied for an unknown adjustment or channel', () => {
		expect(applyImageEffect(greyRow(1), 1, 1, curve(99, 10))).toBeNull();
		expect(applyImageEffect(greyRow(1), 1, 1, curve(CurveAdjustment.Exposure, 10, 7))).toBeNull();
	});
});

describe('Levels', () => {
	it('stretches [shadow%, highlight%] onto [0, 255]', () => {
		// White point 127.5: 64 -> 128.0, 200 -> 255.
		expect(reds(apply(greyRow(64, 200), { kind: 'levels', highlight: 50, midtone: 0, shadow: 0 }))).toEqual([128, 255]);
		// Black point 51: 51 -> 0, 153 -> 127.5 -> 128.
		expect(reds(apply(greyRow(51, 153), { kind: 'levels', highlight: 100, midtone: 0, shadow: 20 }))).toEqual([0, 128]);
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

	it('rotates hue counter-clockwise (red to green at +120)', () => {
		expect(apply(px([255, 0, 0, 255]), hsl(120, 0, 0))).toEqual([0, 255, 0, 255]);
		expect(apply(px([255, 0, 0, 255]), hsl(-120, 0, 0))).toEqual([0, 0, 255, 255]);
	});

	it('removes saturation at -100 and pushes lightness to white at +100', () => {
		expect(apply(px([255, 0, 0, 255]), hsl(0, -100, 0))).toEqual([128, 128, 128, 255]);
		expect(apply(px([255, 0, 0, 255]), hsl(0, 0, 100))).toEqual([255, 255, 255, 255]);
		// Lightness -50 halves L: red at L 0.5 -> L 0.25 = (128, 0, 0).
		expect(apply(px([255, 0, 0, 255]), hsl(0, 0, -50))).toEqual([128, 0, 0, 255]);
	});
});

describe('Tint', () => {
	it('adds the chroma of the hue, keeping luma', () => {
		// Red chroma: (1, 0, 0) - 0.299 = (0.701, -0.299, -0.299) * 255.
		expect(apply(px([128, 128, 128, 255]), { kind: 'tint', hue: 0, amount: 100 })).toEqual([255, 52, 52, 255]);
		// Half the amount: 128 + 89.38 = 217.38, 128 - 38.12 = 89.88.
		expect(apply(px([128, 128, 128, 255]), { kind: 'tint', hue: 0, amount: 50 })).toEqual([217, 90, 90, 255]);
	});

	it('adds the complementary colour for a negative amount', () => {
		expect(apply(px([128, 128, 128, 255]), { kind: 'tint', hue: 0, amount: -50 })).toEqual([39, 166, 166, 255]);
	});
});

describe('RedEyeCorrection', () => {
	it('replaces a dominant red with the mean of green and blue inside the areas only', () => {
		const src = px([200, 50, 60, 255], [50, 200, 60, 255], [200, 50, 60, 255]);
		const effect: EmfPlusImageEffect = { kind: 'redEyeCorrection', areas: [{ left: 0, top: 0, right: 2, bottom: 1 }] };
		expect(apply(src, effect, 3)).toEqual([55, 50, 60, 255, 50, 200, 60, 255, 200, 50, 60, 255]);
	});
});

describe('Blur and Sharpen', () => {
	// Standard deviation radius / 2 = sqrt(2 / 3): exactly one box of radius 1.
	const oneBox = 2 * Math.sqrt(2 / 3);

	it('splits sigma^2 over three boxes of radius k (variance k (k + 1) / 3)', () => {
		expect(boxRadiiForSigma(0)).toEqual([0, 0, 0]);
		expect(boxRadiiForSigma(Math.sqrt(2 / 3))).toEqual([1, 0, 0]);
		expect(boxRadiiForSigma(Math.sqrt(2))).toEqual([1, 1, 1]);
		expect(boxRadiiForSigma(Math.sqrt(5))).toEqual([2, 2, 1]);
	});

	it('blurs an impulse into its box neighbours', () => {
		expect(reds(apply(greyRow(0, 0, 255, 0, 0), { kind: 'blur', radius: oneBox, expandEdge: false }))).toEqual([
			0, 85, 85, 85, 0,
		]);
	});

	it('keeps a uniform image and does not bleed transparent colour', () => {
		const uniform = greyRow(90, 90, 90, 90);
		expect(apply(uniform, { kind: 'blur', radius: 5, expandEdge: true })).toEqual(Array.from(uniform));
		// A transparent red pixel next to opaque blue: the blur spreads alpha
		// ((0 + 0 + 255) / 3 with the edge clamped), never the hidden red.
		const out = apply(px([255, 0, 0, 0], [0, 0, 255, 255], [0, 0, 255, 255]), {
			kind: 'blur',
			radius: oneBox,
			expandEdge: false,
		});
		expect(out.slice(0, 4)).toEqual([0, 0, 255, 85]);
	});

	it('sharpens with an unsharp mask', () => {
		// Pixel 2: blur (64 + 64 + 192) / 3 = 106.67, 64 - 42.67 = 21.33 -> 21;
		// pixel 3: blur 149.33, 192 + 42.67 = 234.67 -> 235.
		expect(reds(apply(greyRow(64, 64, 64, 192, 192, 192), { kind: 'sharpen', radius: oneBox, amount: 100 }))).toEqual([
			64, 64, 21, 235, 192, 192,
		]);
	});
});

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

const COLOR_MATRIX_GUID = [
	0x15, 0x26, 0x8f, 0x71, 0x33, 0x79, 0xe3, 0x40, 0xa5, 0x11, 0x5f, 0x68, 0xfe, 0x14, 0xdd, 0x74,
];
const TINT_GUID = [0x00, 0xaf, 0x77, 0x10, 0x48, 0x28, 0x41, 0x44, 0x94, 0x89, 0x44, 0xad, 0x4c, 0x2d, 0x7a, 0x2c];

/** An EmfPlusSerializableObject record's data: GUID, BufferSize, buffer. */
function serializableObject(guid: number[], buffer: Uint8Array): Uint8Array {
	const out = new Uint8Array(20 + buffer.length);
	out.set(guid, 0);
	new DataView(out.buffer).setUint32(16, buffer.length, true);
	out.set(buffer, 20);
	return out;
}

function colorMatrixObject(m: number[]): Uint8Array {
	const buf = new Uint8Array(100);
	const v = new DataView(buf.buffer);
	m.forEach((x, i) => v.setFloat32(4 * i, x, true));
	return serializableObject(COLOR_MATRIX_GUID, buf);
}

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

/**
 * Rewrites a fixture so that a SerializableObject record carrying `effect`
 * precedes its first DrawImagePoints record, which gets flag E.
 */
function withEffect(name: string, effect: Uint8Array, flagE = true): ArrayBuffer {
	const src = new Uint8Array(readFileSync(fixturePath(name)));
	const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
	const inserted = 12 + effect.length;
	for (let off = 0; off + 8 <= src.length; ) {
		const size = v.getUint32(off + 4, true);
		if (v.getUint32(off, true) === EMR_COMMENT && v.getUint32(off + 12, true) === EMFPLUS_SIGNATURE) {
			const end = off + 12 + v.getUint32(off + 8, true);
			for (let p = off + 16; p + 12 <= end; p += v.getUint32(p + 4, true)) {
				if (v.getUint16(p, true) !== EMFPLUS_DRAWIMAGEPOINTS) {
					continue;
				}
				const out = new Uint8Array(src.length + inserted);
				out.set(src.subarray(0, p), 0);
				out.set(src.subarray(p), p + inserted);
				const o = new DataView(out.buffer);
				o.setUint16(p, EMFPLUS_SERIALIZABLEOBJECT, true);
				o.setUint16(p + 2, 0, true);
				o.setUint32(p + 4, inserted, true);
				o.setUint32(p + 8, effect.length, true);
				out.set(effect, p + 12);
				if (flagE) {
					o.setUint16(p + inserted + 2, o.getUint16(p + inserted + 2, true) | DRAWIMAGE_EFFECT_FLAG, true);
				}
				o.setUint32(off + 4, size + inserted, true);
				o.setUint32(off + 8, v.getUint32(off + 8, true) + inserted, true);
				o.setUint32(48, out.length, true);
				return out.buffer;
			}
		}
		off += size;
	}
	throw new Error(`${name}: no DrawImagePoints record`);
}

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
	const fixture = (): ArrayBuffer => {
		const b = readFileSync(fixturePath(FIXTURE));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	};

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
