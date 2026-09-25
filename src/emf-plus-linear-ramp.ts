/**
 * GDI+'s own colour ramp for a linear gradient brush, reproduced exactly.
 *
 * GDI+ does not evaluate a linear gradient's colour curve (its end colours,
 * `Blend` factors or `InterpolationColors` presets) at every pixel. It
 * samples the curve once into an interpolation table of `N + 1` knots at
 * `t = k / N`, rounds each knot to 8 bits per channel (premultiplied), and
 * then interpolates linearly between neighbouring knots per pixel. So a
 * preset stop that does not fall on a knot is never reached: the peak of a
 * white stop at `t = 0.4` in a 16-interval table is the blend of the knots
 * at 0.375 and 0.4375 (this is what kept the `grad-linear-preset-a120-*`
 * fixtures 1.5% away before). Measured against real GDI+ output
 * (thousands of single-scanline probes over widths 16 to 8192):
 *
 * - The table has `N = 16` intervals when the ramp has at most three
 *   points (a plain two-colour gradient, a three-factor `Blend` such as
 *   `SetBlendTriangularShape`, or three preset colours). With four or more
 *   points it has 16, 64 or 256 intervals, chosen from the brush
 *   rectangle's `width + height` in brush units (above 128: 64; above 512:
 *   256), not from the gradient's device length.
 * - A knot is the curve's colour at `k / N` rounded half up (a translucent
 *   colour's premultiplied value sits a hair below its exact product, so
 *   its halves round down). With `GammaCorrection` the curve is evaluated
 *   in linear light (each end or preset colour raised to the power 2.2 and
 *   interpolated), held in 10 bits and re-encoded with the power 1 / 2.2
 *   before rounding; the per-pixel interpolation between knots stays
 *   linear.
 * - A pixel's ramp coordinate `u = t * N` runs in 16.16 fixed point, as
 *   an affine form of the device pixel whose three coefficients (the value
 *   at device (0, 0) and the steps per pixel in x and in y) are each rounded
 *   once, so every pixel is exact integer arithmetic from the origin (which
 *   decides which side of a period seam a pixel exactly on it falls, as in
 *   `grad-linear-skew-blend-*`). The colour is the knots either
 *   side blended by the top 8 fraction bits: `(K[k] * (256 - f) + K[k+1] *
 *   f + 128) >> 8`. Interpolation is on premultiplied colours, as GDI+
 *   blends a translucent gradient (and as Canvas does).
 *
 * That reproduces GDI+ bit for bit apart from exact rounding ties, where
 * GDI+'s float arithmetic can land a hair either side of one half.
 *
 * {@link linearRampSampler} paints the brush per device pixel this way
 * (used for raster fills, `emf-plus-exact-fill.ts`); {@link linearRampStops}
 * turns the same knots into Canvas/SVG gradient stops, which a Canvas or SVG
 * linear gradient interpolates exactly as GDI+ interpolates between knots.
 *
 * @module emf-plus-linear-ramp
 */

import type {
	EmfPlusGradientStop,
	EmfPlusGradientWrapMode,
	EmfPlusLinearGradient,
	EmfPlusLinearRamp,
	EmfPlusRectF,
	TransformMatrix,
} from './emf-types';

/** A linear gradient's GDI+ interpolation table. */
export interface LinearRampTable {
	/** Number of intervals `N` (16, 64 or 256). */
	intervals: number;
	/** `N + 1` knots, premultiplied RGBA bytes, `(N + 1) * 4` long. */
	knots: Uint8Array;
}

/** Gamma GDI+ applies when a brush is `GammaCorrection`-enabled. */
const GAMMA = 2.2;

/**
 * Number of intervals GDI+ gives the table: 16 for a ramp of at most three
 * points, otherwise 16, 64 or 256 by the brush rectangle's `w + h` in brush
 * units (see the module doc). Pure.
 */
export function linearRampIntervals(pointCount: number, rect: EmfPlusRectF): number {
	if (pointCount <= 3) {
		return 16;
	}
	const size = Math.abs(rect.w) + Math.abs(rect.h);
	if (size > 512) {
		return 256;
	}
	return size > 128 ? 64 : 16;
}

