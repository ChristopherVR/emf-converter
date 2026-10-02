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
 * MS-EMFPLUS specifies each effect's parameters but not its algorithm. The
 * algorithms here are measured against GDI+ itself: when GDI+ records a
 * `DrawImage` with an effect it also writes the bitmap it effected, drawn
 * by a plain `DrawImagePoints` right after the effect draw (see
 * `scripts/gdi-fixtures`, `plus-effect-*`), so every source pixel has
 * GDI+'s own result next to it (`emf-plus-image-effects.fixture.test.ts`).
 * Against those bitmaps:
 *
 * - `ColorMatrix`, `ColorLookupTable`, `BrightnessContrast`, `ColorBalance`
 *   match the native fixtures exactly. Sharpen strength is exact; its blur
 *   convolution retains differences.
 * - `Blur` is within one level through radius 16 in the dimension sweep.
 *   Larger radii use a different native algorithm, still approximated here.
 * - `ColorCurve` uses complete native 256-entry tables for every legal
 *   adjustment and intensity ({@link curveAdjustmentLut}).
 * - A broader Levels sweep has one one-level difference in 258,560 values.
 * - `HueSaturationLightness` reproduces native hue quantization across all
 *   integer angles. Mixed-colour/control sweeps retain one-level rounding.
 * - `Tint` is within two levels on nearly every pixel.
 * - `RedEyeCorrection` remains an approximation.
 *
 * All operations take straight (un-premultiplied) top-down RGBA and return
 * a new buffer; the input is never modified. A draw applies the effect to
 * its source rectangle only ({@link applyImageEffectToRect}).
 *
 * @module emf-plus-image-effects
 */

import { nativeCurveLookup } from './emf-plus-image-curves';

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

/** Size of a ColorCurveParams object (three 32-bit values). */
const COLOR_CURVE_PARAMS_SIZE = 12;

/**
 * Parses an `EmfPlusSerializableObject` record's data (ObjectGUID, a 32-bit
 * BufferSize, then the parameter object). Returns `null` for an unknown
 * GUID or a truncated buffer. Parameters are clamped to their documented
 * ranges.
 *
 * GDI+ serialises a ColorCurve effect under the ColorLookupTable GUID
 * (with its own 12-byte ColorCurveParams). Its own playback then fails to
 * read the effect and draws the image without it, so such an object is
 * rejected here too (`null`), and the draw is plain, as on Windows.
 */
