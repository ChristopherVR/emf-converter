/**
 * EMF+ image effects: `EmfPlusSerializableObject` parsing and the pixel
 * operations `DrawImagePoints` applies with flag E.
 *
 * GDI+ records `Graphics::DrawImage(image, srcRect, matrix, effect, ...)`
 * as an `EmfPlusSerializableObject` record carrying the effect (an
 * ImageEffects GUID, MS-EMFPLUS 2.1.3.1, and its parameter object, 2.2.3)
 * followed by an `EmfPlusDrawImagePoints` record with flag E (0x2000). The
 * effect is applied to the source image's pixels before the image is
 * resampled onto the destination, so every output path (PNG, SVG and the
 * SVG raster mirror) sees the same effected pixels.
 *
 * MS-EMFPLUS specifies each effect's parameters but not its algorithm, and
 * the GDI+ implementation has not been measured for this module, so:
 *
 * - `ColorMatrix` and `ColorLookupTable` follow the GDI+ `ColorMatrix` /
 *   lookup-table definitions exactly (up to rounding).
 * - `ColorCurve` WhiteSaturation / BlackSaturation and `Levels` highlight /
 *   shadow follow the linear mappings the GDI+ documentation describes.
 * - Everything else (brightness, contrast, colour balance, the other curve
 *   adjustments, hue/saturation/lightness, tint, blur, sharpen, red-eye) is
 *   a reasonable formula matching the documented direction and range of
 *   each parameter; parity with GDI+ is unverified.
 *
 * All operations take straight (un-premultiplied) top-down RGBA and return
 * a new buffer; the input is never modified. A draw applies the effect to
 * its source rectangle only ({@link applyImageEffectToRect}), so pixels
 * outside it never bleed in, and a blur with `expandEdge` grows that
 * rectangle by the blur radius on every side, as GDI+'s
 * `Bitmap::ApplyEffect` grows the bitmap.
 *
 * @module emf-plus-image-effects
 */

/** A rectangle in image pixels, right and bottom exclusive (a RECTL). */
export interface EffectRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** A parsed EMF+ image effect (MS-EMFPLUS 2.2.3). */
export type EmfPlusImageEffect =
	| { kind: 'blur'; radius: number; expandEdge: boolean }
	| { kind: 'brightnessContrast'; brightness: number; contrast: number }
	| { kind: 'colorBalance'; cyanRed: number; magentaGreen: number; yellowBlue: number }
	| { kind: 'colorCurve'; adjustment: number; channel: number; intensity: number }
	| { kind: 'colorLookupTable'; b: Uint8Array; g: Uint8Array; r: Uint8Array; a: Uint8Array }
	| { kind: 'colorMatrix'; matrix: number[] }
	| { kind: 'hueSaturationLightness'; hue: number; saturation: number; lightness: number }
	| { kind: 'levels'; highlight: number; midtone: number; shadow: number }
	| { kind: 'redEyeCorrection'; areas: EffectRect[] }
	| { kind: 'sharpen'; radius: number; amount: number }
	| { kind: 'tint'; hue: number; amount: number };

/** ImageEffects identifiers (MS-EMFPLUS 2.1.3.1), in canonical upper-case form. */
const EFFECT_GUIDS: Record<string, EmfPlusImageEffect['kind']> = {
	'633C80A4-1843-482B-9EF2-BE2834C5FDD4': 'blur',
	'D3A1DBE1-8EC4-4C17-9F4C-EA97AD1C343D': 'brightnessContrast',
	'537E597D-251E-48DA-9664-29CA496B70F8': 'colorBalance',
	'DD6A0022-58E4-4A67-9D9B-D48EB881A53D': 'colorCurve',
	'A7CE72A9-0F7F-40D7-B3CC-D0C02D5C3212': 'colorLookupTable',
	'718F2615-7933-40E3-A511-5F68FE14DD74': 'colorMatrix',
	'8B2DD6C3-EB07-4D87-A5F0-7108E26A9C5F': 'hueSaturationLightness',
	'99C354EC-2A31-4F3A-8C34-17A803B33A25': 'levels',
	'74D29D05-69A4-4266-9549-3CC52836B632': 'redEyeCorrection',
	'63CBF3EE-C526-402C-8F71-62C540BF5142': 'sharpen',
	'1077AF00-2848-4441-9489-44AD4C2D7A2C': 'tint',
};

