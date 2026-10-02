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
 * Windows' halftone colour algorithm is not published; the stages below were
 * measured on native 32 x 32 x 32 colour cubes (every palette colour, every
 * parameter, captured with `scripts/gdi-fixtures`, `color-adjustment-cube`).
 * Each stage works on one pixel's channels as 0..255 values, in this order:
 *
 *   1. `IlluminantIndex` 1..5, 7 and 8: a native colour cube (see
 *      {@link ILLUMINANT_CUBE_DATA}); 0 and 6 (D65) leave colours unchanged.
 *   2. Colorfulness and RedGreenTint in CIE 1976 u'v' (BT.709 primaries, D65
 *      white), keeping Y: the chroma offset from white is scaled by
 *      `1 + c / 100` and turned by `-t * 0.6` degrees. A result outside
 *      0..255 is remapped affinely onto 0..255 (smallest channel to 0,
 *      largest to 255) rather than clipped. The stage reads the palette level
 *      unrounded (`255 n / 31`, not the rounded 8-bit entry) and its result is
 *      rounded to an integer before the curve stages below; with both
 *      the native cubes agree on all but about 0.2-0.5% of channels (one level).
 *      Strongly out-of-gamut blues (tint beyond about 50) are compressed less
 *      than the affine remap predicts, up to 24 levels at tint 100.
 *   3. Gamma per channel: `255 * (v / 255) ^ gamma`.
 *   4. Reference black / white: `(v - black) / (white - black)`.
 *   5. Contrast: `v * exp(0.0148885 * c)`.
 *   6. Brightness: `v + 0.95625 * b`.
 *   7. `CA_LOG_FILTER`: `255 * log2(1 + 7 v / 255) / 3`.
 *   8. `CA_NEGATIVE`: `255 - v`.
 *
 * Isolated gamma and log curves skip the palette below and are applied to the
 * sampled colour; every other adjustment follows the palette path: Windows
 * quantises each source channel to 32 levels (`round(n * 255 / 31)`) with the
 * ordered dither of `emf-gdi-halftone-dither`, then maps the quantised colour.
 *
 * @module emf-gdi-color-adjust
 */

import { ILLUMINANT_CUBE_DATA } from './emf-gdi-illuminant-data';
import { inflateZlibSync } from './png-decoder';
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
 * The native colour cube of `IlluminantIndex` 1..5, 7 and 8 (`[r][g][b][channel]`
 * flattened, 32 levels per axis), decoded on first use. The mapping is not a
 * matrix: Windows compresses out-of-gamut colours (a green with a negative red
 * share keeps its green but gains blue), so the table holds the colour Windows
 * draws for every one of the 32^3 palette colours.
 */
const illuminantCubes = new Map<number, Uint8Array | null>();

function illuminantCube(index: number): Uint8Array | null {
	let cube = illuminantCubes.get(index);
	if (cube === undefined) {
		const encoded = ILLUMINANT_CUBE_DATA[index];
		cube = null;
		if (encoded) {
			const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
			const planes = inflateZlibSync(bytes);
			cube = new Uint8Array(32768 * 3);
			for (let c = 0; c < 3; c++) {
				for (let i = 0; i < 32768; i++) {
					const prev = i & 31 ? cube[(i - 1) * 3 + c] : 0;
					cube[i * 3 + c] = (prev + planes[c * 32768 + i]) & 255;
				}
			}
		}
		illuminantCubes.set(index, cube);
	}
	return cube;
}

/** Whether `ca` selects an illuminant that changes colours. */
function hasIlluminant(ca: GdiColorAdjustment): boolean {
	return illuminantCube(ca.illuminant) !== null;
}

/** The 8-bit value of 32-level palette entry `n` (`round(n * 255 / 31)`). */
const PALETTE = Array.from({ length: 32 }, (_, n) => Math.round((n * 255) / 31));

/** The unrounded level `255 n / 31` of a palette entry's 8-bit value, or `v` when it is not a palette entry. */
function exactPaletteLevel(v: number): number {
	const n = Math.round((v * 31) / 255);
	return PALETTE[n] === v ? (255 * n) / 31 : v;
}

/** Fractional palette index of a 0..1 channel value, exact at the palette's own levels. */
function paletteIndex(v: number): number {
	const x = clamp01(v) * 255;
	let n = Math.min(30, Math.floor((x * 31) / 255));
	while (n < 30 && x >= PALETTE[n + 1]) n++;
	while (n > 0 && x < PALETTE[n]) n--;
	return n + Math.min(1, Math.max(0, (x - PALETTE[n]) / (PALETTE[n + 1] - PALETTE[n])));
}

