/**
 * A Canvas-2D-compatible rendering context that records drawing as SVG.
 *
 * The metafile replay code (GDI, EMF+, WMF handlers) is written against the
 * Canvas 2D API. Rather than duplicating hundreds of record handlers for a
 * second output format, the SVG backend implements the subset of that API
 * the replay actually uses and turns each call into SVG elements:
 *
 * - Paths are accumulated in DEVICE space exactly as Canvas does (every
 *   point is mapped through the transform current when it is added; arcs and
 *   ellipses become cubic Beziers, which affine maps carry exactly), so a
 *   fill is emitted as a device-space `<path>` whose paint server (gradient
 *   or pattern) gets the fill-time transform, and a stroke is mapped back
 *   into the stroke-time user space and emitted with that transform, so line
 *   width, dashes and joins scale exactly like Canvas's.
 * - `clip()` becomes a chain of `<clipPath>` elements (each one clipped by
 *   its parent, which is how successive Canvas clips intersect); drawing is
 *   wrapped in a `<g clip-path>` per clip state.
 * - Colours with alpha become `fill-opacity`/`stroke-opacity`;
 *   `globalAlpha` multiplies in; blend-style `globalCompositeOperation`s
 *   (`difference`, `darken`, `lighten`, `multiply`, `screen`, ...) become
 *   `mix-blend-mode`, which is how the approximate ROP2 modes render.
 * - Gradients become `<linearGradient>`/`<radialGradient>`, patterns become
 *   `<pattern>` tiles, text becomes `<text>`, and raster content becomes
 *   `<image>` elements holding PNG data URLs (encoded at the end, see
 *   {@link SvgContext.toTree}).
 *
 * Raster operations that must READ the destination (exact ROP3 blits,
 * exact bitwise ROP2) cannot be expressed in SVG. When a real canvas backend
 * exists, the context mirrors every call onto a hidden "shadow" canvas of
 * the same size, so `getImageData` returns the true destination; a
 * subsequent `putImageData` is emitted as an `<image>` patch holding ONLY
 * the pixels that actually changed (unchanged pixels stay transparent, so
 * the vector content underneath keeps showing through). Without a canvas
 * backend (or with `exactRasterOps: false`) the destination reads back as
 * transparent and callers use their blend-mode approximations instead.
 *
 * @module svg-context
 */

import {
	canvasDrawImage,
	canvasGetImageData,
	canvasPutImageData,
	createImageDataCompat,
	createTempCanvas,
} from './emf-canvas-helpers';
import { encodePng } from './png-encoder';
import { SoftwareRasterCanvas, isSoftwareRaster } from './software-raster';
import { bytesToBase64 } from './svg-tree';
import type { SvgNode } from './svg-tree';
import type { CanvasContext } from './emf-types';

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

function inv(m: Matrix): Matrix | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!det || !Number.isFinite(det)) {
		return null;
	}
	return [
		m[3] / det,
		-m[1] / det,
		-m[2] / det,
		m[0] / det,
		(m[2] * m[5] - m[3] * m[4]) / det,
		(m[1] * m[4] - m[0] * m[5]) / det,
	];
}

function isIdentity(m: Matrix): boolean {
	return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/** Compact number formatting: at most 3 decimals, no trailing zeros, no `-0`. */
export function fmt(n: number): string {
	if (!Number.isFinite(n)) {
		return '0';
	}
	const r = Math.round(n * 1000) / 1000;
	return Object.is(r, -0) ? '0' : String(r);
}

function matrixAttr(m: Matrix): string {
	return `matrix(${m.map(fmt).join(' ')})`;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

interface ParsedColor {
	color: string;
	alpha: number;
}

function hex2(n: number): string {
	return Math.max(0, Math.min(255, Math.round(n)))
		.toString(16)
		.padStart(2, '0');
}

/**
 * Splits a CSS colour into an opaque colour plus an alpha, so the SVG uses
 * `fill-opacity` (understood by every SVG renderer) instead of `rgba()`.
 */
export function parseCssColor(input: string): ParsedColor {
	const s = input.trim();
	if (s === 'transparent') {
		return { color: '#000000', alpha: 0 };
	}
	const m = /^rgba?\(([^)]*)\)$/i.exec(s);
	if (m) {
		const parts = m[1].split(/[\s,/]+/).filter(Boolean);
		const ch = (v: string | undefined): number =>
			v === undefined ? 0 : v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v);
		const a = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
		return {
			color: `#${hex2(ch(parts[0]))}${hex2(ch(parts[1]))}${hex2(ch(parts[2]))}`,
			alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1,
		};
	}
	const h8 = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(s);
	if (h8) {
		return { color: `#${h8[1].toLowerCase()}`, alpha: parseInt(h8[2], 16) / 255 };
	}
	return { color: s.toLowerCase(), alpha: 1 };
}

// ---------------------------------------------------------------------------
// Image payloads
// ---------------------------------------------------------------------------

/** Raster content awaiting encoding into an `<image>` data URL. */
export type ImagePayload =
	| { kind: 'rgba'; data: Uint8ClampedArray; width: number; height: number }
	| { kind: 'encoded'; bytes: Uint8Array; mime: string }
	| { kind: 'url'; url: string };

interface PixelHolder {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

function getWidthHeight(source: unknown): { w: number; h: number } | null {
	const s = source as { width?: unknown; height?: unknown; naturalWidth?: unknown; naturalHeight?: unknown };
	const w = typeof s.naturalWidth === 'number' && s.naturalWidth > 0 ? s.naturalWidth : s.width;
	const h = typeof s.naturalHeight === 'number' && s.naturalHeight > 0 ? s.naturalHeight : s.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Captures a drawable's pixels NOW (Canvas semantics: drawing a canvas copies
 * its current contents; later changes to the source must not leak in).
 */
function snapshotSource(source: unknown): ImagePayload | null {
	if (source instanceof SvgImageSource) {
		return source.payload;
	}
	if (source instanceof SoftwareRasterCanvas) {
		return { kind: 'rgba', data: source.pixels.slice(), width: source.width, height: source.height };
	}
	const size = getWidthHeight(source);
	if (!size) {
		return null;
	}
	const holder = source as Partial<PixelHolder> & { getContext?: (t: '2d') => unknown };
	if (holder.data instanceof Uint8ClampedArray) {
		return { kind: 'rgba', data: holder.data.slice(), width: size.w, height: size.h };
	}
	try {
		if (typeof holder.getContext === 'function') {
			const ctx = holder.getContext('2d') as CanvasContext | null;
			if (ctx && typeof ctx.getImageData === 'function') {
				const img = canvasGetImageData(ctx, 0, 0, size.w, size.h);
				return { kind: 'rgba', data: img.data.slice(), width: size.w, height: size.h };
			}
		}
		// ImageBitmap / decoded image: rasterise through a real scratch canvas.
		const temp = createTempCanvas(size.w, size.h);
		if (temp && !isSoftwareRaster(temp.canvas)) {
			canvasDrawImage(temp.ctx, source as CanvasImageSource, 0, 0, size.w, size.h);
			const img = canvasGetImageData(temp.ctx, 0, 0, size.w, size.h);
			return { kind: 'rgba', data: img.data.slice(), width: size.w, height: size.h };
		}
	} catch {
		/* unreadable source */
	}
	return null;
}

function cropPayload(p: ImagePayload, sx: number, sy: number, sw: number, sh: number): ImagePayload | null {
	if (p.kind !== 'rgba') {
		return p;
	}
	const x0 = Math.max(0, Math.floor(Math.min(sx, sx + sw)));
	const y0 = Math.max(0, Math.floor(Math.min(sy, sy + sh)));
	const x1 = Math.min(p.width, Math.ceil(Math.max(sx, sx + sw)));
	const y1 = Math.min(p.height, Math.ceil(Math.max(sy, sy + sh)));
	const w = x1 - x0;
	const h = y1 - y0;
	if (w <= 0 || h <= 0) {
		return null;
	}
	if (x0 === 0 && y0 === 0 && w === p.width && h === p.height) {
		return p;
	}
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		out.set(p.data.subarray(((y0 + y) * p.width + x0) * 4, ((y0 + y) * p.width + x0 + w) * 4), y * w * 4);
	}
	return { kind: 'rgba', data: out, width: w, height: h };
}