/** DrawImagePoints flag E: apply the effect of the preceding SerializableObject. */
export const DRAWIMAGE_EFFECT_FLAG = 0x2000;

/** CurveAdjustments (MS-EMFPLUS 2.1.1.7). */
export const CurveAdjustment = {
	Exposure: 0,
	Density: 1,
	Contrast: 2,
	Highlight: 3,
	Shadow: 4,
	Midtone: 5,
	WhiteSaturation: 6,
	BlackSaturation: 7,
} as const;

/** CurveChannel (MS-EMFPLUS 2.1.1.8): 0 all, 1 red, 2 green, 3 blue. */
export const CurveChannel = { All: 0, Red: 1, Green: 2, Blue: 3 } as const;

const hex = (v: number, digits: number): string => v.toString(16).toUpperCase().padStart(digits, '0');

/** Formats a little-endian binary GUID at `off` as `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`. */
export function readGuid(view: DataView, off: number): string {
	const tail: string[] = [];
	for (let i = 0; i < 8; i++) {
		tail.push(hex(view.getUint8(off + 8 + i), 2));
	}
	return [
		hex(view.getUint32(off, true), 8),
		hex(view.getUint16(off + 4, true), 4),
		hex(view.getUint16(off + 6, true), 4),
		tail.slice(0, 2).join(''),
		tail.slice(2).join(''),
	].join('-');
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Parses an `EmfPlusSerializableObject` record's data (ObjectGUID, a 32-bit
 * BufferSize, then the parameter object). Returns `null` for an unknown
 * GUID or a truncated buffer. Parameters are clamped to their documented
 * ranges.
 */
export function parseSerializableObject(view: DataView, dataOff: number, dataSize: number): EmfPlusImageEffect | null {
	if (dataSize < 20) {
		return null;
	}
	const kind = EFFECT_GUIDS[readGuid(view, dataOff)];
	const size = view.getUint32(dataOff + 16, true);
	if (!kind || 20 + size > dataSize) {
		return null;
	}
	const p = dataOff + 20;
	const i32 = (k: number, lo: number, hi: number): number => clamp(view.getInt32(p + 4 * k, true), lo, hi);
	const f32 = (k: number, lo: number, hi: number): number => {
		const v = view.getFloat32(p + 4 * k, true);
		return Number.isFinite(v) ? clamp(v, lo, hi) : 0;
	};
	const need = (n: number): boolean => size >= n;
	switch (kind) {
		case 'blur':
			return need(8) ? { kind, radius: f32(0, 0, 255), expandEdge: view.getUint32(p + 4, true) !== 0 } : null;
		case 'brightnessContrast':
			return need(8) ? { kind, brightness: i32(0, -255, 255), contrast: i32(1, -100, 100) } : null;
		case 'colorBalance':
			return need(12)
				? { kind, cyanRed: i32(0, -100, 100), magentaGreen: i32(1, -100, 100), yellowBlue: i32(2, -100, 100) }
				: null;
		case 'colorCurve':
			return need(12)
				? {
						kind,
						adjustment: view.getInt32(p, true),
						channel: view.getInt32(p + 4, true),
						intensity: i32(2, -255, 255),
					}
				: null;
		case 'colorLookupTable': {
			if (!need(1024)) {
				return null;
			}
			const lut = (k: number): Uint8Array =>
				new Uint8Array(view.buffer.slice(view.byteOffset + p + 256 * k, view.byteOffset + p + 256 * (k + 1)));
			return { kind, b: lut(0), g: lut(1), r: lut(2), a: lut(3) };
		}
		case 'colorMatrix': {
			if (!need(100)) {
				return null;
			}
			const matrix: number[] = [];
			for (let k = 0; k < 25; k++) {
				const v = view.getFloat32(p + 4 * k, true);
				matrix.push(Number.isFinite(v) ? v : 0);
			}
			return { kind, matrix };
		}
		case 'hueSaturationLightness':
			return need(12)
				? { kind, hue: i32(0, -180, 180), saturation: i32(1, -100, 100), lightness: i32(2, -100, 100) }
				: null;
		case 'levels':
			return need(12) ? { kind, highlight: i32(0, 0, 100), midtone: i32(1, -100, 100), shadow: i32(2, 0, 100) } : null;
		case 'redEyeCorrection': {
			if (!need(4)) {
				return null;
			}
			const count = view.getInt32(p, true);
			if (count < 0 || 4 + 16 * count > size) {
				return null;
			}
			const areas: EffectRect[] = [];
			for (let k = 0; k < count; k++) {
				const o = p + 4 + 16 * k;
				areas.push({
					left: view.getInt32(o, true),
					top: view.getInt32(o + 4, true),
					right: view.getInt32(o + 8, true),
					bottom: view.getInt32(o + 12, true),
				});
			}
			return { kind, areas };
		}
		case 'sharpen':
			return need(8) ? { kind, radius: f32(0, 0, 255), amount: f32(1, 0, 100) } : null;
		case 'tint':
			return need(8) ? { kind, hue: i32(0, -180, 180), amount: i32(1, -100, 100) } : null;
	}
}