/** Trilinear lookup of a native illuminant cube; inputs and outputs are 0..1 channel values. */
function lookupIlluminant(cube: Uint8Array, r: number, g: number, b: number): [number, number, number] {
	const fr = paletteIndex(r);
	const fg = paletteIndex(g);
	const fb = paletteIndex(b);
	const r0 = Math.min(30, Math.floor(fr));
	const g0 = Math.min(30, Math.floor(fg));
	const b0 = Math.min(30, Math.floor(fb));
	const tr = fr - r0;
	const tg = fg - g0;
	const tb = fb - b0;
	const result: [number, number, number] = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		let acc = 0;
		for (let corner = 0; corner < 8; corner++) {
			const dr = corner & 1;
			const dg = (corner >> 1) & 1;
			const db = (corner >> 2) & 1;
			const weight = (dr ? tr : 1 - tr) * (dg ? tg : 1 - tg) * (db ? tb : 1 - tb);
			if (weight !== 0) {
				acc += weight * cube[(((r0 + dr) * 32 + g0 + dg) * 32 + b0 + db) * 3 + c];
			}
		}
		result[c] = acc / 255;
	}
	return result;
}

/**
 * Whether `ca` only reshapes each channel on its own (gamma, reference
 * black / white, contrast, brightness, log curve, negative): Windows applies
 * such curves to the sampled and sharpened colour exactly, with no palette or
 * dither. An illuminant, colorfulness or tint needs the palette path.
 */
export function isChannelOnlyColorAdjustment(ca: GdiColorAdjustment | undefined): boolean {
	return !!ca && !hasIlluminant(ca) && ca.colorfulness === 0 && ca.redGreenTint === 0;
}

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
			!hasIlluminant(ca) &&
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

/** Contrast `c` multiplies every channel by `exp(CONTRAST_RATE * c)` (measured: 0.0148885 +- 5e-7). */
const CONTRAST_RATE = 0.0148885;
/** Brightness `b` adds `BRIGHTNESS_STEP * b` levels (measured between 0.9557 and 0.9590). */
const BRIGHTNESS_STEP = 0.95625;
/** Colorfulness `c` scales the CIE u'v' chroma by `1 + c / 100`. */
const COLORFULNESS_SCALE = 1 / 100;
/** RedGreenTint `t` turns the u'v' hue by `-t / 100 * 60` degrees. */
const TINT_RADIANS = -Math.PI / 3;

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

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Scales the CIE 1976 u'v' chroma of a 0..255 colour about D65 white by
 * `scale` and turns its hue by `angle`, keeping Y (the channels are treated as
 * linear BT.709 values, which is what Windows measures as). A result outside
 * 0..255 is remapped affinely so its smallest and largest channels land on 0
 * and 255 (Windows compresses the gamut this way instead of clipping).
 */
function adjustChroma(r: number, g: number, b: number, scale: number, angle: number): [number, number, number] {
	const x = RGB_TO_XYZ[0][0] * r + RGB_TO_XYZ[0][1] * g + RGB_TO_XYZ[0][2] * b;
	const y = RGB_TO_XYZ[1][0] * r + RGB_TO_XYZ[1][1] * g + RGB_TO_XYZ[1][2] * b;
	const z = RGB_TO_XYZ[2][0] * r + RGB_TO_XYZ[2][1] * g + RGB_TO_XYZ[2][2] * b;
	const d = x + 15 * y + 3 * z;
	if (d <= 1e-9 || y <= 1e-9) {
		return [r, g, b];
	}
	const du = (4 * x) / d - WHITE_U;
	const dv = (9 * y) / d - WHITE_V;
	const cos = Math.cos(angle) * scale;
	const sin = Math.sin(angle) * scale;
	const u = WHITE_U + du * cos - dv * sin;
	const v = Math.max(1e-6, WHITE_V + du * sin + dv * cos);
	const x2 = (y * 9 * u) / (4 * v);
	const z2 = (y * (12 - 3 * u - 20 * v)) / (4 * v);
	const out: [number, number, number] = [
		XYZ_TO_RGB[0][0] * x2 + XYZ_TO_RGB[0][1] * y + XYZ_TO_RGB[0][2] * z2,
		XYZ_TO_RGB[1][0] * x2 + XYZ_TO_RGB[1][1] * y + XYZ_TO_RGB[1][2] * z2,
		XYZ_TO_RGB[2][0] * x2 + XYZ_TO_RGB[2][1] * y + XYZ_TO_RGB[2][2] * z2,
	];
	const lo = Math.min(0, out[0], out[1], out[2]);
	const hi = Math.max(255, out[0], out[1], out[2]);
	if (lo < 0 || hi > 255) {
		const k = 255 / (hi - lo);
		return [(out[0] - lo) * k, (out[1] - lo) * k, (out[2] - lo) * k];
	}
	return out;
}