/**
 * An already-encoded image (PNG/JPEG/GIF/WebP bytes, or a nested SVG) that
 * can be passed to `drawImage` on an {@link SvgContext} and is embedded
 * verbatim, with no decode/re-encode round trip.
 */
export class SvgImageSource {
	readonly payload: ImagePayload;
	readonly width: number;
	readonly height: number;
	constructor(payload: ImagePayload, width: number, height: number) {
		this.payload = payload;
		this.width = width;
		this.height = height;
	}
}

// ---------------------------------------------------------------------------
// Paint servers
// ---------------------------------------------------------------------------

let paintUid = 0;

/** Gradient returned by {@link SvgContext.createLinearGradient}/`createRadialGradient`. */
export class SvgGradient {
	readonly uid = ++paintUid;
	readonly stops: Array<{ offset: number; color: string }> = [];
	constructor(
		readonly type: 'linear' | 'radial',
		readonly coords: number[],
		readonly real: CanvasGradient | null,
	) {}
	addColorStop(offset: number, color: string): void {
		if (!(offset >= 0 && offset <= 1)) {
			throw new RangeError('Gradient stop offset out of range');
		}
		this.stops.push({ offset, color });
		this.real?.addColorStop(offset, color);
	}
}

/** Pattern returned by {@link SvgContext.createPattern}. */
export class SvgPattern {
	readonly uid = ++paintUid;
	matrix: Matrix = [...IDENTITY];
	constructor(
		readonly payload: ImagePayload,
		readonly width: number,
		readonly height: number,
		readonly repetition: string,
		readonly real: CanvasPattern | null,
		readonly pixelated: boolean,
	) {}
	setTransform(m?: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number }): void {
		this.matrix = [m?.a ?? 1, m?.b ?? 0, m?.c ?? 0, m?.d ?? 1, m?.e ?? 0, m?.f ?? 0];
		try {
			this.real?.setTransform(m as DOMMatrix2DInit);
		} catch {
			/* shadow backend rejected the matrix */
		}
	}
}

type Paint = string | SvgGradient | SvgPattern;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