// ---------------------------------------------------------------------------
// Per-channel tone curves
// ---------------------------------------------------------------------------

/** A 256-entry curve built from `f`, rounded and clamped to 0..255. */
function buildLut(f: (v: number) => number): Uint8Array {
	const lut = new Uint8Array(256);
	for (let v = 0; v < 256; v++) {
		lut[v] = clamp(Math.round(f(v)), 0, 255);
	}
	return lut;
}

/**
 * Contrast about mid-grey: a gain of `(100 + c) / 100` below zero (-100
 * flattens to grey) and `100 / (100 - c)` above (100 thresholds at 50%).
 */
function contrastCurve(c: number): (v: number) => number {
	const gain = c >= 100 ? 1e6 : c >= 0 ? 100 / (100 - c) : (100 + c) / 100;
	return (v) => (v - 127.5) * gain + 127.5;
}

/** Pushes a channel toward 255 (`t > 0`) or toward 0 (`t < 0`) by the fraction `|t| / 100`. */
function balanceCurve(t: number): (v: number) => number {
	const f = t / 100;
	return (v) => (f >= 0 ? v + (255 - v) * f : v * (1 + f));
}

/** Midtone gamma: positive lightens (exponent `2^(-t/100)`, 0.5 at 100), negative darkens. */
function midtoneCurve(t: number): (v: number) => number {
	const gamma = 2 ** (-t / 100);
	return (v) => 255 * (v / 255) ** gamma;
}

/**
 * The tone curve of a `ColorCurve` adjustment (MS-EMFPLUS 2.1.1.7):
 *
 * - Exposure (-255..255): multiplies by `1 + t / 255`; Density (-255..255)
 *   is the same with the sign flipped (more density, darker).
 * - Contrast (-100..100): as BrightnessContrast's contrast.
 * - Highlight / Shadow (-100..100): a half-sine bump of up to `0.32 * t`
 *   levels over the channel values above / below 128, leaving the rest.
 * - Midtone (-100..100): a gamma curve, positive lightening.
 * - WhiteSaturation (0..255): `[0, t]` maps linearly onto `[0, 255]`, as
 *   the GDI+ documentation defines it; BlackSaturation: `[t, 255]` does.
 *
 * Returns `null` for an unknown adjustment.
 */
