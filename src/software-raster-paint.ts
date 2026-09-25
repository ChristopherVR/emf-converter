/**
 * Paint sources and compositing for the pure-JavaScript rasteriser
 * (`software-raster.ts`): CSS colour parsing, Canvas gradients (linear and
 * two-point conical radial, with Canvas's colour-stop and padding rules),
 * patterns (every repetition mode, `setTransform`, nearest or bilinear
 * sampling), and every `globalCompositeOperation` (the Porter-Duff operators
 * plus the separable and non-separable blend modes of the W3C Compositing
 * and Blending specification).
 *
 * Pixels are stored premultiplied, eight bits per channel, like Skia's
 * N32 surfaces; paints produce premultiplied colours in `0..255` floats.
 *
 * @module software-raster-paint
 */

import { invertMatrix, multiplyMatrix, type Matrix } from './canvas-path';

/** Straight (non-premultiplied) colour: r, g, b in 0..255, alpha in 0..1. */
export type Rgba = [number, number, number, number];

const NAMED_COLORS: Record<string, number> = {
	black: 0x000000,
	white: 0xffffff,
	red: 0xff0000,
	lime: 0x00ff00,
	green: 0x008000,
	blue: 0x0000ff,
	yellow: 0xffff00,
	cyan: 0x00ffff,
	aqua: 0x00ffff,
	magenta: 0xff00ff,
	fuchsia: 0xff00ff,
	gray: 0x808080,
	grey: 0x808080,
	silver: 0xc0c0c0,
	maroon: 0x800000,
	olive: 0x808000,
	teal: 0x008080,
	navy: 0x000080,
	purple: 0x800080,
	orange: 0xffa500,
	darkgray: 0xa9a9a9,
	darkgrey: 0xa9a9a9,
	lightgray: 0xd3d3d3,
	lightgrey: 0xd3d3d3,
	dimgray: 0x696969,
	dimgrey: 0x696969,
	whitesmoke: 0xf5f5f5,
	gainsboro: 0xdcdcdc,
};

const colorCache = new Map<string, Rgba | null>();

/**
 * Parses a CSS colour the way the replay code writes them (`#rgb`,
 * `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` with comma or space syntax and
 * optional percentages, `transparent`, and the common named colours).
 * Returns `null` for anything else, which a Canvas setter ignores.
 */
export function parseColor(input: string): Rgba | null {
	const cached = colorCache.get(input);
	if (cached !== undefined) {
		return cached;
	}
	const result = parseColorUncached(input.trim().toLowerCase());
	if (colorCache.size > 4096) {
		colorCache.clear();
	}
	colorCache.set(input, result);
	return result;
}

function parseColorUncached(s: string): Rgba | null {
	if (s === 'transparent') {
		return [0, 0, 0, 0];
	}
	if (s[0] === '#') {
		const h = s.slice(1);
		if (!/^[0-9a-f]+$/.test(h)) {
			return null;
		}
		if (h.length === 3 || h.length === 4) {
			const v = [...h].map((c) => parseInt(c + c, 16));
			return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
		}
		if (h.length === 6 || h.length === 8) {
			return [
				parseInt(h.slice(0, 2), 16),
				parseInt(h.slice(2, 4), 16),
				parseInt(h.slice(4, 6), 16),
				h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
			];
		}
		return null;
	}
	const fn = /^rgba?\(([^)]*)\)$/.exec(s);
	if (fn) {
		const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
		if (parts.length < 3) {
			return null;
		}
		const ch = (v: string): number => {
			const n = v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v);
			return Math.max(0, Math.min(255, Math.round(n)));
		};
		const alpha =
			parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
		const rgb = [ch(parts[0]), ch(parts[1]), ch(parts[2])];
		if (rgb.some((v) => !Number.isFinite(v)) || !Number.isFinite(alpha)) {
			return null;
		}
		return [rgb[0], rgb[1], rgb[2], Math.max(0, Math.min(1, alpha))];
	}
	const named = NAMED_COLORS[s];
	return named === undefined ? null : [(named >> 16) & 255, (named >> 8) & 255, named & 255, 1];
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

interface Stop {
	offset: number;
	color: Rgba;
}

/** A Canvas gradient (`createLinearGradient` / `createRadialGradient`). */
export class SoftwareGradient {
	readonly stops: Stop[] = [];
	private sorted: Stop[] | null = null;

	constructor(
		readonly kind: 'linear' | 'radial',
		/** `[x0, y0, x1, y1]` or `[x0, y0, r0, x1, y1, r1]`, in user space. */
		readonly coords: ReadonlyArray<number>,
	) {}

