/**
 * EMR_SETCOLORADJUSTMENT: the COLORADJUSTMENT structure ([MS-EMF] 2.2.2)
 * and its effect on bitmap blits.
 *
 * GDI applies the DC's colour adjustment to the source bitmap of
 * StretchBlt and StretchDIBits (EMR_STRETCHBLT, EMR_STRETCHDIBITS) only
 * while the stretch mode is HALFTONE: it is an input of the halftone
 * engine, which BitBlt and the other stretch modes never use. The
 * adjustment belongs to the DC state, so SaveDC / RestoreDC save and
 * restore it.
 *
 * Windows' halftone colour algorithm is not published. The model here was
 * fitted to Windows captures (`emfrec-coloradjustment` and the
 * `emfrec-halftone-*-ca` ramps and checkerboards: two different
 * adjustments) and is applied per source pixel (channels as 0..1):
 *
 *   1. `CA_NEGATIVE`: `v = 1 - v`.
 *   2. Reference black / white: `v = (v - black) / (white - black)`,
 *      clamped, with `black = ReferenceBlack / 10000` and
 *      `white = ReferenceWhite / 10000`.
 *   3. Gamma per channel: `v = v ^ gamma`, `gamma = Gamma / 10000`, taken
 *      as the encoding of the source, so it is undone at the end (step 6):
 *      a gamma on its own changes nothing, it only moves where the other
 *      adjustments act.
 *   4. Colorfulness and RedGreenTint in CIE 1976 u'v' (BT.709 primaries,
 *      D65 white), keeping the luminance Y: the chromaticity's offset from
 *      the white point is scaled by `1 + 1.335 c / 100` (`1 + c / 100`
 *      below zero, so -100 is grey) and turned by `-1.135 t / 100`
 *      radians. Out-of-gamut results are clipped per channel. Scaling in
 *      u'v' at constant Y is what makes a dark saturated blue come out
 *      bright, as it does on Windows.
 *   5. Contrast and brightness per channel on CIE L*:
 *      `L' = 50 + (L - 50) * exp(1.88 c / 100) + 0.785 b`, clamped. The
 *      grey ramp of the halftone fixtures (contrast 30, brightness -20,
 *      gamma 1.5) is within a few levels of this.
 *   6. Back through the gamma (`v ^ (1 / gamma)`), then `CA_LOG_FILTER`:
 *      `v = log10(1 + 9v)` (not measured).
 *
 * Windows then dithers: every channel is quantised to one of 32 levels
 * (`n * 255 / 31`) with an ordered threshold per source pixel and the
 * adjusted colour of that quantised input is drawn, so a flat colour comes
 * out as a pattern of two or more nearby colours. That pattern is not
 * reproduced; this module maps each colour continuously, which is within
 * one quantisation step of Windows' pixels for most colours.
 * `IlluminantIndex` is read but not used.
 *
 * @module emf-gdi-color-adjust
 */

import type { GdiColorAdjustment } from './emf-types';

/** COLORADJUSTMENT.caFlags: produce a negative of the source. */
export const CA_NEGATIVE = 0x0001;
/** COLORADJUSTMENT.caFlags: apply a logarithmic curve to the output. */
export const CA_LOG_FILTER = 0x0002;

/** Byte size of a COLORADJUSTMENT structure. */
export const COLOR_ADJUSTMENT_SIZE = 24;

/** The adjustment a fresh DC starts with (it changes nothing). */
export const DEFAULT_COLOR_ADJUSTMENT: Readonly<GdiColorAdjustment> = {
	flags: 0,
	illuminant: 0,
	redGamma: 10000,
	greenGamma: 10000,
	blueGamma: 10000,
	referenceBlack: 0,
	referenceWhite: 10000,
	contrast: 0,
	brightness: 0,
	colorfulness: 0,
	redGreenTint: 0,
};

/**
 * Reads a COLORADJUSTMENT at `off`, or returns null when a field is outside
 * the range `SetColorAdjustment` accepts (Windows then rejects the call and
 * keeps the previous adjustment): gammas 2500..65000, ReferenceBlack
 * 0..4000, ReferenceWhite 6000..10000, contrast / brightness /
 * colorfulness / tint -100..100, IlluminantIndex 0..8 and no flags other
 * than `CA_NEGATIVE` and `CA_LOG_FILTER`.
 */