export function curveAdjustmentLut(adjustment: number, intensity: number): Uint8Array | null {
	const t = intensity;
	switch (adjustment) {
		case CurveAdjustment.Exposure:
			return buildLut((v) => v * (1 + t / 255));
		case CurveAdjustment.Density:
			return buildLut((v) => v * (1 - t / 255));
		case CurveAdjustment.Contrast:
			return buildLut(contrastCurve(clamp(t, -100, 100)));
		case CurveAdjustment.Highlight:
		case CurveAdjustment.Shadow: {
			const high = adjustment === CurveAdjustment.Highlight;
			const amp = clamp(t, -100, 100) * 0.32;
			return buildLut((v) => {
				const inside = high ? v > 128 : v < 128;
				if (!inside) {
					return v;
				}
				const u = high ? (v - 128) / 127 : v / 128;
				return v + amp * Math.sin(Math.PI * u);
			});
		}
		case CurveAdjustment.Midtone:
			return buildLut(midtoneCurve(clamp(t, -100, 100)));
		case CurveAdjustment.WhiteSaturation: {
			const w = Math.max(1, clamp(t, 0, 255));
			return buildLut((v) => (v * 255) / w);
		}
		case CurveAdjustment.BlackSaturation: {
			const b = Math.min(254, clamp(t, 0, 255));
			return buildLut((v) => ((v - b) * 255) / (255 - b));
		}
		default:
			return null;
	}
}

/**
 * Levels (MS-EMFPLUS 2.2.3.8): channel values at or above `highlight`% of
 * full intensity become 255 and those at or below `shadow`% become 0, the
 * range between stretched linearly (the GDI+ documentation's definition),
 * then a midtone gamma (positive lightens).
 */
export function levelsLut(highlight: number, midtone: number, shadow: number): Uint8Array {
	const black = (shadow / 100) * 255;
	const white = Math.max(black + 1, (highlight / 100) * 255);
	const gamma = midtoneCurve(midtone);
	return buildLut((v) => gamma(clamp((v - black) / (white - black), 0, 1) * 255));
}

/** Applies per-channel LUTs (`null` leaves that channel) to straight RGBA. */
function applyLuts(
	src: Uint8ClampedArray,
	r: Uint8Array | null,
	g: Uint8Array | null,
	b: Uint8Array | null,
	a: Uint8Array | null = null,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src);
	for (let i = 0; i < out.length; i += 4) {
		if (r) out[i] = r[src[i]];
		if (g) out[i + 1] = g[src[i + 1]];
		if (b) out[i + 2] = b[src[i + 2]];
		if (a) out[i + 3] = a[src[i + 3]];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Colour-space effects
// ---------------------------------------------------------------------------

/**
 * GDI+ `ColorMatrix` (MS-EMFPLUS 2.2.3.5): the row vector
 * `[r g b a 1]`, each channel normalised to 0..1, times the 5x5 matrix
 * (row-major, the fifth row a translation); the fifth output column is
 * ignored and each result is clamped and scaled back to 0..255.
 */
export function applyColorMatrix(src: Uint8ClampedArray, m: number[]): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src.length);
	for (let i = 0; i < src.length; i += 4) {
		const r = src[i] / 255;
		const g = src[i + 1] / 255;
		const b = src[i + 2] / 255;
		const a = src[i + 3] / 255;
		for (let j = 0; j < 4; j++) {
			const v = r * m[j] + g * m[5 + j] + b * m[10 + j] + a * m[15 + j] + m[20 + j];
			out[i + j] = Math.round(clamp(v, 0, 1) * 255);
		}
	}
	return out;
}

/** RGB (0..1) to HSL: hue in degrees [0, 360), saturation and lightness 0..1. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) {
		return [0, 0, l];
	}
	const s = d / (1 - Math.abs(2 * l - 1));
	let h: number;
	if (max === r) {
		h = ((g - b) / d) % 6;
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	h *= 60;
	return [h < 0 ? h + 360 : h, s, l];
}

/** HSL to RGB (0..1). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	return [r + m, g + m, b + m];
}

/**
 * Hue/saturation/lightness (MS-EMFPLUS 2.2.3.7): the hue rotates by `hue`
 * degrees (positive counter-clockwise, red toward yellow); saturation and
 * lightness move toward 1 (positive) or 0 (negative) by `|t| / 100` of the
 * way. At -100 saturation the image is grey; at +/-100 lightness, white or
 * black.
 */