	addColorStop(offset: number, color: string): void {
		if (!(offset >= 0 && offset <= 1)) {
			throw new RangeError('Gradient stop offset out of range');
		}
		const c = parseColor(color);
		if (!c) {
			throw new SyntaxError(`Invalid colour: ${color}`);
		}
		this.stops.push({ offset, color: c });
		this.sorted = null;
	}

	/** Stops ordered by offset; equal offsets keep insertion order. */
	sortedStops(): Stop[] {
		if (!this.sorted) {
			this.sorted = this.stops
				.map((s, i) => ({ s, i }))
				.sort((a, b) => a.s.offset - b.s.offset || a.i - b.i)
				.map((e) => e.s);
		}
		return this.sorted;
	}
}

/** A Canvas pattern (`createPattern`), holding a premultiplied copy of its image. */
export class SoftwarePattern {
	matrix: Matrix = [1, 0, 0, 1, 0, 0];

	constructor(
		readonly data: Uint8ClampedArray,
		readonly width: number,
		readonly height: number,
		readonly repetition: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat',
	) {}

	setTransform(m?: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }): void {
		const next: Matrix = [m?.a ?? 1, m?.b ?? 0, m?.c ?? 0, m?.d ?? 1, m?.e ?? 0, m?.f ?? 0];
		if (next.every(Number.isFinite)) {
			this.matrix = next;
		}
	}
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * A resolved paint. `solid` is a constant premultiplied colour; otherwise
 * `shade(x, y, out)` writes the premultiplied colour at device pixel
 * (`x`, `y`) (sampled at its centre) into `out[0..3]` and returns `false`
 * where the paint is transparent (outside a non-repeating pattern, or a
 * radial gradient's cone).
 */
export type Shader =
	| { solid: [number, number, number, number] }
	| { solid?: undefined; shade: (x: number, y: number, out: Float64Array) => boolean };

/** Colour of a gradient at parameter `t` (padded), premultiplied, into `out`. */
function gradientColor(stops: Stop[], t: number, out: Float64Array): void {
	let c: Rgba;
	const n = stops.length;
	if (t <= stops[0].offset) {
		c = stops[0].color;
	} else if (t >= stops[n - 1].offset) {
		c = stops[n - 1].color;
	} else {
		// Last stop at or before t; later stops at the same offset win.
		let lo = 0;
		let hi = n - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (stops[mid].offset <= t) {
				lo = mid;
			} else {
				hi = mid;
			}
		}
		const a = stops[lo];
		const b = stops[hi];
		const span = b.offset - a.offset;
		const f = span > 0 ? (t - a.offset) / span : 1;
		const alpha = a.color[3] + (b.color[3] - a.color[3]) * f;
		out[0] = (a.color[0] + (b.color[0] - a.color[0]) * f) * alpha;
		out[1] = (a.color[1] + (b.color[1] - a.color[1]) * f) * alpha;
		out[2] = (a.color[2] + (b.color[2] - a.color[2]) * f) * alpha;
		out[3] = alpha * 255;
		return;
	}
	out[0] = c[0] * c[3];
	out[1] = c[1] * c[3];
	out[2] = c[2] * c[3];
	out[3] = c[3] * 255;
}