/** Number of curve points a ramp is defined by (2 for plain end colours). */
function rampPointCount(ramp: EmfPlusLinearRamp): number {
	if (ramp.preset) {
		return ramp.preset.positions.length;
	}
	if (ramp.blend) {
		return ramp.blend.positions.length;
	}
	return 2;
}

/** Piecewise-linear lookup of `ys` at `x` over ascending `xs`, clamped at both ends. */
function piecewise(xs: readonly number[], ys: readonly number[], x: number): number {
	const n = Math.min(xs.length, ys.length);
	if (n === 0) {
		return x;
	}
	if (x <= xs[0]) {
		return ys[0];
	}
	for (let i = 1; i < n; i++) {
		if (x <= xs[i]) {
			const span = xs[i] - xs[i - 1];
			const f = span > 0 ? (x - xs[i - 1]) / span : 1;
			return ys[i - 1] + (ys[i] - ys[i - 1]) * f;
		}
	}
	return ys[n - 1];
}

/**
 * A packed ARGB colour as premultiplied channels `[r, g, b, a]` (0..255,
 * unrounded), with the colour channels in linear light when `gamma`.
 */
function premultiplied(argb: number, gamma: boolean): [number, number, number, number] {
	const a = (argb >>> 24) & 0xff;
	const k = a / 255;
	const ch = (shift: number): number => {
		const v = (argb >>> shift) & 0xff;
		// A translucent colour's premultiplied value lands a hair below the exact
		// product, so a knot exactly half-way between levels rounds down
		// (measured on the raw PARGB output of a ramp to alpha 200: its knot at
		// 1/16 is alpha 13 over blue 12, while a ramp to an opaque colour
		// rounds the same half up).
		return (gamma ? 255 * Math.pow(v / 255, GAMMA) : v) * k * (a < 255 ? 1 - 2 ** -40 : 1);
	};
	return [ch(16), ch(8), ch(0), a];
}

/** Blend of two premultiplied colours at `f` (0 = `c0`). */
function mix(c0: readonly number[], c1: readonly number[], f: number): [number, number, number, number] {
	return [
		c0[0] + (c1[0] - c0[0]) * f,
		c0[1] + (c1[1] - c0[1]) * f,
		c0[2] + (c1[2] - c0[2]) * f,
		c0[3] + (c1[3] - c0[3]) * f,
	];
}

/**
 * Blend of the end colours at blend factor `f` the way GDI+ forms a
 * `Blend` knot: each end's share is truncated in 8.8 fixed point, with
 * `1 - f` held as a float32, so a factor landing exactly on a half level
 * rounds the way GDI+'s float arithmetic tips it (this matches all but
 * about 0.5% of the exact-tie knots measured; preset colours and plain
 * gradients round their exact value half up instead). The result is in
 * 1/256 levels' precision; {@link buildLinearRampTable} rounds it half up.
 */
function mixBlend(c0: readonly number[], c1: readonly number[], f: number): [number, number, number, number] {
	const g = Math.fround(1 - f);
	const ch = (a: number, b: number): number => (Math.trunc(a * 256 * g) + Math.trunc(b * 256 * f)) / 256;
	return [ch(c0[0], c1[0]), ch(c0[1], c1[1]), ch(c0[2], c1[2]), ch(c0[3], c1[3])];
}

/** The ramp's unrounded premultiplied colour at `t` (0..1). */
function rampColorAt(ramp: EmfPlusLinearRamp, t: number): [number, number, number, number] {
	const gamma = ramp.gammaCorrected;
	if (ramp.preset && ramp.preset.positions.length > 0) {
		const { positions, argb } = ramp.preset;
		const n = Math.min(positions.length, argb.length);
		if (t <= positions[0] || n === 1) {
			return premultiplied(argb[0], gamma);
		}
		for (let i = 1; i < n; i++) {
			if (t <= positions[i]) {
				const span = positions[i] - positions[i - 1];
				const f = span > 0 ? (t - positions[i - 1]) / span : 1;
				return mix(premultiplied(argb[i - 1], gamma), premultiplied(argb[i], gamma), f);
			}
		}
		return premultiplied(argb[n - 1], gamma);
	}
	const start = premultiplied(ramp.startArgb, gamma);
	const end = premultiplied(ramp.endArgb, gamma);
	if (ramp.blend && !gamma) {
		return mixBlend(start, end, piecewise(ramp.blend.positions, ramp.blend.factors, t));
	}
	return mix(start, end, ramp.blend ? piecewise(ramp.blend.positions, ramp.blend.factors, t) : t);
}