export function readColorAdjustment(view: DataView, off: number): GdiColorAdjustment | null {
	const ca: GdiColorAdjustment = {
		flags: view.getUint16(off + 2, true),
		illuminant: view.getUint16(off + 4, true),
		redGamma: view.getUint16(off + 6, true),
		greenGamma: view.getUint16(off + 8, true),
		blueGamma: view.getUint16(off + 10, true),
		referenceBlack: view.getUint16(off + 12, true),
		referenceWhite: view.getUint16(off + 14, true),
		contrast: view.getInt16(off + 16, true),
		brightness: view.getInt16(off + 18, true),
		colorfulness: view.getInt16(off + 20, true),
		redGreenTint: view.getInt16(off + 22, true),
	};
	const within = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;
	const valid =
		(ca.flags & ~(CA_NEGATIVE | CA_LOG_FILTER)) === 0 &&
		within(ca.illuminant, 0, 8) &&
		within(ca.redGamma, 2500, 65000) &&
		within(ca.greenGamma, 2500, 65000) &&
		within(ca.blueGamma, 2500, 65000) &&
		within(ca.referenceBlack, 0, 4000) &&
		within(ca.referenceWhite, 6000, 10000) &&
		within(ca.contrast, -100, 100) &&
		within(ca.brightness, -100, 100) &&
		within(ca.colorfulness, -100, 100) &&
		within(ca.redGreenTint, -100, 100);
	return valid ? ca : null;
}

/** Whether `ca` leaves every colour unchanged (the illuminant is ignored). */
export function isIdentityColorAdjustment(ca: GdiColorAdjustment | undefined): boolean {
	return (
		!ca ||
		(ca.flags === 0 &&
			ca.redGamma === 10000 &&
			ca.greenGamma === 10000 &&
			ca.blueGamma === 10000 &&
			ca.referenceBlack === 0 &&
			ca.referenceWhite === 10000 &&
			ca.contrast === 0 &&
			ca.brightness === 0 &&
			ca.colorfulness === 0 &&
			ca.redGreenTint === 0)
	);
}

/** Contrast `c` multiplies L* about 50 by `exp(CONTRAST_GAIN * c / 100)`. */
const CONTRAST_GAIN = 1.88;
/** Brightness 100 adds this much to L*. */
const BRIGHTNESS_GAIN = 78.5;
/** Colorfulness 100 scales the u'v' chroma by 1 + this. */
const COLORFULNESS_GAIN = 1.335;
/** RedGreenTint 100 turns the u'v' hue by this many radians. */
const TINT_RADIANS = -1.135;

/** Linear sRGB / BT.709 primaries to CIE XYZ (D65 white). */
const RGB_TO_XYZ = [
	[0.4124, 0.3576, 0.1805],
	[0.2126, 0.7152, 0.0722],
	[0.0193, 0.1192, 0.9505],
];
const XYZ_TO_RGB = invert3(RGB_TO_XYZ);
const WHITE = RGB_TO_XYZ.map((row) => row[0] + row[1] + row[2]);
const WHITE_D = WHITE[0] + 15 * WHITE[1] + 3 * WHITE[2];
const WHITE_U = (4 * WHITE[0]) / WHITE_D;
const WHITE_V = (9 * WHITE[1]) / WHITE_D;

function invert3(m: number[][]): number[][] {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const A = e * i - f * h;
	const B = f * g - d * i;
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		[A / det, (c * h - b * i) / det, (b * f - c * e) / det],
		[B / det, (a * i - c * g) / det, (c * d - a * f) / det],
		[C / det, (b * g - a * h) / det, (a * e - b * d) / det],
	];
}

/** CIE L* (0..100) of a relative luminance / linear channel value. */
function lightness(t: number): number {
	return t > 0.008856 ? 116 * Math.cbrt(t) - 16 : 903.3 * t;
}