export function applyHueSaturationLightness(
	src: Uint8ClampedArray,
	hue: number,
	saturation: number,
	lightness: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src);
	const push = (v: number, t: number): number => (t >= 0 ? v + (1 - v) * (t / 100) : v * (1 + t / 100));
	for (let i = 0; i < src.length; i += 4) {
		const [h, s, l] = rgbToHsl(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
		const [r, g, b] = hslToRgb(h + hue, push(s, saturation), push(l, lightness));
		out[i] = Math.round(r * 255);
		out[i + 1] = Math.round(g * 255);
		out[i + 2] = Math.round(b * 255);
	}
	return out;
}

/** Rec. 601 luma weights. */
const LUMA = [0.299, 0.587, 0.114] as const;

/**
 * Tint (MS-EMFPLUS 2.2.3.11): adds `amount / 100` of the chroma of the
 * fully saturated colour at `hue` degrees (0 red, 120 green, -120 blue),
 * that colour minus its own luma, so the luma of each pixel is unchanged.
 * A negative amount adds the complementary colour.
 */
export function applyTint(src: Uint8ClampedArray, hue: number, amount: number): Uint8ClampedArray {
	const tint = hslToRgb(hue, 1, 0.5);
	const y = tint[0] * LUMA[0] + tint[1] * LUMA[1] + tint[2] * LUMA[2];
	const k = (amount / 100) * 255;
	const add = tint.map((c) => (c - y) * k);
	const out = new Uint8ClampedArray(src);
	for (let i = 0; i < src.length; i += 4) {
		out[i] = Math.round(src[i] + add[0]);
		out[i + 1] = Math.round(src[i + 1] + add[1]);
		out[i + 2] = Math.round(src[i + 2] + add[2]);
	}
	return out;
}

/**
 * Red-eye correction (MS-EMFPLUS 2.2.3.9): inside each area, a pixel whose
 * red exceeds both green and blue gets red replaced by the mean of green
 * and blue.
 */