/**
 * Re-encodes a linear-light premultiplied channel to gamma space. GDI+
 * holds the linear value in 10 bits (rounded to 1/1023) before the
 * inverse power: measured on 16 random two-colour gamma ramps, every one
 * of their 768 knot channels matched, where the unquantised curve was off
 * by one level on about one in eight (and by more in the darks).
 */
function encode(v: number, a: number): number {
	if (a <= 0) {
		return 0;
	}
	const k = a / 255;
	const linear = Math.round(Math.min(1, Math.max(0, v / k / 255)) * 1023) / 1023;
	return 255 * Math.pow(linear, 1 / GAMMA) * k;
}

/**
 * Builds GDI+'s interpolation table for a ramp and brush rectangle: `N + 1`
 * premultiplied knots at `t = k / N`, rounded half up. Pure.
 */
export function buildLinearRampTable(ramp: EmfPlusLinearRamp, rect: EmfPlusRectF): LinearRampTable {
	const intervals = linearRampIntervals(rampPointCount(ramp), rect);
	const knots = new Uint8Array((intervals + 1) * 4);
	for (let k = 0; k <= intervals; k++) {
		const c = rampColorAt(ramp, k / intervals);
		const o = k * 4;
		for (let ch = 0; ch < 3; ch++) {
			const v = ramp.gammaCorrected ? encode(c[ch], c[3]) : c[ch];
			knots[o + ch] = Math.min(255, Math.max(0, Math.floor(v + 0.5)));
		}
		knots[o + 3] = Math.min(255, Math.max(0, Math.floor(c[3] + 0.5)));
	}
	return { intervals, knots };
}

/**
 * The ramp a linear gradient descriptor carries, or one rebuilt from its
 * plain two-colour `stops` (hand-built descriptors), or `null` when there is
 * nothing GDI+-shaped to rebuild (a descriptor with other stop lists).
 */
export function linearRampOf(grad: EmfPlusLinearGradient): EmfPlusLinearRamp | null {
	if (grad.ramp) {
		return grad.ramp;
	}
	const s = grad.stops;
	if (s.length === 2 && s[0].offset === 0 && s[1].offset === 1 && s[0].argb !== undefined && s[1].argb !== undefined) {
		return { startArgb: s[0].argb, endArgb: s[1].argb, preset: null, blend: null, gammaCorrected: false };
	}
	return null;
}

/** Straight (non-premultiplied) packed ARGB of knot `k`. */
function knotArgb(table: LinearRampTable, k: number): number {
	const o = k * 4;
	const a = table.knots[o + 3];
	if (a === 0) {
		return 0;
	}
	const un = (v: number): number => Math.min(255, Math.round((v * 255) / a));
	return ((a << 24) | (un(table.knots[o]) << 16) | (un(table.knots[o + 1]) << 8) | un(table.knots[o + 2])) >>> 0;
}

/**
 * Canvas/SVG gradient stops reproducing the table: one stop per knot at
 * `k / N`. A Canvas or SVG gradient interpolates between them linearly
 * (premultiplied), just as GDI+ interpolates between its knots.
 */
export function linearRampStops(table: LinearRampTable): EmfPlusGradientStop[] {
	const stops: EmfPlusGradientStop[] = [];
	for (let k = 0; k <= table.intervals; k++) {
		const argb = knotArgb(table, k);
		const a = ((argb >>> 24) & 0xff) / 255;
		stops.push({
			offset: k / table.intervals,
			color: `rgba(${(argb >>> 16) & 0xff},${(argb >>> 8) & 0xff},${argb & 0xff},${Number(a.toFixed(4))})`,
			argb,
		});
	}
	return stops;
}

/** 16.16 fixed-point one. */
const FIX_ONE = 65536;

/**
 * Folds a 16.16 ramp coordinate `U` (in table intervals) into one wrap
 * period per the wrap mode: `[0, N)` intervals for plain repetition, or
 * `[0, 2N)` for TileFlipX/TileFlipXY, whose second half
 * {@link writeRampColor} reads through the mirrored table (a linear
 * gradient varies along its brush x axis only, so TileFlipY alone repeats
 * it unmirrored). Pure.
 */