type Seg =
	| { t: 'M'; x: number; y: number }
	| { t: 'L'; x: number; y: number }
	| { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
	| { t: 'Z' };

/**
 * Serialises a path compactly: relative commands, implicit command
 * repetition, and coordinates quantised to `1 / 10^decimals` units. Deltas
 * are taken between already-quantised absolute positions, so rounding never
 * accumulates along a long path.
 *
 * @param m        - Optional matrix applied to every point first.
 * @param decimals - Decimal places kept; 2 (1/100 px) for device space.
 */
function pathData(segs: Seg[], m: Matrix | null, decimals = 2): string {
	const q = 10 ** decimals;
	let out = '';
	let lastCmd = '';
	let prevNum = '';
	let cx = 0;
	let cy = 0;
	let sx = 0;
	let sy = 0;
	const quant = (x: number, y: number): [number, number] => {
		const px = m ? m[0] * x + m[2] * y + m[4] : x;
		const py = m ? m[1] * x + m[3] * y + m[5] : y;
		return [Math.round(px * q), Math.round(py * q)];
	};
	const num = (v: number): void => {
		let t = (v / q).toFixed(decimals);
		if (t.includes('.')) {
			t = t.replace(/0+$/, '').replace(/\.$/, '');
		}
		t = t.replace(/^(-?)0\./, '$1.');
		if (t === '-0') {
			t = '0';
		}
		// A separator is only needed when the next token could merge into the
		// previous number: not before '-', and not before '.' when the
		// previous number already has a decimal point.
		if (prevNum && !(t[0] === '-' || (t[0] === '.' && prevNum.includes('.')))) {
			out += ' ';
		}
		out += t;
		prevNum = t;
	};
	const cmd = (c: string): void => {
		if (c !== lastCmd || c === 'm') {
			out += c;
			lastCmd = c;
			prevNum = '';
		}
	};
	for (const s of segs) {
		switch (s.t) {
			case 'M': {
				const [x, y] = quant(s.x, s.y);
				if (out === '') {
					out += 'M';
					prevNum = '';
					num(x);
					num(y);
					// Numbers after an absolute moveto would continue as ABSOLUTE
					// linetos, so the first relative segment must name its command.
					lastCmd = 'M';
				} else {
					cmd('m');
					num(x - cx);
					num(y - cy);
					lastCmd = 'l'; // numbers after a relative moveto continue as relative linetos
				}
				cx = sx = x;
				cy = sy = y;
				break;
			}
			case 'L': {
				const [x, y] = quant(s.x, s.y);
				cmd('l');
				num(x - cx);
				num(y - cy);
				cx = x;
				cy = y;
				break;
			}
			case 'C': {
				const [x1, y1] = quant(s.x1, s.y1);
				const [x2, y2] = quant(s.x2, s.y2);
				const [x, y] = quant(s.x, s.y);
				cmd('c');
				num(x1 - cx);
				num(y1 - cy);
				num(x2 - cx);
				num(y2 - cy);
				num(x - cx);
				num(y - cy);
				cx = x;
				cy = y;
				break;
			}
			case 'Z':
				out += 'z';
				lastCmd = 'z';
				prevNum = '';
				cx = sx;
				cy = sy;
				break;
		}
	}
	return out;
}

/** Decimal places that keep 1/100 device pixel precision in a user space mapped by `m`. */
function userSpaceDecimals(m: Matrix): number {
	const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
	return Math.max(2, Math.min(8, Math.ceil(2 + Math.log10(scale))));
}

/** Flattens a path into closed polygons (for `isPointInPath`). */
function flatten(segs: Seg[]): Array<Array<[number, number]>> {
	const polys: Array<Array<[number, number]>> = [];
	let cur: Array<[number, number]> | null = null;
	let lx = 0;
	let ly = 0;
	for (const s of segs) {
		if (s.t === 'M') {
			cur = [[s.x, s.y]];
			polys.push(cur);
			lx = s.x;
			ly = s.y;
		} else if (s.t === 'L') {
			cur?.push([s.x, s.y]);
			lx = s.x;
			ly = s.y;
		} else if (s.t === 'C') {
			const n = 16;
			for (let i = 1; i <= n; i++) {
				const t = i / n;
				const u = 1 - t;
				cur?.push([
					u * u * u * lx + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
					u * u * u * ly + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y,
				]);
			}
			lx = s.x;
			ly = s.y;
		}
	}
	return polys;
}

function pointInPolys(polys: Array<Array<[number, number]>>, x: number, y: number, rule: CanvasFillRule): boolean {
	let winding = 0;
	let crossings = 0;
	for (const poly of polys) {
		const n = poly.length;
		for (let i = 0; i < n; i++) {
			const [x0, y0] = poly[i];
			const [x1, y1] = poly[(i + 1) % n];
			if (y0 <= y ? y1 > y : y1 <= y) {
				const xi = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
				if (xi > x) {
					crossings++;
					winding += y1 > y0 ? 1 : -1;
				}
			}
		}
	}
	return rule === 'evenodd' ? (crossings & 1) === 1 : winding !== 0;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const BLEND_MODES = new Set([
	'multiply',
	'screen',
	'overlay',
	'darken',
	'lighten',
	'color-dodge',
	'color-burn',
	'hard-light',
	'soft-light',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity',
]);

interface CtxState {
	transform: Matrix;
	fillStyle: Paint;
	strokeStyle: Paint;
	lineWidth: number;
	lineDash: number[];
	lineDashOffset: number;
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	miterLimit: number;
	globalAlpha: number;
	gco: string;
	font: string;
	textAlign: CanvasTextAlign;
	textBaseline: CanvasTextBaseline;
	imageSmoothingEnabled: boolean;
	clipId: string | null;
}

/** Options for constructing an {@link SvgContext}. */
export interface SvgContextOptions {
	/** Prefix for every generated element id (keep unique per page when inlining several SVGs). */
	idPrefix?: string;
	/** Mirror drawing onto a real canvas so destination-reading raster ops stay exact. */
	shadow?: CanvasContext | null;
}

interface PendingImage {
	node: SvgNode;
	payload: ImagePayload;
}

/**
 * The SVG-recording context. Pass it (cast to `CanvasContext`) anywhere the
 * replay expects a 2D context, then call {@link SvgContext.toTree}.
 */
export class SvgContext {
	/** Canvas-like handle (width/height), as `ctx.canvas` is used for surface size. */
	readonly canvas: { width: number; height: number; svgContext: SvgContext };
	/** Hidden raster mirror, when exact destination reads are available. */
	readonly shadow: CanvasContext | null;
	private readonly idPrefix: string;
	private nextId = 0;
	private state: CtxState;
	private stack: CtxState[] = [];
	private path: Seg[] = [];
	/** Current point and subpath start, in DEVICE space. */
	private cur: { x: number; y: number } | null = null;
	private start: { x: number; y: number } | null = null;
	private readonly defs: SvgNode[] = [];
	private readonly defKeys = new Map<string, string>();
	private readonly body: SvgNode[] = [];
	private group: { node: SvgNode; clipId: string } | null = null;
	private readonly images: PendingImage[] = [];
	private measureCtx: CanvasContext | null | undefined;

	constructor(width: number, height: number, options: SvgContextOptions = {}) {
		this.canvas = { width, height, svgContext: this };
		this.shadow = options.shadow ?? null;
		this.idPrefix = options.idPrefix ?? 'emf-';
		this.state = {
			transform: [...IDENTITY],
			fillStyle: '#000000',
			strokeStyle: '#000000',
			lineWidth: 1,
			lineDash: [],
			lineDashOffset: 0,
			lineCap: 'butt',
			lineJoin: 'miter',
			miterLimit: 10,
			globalAlpha: 1,
			gco: 'source-over',
			font: '10px sans-serif',
			textAlign: 'start',
			textBaseline: 'alphabetic',
			imageSmoothingEnabled: true,
			clipId: null,
		};
	}

	/** True when `getImageData` returns the real destination (a shadow canvas exists). */
	get canReadPixels(): boolean {
		return this.shadow !== null;
	}

	private id(kind: string): string {
		return `${this.idPrefix}${kind}${this.nextId++}`;
	}

	// ---- state properties --------------------------------------------------

	get fillStyle(): Paint {
		return this.state.fillStyle;
	}
	set fillStyle(v: Paint) {
		if (typeof v === 'string' || v instanceof SvgGradient || v instanceof SvgPattern) {
			this.state.fillStyle = v;
			this.forwardPaint('fillStyle', v);
		}
	}
	get strokeStyle(): Paint {
		return this.state.strokeStyle;
	}
	set strokeStyle(v: Paint) {
		if (typeof v === 'string' || v instanceof SvgGradient || v instanceof SvgPattern) {
			this.state.strokeStyle = v;
			this.forwardPaint('strokeStyle', v);
		}
	}
	private forwardPaint(key: 'fillStyle' | 'strokeStyle', v: Paint): void {
		if (!this.shadow) {
			return;
		}
		const real = typeof v === 'string' ? v : v.real;
		if (real) {
			(this.shadow as unknown as Record<string, unknown>)[key] = real;
		}
	}
	get lineWidth(): number {
		return this.state.lineWidth;
	}
	set lineWidth(v: number) {
		// Canvas ignores non-positive / non-finite widths.
		if (Number.isFinite(v) && v > 0) {
			this.state.lineWidth = v;
			if (this.shadow) {
				this.shadow.lineWidth = v;
			}
		}
	}
	get lineCap(): CanvasLineCap {
		return this.state.lineCap;
	}
	set lineCap(v: CanvasLineCap) {
		this.state.lineCap = v;
		if (this.shadow) {
			this.shadow.lineCap = v;
		}
	}
	get lineJoin(): CanvasLineJoin {
		return this.state.lineJoin;
	}
	set lineJoin(v: CanvasLineJoin) {
		this.state.lineJoin = v;
		if (this.shadow) {
			this.shadow.lineJoin = v;
		}
	}
	get miterLimit(): number {
		return this.state.miterLimit;
	}
	set miterLimit(v: number) {
		if (Number.isFinite(v) && v > 0) {
			this.state.miterLimit = v;
			if (this.shadow) {
				this.shadow.miterLimit = v;
			}
		}
	}
	get lineDashOffset(): number {
		return this.state.lineDashOffset;
	}
	set lineDashOffset(v: number) {
		if (Number.isFinite(v)) {
			this.state.lineDashOffset = v;
			if (this.shadow) {
				this.shadow.lineDashOffset = v;
			}
		}
	}
	get globalAlpha(): number {
		return this.state.globalAlpha;
	}
	set globalAlpha(v: number) {
		if (Number.isFinite(v) && v >= 0 && v <= 1) {
			this.state.globalAlpha = v;
			if (this.shadow) {
				this.shadow.globalAlpha = v;
			}
		}
	}
	get globalCompositeOperation(): GlobalCompositeOperation {
		return this.state.gco as GlobalCompositeOperation;
	}
	set globalCompositeOperation(v: GlobalCompositeOperation) {
		this.state.gco = v;
		if (this.shadow) {
			this.shadow.globalCompositeOperation = v;
		}
	}
	get font(): string {
		return this.state.font;
	}
	set font(v: string) {
		this.state.font = v;
		if (this.shadow) {
			this.shadow.font = v;
		}
	}
	get textAlign(): CanvasTextAlign {
		return this.state.textAlign;
	}
	set textAlign(v: CanvasTextAlign) {
		this.state.textAlign = v;
		if (this.shadow) {
			this.shadow.textAlign = v;
		}
	}
	get textBaseline(): CanvasTextBaseline {
		return this.state.textBaseline;
	}
	set textBaseline(v: CanvasTextBaseline) {
		this.state.textBaseline = v;
		if (this.shadow) {
			this.shadow.textBaseline = v;
		}
	}
	get imageSmoothingEnabled(): boolean {
		return this.state.imageSmoothingEnabled;
	}
	set imageSmoothingEnabled(v: boolean) {
		this.state.imageSmoothingEnabled = v;
		if (this.shadow) {
			this.shadow.imageSmoothingEnabled = v;
		}
	}

	setLineDash(segments: number[]): void {
		if (!Array.isArray(segments) || segments.some((s) => !Number.isFinite(s) || s < 0)) {
			return;
		}
		this.state.lineDash = segments.length % 2 ? [...segments, ...segments] : [...segments];
		this.shadow?.setLineDash(segments);
	}
	getLineDash(): number[] {
		return [...this.state.lineDash];
	}

	// ---- state stack & transforms -----------------------------------------

	save(): void {
		this.stack.push({
			...this.state,
			transform: [...this.state.transform] as Matrix,
			lineDash: [...this.state.lineDash],
		});
		this.shadow?.save();
	}
	restore(): void {
		const s = this.stack.pop();
		if (s) {
			this.state = s;
		}
		this.shadow?.restore();
	}
	getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
		const [a, b, c, d, e, f] = this.state.transform;
		return { a, b, c, d, e, f };
	}
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		if ([a, b, c, d, e, f].every(Number.isFinite)) {
			this.state.transform = [a, b, c, d, e, f];
		}
		this.shadow?.setTransform(a, b, c, d, e, f);
	}
	resetTransform(): void {
		this.setTransform(1, 0, 0, 1, 0, 0);
	}
	transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		if ([a, b, c, d, e, f].every(Number.isFinite)) {
			this.state.transform = mul(this.state.transform, [a, b, c, d, e, f]);
		}
		this.shadow?.transform(a, b, c, d, e, f);
	}
	translate(x: number, y: number): void {
		this.transform(1, 0, 0, 1, x, y);
	}
	scale(x: number, y: number): void {
		this.transform(x, 0, 0, y, 0, 0);
	}
	rotate(angle: number): void {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		this.transform(c, s, -s, c, 0, 0);
	}

	// ---- path construction -----------------------------------------------

	private map(x: number, y: number): { x: number; y: number } {
		const m = this.state.transform;
		return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
	}

	beginPath(): void {
		this.path = [];
		this.cur = null;
		this.start = null;
		this.shadow?.beginPath();
	}
	private moveDevice(p: { x: number; y: number }): void {
		this.path.push({ t: 'M', x: p.x, y: p.y });
		this.cur = p;
		this.start = p;
	}
	private lineDevice(p: { x: number; y: number }): void {
		if (!this.cur) {
			this.moveDevice(p);
			return;
		}
		this.path.push({ t: 'L', x: p.x, y: p.y });
		this.cur = p;
	}
	moveTo(x: number, y: number): void {
		if (Number.isFinite(x) && Number.isFinite(y)) {
			this.moveDevice(this.map(x, y));
		}
		this.shadow?.moveTo(x, y);
	}
	lineTo(x: number, y: number): void {
		if (Number.isFinite(x) && Number.isFinite(y)) {
			this.lineDevice(this.map(x, y));
		}
		this.shadow?.lineTo(x, y);
	}
	private curveUser(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		const p1 = this.map(x1, y1);
		const p2 = this.map(x2, y2);
		const p = this.map(x, y);
		if (!this.cur) {
			this.moveDevice(p1);
		}
		this.path.push({ t: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
		this.cur = p;
	}
	bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		if ([x1, y1, x2, y2, x, y].every(Number.isFinite)) {
			this.curveUser(x1, y1, x2, y2, x, y);
		}
		this.shadow?.bezierCurveTo(x1, y1, x2, y2, x, y);
	}
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
		if ([cx, cy, x, y].every(Number.isFinite)) {
			const m = this.state.transform;
			const i = inv(m);
			const p0 = this.cur && i ? { x: i[0] * this.cur.x + i[2] * this.cur.y + i[4], y: i[1] * this.cur.x + i[3] * this.cur.y + i[5] } : { x: cx, y: cy };
			this.curveUser(
				p0.x + (2 / 3) * (cx - p0.x),
				p0.y + (2 / 3) * (cy - p0.y),
				x + (2 / 3) * (cx - x),
				y + (2 / 3) * (cy - y),
				x,
				y,
			);
		}
		this.shadow?.quadraticCurveTo(cx, cy, x, y);
	}
	closePath(): void {
		if (this.cur) {
			this.path.push({ t: 'Z' });
			this.cur = this.start;
		}
		this.shadow?.closePath();
	}
	rect(x: number, y: number, w: number, h: number): void {
		if ([x, y, w, h].every(Number.isFinite)) {
			this.moveDevice(this.map(x, y));
			this.lineDevice(this.map(x + w, y));
			this.lineDevice(this.map(x + w, y + h));
			this.lineDevice(this.map(x, y + h));
			this.path.push({ t: 'Z' });
			this.moveDevice(this.map(x, y));
		}
		this.shadow?.rect(x, y, w, h);
	}

	/** Appends an elliptical arc as cubic Beziers (user space, then mapped). */
	private ellipseUser(
		cx: number,
		cy: number,
		rx: number,
		ry: number,
		rotation: number,
		startAngle: number,
		endAngle: number,
		ccw: boolean,
	): void {
		const TAU = Math.PI * 2;
		let sweep = endAngle - startAngle;
		if (!ccw) {
			sweep = sweep >= TAU ? TAU : ((sweep % TAU) + TAU) % TAU;
		} else {
			sweep = -sweep >= TAU ? -TAU : -((((-sweep) % TAU) + TAU) % TAU);
		}
		const cosR = Math.cos(rotation);
		const sinR = Math.sin(rotation);
		const pt = (t: number): { x: number; y: number } => {
			const ex = rx * Math.cos(t);
			const ey = ry * Math.sin(t);
			return { x: cx + ex * cosR - ey * sinR, y: cy + ex * sinR + ey * cosR };
		};
		const deriv = (t: number): { x: number; y: number } => {
			const ex = -rx * Math.sin(t);
			const ey = ry * Math.cos(t);
			return { x: ex * cosR - ey * sinR, y: ex * sinR + ey * cosR };
		};
		const first = this.map(pt(startAngle).x, pt(startAngle).y);
		this.lineDevice(first);
		if (sweep === 0) {
			return;
		}
		const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
		const step = sweep / n;
		const k = (4 / 3) * Math.tan(step / 4);
		for (let i = 0; i < n; i++) {
			const t0 = startAngle + i * step;
			const t1 = t0 + step;
			const p0 = pt(t0);
			const p1 = pt(t1);
			const d0 = deriv(t0);
			const d1 = deriv(t1);
			this.curveUser(p0.x + k * d0.x, p0.y + k * d0.y, p1.x - k * d1.x, p1.y - k * d1.y, p1.x, p1.y);
		}
	}
	ellipse(
		x: number,
		y: number,
		rx: number,
		ry: number,
		rotation: number,
		startAngle: number,
		endAngle: number,
		counterclockwise = false,
	): void {
		if (rx < 0 || ry < 0) {
			throw new RangeError('The radii provided are negative');
		}
		if ([x, y, rx, ry, rotation, startAngle, endAngle].every(Number.isFinite)) {
			this.ellipseUser(x, y, rx, ry, rotation, startAngle, endAngle, counterclockwise);
		}
		this.shadow?.ellipse(x, y, rx, ry, rotation, startAngle, endAngle, counterclockwise);
	}
	arc(x: number, y: number, r: number, startAngle: number, endAngle: number, counterclockwise = false): void {
		if (r < 0) {
			throw new RangeError('The radius provided is negative');
		}
		if ([x, y, r, startAngle, endAngle].every(Number.isFinite)) {
			this.ellipseUser(x, y, r, r, 0, startAngle, endAngle, counterclockwise);
		}
		this.shadow?.arc(x, y, r, startAngle, endAngle, counterclockwise);
	}
	arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
		this.shadow?.arcTo(x1, y1, x2, y2, r);
		if (![x1, y1, x2, y2, r].every(Number.isFinite)) {
			return;
		}
		if (!this.cur) {
			this.moveDevice(this.map(x1, y1));
			return;
		}
		const i = inv(this.state.transform);
		if (!i) {
			return;
		}
		const x0 = i[0] * this.cur.x + i[2] * this.cur.y + i[4];
		const y0 = i[1] * this.cur.x + i[3] * this.cur.y + i[5];
		const v1x = x0 - x1;
		const v1y = y0 - y1;
		const v2x = x2 - x1;
		const v2y = y2 - y1;
		const l1 = Math.hypot(v1x, v1y);
		const l2 = Math.hypot(v2x, v2y);
		const cross = v1x * v2y - v1y * v2x;
		if (r === 0 || l1 === 0 || l2 === 0 || Math.abs(cross) < 1e-12 * l1 * l2) {
			this.lineDevice(this.map(x1, y1));
			return;
		}
		const u1x = v1x / l1;
		const u1y = v1y / l1;
		const u2x = v2x / l2;
		const u2y = v2y / l2;
		const theta = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)));
		const dist = r / Math.tan(theta / 2);
		const t1 = { x: x1 + u1x * dist, y: y1 + u1y * dist };
		const t2 = { x: x1 + u2x * dist, y: y1 + u2y * dist };
		const bx = u1x + u2x;
		const by = u1y + u2y;
		const bl = Math.hypot(bx, by);
		const cd = r / Math.sin(theta / 2);
		const c = { x: x1 + (bx / bl) * cd, y: y1 + (by / bl) * cd };
		const a1 = Math.atan2(t1.y - c.y, t1.x - c.x);
		const a2 = Math.atan2(t2.y - c.y, t2.x - c.x);
		let delta = a2 - a1;
		while (delta > Math.PI) {
			delta -= 2 * Math.PI;
		}
		while (delta <= -Math.PI) {
			delta += 2 * Math.PI;
		}
		this.ellipseUser(c.x, c.y, r, r, 0, a1, a1 + delta, delta < 0);
	}

	isPointInPath(x: number, y: number, fillRule: CanvasFillRule = 'nonzero'): boolean {
		if (this.shadow && typeof this.shadow.isPointInPath === 'function') {
			return this.shadow.isPointInPath(x, y, fillRule);
		}
		return pointInPolys(flatten(this.path), x, y, fillRule);
	}

	// ---- emission --------------------------------------------------------

	/** Appends a drawn element to the body, inside a group for the active clip. */
	private emit(node: SvgNode): void {
		const clipId = this.state.clipId;
		if (!clipId) {
			this.body.push(node);
			this.group = null;
			return;
		}
		if (!this.group || this.group.clipId !== clipId || this.body[this.body.length - 1] !== this.group.node) {
			this.group = { node: { tag: 'g', attrs: { 'clip-path': `url(#${clipId})` }, children: [] }, clipId };
			this.body.push(this.group.node);
		}
		this.group.node.children!.push(node);
	}

	private blendStyle(attrs: SvgNode['attrs']): void {
		if (BLEND_MODES.has(this.state.gco)) {
			attrs.style = `mix-blend-mode:${this.state.gco}`;
		}
	}

	private define(key: string, kind: string, build: (id: string) => SvgNode): string {
		const existing = this.defKeys.get(key);
		if (existing) {
			return existing;
		}
		const id = this.id(kind);
		this.defKeys.set(key, id);
		this.defs.push(build(id));
		return id;
	}

	/** Resolves a paint to an SVG paint + opacity, in the user space `space`. */
	private resolvePaint(paint: Paint, space: Matrix): { value: string; opacity: number } | null {
		const alpha = this.state.globalAlpha;
		if (typeof paint === 'string') {
			const c = parseCssColor(paint);
			const opacity = c.alpha * alpha;
			return opacity <= 0 ? null : { value: c.color, opacity };
		}
		if (alpha <= 0) {
			return null;
		}
		if (paint instanceof SvgGradient) {
			if (paint.stops.length === 0) {
				return null;
			}
			const key = `g${paint.uid}:${paint.stops.length}:${space.join(',')}`;
			const id = this.define(key, 'g', (gid) => this.gradientNode(paint, gid, space));
			return { value: `url(#${id})`, opacity: alpha };
		}
		const key = `p${paint.uid}:${paint.matrix.join(',')}:${space.join(',')}`;
		const id = this.define(key, 'p', (pid) => this.patternNode(paint, pid, space));
		return { value: `url(#${id})`, opacity: alpha };
	}

	private gradientNode(g: SvgGradient, id: string, space: Matrix): SvgNode {
		const c = g.coords;
		const attrs: SvgNode['attrs'] =
			g.type === 'linear'
				? { id, gradientUnits: 'userSpaceOnUse', x1: fmt(c[0]), y1: fmt(c[1]), x2: fmt(c[2]), y2: fmt(c[3]) }
				: {
						id,
						gradientUnits: 'userSpaceOnUse',
						fx: fmt(c[0]),
						fy: fmt(c[1]),
						fr: fmt(c[2]),
						cx: fmt(c[3]),
						cy: fmt(c[4]),
						r: fmt(c[5]),
					};
		if (!isIdentity(space)) {
			attrs.gradientTransform = matrixAttr(space);
		}
		const stops = [...g.stops]
			.map((s, i) => ({ ...s, i }))
			.sort((a, b) => a.offset - b.offset || a.i - b.i)
			.map((s) => {
				const col = parseCssColor(s.color);
				const sa: SvgNode['attrs'] = { offset: String(Math.round(s.offset * 1e6) / 1e6), 'stop-color': col.color };
				if (col.alpha < 1) {
					sa['stop-opacity'] = fmt(col.alpha);
				}
				return { tag: 'stop', attrs: sa };
			});
		return { tag: g.type === 'linear' ? 'linearGradient' : 'radialGradient', attrs, children: stops };
	}

	private patternNode(p: SvgPattern, id: string, space: Matrix): SvgNode {
		const m = mul(space, p.matrix);
		// 'no-repeat' has no SVG equivalent: stretch the tile period beyond
		// the visible surface (in pattern space) so only the copy at the
		// origin can show. Kept tight, since renderers reject huge tiles.
		let spanU = p.width;
		let spanV = p.height;
		const im = inv(m);
		if (im) {
			const { width: cw, height: ch } = this.canvas;
			for (const [x, y] of [
				[0, 0],
				[cw, 0],
				[0, ch],
				[cw, ch],
			]) {
				spanU = Math.max(spanU, Math.abs(im[0] * x + im[2] * y + im[4]));
				spanV = Math.max(spanV, Math.abs(im[1] * x + im[3] * y + im[5]));
			}
		}
		const tw = p.repetition === 'repeat' || p.repetition === 'repeat-x' ? p.width : Math.ceil(2 * (spanU + p.width) + 1);
		const th = p.repetition === 'repeat' || p.repetition === 'repeat-y' ? p.height : Math.ceil(2 * (spanV + p.height) + 1);
		const attrs: SvgNode['attrs'] = {
			id,
			patternUnits: 'userSpaceOnUse',
			width: fmt(tw),
			height: fmt(th),
		};
		if (!isIdentity(m)) {
			attrs.patternTransform = matrixAttr(m);
		}
		const image = this.imageNode(p.payload, 0, 0, p.width, p.height, p.pixelated);
		return { tag: 'pattern', attrs, children: [image] };
	}

	private imageNode(
		payload: ImagePayload,
		x: number,
		y: number,
		w: number,
		h: number,
		pixelated: boolean,
	): SvgNode {
		const attrs: SvgNode['attrs'] = {
			x: fmt(x),
			y: fmt(y),
			width: fmt(w),
			height: fmt(h),
			preserveAspectRatio: 'none',
		};
		if (pixelated) {
			attrs['image-rendering'] = 'optimizeSpeed';
			attrs.style = 'image-rendering:pixelated';
		}
		const node: SvgNode = { tag: 'image', attrs };
		this.images.push({ node, payload });
		return node;
	}

	private fillPath(segs: Seg[], fillRule: CanvasFillRule): void {
		if (segs.length === 0) {
			return;
		}
		const paint = this.resolvePaint(this.state.fillStyle, this.state.transform);
		if (!paint) {
			return;
		}
		const attrs: SvgNode['attrs'] = { d: pathData(segs, null), fill: paint.value };
		if (paint.opacity < 1) {
			attrs['fill-opacity'] = fmt(paint.opacity);
		}
		if (fillRule === 'evenodd') {
			attrs['fill-rule'] = 'evenodd';
		}
		this.blendStyle(attrs);
		this.emit({ tag: 'path', attrs });
	}

	private strokePath(segs: Seg[]): void {
		if (segs.length === 0) {
			return;
		}
		const m = this.state.transform;
		const i = inv(m);
		if (!i) {
			return;
		}
		const paint = this.resolvePaint(this.state.strokeStyle, IDENTITY);
		if (!paint) {
			return;
		}
		const s = this.state;
		const attrs: SvgNode['attrs'] = {
			d: pathData(segs, isIdentity(m) ? null : i, isIdentity(m) ? 2 : userSpaceDecimals(m)),
			fill: 'none',
			stroke: paint.value,
		};
		if (paint.opacity < 1) {
			attrs['stroke-opacity'] = fmt(paint.opacity);
		}
		if (s.lineWidth !== 1) {
			attrs['stroke-width'] = fmt(s.lineWidth);
		}
		if (s.lineCap !== 'butt') {
			attrs['stroke-linecap'] = s.lineCap;
		}
		if (s.lineJoin !== 'miter') {
			attrs['stroke-linejoin'] = s.lineJoin;
		} else {
			// Canvas defaults to 10, SVG to 4.
			attrs['stroke-miterlimit'] = fmt(s.miterLimit);
		}
		if (s.lineDash.length) {
			attrs['stroke-dasharray'] = s.lineDash.map(fmt).join(' ');
			if (s.lineDashOffset) {
				attrs['stroke-dashoffset'] = fmt(s.lineDashOffset);
			}
		}
		if (!isIdentity(m)) {
			attrs.transform = matrixAttr(m);
		}
		this.blendStyle(attrs);
		this.emit({ tag: 'path', attrs });
	}

	fill(fillRule: CanvasFillRule = 'nonzero'): void {
		this.fillPath(this.path, fillRule);
		this.shadow?.fill(fillRule);
	}
	stroke(): void {
		this.strokePath(this.path);
		this.shadow?.stroke();
	}
	private rectSegs(x: number, y: number, w: number, h: number): Seg[] {
		const p = [this.map(x, y), this.map(x + w, y), this.map(x + w, y + h), this.map(x, y + h)];
		return [
			{ t: 'M', x: p[0].x, y: p[0].y },
			{ t: 'L', x: p[1].x, y: p[1].y },
			{ t: 'L', x: p[2].x, y: p[2].y },
			{ t: 'L', x: p[3].x, y: p[3].y },
			{ t: 'Z' },
		];
	}
	fillRect(x: number, y: number, w: number, h: number): void {
		if ([x, y, w, h].every(Number.isFinite) && w !== 0 && h !== 0) {
			this.fillPath(this.rectSegs(x, y, w, h), 'nonzero');
		}
		this.shadow?.fillRect(x, y, w, h);
	}
	strokeRect(x: number, y: number, w: number, h: number): void {
		if ([x, y, w, h].every(Number.isFinite)) {
			this.strokePath(this.rectSegs(x, y, w, h));
		}
		this.shadow?.strokeRect(x, y, w, h);
	}
	clearRect(x: number, y: number, w: number, h: number): void {
		// SVG cannot erase what is already painted; only the shadow is cleared.
		this.shadow?.clearRect(x, y, w, h);
	}

	clip(fillRule: CanvasFillRule = 'nonzero'): void {
		const parent = this.state.clipId;
		const id = this.id('c');
		const attrs: SvgNode['attrs'] = { id };
		if (parent) {
			attrs['clip-path'] = `url(#${parent})`;
		}
		const pathAttrs: SvgNode['attrs'] = { d: pathData(this.path, null) || 'M0 0' };
		if (fillRule === 'evenodd') {
			pathAttrs['clip-rule'] = 'evenodd';
		}
		this.defs.push({ tag: 'clipPath', attrs, children: [{ tag: 'path', attrs: pathAttrs }] });
		this.state.clipId = id;
		this.shadow?.clip(fillRule);
	}

	// ---- gradients & patterns -------------------------------------------

	createLinearGradient(x0: number, y0: number, x1: number, y1: number): SvgGradient {
		const real = this.shadow ? this.shadow.createLinearGradient(x0, y0, x1, y1) : null;
		return new SvgGradient('linear', [x0, y0, x1, y1], real);
	}
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): SvgGradient {
		const real = this.shadow ? this.shadow.createRadialGradient(x0, y0, r0, x1, y1, r1) : null;
		return new SvgGradient('radial', [x0, y0, r0, x1, y1, r1], real);
	}
	createPattern(image: unknown, repetition: string | null): SvgPattern | null {
		const payload = snapshotSource(image);
		const size = getWidthHeight(image);
		if (!payload || !size) {
			return null;
		}
		let real: CanvasPattern | null = null;
		if (this.shadow && !isSoftwareRaster(image) && !(image instanceof SvgImageSource)) {
			try {
				real = (this.shadow.createPattern as unknown as (i: unknown, r: string) => CanvasPattern | null).call(
					this.shadow,
					image,
					repetition ?? 'repeat',
				);
			} catch {
				real = null;
			}
		}
		return new SvgPattern(payload, size.w, size.h, repetition || 'repeat', real, !this.state.imageSmoothingEnabled);
	}

	/**
	 * Fills the current path with a repeating tile whose texel (0,0) sits at
	 * device (`originX`, `originY`) and each texel spans `cellW`×`cellH`
	 * device pixels, rendered without filtering. This is how a GDI hatch/
	 * mono/DIB pattern brush fill is expressed natively in SVG (where the
	 * raster path instead writes every covered pixel).
	 */
	fillWithTile(
		tile: { width: number; height: number; rgba: Uint8ClampedArray },
		originX: number,
		originY: number,
		cellW: number,
		cellH: number,
		fillRule: CanvasFillRule,
	): void {
		const pattern = new SvgPattern(
			{ kind: 'rgba', data: tile.rgba, width: tile.width, height: tile.height },
			tile.width,
			tile.height,
			'repeat',
			null,
			true,
		);
		pattern.matrix = [cellW, 0, 0, cellH, originX, originY];
		const saved = this.state.fillStyle;
		const savedT = this.state.transform;
		this.state.fillStyle = pattern;
		this.state.transform = [...IDENTITY];
		this.fillPath(this.path, fillRule);
		this.state.fillStyle = saved;
		this.state.transform = savedT;
		if (this.shadow) {
			// Keep the destination mirror in step with a plain pixel fill.
			const temp = createTempCanvas(tile.width, tile.height);
			if (temp && !isSoftwareRaster(temp.canvas)) {
				canvasPutImageData(temp.ctx, createImageDataCompat(tile.rgba, tile.width, tile.height), 0, 0);
				const real = (this.shadow.createPattern as unknown as (i: unknown, r: string) => CanvasPattern | null).call(
					this.shadow,
					temp.canvas,
					'repeat',
				);
				if (real) {
					real.setTransform({ a: cellW, b: 0, c: 0, d: cellH, e: originX, f: originY });
					this.shadow.save();
					this.shadow.setTransform(1, 0, 0, 1, 0, 0);
					this.shadow.fillStyle = real;
					this.shadow.fill(fillRule);
					this.shadow.restore();
				}
			}
		}
	}

	// ---- text ---------------------------------------------------------------

	private measurer(): CanvasContext | null {
		if (this.measureCtx === undefined) {
			const temp = createTempCanvas(1, 1);
			this.measureCtx = temp && !isSoftwareRaster(temp.canvas) ? temp.ctx : null;
		}
		return this.measureCtx;
	}

	measureText(text: string): TextMetrics {
		const real = this.shadow ?? this.measurer();
		if (real) {
			real.font = this.state.font;
			return real.measureText(text) as TextMetrics;
		}
		const size = parseFont(this.state.font).size;
		return { width: estimateTextWidth(text, size) } as TextMetrics;
	}

	fillText(text: string, x: number, y: number, maxWidth?: number): void {
		this.shadow?.fillText(text, x, y, maxWidth as number);
		if (!text || ![x, y].every(Number.isFinite)) {
			return;
		}
		const paint = this.resolvePaint(this.state.fillStyle, IDENTITY);
		if (!paint) {
			return;
		}
		const font = parseFont(this.state.font);
		const attrs: SvgNode['attrs'] = { x: fmt(x), y: fmt(y) };
		const m = this.state.transform;
		if (!isIdentity(m)) {
			attrs.transform = matrixAttr(m);
		}
		attrs['font-family'] = font.family;
		attrs['font-size'] = fmt(font.size);
		if (font.weight) {
			attrs['font-weight'] = font.weight;
		}
		if (font.style) {
			attrs['font-style'] = font.style;
		}
		const anchor = { center: 'middle', right: 'end', end: 'end' }[this.state.textAlign as string];
		if (anchor) {
			attrs['text-anchor'] = anchor;
		}
		const baseline = {
			top: 'text-before-edge',
			hanging: 'hanging',
			middle: 'central',
			bottom: 'text-after-edge',
			ideographic: 'ideographic',
		}[this.state.textBaseline as string];
		if (baseline) {
			attrs['dominant-baseline'] = baseline;
		}
		attrs.fill = paint.value;
		if (paint.opacity < 1) {
			attrs['fill-opacity'] = fmt(paint.opacity);
		}
		if (maxWidth !== undefined && Number.isFinite(maxWidth) && maxWidth > 0) {
			const w = this.measureText(text).width;
			if (w > maxWidth) {
				attrs.textLength = fmt(maxWidth);
				attrs.lengthAdjust = 'spacingAndGlyphs';
			}
		}
		if (/^\s|\s$|\s\s/.test(text)) {
			attrs['xml:space'] = 'preserve';
		}
		this.blendStyle(attrs);
		this.emit({ tag: 'text', attrs, text });
	}

	// ---- images & pixels -------------------------------------------------

	drawImage(image: unknown, ...args: number[]): void {
		if (this.shadow && !isSoftwareRaster(image) && !(image instanceof SvgImageSource)) {
			try {
				(this.shadow.drawImage as unknown as (...a: unknown[]) => void).call(this.shadow, image, ...args);
			} catch {
				/* shadow could not draw this source */
			}
		} else if (this.shadow && isSoftwareRaster(image)) {
			this.mirrorSoftwareDraw(image as SoftwareRasterCanvas, args);
		}
		let payload = snapshotSource(image);
		const size = getWidthHeight(image);
		if (!payload || !size) {
			return;
		}
		let dx: number;
		let dy: number;
		let dw: number;
		let dh: number;
		if (args.length >= 8) {
			const [sx, sy, sw, sh] = args;
			[, , , , dx, dy, dw, dh] = args;
			const cropped = cropPayload(payload, sx, sy, sw, sh);
			if (!cropped) {
				return;
			}
			payload = cropped;
		} else if (args.length >= 4) {
			[dx, dy, dw, dh] = args;
		} else {
			[dx, dy] = args;
			dw = size.w;
			dh = size.h;
		}
		if (![dx, dy, dw, dh].every(Number.isFinite) || dw === 0 || dh === 0 || this.state.globalAlpha <= 0) {
			return;
		}
		const node = this.imageNode(payload, dx, dy, dw, dh, !this.state.imageSmoothingEnabled);
		const m = this.state.transform;
		if (!isIdentity(m)) {
			node.attrs.transform = matrixAttr(m);
		}
		if (this.state.globalAlpha < 1) {
			node.attrs.opacity = fmt(this.state.globalAlpha);
		}
		if (BLEND_MODES.has(this.state.gco)) {
			node.attrs.style = `${node.attrs.style ? `${node.attrs.style};` : ''}mix-blend-mode:${this.state.gco}`;
		}
		this.emit(node);
	}

	/** Copies a software-raster draw onto the shadow through a real scratch canvas. */
	private mirrorSoftwareDraw(image: SoftwareRasterCanvas, args: number[]): void {
		const temp = createTempCanvas(image.width, image.height);
		if (!temp || isSoftwareRaster(temp.canvas) || !this.shadow) {
			return;
		}
		canvasPutImageData(temp.ctx, createImageDataCompat(image.pixels.slice(), image.width, image.height), 0, 0);
		(this.shadow.drawImage as unknown as (...a: unknown[]) => void).call(this.shadow, temp.canvas, ...args);
	}

	getImageData(x: number, y: number, w: number, h: number): ImageData {
		if (this.shadow) {
			return canvasGetImageData(this.shadow, x, y, w, h);
		}
		return createImageDataCompat(new Uint8ClampedArray(Math.max(0, w * h * 4)), w, h);
	}

	/**
	 * Writes pixels (ignoring transform, clip and compositing, like Canvas),
	 * emitting only the pixels that differ from what is already there.
	 */
	putImageData(image: ImageData, x: number, y: number): void {
		const dx = Math.round(x);
		const dy = Math.round(y);
		const { width: w, height: h, data } = image;
		const before = this.shadow ? canvasGetImageData(this.shadow, dx, dy, w, h).data : null;
		let minX = w;
		let minY = h;
		let maxX = -1;
		let maxY = -1;
		const changed = new Uint8Array(w * h);
		for (let py = 0; py < h; py++) {
			const ty = dy + py;
			if (ty < 0 || ty >= this.canvas.height) {
				continue;
			}
			for (let px = 0; px < w; px++) {
				const tx = dx + px;
				if (tx < 0 || tx >= this.canvas.width) {
					continue;
				}
				const i = (py * w + px) * 4;
				const differs = before
					? data[i] !== before[i] ||
						data[i + 1] !== before[i + 1] ||
						data[i + 2] !== before[i + 2] ||
						data[i + 3] !== before[i + 3]
					: data[i + 3] !== 0;
				if (differs) {
					changed[py * w + px] = 1;
					if (px < minX) minX = px;
					if (px > maxX) maxX = px;
					if (py < minY) minY = py;
					if (py > maxY) maxY = py;
				}
			}
		}
		if (this.shadow) {
			canvasPutImageData(this.shadow, image, dx, dy);
		}
		if (maxX < 0) {
			return;
		}
		const pw = maxX - minX + 1;
		const ph = maxY - minY + 1;
		const patch = new Uint8ClampedArray(pw * ph * 4);
		for (let py = 0; py < ph; py++) {
			for (let px = 0; px < pw; px++) {
				const si = (minY + py) * w + (minX + px);
				if (!changed[si]) {
					continue;
				}
				const o = (py * pw + px) * 4;
				patch[o] = data[si * 4];
				patch[o + 1] = data[si * 4 + 1];
				patch[o + 2] = data[si * 4 + 2];
				patch[o + 3] = data[si * 4 + 3];
			}
		}
		const node = this.imageNode(
			{ kind: 'rgba', data: patch, width: pw, height: ph },
			dx + minX,
			dy + minY,
			pw,
			ph,
			true,
		);
		// putImageData ignores the clip: emit outside any clip group.
		this.body.push(node);
		this.group = null;
	}

	/**
	 * Reserves a placeholder at the current paint position (and clip), for
	 * an image whose content is only available after async decoding. Keeps
	 * the image in its true z-order instead of painting it on top of
	 * everything recorded after it.
	 */
	reserveSlot(): SvgNode {
		const slot: SvgNode = { tag: 'g', attrs: {}, children: [] };
		this.emit(slot);
		return slot;
	}

	/** Fills a slot from {@link reserveSlot} with an image under `transform`. */
	fillSlot(
		slot: SvgNode,
		payload: ImagePayload,
		transform: Matrix,
		dx: number,
		dy: number,
		dw: number,
		dh: number,
	): void {
		const node = this.imageNode(payload, dx, dy, dw, dh, false);
		if (!isIdentity(transform)) {
			node.attrs.transform = matrixAttr(transform);
		}
		slot.children!.push(node);
	}

	/**
	 * Fills a slot with the source rectangle (`sx`,`sy`,`sw`,`sh`, in image
	 * pixels) of an image whose pixel coordinates `toDevice` maps to the
	 * device: the image is laid out at its natural size in pixel space and
	 * clipped to the source rectangle, so crops, rotation and shear are all
	 * carried by one exact affine transform.
	 */
	fillSlotCropped(
		slot: SvgNode,
		payload: ImagePayload,
		toDevice: Matrix,
		natural: { w: number; h: number },
		sx: number,
		sy: number,
		sw: number,
		sh: number,
	): void {
		const image = this.imageNode(payload, 0, 0, natural.w, natural.h, false);
		const fullImage = sx <= 0 && sy <= 0 && sx + sw >= natural.w && sy + sh >= natural.h;
		const group: SvgNode = { tag: 'g', attrs: {}, children: [image] };
		if (!isIdentity(toDevice)) {
			group.attrs.transform = matrixAttr(toDevice);
		}
		if (!fullImage) {
			// Clip in the group's own (image pixel) space: clipPathUnits default
			// to the referencing element's user space, which includes its transform.
			const id = this.id('c');
			this.defs.push({
				tag: 'clipPath',
				attrs: { id },
				children: [{ tag: 'rect', attrs: { x: fmt(sx), y: fmt(sy), width: fmt(sw), height: fmt(sh) } }],
			});
			image.attrs['clip-path'] = `url(#${id})`;
		}
		slot.children!.push(group);
	}

	// ---- finalisation ------------------------------------------------------

	/**
	 * Encodes every pending raster payload and returns the finished `<svg>`
	 * tree. Call once, after replay (and deferred images) are complete.
	 */
	async toTree(options: { includeSize?: boolean } = {}): Promise<SvgNode> {
		const cache = new Map<ImagePayload, string>();
		for (const img of this.images) {
			let url = cache.get(img.payload);
			if (url === undefined) {
				url = await payloadToUrl(img.payload);
				cache.set(img.payload, url);
			}
			img.node.attrs.href = url;
		}
		const { width, height } = this.canvas;
		const attrs: SvgNode['attrs'] = { xmlns: 'http://www.w3.org/2000/svg' };
		if (options.includeSize ?? true) {
			attrs.width = width;
			attrs.height = height;
		}
		attrs.viewBox = `0 0 ${width} ${height}`;
		attrs.style = 'isolation:isolate';
		const children: SvgNode[] = [];
		if (this.defs.length) {
			children.push({ tag: 'defs', attrs: {}, children: this.defs });
		}
		children.push(...pruneEmptySlots(this.body));
		return { tag: 'svg', attrs, children };
	}
}

