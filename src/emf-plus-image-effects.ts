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
 *   match the native fixtures exactly. Sharpen strength is exact.
 * - `Blur` is exact: the kernel weights are formed in float32 arithmetic that
 *   truncates ({@link blurKernel}), and the filtering and large-radius
 *   reduction are reproduced axis by axis. No pixel differs from GDI+ across
 *   random images at random radii from 1 to 255, the fixtures and the 654
 *   expanded and narrow draws; sharpen, which blurs first, inherits it.
 * - `ColorCurve` uses complete native 256-entry tables for every legal
 *   adjustment and intensity ({@link curveAdjustmentLut}).
 * - Levels reproduces the native table exactly (truncating float32 arithmetic): 258,560
 *   sweep values and a further 2.6 million probe values match.
 * - `HueSaturationLightness` is exact: the integer HSL pipeline matches the
 *   native output for the whole RGB cube at every setting measured.
 * - `Tint` is exact: the integer luma-preserving pipeline matches the whole
 *   RGB cube at every amount.
 * - `RedEyeCorrection` is a sector model fitted to GDI+'s outputs alone, with
 *   its pupil texture left out ({@link applyRedEyeCorrection}). Its constants
 *   and structure come purely from black-box measurements: the public flat API
 *   (`GdipBitmapApplyEffect` and friends) driven with synthetic bitmaps and
 *   the results recorded. No GDI+ binary was disassembled, debugged or read,
 *   and no disassembly-derived notes were used.
 *
 * All operations take straight (un-premultiplied) top-down RGBA and return
 * a new buffer; the input is never modified. A draw applies the effect to
 * its source rectangle only ({@link applyImageEffectToRect}).
 *
 * @module emf-plus-image-effects
 */

import { nativeCurveLookup } from './emf-plus-image-curves';
import { truncF32 } from './emf-plus-linear-ramp';

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
	gamma = Math.abs(t) === 100 ? 10 : Math.min(10, truncF32(gamma + truncF32(truncF32(Math.abs(t) - low) / truncF32(high - low))));
	return t < 0 ? truncF32(gamma) : truncF32(1 / truncF32(gamma));
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
	if (highlight !== shadow) {
		// GDI+ forms the whole table in float32 arithmetic that truncates
		// toward zero; inverted ranges mirror the stretch and subtract from 255.
		const forward = highlight > shadow;
		const lo = truncF32((forward ? shadow : highlight) * 255 / 100);
		const hi = truncF32((forward ? highlight : shadow) * 255 / 100);
		const scale = truncF32(1 / truncF32(hi - lo));
		const exponent = midtoneGamma(midtone);
		const lut = new Uint8Array(256);
		for (let v = 0; v < 256; v++) {
			let level = clamp(truncF32(truncF32(v - lo) * scale), 0, 1);
			if (midtone !== 0) {
				level = truncF32(level ** exponent);
			}
			const out = forward ? truncF32(255 * level) : truncF32(255 - truncF32(255 * level));
			lut[v] = clamp(Math.floor(out + 0.5), 0, 255);
		}
		return lut;
	}
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
 * Hue/saturation/lightness (MS-EMFPLUS 2.2.3.7) in GDI+'s all-integer HSL,
 * reproduced exactly (the whole 16.7 million colour cube at 20 settings, and
 * the 1,390,080-pair sweep). Lightness `L` is `(max + min) >> 1`, saturation
 * `S` is `floor(255 * (max - min) / min(max + min, 510 - max - min))`, and
 * the hue ({@link gdipHue}) is an index on 255 steps. The lightness control
 * adds `round(255 * floor(65536 * lightness / 100) / 65536)` levels to `L`;
 * the saturation control multiplies `S` by `65536 + floor(65536 * saturation /
 * 100)` in 16.16 fixed point, rounded. The hue control rotates the index by
 * round(`hue * 255 / 360`) (positive: red toward yellow). The colour is
 * rebuilt from `hi = floor(L * (255 + S) / 255)` (`L + S - floor(L * S /
 * 255)` above 127) and `2L - hi`, the middle channel interpolated linearly
 * with truncating integer division over 43 steps per sextant, skipping three
 * indices in the 258-unit domain.
 */