function gradientShader(g: SoftwareGradient, fillTransform: Readonly<Matrix>): Shader | null {
	const stops = g.sortedStops();
	const inv = invertMatrix(fillTransform);
	if (stops.length === 0 || !inv) {
		return null;
	}
	const c = g.coords;
	if (g.kind === 'linear') {
		const [x0, y0, x1, y1] = c;
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len2 = dx * dx + dy * dy;
		if (!(len2 > 0)) {
			return null; // Canvas paints nothing for a zero-length linear gradient.
		}
		return {
			shade(x, y, out) {
				const px = x + 0.5;
				const py = y + 0.5;
				const ux = inv[0] * px + inv[2] * py + inv[4];
				const uy = inv[1] * px + inv[3] * py + inv[5];
				gradientColor(stops, ((ux - x0) * dx + (uy - y0) * dy) / len2, out);
				return true;
			},
		};
	}
	const [x0, y0, r0, x1, y1, r1] = c;
	if (x0 === x1 && y0 === y1 && r0 === r1) {
		return null;
	}
	const cdx = x1 - x0;
	const cdy = y1 - y0;
	const dr = r1 - r0;
	const a = cdx * cdx + cdy * cdy - dr * dr;
	return {
		shade(x, y, out) {
			const px = x + 0.5;
			const py = y + 0.5;
			const ux = inv[0] * px + inv[2] * py + inv[4] - x0;
			const uy = inv[1] * px + inv[3] * py + inv[5] - y0;
			// Largest t with r(t) = r0 + t*dr >= 0 and |p - c(t)| = r(t).
			const b = ux * cdx + uy * cdy + r0 * dr;
			const cc = ux * ux + uy * uy - r0 * r0;
			let t: number;
			if (Math.abs(a) < 1e-12) {
				if (Math.abs(b) < 1e-12) {
					return false;
				}
				t = cc / (2 * b);
				if (r0 + t * dr < 0) {
					return false;
				}
			} else {
				const disc = b * b - a * cc;
				if (disc < 0) {
					return false;
				}
				const sq = Math.sqrt(disc);
				const t1 = (b + sq) / a;
				const t2 = (b - sq) / a;
				const hiT = Math.max(t1, t2);
				const loT = Math.min(t1, t2);
				if (r0 + hiT * dr >= 0) {
					t = hiT;
				} else if (r0 + loT * dr >= 0) {
					t = loT;
				} else {
					return false;
				}
			}
			gradientColor(stops, t, out);
			return true;
		},
	};
}

/**
 * Texel sampler over a premultiplied RGBA image. `wrapX`/`wrapY` tile the
 * image on that axis; otherwise coordinates clamp to the rectangle
 * `[minX, maxX) x [minY, maxY)` (a drawImage source rectangle, sampled
 * strictly inside, as Canvas requires) and `outside` decides whether a
 * sample point beyond it is transparent (a non-repeating pattern) or is
 * clamped (drawImage, whose destination quad already bounds it).
 */
export interface Sampler {
	data: Uint8ClampedArray;
	width: number;
	height: number;
	wrapX: boolean;
	wrapY: boolean;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	transparentOutside: boolean;
	smooth: boolean;
}

function wrapIndex(i: number, n: number): number {
	const r = i % n;
	return r < 0 ? r + n : r;
}

/** Samples `s` at image-space point (`u`, `v`) into `out`; `false` when transparent. */
export function sample(s: Sampler, u: number, v: number, out: Float64Array): boolean {
	if (s.transparentOutside) {
		if ((!s.wrapX && (u < s.minX || u >= s.maxX)) || (!s.wrapY && (v < s.minY || v >= s.maxY))) {
			return false;
		}
	}
	const d = s.data;
	const w = s.width;
	const texelX = (i: number): number => (s.wrapX ? wrapIndex(i, w) : Math.min(s.maxX - 1, Math.max(s.minX, i)));
	const texelY = (j: number): number => (s.wrapY ? wrapIndex(j, s.height) : Math.min(s.maxY - 1, Math.max(s.minY, j)));
	if (!s.smooth) {
		const o = (texelY(Math.floor(v)) * w + texelX(Math.floor(u))) * 4;
		out[0] = d[o];
		out[1] = d[o + 1];
		out[2] = d[o + 2];
		out[3] = d[o + 3];
		return true;
	}
	const fu = u - 0.5;
	const fv = v - 0.5;
	const i0 = Math.floor(fu);
	const j0 = Math.floor(fv);
	const tx = fu - i0;
	const ty = fv - j0;
	const xa = texelX(i0);
	const xb = texelX(i0 + 1);
	const ya = texelY(j0) * w;
	const yb = texelY(j0 + 1) * w;
	const o00 = (ya + xa) * 4;
	const o10 = (ya + xb) * 4;
	const o01 = (yb + xa) * 4;
	const o11 = (yb + xb) * 4;
	const w00 = (1 - tx) * (1 - ty);
	const w10 = tx * (1 - ty);
	const w01 = (1 - tx) * ty;
	const w11 = tx * ty;
	for (let c = 0; c < 4; c++) {
		out[c] = d[o00 + c] * w00 + d[o10 + c] * w10 + d[o01 + c] * w01 + d[o11 + c] * w11;
	}
	return true;
}

/** A shader drawing `sampler` through `toDevice` (image space to device space). */
export function imageShader(sampler: Sampler, toDevice: Readonly<Matrix>): Shader | null {
	const inv = invertMatrix(toDevice);
	if (!inv) {
		return null;
	}
	return {
		shade(x, y, out) {
			const px = x + 0.5;
			const py = y + 0.5;
			return sample(sampler, inv[0] * px + inv[2] * py + inv[4], inv[1] * px + inv[3] * py + inv[5], out);
		},
	};
}