function pruneEmptySlots(nodes: SvgNode[]): SvgNode[] {
	return nodes.filter((n) => {
		if (n.tag === 'g' && n.children) {
			n.children = pruneEmptySlots(n.children);
			return n.children.length > 0;
		}
		return true;
	});
}

async function payloadToUrl(p: ImagePayload): Promise<string> {
	switch (p.kind) {
		case 'url':
			return p.url;
		case 'encoded':
			return `data:${p.mime};base64,${bytesToBase64(p.bytes)}`;
		case 'rgba':
			return `data:image/png;base64,${bytesToBase64(await encodePng(p.data, p.width, p.height))}`;
	}
}

// ---------------------------------------------------------------------------
// Font helpers
// ---------------------------------------------------------------------------

/** Parses the Canvas font shorthand the replay code produces. */
export function parseFont(font: string): { style: string; weight: string; size: number; family: string } {
	const m = /^\s*((?:(?:italic|oblique|normal|bold|bolder|lighter|small-caps|\d{3})\s+)*)([\d.]+)px\s+(.+)$/i.exec(font);
	if (!m) {
		return { style: '', weight: '', size: 10, family: 'sans-serif' };
	}
	const tokens = m[1].trim().split(/\s+/).filter(Boolean);
	const style = tokens.find((t) => /^(italic|oblique)$/i.test(t)) ?? '';
	const weight = tokens.find((t) => /^(bold|bolder|lighter|\d{3})$/i.test(t)) ?? '';
	return { style, weight, size: parseFloat(m[2]), family: m[3].trim() };
}

/** Rough advance-width estimate used only when no canvas exists to measure text. */
export function estimateTextWidth(text: string, size: number): number {
	let em = 0;
	for (const ch of text) {
		if (/[ilj.,;:'!|]/.test(ch)) {
			em += 0.28;
		} else if (/[mwMW@]/.test(ch)) {
			em += 0.83;
		} else if (/[A-Z0-9]/.test(ch)) {
			em += 0.64;
		} else if (ch === ' ') {
			em += 0.28;
		} else if (ch.charCodeAt(0) > 0x2e7f) {
			em += 1;
		} else {
			em += 0.52;
		}
	}
	return em * size;
}

/** True when `ctx` is an {@link SvgContext}. */
export function isSvgContext(ctx: unknown): ctx is SvgContext {
	return ctx instanceof SvgContext;
}

/**
 * True when reading pixels back from `ctx` yields the real destination:
 * always for a raster canvas, and for an {@link SvgContext} only when it has
 * a shadow canvas.
 */
export function canReadBack(ctx: unknown): boolean {
	return !(ctx instanceof SvgContext) || ctx.canReadPixels;
}