export function applyHueSaturationLightness(
	src: Uint8ClampedArray,
	hue: number,
	saturation: number,
	lightness: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src);
	const shift = Math.round((hue * HUE_CIRCLE) / 360);
	const satScale = 65536 + Math.floor((saturation * 65536) / 100);
	const lightOffset = Math.round((255 * Math.floor((lightness * 65536) / 100)) / 65536);
	for (let i = 0; i < src.length; i += 4) {
		const r = src[i];
		const g = src[i + 1];
		const b = src[i + 2];
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const l = clamp(((max + min) >> 1) + lightOffset, 0, 255);
		if (max === min) {
			out[i] = out[i + 1] = out[i + 2] = l;
			continue;
		}
		const sum = max + min;
		const sat = clamp(Math.round((Math.floor(((max - min) * 255) / (sum <= 255 ? sum : 510 - sum)) * satScale) / 65536), 0, 255);
		const hi = l <= 127 ? Math.floor((l * (255 + sat)) / 255) : l + sat - Math.floor((l * sat) / 255);
		const m1 = 2 * l - hi;
		const m2 = hi;
		const index = (((gdipHue(r, g, b) + shift) % HUE_CIRCLE) + HUE_CIRCLE) % HUE_CIRCLE;
		const q = index + Math.floor((index + 41) / 85);
		const sextant = Math.min(5, Math.floor(q / HUE_SEXTANT));
		const position = q - sextant * HUE_SEXTANT;
		const up = m1 + Math.floor(((m2 - m1) * position) / HUE_SEXTANT);
		const down = m1 + Math.floor(((m2 - m1) * (HUE_SEXTANT - position)) / HUE_SEXTANT);
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

/**
 * Tint (MS-EMFPLUS 2.2.3.11) in GDI+'s integer arithmetic, reproduced
 * exactly. Luma is `S = 54 r + 183 g + 19 b` (weights over 256, so 8.8 fixed
 * point). The tint colour `T` is the full-intensity colour at `hue`, rebuilt
 * like the HSL effect's (hue index from `hue * 255 / 360` rounded with sign and
 * wrapped at 256, 43 steps a sextant, a maximum of 254). The amount becomes a
 * signed weight `w = +-round(2.55 |amount|)` (halves toward zero). With `v`
 * the pixel's largest channel and `u = (w * v) >> 8` (an arithmetic shift, so
 * negative weights round down), each channel's 8.8 value is
 * `x = (255 - w) c + T u` and the output is `(S + x - luma(x >> 8)) >> 8`: the
 * tinted colour keeps the pixel's luma. Matches the whole 16.7 million-colour
 * RGB cube at every amount and hue measured.
 */
export function applyTint(src: Uint8ClampedArray, hue: number, amount: number): Uint8ClampedArray {
	// Signed half rounding makes -180 and +180 adjacent palette indices.
	const index = (Math.round((hue * 255) / 360) + 256) % 256;
	const q = (index + Math.floor((index + 41) / 85)) % 258;
	const sextant = Math.min(5, Math.floor(q / HUE_SEXTANT));
	const position = q - sextant * HUE_SEXTANT;
	const up = Math.floor((TINT_FULL * position) / HUE_SEXTANT);
	const down = Math.floor((TINT_FULL * (HUE_SEXTANT - position)) / HUE_SEXTANT);
	const [tr, tg, tb] = [
		[TINT_FULL, up, 0],
		[down, TINT_FULL, 0],
		[0, TINT_FULL, up],
		[0, down, TINT_FULL],
		[up, 0, TINT_FULL],
		[TINT_FULL, 0, down],
	][sextant];
	// Round-half-down of 2.55 |amount| in integers, keeping the sign.
	const weight = Math.sign(amount) * Math.floor((255 * Math.abs(amount) + 49) / 100);
	const original = 255 - weight;
	const out = new Uint8ClampedArray(src);
	for (let i = 0; i < src.length; i += 4) {
		const r = src[i];
		const g = src[i + 1];
		const b = src[i + 2];
		const u = (weight * Math.max(r, g, b)) >> 8;
		const x0 = original * r + tr * u;
		const x1 = original * g + tg * u;
		const x2 = original * b + tb * u;
		const base = 54 * r + 183 * g + 19 * b - (54 * (x0 >> 8) + 183 * (x1 >> 8) + 19 * (x2 >> 8));
		out[i] = (base + x0) >> 8;
		out[i + 1] = (base + x1) >> 8;
		out[i + 2] = (base + x2) >> 8;
	}
	return out;
}

/** Largest tint channel: the HSL effect's 255-level maximum is 254. */
const TINT_FULL = 254;

/**
 * Red-eye correction (MS-EMFPLUS 2.2.3.9), modelled from black-box
 * measurements only: GDI+'s `RedEyeCorrection` was driven through the public
 * flat API (`GdipCreateEffect`, `GdipBitmapApplyEffect`) with synthetic
 * bitmaps and its outputs recorded; the effect's internals were never
 * disassembled, debugged, dumped or read, and nothing below comes from such
 * analysis. The constants and rules reproduce those measurements (single-pixel
 * and region perturbations, uniform fields, concentric and split scenes, and
 * the native fixtures), not GDI+'s code.
 *
 * Measured structure, per area (areas run one after another):
 *
 * - **Redness** `x = R - max(G, B)`; pixels with `x <= 0` are untouched. A
 *   corrected pixel moves along a fixed direction by `a = x - rest`
 *   (`a = 0` when `rest >= x`): red falls by `a`, green and blue rise by
 *   `a * 5 / 16` (each rounded separately; red by `a * 11 / 16`).
 * - **Luma** `L = round((9 G + 2 B) / 11)`, an integer (red plays no part).
 *   Its 30th and 70th percentiles over all of the area's pixels (red or not)
 *   differ by the **spread** `S`. **Darkness** `D = G + 2/9 B` (not rounded)
 *   feeds the falloff below.
 * - **Centre.** The centroid of the pixels' weights, over pixel centres:
 *   `x / L` for red pixels (1 flat when `L = 0`), nothing for the rest,
 *   uncapped. An area processed after another (one that held red) is nudged:
 *   the previous area's centroid, in image pixel-index coordinates (its
 *   origin plus the centroid minus 0.5, before any fallback), is added once to
 *   the weighted coordinate sums (the denominator is unchanged), which is why
 *   the second of two areas differs from the same area processed alone, and
 *   by how much depends on where the first one was. An area without red
 *   passes the carry on unchanged. A centroid farther from the area's middle than `(w + h) / 6` is
 *   discarded for the middle itself.
 * - **Radius.** `radius = min(e, f)` where, with `ax`, `ay` the centre in image
 *   coordinates, `e` is the distance to the left or right edge (`cx - 0.5`,
 *   or `w - cx + 0.5` once `round(cx) > w / 2`) and `f` the other axis'
 *   absolute coordinate minus 0.5, the horizontal edge distance applying when
 *   `ax > ay` and the vertical one otherwise. Pixels nearer than the radius to
 *   the centre are processed, and only they are counted.
 * - **Polar frame.** 60 sectors of 6 degrees (from +x towards +y); `M` is the
 *   mean of `x` over a sector's counted pixels and `Dm` the mean of `D`.
 * - **Rest.** `rest = (1 - F) M` with `F = max(m (1 - u)^2, (1 - D / Dm)^2 / 2)`
 *   for `u = distance / radius`. The first term is `m = 1/4` for a uniform
 *   area and rises by quantised steps with the spread (`1/2` above `S = 25`,
 *   `0.661` above 40, `3/4` above 80); the second corrects pixels much darker
 *   than their sector harder (pupils). The squared darkness term is symmetric
 *   about the sector mean, and is used only for `D / Dm < 2`; brighter
 *   pixels at or above twice that mean retain the radial term alone. The one
 *   brightest pixel of the area (its `L` strictly above every other pixel's)
 *   whose `L` is at least 40 above the 70th percentile is a highlight and
 *   gets `F = 1`.
 * - **Pixels on an axis through the centre.** The centre pixel itself is in
 *   the sector from 90 to 96 degrees (a lone red pixel is the centre; this
 *   fits 2,105 of 2,110 lone pixels inside the fallback circle, in nine area
 *   shapes and offsets; the sector at 0 misses 322 of them, the one at 270
 *   575).
 *
 * Not reproduced: the native output when the area holds red pixels with
 * `L = 0` and no other spread information (it depends on the calls made
 * before it, as the committed `redeye-stages` sequences show), the exact
 * fallback centre of the farthest-off areas, and which sector the pixels on
 * the four axes fall in when a symmetric scene puts the centre exactly on a
 * pixel centre (the native choice follows rounding noise).
 */
export function applyRedEyeCorrection(
	src: Uint8ClampedArray,
	width: number,
	height: number,
	areas: EffectRect[],
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(src);
	const carry = { x: 0, y: 0 };
	for (const a of areas) {
		correctRedEyeArea(out, width, clamp(a.left, 0, width), clamp(a.top, 0, height), clamp(a.right, 0, width), clamp(a.bottom, 0, height), carry);
	}
	return out;
}

const RED_EYE_SECTORS = 60;
/** Sector of the pixel whose centre is the area's centre: the one spanning 90 to 96 degrees. */
const RED_EYE_CENTRE_SECTOR = 15;
/** Blue's share in the darkness `D = G + 2/9 B` of the falloff term. */
const RED_EYE_BLUE_WEIGHT = 2 / 9;
/** Centroid weight of a red pixel whose integer luma {@link redEyeLuma} is 0 (almost no green or blue). */
const RED_EYE_PURE_WEIGHT = 1;
/** Share of the previous area's centroid carried into the next area's coordinate sums. */
const RED_EYE_CARRY = 1;

/**
 * The integer luma that weights the centroid: `round((9 G + 2 B) / 11)`.
 * Measured by ordering pixels: a pixel `P` is compared with `Q` exactly by
 * this value (0 disagreements in 46,966 `G`/`B` pairs), and a red pixel's
 * centroid weight is its redness over it.
 */
function redEyeLuma(g: number, b: number): number {
	return Math.floor((9 * g + 2 * b + 5) / 11);
}
/** Share of the removed redness that lands in green and blue each (the rest leaves red). */
const RED_EYE_GREEN_SHARE = 5 / 16;
/**
 * Spreads of integer luma (30th to 70th percentile over the whole area) above which the radial
 * strength steps up, and the strengths. Measured exactly with two-valued fields: a spread of 25
 * still gives 1/4, 26 gives 1/2; 40 gives 1/2, 41 gives 0.661; 80 gives 0.661, 81 gives 3/4.
 */
const RED_EYE_SPREAD_STEPS = [25, 40, 80] as const;
const RED_EYE_STRENGTHS = [0.25, 0.5, 0.661, 0.75] as const;
/**
 * A pixel that is the area's one brightest (integer luma strictly above every other pixel's) and at
 * least 40 above the 70th percentile is a highlight (a catch-light). It is corrected completely and
 * its surroundings are pulled in as well: no pixel keeps more than {@link RED_EYE_HIGHLIGHT_REST}
 * levels of redness per squared pixel of distance from it.
 */
const RED_EYE_HIGHLIGHT_RISE = 40;
const RED_EYE_HIGHLIGHT_REST = 5;

function correctRedEyeArea(
	out: Uint8ClampedArray,
	stride: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	carry: { x: number; y: number },
): void {
	const w = x1 - x0;
	const h = y1 - y0;
	const count = w * h;
	if (!(count > 0)) {
		return;
	}
	const redness = new Float64Array(count);
	const dark = new Float64Array(count);
	const lumas = new Int32Array(count);
	let sx = 0;
	let sy = 0;
	let sw = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = ((y0 + y) * stride + x0 + x) * 4;
			const r = out[i];
			const g = out[i + 1];
			const b = out[i + 2];
			const k = y * w + x;
			const d = g + RED_EYE_BLUE_WEIGHT * b;
			dark[k] = d;
			const luma = redEyeLuma(g, b);
			lumas[k] = luma;
			const v = r - Math.max(g, b);
			if (v > 0) {
				redness[k] = v;
				const weight = luma >= 1 ? v / luma : RED_EYE_PURE_WEIGHT;
				sx += weight * (x + 0.5);
				sy += weight * (y + 0.5);
				sw += weight;
			}
		}
	}
	if (sw === 0) {
		// Nothing red: untouched, and the next area is not influenced either.
		return;
	}
	// Centroids of symmetric scenes land on exact half pixels; rounding noise would otherwise decide which
	// sector a pixel exactly on a sector edge (or the centre pixel itself) falls in.
	let cx = Math.round(((sx + RED_EYE_CARRY * carry.x) / sw) * 1e9) / 1e9;
	let cy = Math.round(((sy + RED_EYE_CARRY * carry.y) / sw) * 1e9) / 1e9;
	// The next area is nudged by this centroid in pixel-index coordinates (a pixel centre is x + 0.5).
	carry.x = x0 + cx - 0.5;
	carry.y = y0 + cy - 0.5;
	if (Math.hypot(cx - w / 2, cy - h / 2) >= (w + h) / 6) {
		cx = w / 2;
		cy = h / 2;
	}
	// Edge distances: the nearer of the left/right (top/bottom) edge picked by the rounded centre; the other axis' absolute coordinate bounds the radius too.
	const ax = x0 + cx;
	const ay = y0 + cy;
	const edgeX = Math.round(cx) > w / 2 ? w - cx + 0.5 : cx - 0.5;
	const edgeY = Math.round(cy) > h / 2 ? h - cy + 0.5 : cy - 0.5;
	const radius = ax > ay ? Math.min(edgeX, ay - 0.5) : Math.min(edgeY, ax - 0.5);
	if (!(radius > 0)) {
		return;
	}
	// Strength of the falloff term: stepped by the spread of integer luma over the whole area.
	const sorted = Int32Array.from(lumas).sort();
	const p70 = sorted[Math.floor(0.7 * count)];
	const spread = p70 - sorted[Math.floor(0.3 * count)];
	const brightest = sorted[count - 1];
	const second = count > 1 ? sorted[count - 2] : -1;
	// The highlight (if any): the one pixel whose luma is strictly the area's largest and at least 40 above the 70th percentile.
	let highlight = -1;
	if (brightest > second && brightest - p70 >= RED_EYE_HIGHLIGHT_RISE) {
		highlight = lumas.indexOf(brightest);
	}
	let level = 0;
	while (level < RED_EYE_SPREAD_STEPS.length && spread > RED_EYE_SPREAD_STEPS[level]) {
		level++;
	}
	const strength = RED_EYE_STRENGTHS[level];
	const sector = new Uint8Array(count);
	const distance = new Float64Array(count);
	const sectorSum = new Float64Array(RED_EYE_SECTORS);
	const sectorDark = new Float64Array(RED_EYE_SECTORS);
	const sectorCount = new Float64Array(RED_EYE_SECTORS);
	const degrees = 180 / Math.PI;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const k = y * w + x;
			const d = Math.hypot(dx, dy);
			distance[k] = d;
			let angle = Math.atan2(dy, dx) * degrees;
			if (angle < 0) {
				angle += 360;
			}
			// The pixel exactly at the centre (a lone red pixel, or a centroid on a pixel centre) belongs to
			// the sector at 90 degrees, not to the one at 0.
			const s = dx === 0 && dy === 0 ? RED_EYE_CENTRE_SECTOR : Math.min(RED_EYE_SECTORS - 1, Math.floor(angle / 6));
			sector[k] = s;
			if (d < radius) {
				sectorSum[s] += redness[k];
				sectorDark[s] += dark[k];
				sectorCount[s]++;
			}
		}
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const k = y * w + x;
			const v = redness[k];
			if (v <= 0 || distance[k] >= radius) {
				continue;
			}
			const s = sector[k];
			const mean = sectorSum[s] / sectorCount[s];
			const meanDark = sectorDark[s] / sectorCount[s];
			const ratio = meanDark > 0 ? dark[k] / meanDark : 1;
			const u = distance[k] / radius;
			// Native concentric controls correct both sides of the mean, but stop
			// using this darkness term at twice the sector mean.
			const darknessFalloff = ratio < 2 ? 0.5 * (1 - ratio) ** 2 : 0;
			const falloff = Math.max(strength * (1 - u) * (1 - u), darknessFalloff);
			let rest = (1 - falloff) * mean;
			if (highlight >= 0) {
				// A highlight leaves at most 5 levels of redness per squared pixel of distance from it.
				const hdx = x - (highlight % w);
				const hdy = y - Math.floor(highlight / w);
				rest = Math.min(rest, RED_EYE_HIGHLIGHT_REST * (hdx * hdx + hdy * hdy));
			}
			if (rest >= v) {
				continue;
			}
			const removed = v - rest;
			const i = ((y0 + y) * stride + x0 + x) * 4;
			out[i] = Math.round(out[i] - (1 - RED_EYE_GREEN_SHARE) * removed);
			out[i + 1] = Math.round(out[i + 1] + RED_EYE_GREEN_SHARE * removed);
			out[i + 2] = Math.round(out[i + 2] + RED_EYE_GREEN_SHARE * removed);
		}
	}
}