/** Resolves a fill/stroke style to a shader under the fill-time transform. */
export function makeShader(
	style: unknown,
	fillTransform: Readonly<Matrix>,
	smoothing: boolean,
): Shader | null {
	if (typeof style === 'string') {
		const c = parseColor(style);
		if (!c) {
			return null;
		}
		return { solid: [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3] * 255] };
	}
	if (style instanceof SoftwareGradient) {
		return gradientShader(style, fillTransform);
	}
	if (style instanceof SoftwarePattern) {
		const rep = style.repetition;
		const wrapX = rep === 'repeat' || rep === 'repeat-x';
		const wrapY = rep === 'repeat' || rep === 'repeat-y';
		return imageShader(
			{
				data: style.data,
				width: style.width,
				height: style.height,
				wrapX,
				wrapY,
				minX: 0,
				minY: 0,
				maxX: style.width,
				maxY: style.height,
				transparentOutside: true,
				smooth: smoothing,
			},
			multiplyMatrix(fillTransform, style.matrix),
		);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

/** Operators that affect the destination OUTSIDE the drawn shape (Canvas treats the source there as transparent). */
export const UNBOUNDED_OPS = new Set(['copy', 'source-in', 'source-out', 'destination-in', 'destination-atop']);

const SEPARABLE: Record<string, (s: number, d: number) => number> = {
	multiply: (s, d) => s * d,
	screen: (s, d) => s + d - s * d,
	overlay: (s, d) => hardLight(d, s),
	darken: (s, d) => Math.min(s, d),
	lighten: (s, d) => Math.max(s, d),
	'color-dodge': (s, d) => (d === 0 ? 0 : s >= 1 ? 1 : Math.min(1, d / (1 - s))),
	'color-burn': (s, d) => (d >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / s)),
	'hard-light': (s, d) => hardLight(s, d),
	'soft-light': (s, d) => {
		if (s <= 0.5) {
			return d - (1 - 2 * s) * d * (1 - d);
		}
		const g = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
		return d + (2 * s - 1) * (g - d);
	},
	difference: (s, d) => Math.abs(s - d),
	exclusion: (s, d) => s + d - 2 * s * d,
};

function hardLight(s: number, d: number): number {
	return s <= 0.5 ? d * 2 * s : SEPARABLE.screen(2 * s - 1, d);
}

function lum(r: number, g: number, b: number): number {
	return 0.3 * r + 0.59 * g + 0.11 * b;
}

function clipColor(c: [number, number, number]): [number, number, number] {
	const l = lum(c[0], c[1], c[2]);
	const n = Math.min(c[0], c[1], c[2]);
	const x = Math.max(c[0], c[1], c[2]);
	let [r, g, b] = c;
	if (n < 0) {
		r = l + ((r - l) * l) / (l - n);
		g = l + ((g - l) * l) / (l - n);
		b = l + ((b - l) * l) / (l - n);
	}
	if (x > 1) {
		r = l + ((r - l) * (1 - l)) / (x - l);
		g = l + ((g - l) * (1 - l)) / (x - l);
		b = l + ((b - l) * (1 - l)) / (x - l);
	}
	return [r, g, b];
}

function setLum(c: [number, number, number], l: number): [number, number, number] {
	const d = l - lum(c[0], c[1], c[2]);
	return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function sat(c: [number, number, number]): number {
	return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

function setSat(c: [number, number, number], s: number): [number, number, number] {
	const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
	const out: [number, number, number] = [0, 0, 0];
	const [lo, mid, hi] = idx;
	if (c[hi] > c[lo]) {
		out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]);
		out[hi] = s;
	}
	return out;
}

const NON_SEPARABLE: Record<string, (s: [number, number, number], d: [number, number, number]) => [number, number, number]> = {
	hue: (s, d) => setLum(setSat(s, sat(d)), lum(d[0], d[1], d[2])),
	saturation: (s, d) => setLum(setSat(d, sat(s)), lum(d[0], d[1], d[2])),
	color: (s, d) => setLum(s, lum(d[0], d[1], d[2])),
	luminosity: (s, d) => setLum(d, lum(s[0], s[1], s[2])),
};

/** True for every `globalCompositeOperation` value this module implements. */
export function isCompositeOp(op: string): boolean {
	return (
		op in SEPARABLE ||
		op in NON_SEPARABLE ||
		[
			'source-over',
			'source-in',
			'source-out',
			'source-atop',
			'destination-over',
			'destination-in',
			'destination-out',
			'destination-atop',
			'xor',
			'copy',
			'lighter',
		].includes(op)
	);
}