/**
 * Builds the per-pixel mapping for `ca` (see the module doc for the
 * stages). Returns packed `0xRRGGBB` for packed `0xRRGGBB`.
 */
export function colorAdjustmentMapper(ca: GdiColorAdjustment): (rgb: number) => number {
	const illuminant = illuminantCube(ca.illuminant);
	const gammas = [ca.redGamma / 10000, ca.greenGamma / 10000, ca.blueGamma / 10000];
	const black = (ca.referenceBlack / 10000) * 255;
	const span = Math.max(1e-6, (ca.referenceWhite / 10000) * 255 - black);
	const gain = Math.exp(CONTRAST_RATE * ca.contrast);
	const lift = BRIGHTNESS_STEP * ca.brightness;
	const chroma = ca.colorfulness !== 0 || ca.redGreenTint !== 0;
	const scale = 1 + COLORFULNESS_SCALE * ca.colorfulness;
	const angle = (TINT_RADIANS * ca.redGreenTint) / 100;
	const log = (ca.flags & CA_LOG_FILTER) !== 0;
	const negative = (ca.flags & CA_NEGATIVE) !== 0;
	const curve = (value: number, channel: number): number => {
		// The stages run in this order: gamma, reference black / white,
		// contrast, brightness, log curve, negative.
		let v = 255 * (clamp255(value) / 255) ** gammas[channel];
		v = ((v - black) / span) * 255;
		v = v * gain + lift;
		if (log) {
			v = (255 * Math.log2(1 + (7 * clamp255(v)) / 255)) / 3;
		}
		if (negative) {
			v = 255 - clamp255(v);
		}
		return Math.round(clamp255(v));
	};
	if (!illuminant && !chroma) {
		const tables = [0, 1, 2].map(channel => Uint8Array.from({ length: 256 }, (_, i) => curve(i, channel)));
		return rgb => (tables[0][(rgb >> 16) & 255] << 16) | (tables[1][(rgb >> 8) & 255] << 8) | tables[2][rgb & 255];
	}
	return (rgb: number): number => {
		let c: [number, number, number] = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
		if (illuminant) {
			const mapped = lookupIlluminant(illuminant, c[0] / 255, c[1] / 255, c[2] / 255);
			c = [mapped[0] * 255, mapped[1] * 255, mapped[2] * 255];
		}
		if (chroma) {
			if (!illuminant) {
				// The chroma stage reads the palette level unrounded (255 n / 31),
				// not the rounded 8-bit entry the curve stages see.
				c = c.map(exactPaletteLevel) as [number, number, number];
			}
			c = adjustChroma(clamp255(c[0]), clamp255(c[1]), clamp255(c[2]), scale, angle);
			c = c.map(Math.round) as [number, number, number];
		}
		return (curve(c[0], 0) << 16) | (curve(c[1], 1) << 8) | curve(c[2], 2);
	};
}

/**
 * The two halves of an adjustment that needs the palette path: the colour
 * operations (illuminant, colorfulness, tint), which Windows applies to the
 * quantised source, and the per-channel curves, which it applies to the
 * finished sampled colour. Either half is `undefined` when it does nothing.
 */
export function splitColorAdjustment(ca: GdiColorAdjustment): { palette?: GdiColorAdjustment; curves?: GdiColorAdjustment } {
	const neutral = DEFAULT_COLOR_ADJUSTMENT;
	const palette: GdiColorAdjustment = { ...neutral, illuminant: ca.illuminant, colorfulness: ca.colorfulness, redGreenTint: ca.redGreenTint };
	const curves: GdiColorAdjustment = { ...ca, illuminant: 0, colorfulness: 0, redGreenTint: 0 };
	return {
		palette: isIdentityColorAdjustment(palette) ? undefined : palette,
		curves: isIdentityColorAdjustment(curves) ? undefined : curves,
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