export function foldRampCoordinate(u: number, intervals: number, wrap: EmfPlusGradientWrapMode): number {
	const period = (wrap === 'tile-flip-x' || wrap === 'tile-flip-xy' ? 2 : 1) * intervals * FIX_ONE;
	return ((u % period) + period) % period;
}

/**
 * Writes the table's colour at folded 16.16 coordinate `u` (see
 * {@link foldRampCoordinate}) into `out` at `o` as straight RGBA. A
 * coordinate in the second (mirrored) period reads knot `2N - j` for knot
 * `j`, the way GDI+ lays a TileFlipX ramp out as one doubled table, and
 * blends it by the same 8 fraction bits (mirroring the coordinate itself
 * instead would round those bits the other way). Pure.
 */
export function writeRampColor(table: LinearRampTable, u: number, out: Uint8ClampedArray, o: number): void {
	const n = table.intervals;
	const k = Math.floor(u / FIX_ONE);
	const f = Math.floor(u / 256) & 0xff;
	const j0 = k <= n ? k : 2 * n - k;
	const j1 = k + 1 <= n ? k + 1 : Math.max(0, 2 * n - k - 1);
	const kn = table.knots;
	const i0 = Math.min(n, j0) * 4;
	const i1 = Math.min(n, j1) * 4;
	const a = (kn[i0 + 3] * (256 - f) + kn[i1 + 3] * f + 128) >> 8;
	if (a === 0) {
		return;
	}
	for (let ch = 0; ch < 3; ch++) {
		const p = (kn[i0 + ch] * (256 - f) + kn[i1 + ch] * f + 128) >> 8;
		out[o + ch] = a === 255 ? p : Math.round((p * 255) / a);
	}
	out[o + 3] = a;
}

/**
 * The per-device-pixel colour of a linear gradient brush, computed exactly
 * as GDI+ rasterises it (see the module doc). `device` is the world-to-device matrix and
 * `halfPixel` is true under a `PixelOffsetMode` that samples pixel centres.
 * Returns a sampler with the {@link DeviceBrushSampler} signature, or `null`
 * for a degenerate brush. Pure apart from writing `out`.
 */
export function linearRampSampler(
	grad: EmfPlusLinearGradient,
	device: TransformMatrix,
	halfPixel: boolean,
): ((x0: number, y0: number, w: number, h: number, out: Uint8ClampedArray) => void) | null {
	const rect = grad.rect;
	const ramp = linearRampOf(grad);
	if (!rect || !ramp || !(Math.abs(rect.w) > 1e-9)) {
		return null;
	}
	const b = grad.transform ?? [1, 0, 0, 1, 0, 0];
	const full: TransformMatrix = [
		device[0] * b[0] + device[2] * b[1],
		device[1] * b[0] + device[3] * b[1],
		device[0] * b[2] + device[2] * b[3],
		device[1] * b[2] + device[3] * b[3],
		device[0] * b[4] + device[2] * b[5] + device[4],
		device[1] * b[4] + device[3] * b[5] + device[5],
	];
	const det = full[0] * full[3] - full[1] * full[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return null;
	}
	// Brush-space x of device point (X, Y): row 0 of the inverse matrix.
	const ia = full[3] / det;
	const ic = -full[2] / det;
	const ie = -(ia * full[4] + ic * full[5]);
	const table = buildLinearRampTable(ramp, rect);
	const n = table.intervals;
	const scale = n / rect.w;
	const off = halfPixel ? 0.5 : 0;
	// GDI+ evaluates the device-to-ramp mapping as a 16.16 fixed-point
	// affine form anchored at device (0, 0): each coefficient is rounded
	// once, so a pixel's coordinate is exact integer arithmetic from there.
	const du = Math.round(ia * scale * FIX_ONE);
	const dv = Math.round(ic * scale * FIX_ONE);
	const u00 = Math.round((ia * off + ic * off + ie - rect.x) * scale * FIX_ONE);
	return (x0, y0, w, h, out) => {
		for (let j = 0; j < h; j++) {
			let u = u00 + x0 * du + (y0 + j) * dv;
			for (let i = 0; i < w; i++, u += du) {
				writeRampColor(table, foldRampCoordinate(u, n, grad.wrapMode), out, (j * w + i) * 4);
			}
		}
	};
}
