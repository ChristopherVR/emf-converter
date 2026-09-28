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
 * Windows' halftone colour algorithm is not published. The formulas here
 * are a documented approximation, applied per source pixel in this order
 * (channels as 0..1):
 *
 *   1. Reference black / white: `v = (v - black) / (white - black)`,
 *      clamped, with `black = ReferenceBlack / 10000` and
 *      `white = ReferenceWhite / 10000` (so the defaults 0 and 10000 are
 *      the identity).
 *   2. Gamma per channel: `v = v ^ gamma`, `gamma = Gamma / 10000`.
 *   3. `CA_NEGATIVE`: `v = 1 - v`.
 *   4. Split into BT.601 luma `Y` and the colour differences `R - Y`,
 *      `B - Y`, then:
 *      - Colorfulness scales both differences by `1 + 2c / 100` for
 *        `c > 0` and `1 + c / 100` for `c <= 0` (-100 is grey).
 *      - Contrast scales `Y` about mid-grey by `1 + c / 100`.
 *      - Brightness adds `0.8 * b / 100` to `Y`.
 *      - RedGreenTint adds `0.3 * t / 100` to `R - Y` (towards red for a
 *        positive tint, towards green for a negative one, keeping `Y`).
 *   5. Back to RGB, clamped to 0..1.
 *   6. `CA_LOG_FILTER`: `v = log10(1 + 9v)`, which lifts and spreads the
 *      dark tones.
 *
 * The contrast, brightness, colorfulness and tint scales were chosen to
 * come close to one Windows capture (`emfrec-coloradjustment`, which
 * combines a negative with strong gamma, contrast, brightness,
 * colorfulness and tint settings); the result is not bit-exact, and
 * Windows also dithers the adjusted colours, which is not reproduced.
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

/** Scale of the colour differences for a Colorfulness value (see the module doc). */
function colorfulnessScale(c: number): number {
	return c > 0 ? 1 + (2 * c) / 100 : 1 + c / 100;
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
	// Stages 1-3 per channel depend on one byte each: tabulate them.
	const curves = gammas.map((gamma) => {
		const table = new Float64Array(256);
		for (let i = 0; i < 256; i++) {
			let v = clamp01((i / 255 - black) / span);
			v = Math.pow(v, gamma);
			table[i] = ca.flags & CA_NEGATIVE ? 1 - v : v;
		}
		return table;
	});
	const chroma = colorfulnessScale(ca.colorfulness);
	const contrast = 1 + ca.contrast / 100;
	const brightness = (0.8 * ca.brightness) / 100;
	const tint = (0.3 * ca.redGreenTint) / 100;
	const log = (ca.flags & CA_LOG_FILTER) !== 0;
	const out = (v: number): number => {
		v = clamp01(v);
		if (log) {
			v = Math.log10(1 + 9 * v);
		}
		return Math.round(v * 255);
	};
	return (rgb: number): number => {
		const r = curves[0][(rgb >> 16) & 0xff];
		const g = curves[1][(rgb >> 8) & 0xff];
		const b = curves[2][rgb & 0xff];
		let y = 0.299 * r + 0.587 * g + 0.114 * b;
		let cr = (r - y) * chroma;
		const cb = (b - y) * chroma;
		y = (y - 0.5) * contrast + 0.5 + brightness;
		cr += tint;
		const r2 = y + cr;
		const b2 = y + cb;
		const g2 = (y - 0.299 * r2 - 0.114 * b2) / 0.587;
		return (out(r2) << 16) | (out(g2) << 8) | out(b2);
	};
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