export function parseSerializableObject(view: DataView, dataOff: number, dataSize: number): EmfPlusImageEffect | null {
	if (dataSize < 20 || dataOff < 0 || dataOff + dataSize > view.byteLength) {
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
		case 'colorCurve': {
			if (!need(COLOR_CURVE_PARAMS_SIZE)) return null;
			const adjustment = view.getInt32(p, true), channel = view.getInt32(p + 4, true), intensity = view.getInt32(p + 8, true);
			const min = adjustment < 2 ? -255 : adjustment < 6 ? -100 : adjustment === 6 ? 1 : 0;
			const max = adjustment === 7 ? 254 : adjustment < 2 || adjustment === 6 ? 255 : 100;
			return adjustment < 0 || adjustment > 7 || channel < 0 || channel > 3 || intensity < min || intensity > max ? null : { kind, adjustment, channel, intensity };
		}
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
				if (!Number.isFinite(v)) return null;
				matrix.push(v);
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

/** Rounds halves down (`2.5` to `2`), as GDI+'s Levels table does. */
const roundHalfDown = (v: number): number => Math.ceil(v - 0.5);

/** A 256-entry curve built from `f`, rounded (`round`, default half up) and clamped to 0..255. */
function buildLut(f: (v: number) => number, round: (v: number) => number = Math.round): Uint8Array {
	const lut = new Uint8Array(256);
	for (let v = 0; v < 256; v++) {
		lut[v] = clamp(round(f(v)), 0, 255);
	}
	return lut;
}

/**
 * Levels' gamma interpolates between knots at 0, 50, 75, 87.5, ... with
 * gamma 1, 2, 3, 4, ... capped at 10. Positive midtones use its reciprocal.
 */
function midtoneGamma(t: number): number {
	let gamma = 1;
	let low = 0;
	let high = 50;
	while (Math.abs(t) >= high && high < 100) {
		gamma++;
		low = high;
		high = (high + 100) / 2;
	}
	gamma = Math.abs(t) === 100 ? 10 : Math.min(10, gamma + (Math.abs(t) - low) / (high - low));
	return Math.fround(t < 0 ? gamma : 1 / gamma);
}

/**
 * Brightness/contrast (MS-EMFPLUS 2.2.3.2): contrast is a gain about 127.5,
 * `100 / (100 - c)` for c > 0 and `(100 + c) / 100` for c < 0; brightness is
 * added half before the gain and half after, so it is scaled by
 * `(1 + gain) / 2`.
 */
export function brightnessContrastLut(brightness: number, contrast: number): Uint8Array {
	const gain = contrast >= 100 ? 1e6 : contrast >= 0 ? 100 / (100 - contrast) : (100 + contrast) / 100;
	const half = brightness / 2;
	return buildLut((v) => (v + half - 127.5) * gain + 127.5 + half);
}

/** Colour balance (MS-EMFPLUS 2.2.3.3): each channel scaled by `1 + t / 100`. */
function balanceLut(t: number): Uint8Array {
	return buildLut((v) => v * (Math.floor((1 + t / 100) * 65536) / 65536));
}

/** Complete Windows lookups; values outside the native ranges are clamped. */
export function curveAdjustmentLut(adjustment: number, intensity: number): Uint8Array | null {
	if (!Number.isInteger(adjustment) || adjustment < 0 || adjustment > 7) return null;
	const min = adjustment < 2 ? -255 : adjustment < 6 ? -100 : adjustment === 6 ? 1 : 0;
	const max = adjustment === 7 ? 254 : adjustment < 2 || adjustment === 6 ? 255 : 100;
	return nativeCurveLookup(adjustment, clamp(Math.trunc(intensity), min, max)).slice();
}

/**
 * Levels (MS-EMFPLUS 2.2.3.8): channel values at or below `shadow`% of full
 * intensity become 0 and those at or above `highlight`% become 255, the
 * range between stretched linearly and raised to the midtone exponent
 * ({@link midtoneGamma}); halves round down.
 */
export function levelsLut(highlight: number, midtone: number, shadow: number): Uint8Array {
	const base = shadow * 255 / 100 - (highlight === shadow && shadow < 50 ? 1 : 0);
	const span = highlight === shadow ? 1 : (highlight - shadow) * 255 / 100;
	const exponent = midtoneGamma(midtone);
	return buildLut((v) => {
		const level = clamp((v - base) / span, 0, 1);
		return 255 * (highlight >= shadow ? level ** exponent : 1 - (1 - level) ** exponent);
	}, roundHalfDown);
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

/** Native hue rotates on 255 indices; reconstruction uses 43-unit sextants. */
const HUE_SEXTANT = 43;
const HUE_CIRCLE = 255;

/**
 * GDI+'s integer hue of an RGB colour whose channels are not all equal
 * (measured): 43 units per sextant, with byte-domain primary offsets
 * 0, 86 and 170. Descending sectors truncate the complementary difference
 * directly, which differs from subtracting a truncated ascending fraction.
 */
function gdipHue(r: number, g: number, b: number): number {
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	const f = (x: number): number => Math.floor((x * HUE_SEXTANT) / d);
	if (max === r && g >= b) {
		return f(g - b);
	}
	// At a green/blue maximum tie GDI+ takes the blue branch (cyan's
	// hue is 127, not 129); the distinction remains after rotation.
	if (max === b && b !== r) {
		return r >= g ? 170 + f(r - g) : 127 + f(b - g);
	}
	if (max === g) {
		return b >= r ? 86 + f(b - r) : 43 + f(g - r);
	}
	const t = f(b - g);
	const q = (256 - t - (t >= 40 ? 1 : 0)) % 256;
	return q - Math.floor((q + 42) / 86);
}

/**
 * Hue/saturation/lightness (MS-EMFPLUS 2.2.3.7) in GDI+'s integer HSL
 * (measured): lightness is `(max + min) >> 1` (a full-intensity colour tops
 * out at 254) plus `2.55 * lightness` levels; saturation, the usual HSL
 * saturation, is scaled by `1 + saturation / 100`; the hue ({@link gdipHue})
 * rotates by round(`hue * 255 / 360`) indices (positive: red toward yellow).
 * Reconstruction skips three indices in the 258-unit sextant domain. The
 * colour is rebuilt from the rounded HSL maximum and minimum, the middle
 * channel truncated. Saturated colours match all 361 native rotation
 * angles exactly; mixed colours and controls retain one-level rounding.
 */
export function applyHueSaturationLightness(
	src: Uint8ClampedArray,
	hue: number,
	saturation: number,
	lightness: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src);
	const shift = Math.round((hue * HUE_CIRCLE) / 360);
	const sMul = 1 + saturation / 100;
	for (let i = 0; i < src.length; i += 4) {
		const r = src[i];
		const g = src[i + 1];
		const b = src[i + 2];
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const l = clamp(Math.round((((max + min) >> 1) * 100 + 255 * lightness) / 100), 0, 255);
		if (max === min) {
			out[i] = out[i + 1] = out[i + 2] = l;
			continue;
		}
		const sum = max + min;
		const s = Math.fround(clamp(((max - min) / (sum <= 255 ? sum : 510 - sum)) * sMul, 0, 1));
		const hi = l <= 127 ? l * (1 + s) : l + s * (255 - l);
		const m1 = l <= 127 ? 2 * l - Math.trunc(hi) : Math.round(2 * l - hi);
		const m2 = 2 * l - m1;
		const index = (((gdipHue(r, g, b) + shift) % HUE_CIRCLE) + HUE_CIRCLE) % HUE_CIRCLE;
		const q = index + Math.floor((index + 41) / 85);
		const sextant = Math.min(5, Math.floor(q / HUE_SEXTANT));
		const f = (q - sextant * HUE_SEXTANT) / HUE_SEXTANT;
		const up = Math.trunc(m1 + (m2 - m1) * f);
		const down = Math.trunc(m1 + (m2 - m1) * (1 - f));
		const [nr, ng, nb] = [
			[m2, up, m1],
			[down, m2, m1],
			[m1, m2, up],
			[m1, down, m2],
			[up, m1, m2],
			[m2, m1, down],
		][sextant];
		out[i] = nr;
		out[i + 1] = ng;
		out[i + 2] = nb;
	}
	return out;
}

/** Rec. 709 luma weights, which GDI+'s Tint uses. */
const LUMA_709 = [0.2126, 0.7152, 0.0722] as const;

/** Fitted native chroma scale, now checked across 90 hue/amount settings. */
const TINT_CHROMA_SCALE = 0.985;

/**
 * Tint (MS-EMFPLUS 2.2.3.11), measured: each pixel moves `amount / 100` of
 * the way toward its own Rec. 709 luma plus the chroma of the fully
 * saturated colour at `hue` degrees (0 red, 120 green, -120 blue; GDI+'s
 * documentation counts from blue, but its red and blue are swapped) scaled
 * by the pixel's largest channel. A negative amount extrapolates away from
 * it, strengthening the complementary colour. Native Tint wraps its
 * quantized hue at 256, unlike HSL's 255-index rotation. A broader sweep
 * retains three levels at positive amounts and five at negative amounts;
 * the chroma scale and colour rounding remain approximate.
 */
export function applyTint(src: Uint8ClampedArray, hue: number, amount: number): Uint8ClampedArray {
	// Signed half rounding makes -180 and +180 adjacent palette indices.
	const index = (Math.round(hue * 255 / 360) + 256) % 256;
	const q = (index + Math.floor((index + 41) / 85)) % 258;
	const tint = hslToRgb(q * 60 / 43, 1, 0.5);
	const ty = tint[0] * LUMA_709[0] + tint[1] * LUMA_709[1] + tint[2] * LUMA_709[2];
	const chroma = tint.map((c) => (c - ty) * TINT_CHROMA_SCALE);
	const a = amount / 100;
	const out = new Uint8ClampedArray(src);
	for (let i = 0; i < src.length; i += 4) {
		const r = src[i];
		const g = src[i + 1];
		const b = src[i + 2];
		const y = r * LUMA_709[0] + g * LUMA_709[1] + b * LUMA_709[2];
		const v = Math.max(r, g, b);
		out[i] = Math.round((1 - a) * r + a * (y + v * chroma[0]));
		out[i + 1] = Math.round((1 - a) * g + a * (y + v * chroma[1]));
		out[i + 2] = Math.round((1 - a) * b + a * (y + v * chroma[2]));
	}
	return out;
}

/**
 * Red-eye correction (MS-EMFPLUS 2.2.3.9), an approximation: inside each
 * area, a strongly red pixel (red at least twice both green and blue) gets
 * its red replaced by the mean of green and blue. GDI+ detects and repaints
 * whole pupils (a textured dark grey), which is not reproduced; skin and
 * other moderately red pixels are left alone, as GDI+ leaves them.
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
				if (r >= 2 * g && r >= 2 * b && r > 64) {
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
 * GDI+'s blur kernel for `radius`: `exp(-(1.4 * offset / radius)^2)`,
 * truncated at `ceil(radius)` taps on each side and
 * normalised (measured; `[0.110, 0.780, 0.110]` at radius 1).
 */
export function blurKernel(radius: number): Float64Array {
	const taps = Math.ceil(radius);
	const k = new Float64Array(2 * taps + 1);
	if (taps === 0) {
		k[0] = 1;
		return k;
	}
	let sum = 0;
	for (let i = -taps; i <= taps; i++) {
		const w = Math.exp(-1.96 * i * i / (radius * radius));
		k[i + taps] = w;
		sum += w;
	}
	for (let i = 0; i < k.length; i++) {
		k[i] /= sum;
	}
	return k;
}

/** Index `p` reflected into `[0, n)` about the end pixels (`-1` reads 1, `n` reads `n - 2`). */
function mirror(p: number, n: number): number {
	if (n === 1) {
		return 0;
	}
	while (p < 0 || p >= n) {
		p = p < 0 ? -p : 2 * (n - 1) - p;
	}
	return p;
}

/**
 * GDI+'s small-radius blur of a `w` x `h` straight RGBA buffer: every channel
 * (alpha included, colour not premultiplied) convolved along each row with
 * {@link blurKernel}, with rounded horizontal pixels before the vertical
 * pass. Every product is kept to 1/256 of a level before it is summed.
 * Native filtering visits `verticalRows` (default ceil(h / w)) leading rows
 * starting at `vRow`. Edges reflect unless the kernel reaches that axis's
 * size (`taps` rounded up to odd covers it), when they clamp; `vZeroAbove` reads transparency above the source
 * rectangle. Returns floats.
 */
function gdipBlur(src: ArrayLike<number>, w: number, h: number, radius: number, vRow = 0, vZeroAbove = false, verticalRows = Math.ceil(h / w)): Float64Array {
	const k = blurKernel(radius);
	const taps = (k.length - 1) / 2;
	const horizontalIndex = (taps | 1) >= w ? (x: number) => Math.max(0, Math.min(w - 1, x)) : (x: number) => mirror(x, w);
	const verticalIndex = (taps | 1) >= h ? (y: number) => Math.max(0, Math.min(h - 1, y)) : (y: number) => mirror(y, h);
	const out = new Float64Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		const row = y * w * 4;
		for (let x = 0; x < w; x++) {
			let s0 = 0;
			let s1 = 0;
			let s2 = 0;
			let s3 = 0;
			for (let j = -taps; j <= taps; j++) {
				const p = row + horizontalIndex(x + j) * 4;
				// The centre weight is applied as two halves, each product rounded on its own.
				const kw = j === 0 ? k[taps] * 128 : k[j + taps] * 256;
				const times = j === 0 ? 2 : 1;
				s0 += times * Math.round(kw * src[p]);
				s1 += times * Math.round(kw * src[p + 1]);
				s2 += times * Math.round(kw * src[p + 2]);
				s3 += times * Math.round(kw * src[p + 3]);
			}
			const o = row + x * 4;
			out[o] = Math.floor((s0 + 128) / 256);
			out[o + 1] = Math.floor((s1 + 128) / 256);
			out[o + 2] = Math.floor((s2 + 128) / 256);
			out[o + 3] = Math.floor((s3 + 128) / 256);
		}
	}
	if (taps > 0 && vRow >= 0 && vRow < h) {
		const horizontal = out.slice();
		// Native small-radius filtering visits ceil(height / width) leading
		// rows. Tall and narrow probes expose the extra rows hidden by square
		// and landscape fixtures.
		const endRow = Math.min(h, vRow + verticalRows);
		for (let row = vRow; row < endRow; row++) {
			const col = new Float64Array(w * 4);
			for (let j = -taps; j <= taps; j++) {
				const yy = row + j;
				if (vZeroAbove && yy < vRow) {
					continue;
				}
				const base = verticalIndex(yy) * w * 4;
				const kw = j === 0 ? k[taps] * 128 : k[j + taps] * 256;
				const times = j === 0 ? 2 : 1;
				for (let i = 0; i < w * 4; i++) {
					col[i] += (times * Math.round(kw * horizontal[base + i])) / 256;
				}
			}
			out.set(col, row * w * 4);
		}
	}
	return out;
}

/** Native reduction transitions, measured at every quarter radius from 16 to 255. */
function blurReduction(radius: number): number {
	return radius < 20 ? 1 : radius < 40 ? 2 : radius <= 80 ? 4 : radius < 160 ? 8 : 16;
}

/** The samples one axis of a large blur reduces, with transparent reduced samples added around them. */
interface BlurSpan {
	start: number;
	size: number;
	pad: number;
}

/**
 * One axis of a large-radius blur over `lanes` rows (or columns) of
 * `length` samples, four channels each. Per lane and channel the samples of
 * `span` (default all) are reduced by `factor` (the floor of each block's
 * mean, a partial last block averaged over its own samples), filtered with
 * the reduced kernel and enlarged back to `length` samples. `get` reads sample
 * `i` of lane `lane`, channel `c`; `put` stores the enlarged sample.
 * `edgeLength` is the number of reduced samples (partial block included) that
 * picks the edge mode: a kernel whose half-width, rounded up to odd, reaches it
 * clamps at the ends, a narrower one reflects. A lone reduced sample has no
 * line to continue, so a single pixel beyond it is left as it was.
 */
function blurAxis(
	length: number,
	lanes: number,
	factor: number,
	k: Float64Array,
	edgeLength: number,
	get: (i: number, lane: number, c: number) => number,
	put: (i: number, lane: number, c: number, v: number) => void,
	span: BlurSpan = { start: 0, size: length, pad: 0 },
): void {
	const inner = Math.ceil(span.size / factor);
	const n = inner + 2 * span.pad;
	const taps = (k.length - 1) / 2;
	const index = (taps | 1) >= edgeLength ? (i: number) => clamp(i, 0, n - 1) : (i: number) => mirror(i, n);
	const reduced = new Float64Array(n);
	const filtered = new Float64Array(n);
	const k256 = k.map((w) => w * 256);
	// The centre weight is applied as two halves, each product rounded on its own.
	const half = k256[taps] / 2;
	k256[taps] = 0;
	for (let lane = 0; lane < lanes; lane++) for (let c = 0; c < 4; c++) {
		for (let b = span.pad; b < span.pad + inner; b++) {
			const from = span.start + (b - span.pad) * factor;
			const end = Math.min(span.start + span.size, from + factor);
			let sum = 0;
			for (let i = from; i < end; i++) sum += get(i, lane, c);
			reduced[b] = Math.floor(sum / (end - from));
		}
		// Every product is kept to 1/256 of a level, then the sum rounds half up.
		for (let b = 0; b < n; b++) {
			let sum = 0;
			if (b >= taps && b + taps < n) {
				for (let j = 0; j < k256.length; j++) sum += Math.round(k256[j] * reduced[b - taps + j]);
			} else {
				for (let j = 0; j < k256.length; j++) sum += Math.round(k256[j] * reduced[index(b - taps + j)]);
			}
			sum += 2 * Math.round(half * reduced[b]);
			filtered[b] = Math.floor((sum + 128) / 256);
		}
		// A lone reduced sample has no line to continue: a single pixel beyond it stays as it was.
		const written = n === 1 && length - Math.ceil(factor / 2) === 1 ? length - 1 : length;
		for (let i = 0; i < written; i++) {
			// Beyond the outer reduced samples the line through the two nearest continues.
			const p = (i - span.start + 0.5) / factor - 0.5 + span.pad;
			const a = clamp(Math.floor(p), 0, Math.max(0, n - 2));
			const t = p - a;
			put(i, lane, c, clamp(Math.floor((1 - t) * filtered[a] + t * filtered[Math.min(n - 1, a + 1)] + 1e-9), 0, 255));
		}
	}
}

/**
 * Large native blurs (radius 20 and above) filter each axis separately:
 * every row is reduced horizontally, filtered and enlarged back to full width,
 * then every column of those rows is reduced vertically, filtered and
 * enlarged. Reduction and enlargement truncate; filtering sums products kept to
 * 1/256 of a level and rounds half up; the centre weight is applied as two
 * rounded halves. Against native noise, ramps, impulses and one-dimensional
 * images at radii 20-255, more than 99.97% of pixels are exact, the rest one
 * level off where a product lands within 0.0005 of a rounding tie. `region`, an expanded
 * blur's source rectangle inside its transparent padding, is reduced from its
 * own origin so that its partial blocks are not averaged with padding.
 */
function effectBlur(src: Uint8ClampedArray, width: number, height: number, radius: number, region?: { x: number; y: number; w: number; h: number }): Float64Array {
	const factor = blurReduction(radius);
	// Native partial blocks on very small buffers use a different edge path.
	if (factor === 1) {
		return gdipBlur(src, width, height, radius);
	}
	const k = blurKernel(radius / factor);
	const pad = region ? Math.ceil(Math.ceil(radius) / factor) : 0;
	const spanX = region ? { start: region.x, size: region.w, pad } : undefined;
	const spanY = region ? { start: region.y, size: region.h, pad } : undefined;
	const rows = new Uint8Array(src);
	blurAxis(width, height, factor, k, Math.ceil(width / factor), (i, lane, c) => src[(lane * width + i) * 4 + c], (i, lane, c, v) => {
		rows[(lane * width + i) * 4 + c] = v;
	}, spanX);
	const out = Float64Array.from(rows);
	blurAxis(height, width, factor, k, Math.ceil(height / factor), (i, lane, c) => rows[(i * width + lane) * 4 + c], (i, lane, c, v) => {
		out[(i * width + lane) * 4 + c] = v;
	}, spanY);
	return out;
}

/**
 * Blur (MS-EMFPLUS 2.2.3.1) as GDI+ applies it to a `w` x `h` buffer (see
 * {@link effectBlur}): small radii filter rows and leading columns; large
 * radii reduce, filter both axes and enlarge. `expandEdge` is
 * handled by {@link applyImageEffectToRect}.
 */
export function applyBlur(src: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
	return Uint8ClampedArray.from(effectBlur(src, w, h, radius), Math.round);
}

/**
 * GDI+'s unsharp-mask gain, independent of radius. The rational amount
 * curve is quantized to 1/64 with half-down rounding. Verified against
 * every integer amount from 0 through 100 in a native pixel sweep.
 */
export function sharpenGain(_radius: number, amount: number): number {
	return roundHalfDown(64 * amount / (250 - 2 * amount)) / 64;
}

/**
 * Sharpen (MS-EMFPLUS 2.2.3.10): an unsharp mask,
 * `v + gain * (v - round(blur(v)))` using {@link effectBlur}
 * (the blur rounded to 8 bits first) and the gain of
 * {@link sharpenGain}. Alpha is raised to the largest colour channel, as
 * GDI+ does (it treats the straight colour as premultiplied and restores
 * `colour <= alpha`), so a translucent pixel comes out more opaque.
 */
export function applySharpen(
	src: Uint8ClampedArray,
	w: number,
	h: number,
	radius: number,
	amount: number,
): Uint8ClampedArray {
	const blurred = effectBlur(src, w, h, radius);
	const gain = sharpenGain(radius, amount);
	const out = new Uint8ClampedArray(src);
	for (let i = 0; i < src.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			out[i + c] = Math.round(src[i + c] + gain * (src[i + c] - Math.round(blurred[i + c])));
		}
		out[i + 3] = Math.max(src[i + 3], out[i], out[i + 1], out[i + 2]);
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
			const lut = brightnessContrastLut(effect.brightness, effect.contrast);
			return applyLuts(rgba, lut, lut, lut);
		}
		case 'colorBalance':
			return applyLuts(
				rgba,
				balanceLut(effect.cyanRed),
				balanceLut(effect.magentaGreen),
				balanceLut(effect.yellowBlue),
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
	/** The top-left of `rgba` in source image pixels. */
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Copies the `w` x `h` block at (`sx`, `sy`) of a `width`-wide image into a new `bw`-wide buffer at (`dx`, `dy`). */
function copyBlock(
	src: Uint8ClampedArray,
	width: number,
	sx: number,
	sy: number,
	w: number,
	h: number,
	dst: Uint8ClampedArray,
	bw: number,
	dx: number,
	dy: number,
): void {
	for (let y = 0; y < h; y++) {
		const from = ((sy + y) * width + sx) * 4;
		dst.set(src.subarray(from, from + w * 4), ((dy + y) * bw + dx) * 4);
	}
}

/**
 * An expanded blur (`expandEdge`) of the region [x0, x1) x [y0, y1) of the
 * image, cropped back to that region. GDI+ blurs a buffer grown by the
 * kernel's reach on every side, transparent where it has no pixels. A
 * source rectangle ending before both the right and bottom image edges
 * copies only its own pixels and starts vertical filtering at its top row.
 * A rectangle reaching either edge copies image pixels throughout the
 * grown buffer and starts at the buffer's top. Small-radius vertical row
 * counts use the source region's dimensions, before adding transparent
 * padding. Large radii reduce and filter both axes. A cropped region is
 * reduced from its own corner, so a partial block at its far edge averages
 * only its own pixels, and transparent reduced samples are added around it;
 * a rectangle reaching an edge reduces the whole grown buffer from its corner.
 */
function expandedBlur(
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	cropped: boolean,
): Uint8ClampedArray {
	const r = Math.ceil(radius);
	const bw = x1 - x0 + 2 * r;
	const bh = y1 - y0 + 2 * r;
	const buf = new Uint8ClampedArray(bw * bh * 4);
	if (cropped) {
		copyBlock(rgba, width, x0, y0, x1 - x0, y1 - y0, buf, bw, r, r);
	} else {
		const gx0 = Math.max(0, x0 - r);
		const gy0 = Math.max(0, y0 - r);
		const gx1 = Math.min(width, x1 + r);
		const gy1 = Math.min(height, y1 + r);
		copyBlock(rgba, width, gx0, gy0, gx1 - gx0, gy1 - gy0, buf, bw, gx0 - (x0 - r), gy0 - (y0 - r));
	}
	const blurred =
		blurReduction(radius) > 1
			? effectBlur(buf, bw, bh, radius, cropped ? { x: r, y: r, w: x1 - x0, h: y1 - y0 } : undefined)
			: gdipBlur(buf, bw, bh, radius, cropped ? r : 0, cropped, Math.ceil((y1 - y0) / (x1 - x0)));
	const w = x1 - x0;
	const out = new Uint8ClampedArray(w * (y1 - y0) * 4);
	for (let y = 0; y < y1 - y0; y++) {
		const from = ((y + r) * bw + r) * 4;
		for (let i = 0; i < w * 4; i++) {
			out[y * w * 4 + i] = Math.round(blurred[from + i]);
		}
	}
	return out;
}

/**
 * Applies `effect` to the part of a `width` x `height` image that a draw's
 * source rectangle `src` (image pixels, possibly fractional) covers, the way
 * GDI+'s `DrawImage(image, srcRect, xform, effect, ...)` does:
 *
 * - the effect sees the rectangle rounded outward plus one more column and
 *   row (GDI+'s own bounds), clamped to the image; a blur or sharpen reads
 *   nothing outside it and reflects at its edges; the result is the
 *   rectangle rounded outward, without that extra column and row;
 * - a blur with `expandEdge` blurs transparency in from beyond the edges
 *   (see {@link expandedBlur}), but the result is still only the region:
 *   GDI+ draws no halo outside the source rectangle;
 * - red-eye areas, given in image pixels, are moved into the region's
 *   coordinates.
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
		x1 = clamp(Math.ceil(src.x + src.w) + 1, 0, width);
		y1 = clamp(Math.ceil(src.y + src.h) + 1, 0, height);
		if (x1 <= x0 || y1 <= y0 || src.x + src.w <= x0 || src.y + src.h <= y0) {
			return null;
		}
	}
	const w = x1 - x0;
	const h = y1 - y0;
	// The part a draw shows: the rectangle rounded outward, without the extra column and row.
	const shownWidth = src ? Math.min(w, Math.ceil(src.x + src.w) - x0) : w;
	const shownHeight = src ? Math.min(h, Math.ceil(src.y + src.h) - y0) : h;
	const result = (out: Uint8ClampedArray): EffectedRegion => {
		if (shownWidth === w && shownHeight === h) {
			return { rgba: out, x: x0, y: y0, width: w, height: h };
		}
		const shown = new Uint8ClampedArray(shownWidth * shownHeight * 4);
		copyBlock(out, w, 0, 0, shownWidth, shownHeight, shown, shownWidth, 0, 0);
		return { rgba: shown, x: x0, y: y0, width: shownWidth, height: shownHeight };
	};
	if (src && effect.kind === 'blur' && effect.expandEdge) {
		// Decide cropping from the shown rectangle, before adding the extra
		// native working column/row. A one-pixel gap still takes the crop path.
		const cropped = Math.ceil(src.x + src.w) < width && Math.ceil(src.y + src.h) < height;
		return result(expandedBlur(rgba, width, height, effect.radius, x0, y0, x1, y1, cropped));
	}
	let region = rgba;
	if (w !== width || h !== height) {
		region = new Uint8ClampedArray(w * h * 4);
		copyBlock(rgba, width, x0, y0, w, h, region, w, 0, 0);
	}
	const local: EmfPlusImageEffect =
		effect.kind === 'redEyeCorrection'
			? {
					kind: effect.kind,
					areas: effect.areas.map((a) => ({
						left: a.left - x0,
						top: a.top - y0,
						right: a.right - x0,
						bottom: a.bottom - y0,
					})),
				}
			: effect;
	const out = applyImageEffect(region, w, h, local);
	return out ? result(out) : null;
}