// ---------------------------------------------------------------------------
// Blur and sharpen
// ---------------------------------------------------------------------------

/**
 * GDI+'s blur kernel for `radius`: `exp(-(1.4 * offset / radius)^2)`,
 * truncated at `ceil(radius)` taps on each side and
 * normalised (measured; `[0.110, 0.780, 0.110]` at radius 1).
 *
 * The weights are float32 values formed with every operation rounding toward
 * zero, which decides the rounding of products that land within a few
 * ten-thousandths of a tie. The offset is accumulated (`q_i = q_(i-1) + 1.4 /
 * radius`, not `i * 1.4 / radius`), `w_i = exp(-q_i^2)`, the sum is built as
 * `w_0 + 2 w_1 + 2 w_2 + ...` in that order, and each normalised weight is
 * `w_i * (256 / sum)` (here divided back by 256, which is exact). Found by
 * probing single products at float32-adjacent radii: every product rounding
 * of 7,000 probed radius / tap / value crossings (73 radii each) matches.
 */
export function blurKernel(radius: number): Float64Array {
	const taps = Math.ceil(radius);
	const k = new Float64Array(2 * taps + 1);
	if (taps === 0) {
		k[0] = 1;
		return k;
	}
	// Every operation is a float32 one that truncates toward zero, and the
	// offset accumulates: q_i = q_(i-1) + 1.4 / r, w_i = exp(-q_i^2),
	// sum = w_0 + 2 w_1 + 2 w_2 + ... in that order, k_i = w_i * (1 / sum)
	// (this reproduces the native weights bit for bit: 0 differing rounding
	// decisions across 10^5 probed radius / tap / value combinations).
	const step = truncF32(truncF32(1.4) / Math.fround(radius));
	const w = new Float64Array(taps + 1);
	w[0] = 1;
	let offset = 0;
	let sum = 1;
	for (let i = 1; i <= taps; i++) {
		offset = truncF32(offset + step);
		w[i] = truncF32(Math.exp(-truncF32(offset * offset)));
		sum = truncF32(sum + truncF32(2 * w[i]));
	}
	const scale = truncF32(256 / sum);
	for (let i = 0; i <= taps; i++) {
		// Scaling by 256 is exact, so these are the float32 products / 256.
		const weight = truncF32(w[i] * scale) / 256;
		k[taps + i] = weight;
		k[taps - i] = weight;
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
	/** Reduced samples beyond the ends are transparent instead of reflecting or clamping (expanded blur). */
	zeroOutside?: boolean;
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
				for (let j = 0; j < k256.length; j++) {
					const at = b - taps + j;
					sum += Math.round(k256[j] * (span.zeroOutside && (at < 0 || at >= n) ? 0 : reduced[index(at)]));
				}
			}
			sum += 2 * Math.round(half * reduced[b]);
			filtered[b] = Math.floor((sum + 128) / 256);
		}
		// A lone reduced sample has no line to continue. Unpadded, a single pixel beyond it stays as it
		// was; inside padding the pixel is empty and the line runs from the sample to a zero neighbour.
		const lone = inner === 1 && span.pad > 0;
		const skipped = inner === 1 && span.size - Math.ceil(factor / 2) === 1 ? span.start + span.size - 1 : -1;
		for (let i = 0; i < length; i++) {
			if (i === skipped) {
				if (span.pad > 0) put(i, lane, c, 0);
				continue;
			}
			// Only the span's own samples are enlarged (padding samples shape the filtering alone); beyond
			// the outer ones the line through the two nearest continues.
			const p = (i - span.start + 0.5) / factor - 0.5;
			if (lone) {
				// The sample sits at the middle of a full block, or just past the last pixel of a shorter one.
				const distance = Math.abs(i - span.start - (Math.min(span.size, factor / 2) - 0.5)) / factor;
				put(i, lane, c, clamp(Math.floor((1 + distance) * filtered[span.pad] + 1e-9), 0, 255));
				continue;
			}
			const a = clamp(Math.floor(p), 0, Math.max(0, inner - 2));
			const t = p - a;
			put(i, lane, c, clamp(Math.floor((1 - t) * filtered[span.pad + a] + t * filtered[span.pad + Math.min(inner - 1, a + 1)] + 1e-9), 0, 255));
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
 * images at radii 20-255 every pixel is exact. `region`, an expanded
 * blur's source rectangle inside its transparent padding, is reduced from its
 * own origin so that its partial blocks are not averaged with padding, and
 * only its own reduced samples are enlarged. `expanded` makes reduced samples
 * beyond the buffer transparent instead of reflecting or clamping them.
 */
function effectBlur(
	src: Uint8ClampedArray,
	width: number,
	height: number,
	radius: number,
	region?: { x: number; y: number; w: number; h: number },
	expanded = false,
): Float64Array {
	const factor = blurReduction(radius);
	// Native partial blocks on very small buffers use a different edge path.
	if (factor === 1) {
		return gdipBlur(src, width, height, radius);
	}
	const k = blurKernel(radius / factor);
	const pad = region ? Math.ceil(Math.ceil(radius) / factor) : 0;
	const spanX = region ? { start: region.x, size: region.w, pad, zeroOutside: true } : expanded ? { start: 0, size: width, pad: 0, zeroOutside: true } : undefined;
	const spanY = region ? { start: region.y, size: region.h, pad, zeroOutside: true } : expanded ? { start: 0, size: height, pad: 0, zeroOutside: true } : undefined;
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
	/**
	 * An expanded blur's first halo column, just right of the region (`height`
	 * RGBA texels). GDI+ draws no halo, but a bilinear tap at the region's
	 * right edge reads this column rather than a transparent one. Absent
	 * when the region does not reach the end of the effect's output.
	 */
	haloRight?: Uint8ClampedArray;
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
 * Either way only the rectangle's own reduced samples are enlarged, and
 * reduced samples beyond the grown buffer are transparent.
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
): { out: Uint8ClampedArray; halo: Uint8ClampedArray } {
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
			? effectBlur(buf, bw, bh, radius, cropped ? { x: r, y: r, w: x1 - x0, h: y1 - y0 } : undefined, true)
			: gdipBlur(buf, bw, bh, radius, cropped ? r : 0, cropped, Math.ceil((y1 - y0) / (x1 - x0)));
	const w = x1 - x0;
	const out = new Uint8ClampedArray(w * (y1 - y0) * 4);
	const halo = new Uint8ClampedArray((y1 - y0) * 4);
	for (let y = 0; y < y1 - y0; y++) {
		const from = ((y + r) * bw + r) * 4;
		for (let i = 0; i < w * 4; i++) {
			out[y * w * 4 + i] = Math.round(blurred[from + i]);
		}
		for (let i = 0; i < 4; i++) {
			halo[y * 4 + i] = Math.round(blurred[from + w * 4 + i]);
		}
	}
	return { out, halo };
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
 *   GDI+ draws no halo outside the source rectangle (the first halo column
 *   is kept as `haloRight`, which a bilinear tap at the right edge reads);
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
		const { out, halo } = expandedBlur(rgba, width, height, effect.radius, x0, y0, x1, y1, cropped);
		const region = result(out);
		if (shownWidth === w && shownHeight === h) {
			region.haloRight = halo;
		}
		return region;
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