export function applyRedEyeCorrection(
	src: Uint8ClampedArray,
	width: number,
	height: number,
	areas: EffectRect[],
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src);
	for (const a of areas) {
		const x0 = clamp(a.left, 0, width);
		const x1 = clamp(a.right, 0, width);
		const y0 = clamp(a.top, 0, height);
		const y1 = clamp(a.bottom, 0, height);
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = (y * width + x) * 4;
				const r = out[i];
				const g = out[i + 1];
				const b = out[i + 2];
				if (r > g && r > b) {
					out[i] = Math.round((g + b) / 2);
				}
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Blur and sharpen
// ---------------------------------------------------------------------------

/**
 * Radii of three successive box filters whose combined (discrete) variance
 * is as close as possible to `sigma^2`: a box of radius k has variance
 * `k (k + 1) / 3`.
 */
export function boxRadiiForSigma(sigma: number): [number, number, number] {
	const target = sigma * sigma;
	let k = 0;
	while ((k + 1) * (k + 2) <= target) {
		k++;
	}
	const v = (n: number): number => (n * (n + 1)) / 3;
	let best = 0;
	for (let m = 1; m <= 3; m++) {
		if (Math.abs((3 - m) * v(k) + m * v(k + 1) - target) < Math.abs((3 - best) * v(k) + best * v(k + 1) - target)) {
			best = m;
		}
	}
	return [0, 1, 2].map((i) => (i < best ? k + 1 : k)) as [number, number, number];
}

/** One box-filter pass of radius `r` along rows (`horizontal`) or columns, edges clamped. */
function boxPass(src: Float64Array, w: number, h: number, r: number, horizontal: boolean): Float64Array {
	if (r <= 0) {
		return src;
	}
	const out = new Float64Array(src.length);
	const lines = horizontal ? h : w;
	const len = horizontal ? w : h;
	const step = horizontal ? 4 : w * 4;
	const norm = 1 / (2 * r + 1);
	for (let line = 0; line < lines; line++) {
		const base = horizontal ? line * w * 4 : line * 4;
		for (let c = 0; c < 4; c++) {
			const at = (p: number): number => src[base + clamp(p, 0, len - 1) * step + c];
			let sum = 0;
			for (let p = -r; p <= r; p++) {
				sum += at(p);
			}
			for (let p = 0; p < len; p++) {
				out[base + p * step + c] = sum * norm;
				sum += at(p + r + 1) - at(p - r);
			}
		}
	}
	return out;
}

/**
 * Gaussian blur of straight RGBA with standard deviation `radius / 2`
 * (approximated by three box passes per axis), done on premultiplied
 * colour so transparent pixels do not bleed their colour, edges clamped.
 * Returns straight RGBA as floats.
 */
function blurFloat(src: Uint8ClampedArray, w: number, h: number, radius: number): Float64Array {
	let buf: Float64Array = new Float64Array(src.length);
	for (let i = 0; i < src.length; i += 4) {
		const a = src[i + 3] / 255;
		buf[i] = src[i] * a;
		buf[i + 1] = src[i + 1] * a;
		buf[i + 2] = src[i + 2] * a;
		buf[i + 3] = src[i + 3];
	}
	for (const r of boxRadiiForSigma(radius / 2)) {
		buf = boxPass(buf, w, h, r, true);
		buf = boxPass(buf, w, h, r, false);
	}
	for (let i = 0; i < buf.length; i += 4) {
		const a = buf[i + 3] / 255;
		for (let c = 0; c < 3; c++) {
			buf[i + c] = a > 0 ? buf[i + c] / a : 0;
		}
	}
	return buf;
}

/**
 * Blur (MS-EMFPLUS 2.2.3.1): a Gaussian of standard deviation
 * `radius / 2` (see {@link blurFloat}), edges clamped. This keeps the
 * image's size; `expandEdge` (growing the bitmap by the radius) is handled
 * by {@link applyImageEffectToRect}, which pads the pixels with transparency
 * first.
 */
export function applyBlur(src: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
	const blurred = blurFloat(src, w, h, radius);
	const out = new Uint8ClampedArray(src.length);
	for (let i = 0; i < src.length; i++) {
		out[i] = Math.round(blurred[i]);
	}
	return out;
}

/**
 * Sharpen (MS-EMFPLUS 2.2.3.10): an unsharp mask, each colour channel
 * `v + amount / 100 * (v - blur(v))` with the blur of {@link applyBlur}
 * at `radius`; alpha is kept.
 */
export function applySharpen(
	src: Uint8ClampedArray,
	w: number,
	h: number,
	radius: number,
	amount: number,
): Uint8ClampedArray {
	const blurred = blurFloat(src, w, h, radius);
	const k = amount / 100;
	const out = new Uint8ClampedArray(src);
	for (let i = 0; i < src.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			out[i + c] = Math.round(src[i + c] + k * (src[i + c] - blurred[i + c]));
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Applies `effect` to `width` x `height` straight RGBA pixels, returning a
 * new buffer (the input is not modified), or `null` when the effect cannot
 * be applied (an unknown curve adjustment or channel, or a size mismatch).
 */
export function applyImageEffect(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	effect: EmfPlusImageEffect,
): Uint8ClampedArray | null {
	if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
		return null;
	}
	switch (effect.kind) {
		case 'blur':
			return applyBlur(rgba, width, height, effect.radius);
		case 'sharpen':
			return applySharpen(rgba, width, height, effect.radius, effect.amount);
		case 'brightnessContrast': {
			const contrast = contrastCurve(effect.contrast);
			const lut = buildLut((v) => contrast(v) + effect.brightness);
			return applyLuts(rgba, lut, lut, lut);
		}
		case 'colorBalance':
			return applyLuts(
				rgba,
				buildLut(balanceCurve(effect.cyanRed)),
				buildLut(balanceCurve(effect.magentaGreen)),
				buildLut(balanceCurve(effect.yellowBlue)),
			);
		case 'colorCurve': {
			const lut = curveAdjustmentLut(effect.adjustment, effect.intensity);
			const ch = effect.channel;
			if (!lut || ch < CurveChannel.All || ch > CurveChannel.Blue) {
				return null;
			}
			const pick = (c: number): Uint8Array | null => (ch === CurveChannel.All || ch === c ? lut : null);
			return applyLuts(rgba, pick(CurveChannel.Red), pick(CurveChannel.Green), pick(CurveChannel.Blue));
		}
		case 'colorLookupTable':
			return applyLuts(rgba, effect.r, effect.g, effect.b, effect.a);
		case 'colorMatrix':
			return applyColorMatrix(rgba, effect.matrix);
		case 'hueSaturationLightness':
			return applyHueSaturationLightness(rgba, effect.hue, effect.saturation, effect.lightness);
		case 'levels': {
			const lut = levelsLut(effect.highlight, effect.midtone, effect.shadow);
			return applyLuts(rgba, lut, lut, lut);
		}
		case 'redEyeCorrection':
			return applyRedEyeCorrection(rgba, width, height, effect.areas);
		case 'tint':
			return applyTint(rgba, effect.hue, effect.amount);
	}
}

/** Pixels an effect produced, placed in the source image's pixel coordinates. */
export interface EffectedRegion {
	rgba: Uint8ClampedArray;
	/** The top-left of `rgba` in source image pixels (negative when the region grew past the image). */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Transparent padding added on every side before the effect (an expanded blur's radius), else 0. */
	pad: number;
}

/**
 * Applies `effect` to the part of a `width` x `height` image that a draw's
 * source rectangle `src` (image pixels, possibly fractional) covers, the way
 * GDI+'s `DrawImage(image, srcRect, xform, effect, ...)` does:
 *
 * - the rectangle is rounded outward and clamped to the image, and only
 *   those pixels are handed to the effect, so a blur or sharpen never reads
 *   pixels outside it (its own edges are clamped);
 * - a blur with `expandEdge` gets `ceil(radius)` transparent pixels of
 *   padding on every side first, so the blurred halo extends beyond the
 *   rectangle (`Bitmap::ApplyEffect` grows the bitmap by the radius);
 * - red-eye areas, given in image pixels, are moved into the cropped
 *   region's coordinates.
 *
 * `src` of `null` applies the effect to the whole image, unexpanded.
 * Returns `null` when the rectangle misses the image or the effect cannot
 * be applied.
 */
export function applyImageEffectToRect(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	effect: EmfPlusImageEffect,
	src: { x: number; y: number; w: number; h: number } | null,
): EffectedRegion | null {
	if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
		return null;
	}
	let x0 = 0;
	let y0 = 0;
	let x1 = width;
	let y1 = height;
	if (src) {
		x0 = clamp(Math.floor(src.x), 0, width);
		y0 = clamp(Math.floor(src.y), 0, height);
		x1 = clamp(Math.ceil(src.x + src.w), 0, width);
		y1 = clamp(Math.ceil(src.y + src.h), 0, height);
		if (x1 <= x0 || y1 <= y0) {
			return null;
		}
	}
	const pad = src && effect.kind === 'blur' && effect.expandEdge ? Math.ceil(effect.radius) : 0;
	const cw = x1 - x0;
	const ch = y1 - y0;
	const w = cw + 2 * pad;
	const h = ch + 2 * pad;
	let region = rgba;
	if (w !== width || h !== height || x0 !== 0 || y0 !== 0) {
		region = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < ch; y++) {
			const from = ((y0 + y) * width + x0) * 4;
			region.set(rgba.subarray(from, from + cw * 4), ((pad + y) * w + pad) * 4);
		}
	}
	const ox = x0 - pad;
	const oy = y0 - pad;
	const local: EmfPlusImageEffect =
		effect.kind === 'redEyeCorrection'
			? {
					kind: effect.kind,
					areas: effect.areas.map((a) => ({
						left: a.left - ox,
						top: a.top - oy,
						right: a.right - ox,
						bottom: a.bottom - oy,
					})),
				}
			: effect;
	const out = applyImageEffect(region, w, h, local);
	return out ? { rgba: out, x: ox, y: oy, width: w, height: h, pad } : null;
}