/** Inverse of {@link lightness}. */
function fromLightness(l: number): number {
	return l > 8 ? ((l + 16) / 116) ** 3 : l / 903.3;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Builds the per-pixel mapping for `ca` (see the module doc for the
 * formulas). Returns packed `0xRRGGBB` for packed `0xRRGGBB`.
 */
export function colorAdjustmentMapper(ca: GdiColorAdjustment): (rgb: number) => number {
	const black = ca.referenceBlack / 10000;
	const span = Math.max(1e-6, ca.referenceWhite / 10000 - black);
	const gammas = [ca.redGamma / 10000, ca.greenGamma / 10000, ca.blueGamma / 10000];
	const negative = (ca.flags & CA_NEGATIVE) !== 0;
	// Stage 1 per channel depends on one byte each: tabulate it.
	const linear = gammas.map((gamma) => {
		const table = new Float64Array(256);
		for (let i = 0; i < 256; i++) {
			const v = negative ? 1 - i / 255 : i / 255;
			table[i] = clamp01((v - black) / span) ** gamma;
		}
		return table;
	});
	// Colorfulness -100 leaves grey; a positive value boosts faster.
	const chroma = ca.colorfulness < 0 ? 1 + ca.colorfulness / 100 : 1 + (COLORFULNESS_GAIN * ca.colorfulness) / 100;
	const angle = (TINT_RADIANS * ca.redGreenTint) / 100;
	const cos = Math.cos(angle) * chroma;
	const sin = Math.sin(angle) * chroma;
	const slope = Math.exp((CONTRAST_GAIN * ca.contrast) / 100);
	const offset = 50 - 50 * slope + (BRIGHTNESS_GAIN * ca.brightness) / 100;
	const log = (ca.flags & CA_LOG_FILTER) !== 0;
	const colour = ca.colorfulness !== 0 || ca.redGreenTint !== 0;
	const out = (v: number, c: number): number => {
		v = clamp01(fromLightness(slope * lightness(clamp01(v)) + offset)) ** (1 / gammas[c]);
		if (log) {
			v = Math.log10(1 + 9 * v);
		}
		return Math.round(v * 255);
	};
	return (rgb: number): number => {
		let r = linear[0][(rgb >> 16) & 0xff];
		let g = linear[1][(rgb >> 8) & 0xff];
		let b = linear[2][rgb & 0xff];
		if (colour) {
			// Scale and turn the chromaticity about the white point (CIE u'v'), keeping Y.
			const x = RGB_TO_XYZ[0][0] * r + RGB_TO_XYZ[0][1] * g + RGB_TO_XYZ[0][2] * b;
			const y = RGB_TO_XYZ[1][0] * r + RGB_TO_XYZ[1][1] * g + RGB_TO_XYZ[1][2] * b;
			const z = RGB_TO_XYZ[2][0] * r + RGB_TO_XYZ[2][1] * g + RGB_TO_XYZ[2][2] * b;
			const d = x + 15 * y + 3 * z;
			if (d > 1e-12 && y > 1e-12) {
				const du = (4 * x) / d - WHITE_U;
				const dv = (9 * y) / d - WHITE_V;
				const u = WHITE_U + du * cos - dv * sin;
				const v = Math.max(1e-6, WHITE_V + du * sin + dv * cos);
				const x2 = (y * 9 * u) / (4 * v);
				const z2 = (y * (12 - 3 * u - 20 * v)) / (4 * v);
				r = XYZ_TO_RGB[0][0] * x2 + XYZ_TO_RGB[0][1] * y + XYZ_TO_RGB[0][2] * z2;
				g = XYZ_TO_RGB[1][0] * x2 + XYZ_TO_RGB[1][1] * y + XYZ_TO_RGB[1][2] * z2;
				b = XYZ_TO_RGB[2][0] * x2 + XYZ_TO_RGB[2][1] * y + XYZ_TO_RGB[2][2] * z2;
			}
		}
		return (out(r, 0) << 16) | (out(g, 1) << 8) | out(b, 2);
	};
}

/**
 * Applies `ca` to packed RGB triples in place (see {@link applyColorAdjustment}).
 */
export function colorAdjustRgb(rgbs: Int32Array, ca: GdiColorAdjustment | undefined): void {
	if (!ca || isIdentityColorAdjustment(ca)) {
		return;
	}
	const map = colorAdjustmentMapper(ca);
	const cache = new Map<number, number>();
	for (let i = 0; i + 2 < rgbs.length; i += 3) {
		const rgb = (rgbs[i] << 16) | (rgbs[i + 1] << 8) | rgbs[i + 2];
		let v = cache.get(rgb);
		if (v === undefined) {
			v = map(rgb);
			if (cache.size < 65536) {
				cache.set(rgb, v);
			}
		}
		rgbs[i] = (v >> 16) & 0xff;
		rgbs[i + 1] = (v >> 8) & 0xff;
		rgbs[i + 2] = v & 0xff;
	}
}

/**
 * Applies `ca` to every pixel of `pixels` in place (alpha untouched). A
 * no-op for the identity adjustment.
 */
export function applyColorAdjustment(
	pixels: { data: Uint8ClampedArray },
	ca: GdiColorAdjustment | undefined,
): void {
	if (!ca || isIdentityColorAdjustment(ca)) {
		return;
	}
	const map = colorAdjustmentMapper(ca);
	const d = pixels.data;
	const cache = new Map<number, number>();
	for (let i = 0; i + 3 < d.length; i += 4) {
		const rgb = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
		let v = cache.get(rgb);
		if (v === undefined) {
			v = map(rgb);
			if (cache.size < 65536) {
				cache.set(rgb, v);
			}
		}
		d[i] = (v >> 16) & 0xff;
		d[i + 1] = (v >> 8) & 0xff;
		d[i + 2] = v & 0xff;
	}
}