/**
 * Composites one premultiplied source colour (`s*` in 0..1, alpha already
 * scaled by `globalAlpha`) onto the premultiplied destination pixel at `di`
 * with operator `op`, then blends that result with the original pixel by
 * `coverage` (0..1), as Skia applies anti-aliased coverage.
 */
export function compositePixel(
	dst: Uint8ClampedArray,
	di: number,
	sr: number,
	sg: number,
	sb: number,
	sa: number,
	coverage: number,
	op: string,
): void {
	const dr = dst[di] / 255;
	const dg = dst[di + 1] / 255;
	const db = dst[di + 2] / 255;
	const da = dst[di + 3] / 255;
	let r: number;
	let g: number;
	let b: number;
	let a: number;
	switch (op) {
		case 'source-over':
			r = sr + dr * (1 - sa);
			g = sg + dg * (1 - sa);
			b = sb + db * (1 - sa);
			a = sa + da * (1 - sa);
			break;
		case 'copy':
			r = sr;
			g = sg;
			b = sb;
			a = sa;
			break;
		case 'destination-over':
			r = sr * (1 - da) + dr;
			g = sg * (1 - da) + dg;
			b = sb * (1 - da) + db;
			a = sa * (1 - da) + da;
			break;
		case 'source-in':
			r = sr * da;
			g = sg * da;
			b = sb * da;
			a = sa * da;
			break;
		case 'destination-in':
			r = dr * sa;
			g = dg * sa;
			b = db * sa;
			a = da * sa;
			break;
		case 'source-out':
			r = sr * (1 - da);
			g = sg * (1 - da);
			b = sb * (1 - da);
			a = sa * (1 - da);
			break;
		case 'destination-out':
			r = dr * (1 - sa);
			g = dg * (1 - sa);
			b = db * (1 - sa);
			a = da * (1 - sa);
			break;
		case 'source-atop':
			r = sr * da + dr * (1 - sa);
			g = sg * da + dg * (1 - sa);
			b = sb * da + db * (1 - sa);
			a = da;
			break;
		case 'destination-atop':
			r = sr * (1 - da) + dr * sa;
			g = sg * (1 - da) + dg * sa;
			b = sb * (1 - da) + db * sa;
			a = sa;
			break;
		case 'xor':
			r = sr * (1 - da) + dr * (1 - sa);
			g = sg * (1 - da) + dg * (1 - sa);
			b = sb * (1 - da) + db * (1 - sa);
			a = sa * (1 - da) + da * (1 - sa);
			break;
		case 'lighter':
			r = Math.min(1, sr + dr);
			g = Math.min(1, sg + dg);
			b = Math.min(1, sb + db);
			a = Math.min(1, sa + da);
			break;
		default: {
			// Blend modes: co = cs(1 - ab) + cb(1 - as) + as*ab*B(Cs, Cb).
			a = sa + da - sa * da;
			const both = sa * da;
			const us = [sa > 0 ? sr / sa : 0, sa > 0 ? sg / sa : 0, sa > 0 ? sb / sa : 0] as [number, number, number];
			const ud = [da > 0 ? dr / da : 0, da > 0 ? dg / da : 0, da > 0 ? db / da : 0] as [number, number, number];
			let mixed: [number, number, number];
			const sepFn = SEPARABLE[op];
			if (sepFn) {
				mixed = [sepFn(us[0], ud[0]), sepFn(us[1], ud[1]), sepFn(us[2], ud[2])];
			} else {
				const nsFn = NON_SEPARABLE[op];
				if (!nsFn) {
					// Unknown operator: Canvas keeps the previous one; treat as source-over.
					compositePixel(dst, di, sr, sg, sb, sa, coverage, 'source-over');
					return;
				}
				mixed = nsFn(us, ud);
			}
			r = sr * (1 - da) + dr * (1 - sa) + both * mixed[0];
			g = sg * (1 - da) + dg * (1 - sa) + both * mixed[1];
			b = sb * (1 - da) + db * (1 - sa) + both * mixed[2];
		}
	}
	if (coverage < 1) {
		r = dr + (r - dr) * coverage;
		g = dg + (g - dg) * coverage;
		b = db + (b - db) * coverage;
		a = da + (a - da) * coverage;
	}
	dst[di] = r * 255;
	dst[di + 1] = g * 255;
	dst[di + 2] = b * 255;
	dst[di + 3] = a * 255;
}
