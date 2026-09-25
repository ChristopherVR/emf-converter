/**
 * A pure-JavaScript implementation of the Canvas 2D API, used wherever no
 * real canvas exists (plain Node.js without the optional `@napi-rs/canvas`
 * package): as the SVG backend's hidden "shadow" raster, so destination-
 * reading raster operations (exact ROP3 blits, bitwise ROP2, per-pixel
 * pattern fills, `gdiAntialias: false` shapes) stay exact with no canvas
 * dependency; as every scratch surface (`createTempCanvas`); and as the
 * output surface of PNG conversion when the drawing contains no text.
 *
 * What it implements, following Chromium/Skia semantics:
 * - paths in device space (built by the shared `canvas-path.ts`, so the
 *   shadow rasterises exactly the geometry the SVG describes), filled with
 *   the nonzero or even-odd rule at analytic anti-aliased coverage
 *   (`software-raster-coverage.ts`);
 * - strokes as polygons in the stroke-time user space: widths, all caps,
 *   joins and miter limits, dashes with offsets (`software-raster-stroke.ts`);
 * - clipping as an intersected stack of anti-aliased coverage masks;
 * - solid colours, linear and radial gradients, patterns, `globalAlpha`,
 *   and every `globalCompositeOperation` (`software-raster-paint.ts`),
 *   including the unbounded operators that clear outside the shape;
 * - `drawImage` in all three forms under any affine transform (nearest or
 *   bilinear per `imageSmoothingEnabled`, strictly inside the source
 *   rectangle, anti-aliased edges), `getImageData`/`putImageData` (with the
 *   dirty rectangle), `createPattern`, `isPointInPath`, `isPointInStroke`.
 *
 * Text is the one thing it cannot rasterise: glyphs need a font engine.
 * `fillText`/`strokeText` therefore paint nothing, count the call
 * ({@link SoftwareRasterCanvas.textDraws}; PNG conversion refuses to return
 * an image missing its text), and mark a generous box around where the
 * glyphs would be as UNKNOWN ({@link SoftwareRasterCanvas.unknownIn}). A
 * later drawing that fully determines a pixel (an opaque source-over or
 * `copy` write at full coverage, `putImageData`, `clearRect`) makes it known
 * again. The SVG backend uses this to keep raster operations over text
 * exact wherever the result does not depend on the glyph pixels, and to
 * defer the rest to the SVG renderer, which does have the fonts (see
 * `splitUnknownDestination` in `emf-rop2-exact.ts`).
 *
 * Pixels are stored premultiplied, eight bits per channel (like Skia);
 * `getImageData` un-premultiplies and `putImageData` premultiplies, with
 * the same (lossy for translucent pixels) rounding round trip Canvas has.
 *
 * @module software-raster
 */

import {
	IDENTITY_MATRIX,
	PathBuilder,
	flattenPath,
	multiplyMatrix,
	pointInPolylines,
	type Matrix,
	type PathSeg,
	type Polyline,
} from './canvas-path';
import { rasterizeRings, type PixelRect } from './software-raster-coverage';
import {
	SoftwareGradient,
	SoftwarePattern,
	UNBOUNDED_OPS,
	compositePixel,
	imageShader,
	isCompositeOp,
	makeShader,
	parseColor,
	type Shader,
} from './software-raster-paint';
import { drawHairline, hairlineCoverage, hairlineCubicSegments } from './software-raster-hairline';
import { strokeCenterlines, strokeToRings, type StrokeParams } from './software-raster-stroke';
import { estimateTextWidth, parseFont, textInkBox } from './text-estimate';

export { SoftwareGradient, SoftwarePattern } from './software-raster-paint';

/** Plain `ImageData`-shaped pixel holder (the DOM class may not exist). */
export interface RasterPixels {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

/** Device-space chord error allowed when flattening curves and round joins. */
const FLATTEN_TOLERANCE = 0.05;

/**
 * An anti-aliased clip: coverage `mask` (0..255) over `box`, zero outside
 * it; a `null` mask means the whole box is fully inside (a pixel-aligned
 * rectangle, the common GDI clip region).
 */
interface ClipMask {
	box: PixelRect;
	mask: Uint8Array | null;
}

interface RasterState {
	transform: Matrix;
	fillStyle: unknown;
	strokeStyle: unknown;
	lineWidth: number;
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	miterLimit: number;
	lineDash: number[];
	lineDashOffset: number;
	globalAlpha: number;
	gco: string;
	font: string;
	textAlign: CanvasTextAlign;
	textBaseline: CanvasTextBaseline;
	imageSmoothingEnabled: boolean;
	imageSmoothingQuality: ImageSmoothingQuality;
	clip: ClipMask | null;
}

/** The "canvas" half of a software raster: dimensions, pixels, and its context. */
export class SoftwareRasterCanvas {
	readonly width: number;
	readonly height: number;
	/** Premultiplied RGBA, row-major, top-down. */
	readonly data: Uint8ClampedArray;
	/** The same pixels as 32-bit words, for filling runs. */
	readonly words: Uint32Array;
	readonly ctx: SoftwareRasterContext;
	/** Per-pixel flags: 1 where the pixel's true value is unknown (text glyphs). Lazily allocated. */
	unknown: Uint8Array | null = null;
	/** Number of `fillText`/`strokeText` calls that would have painted glyphs. */
	textDraws = 0;

	constructor(width: number, height: number) {
		this.width = Math.max(1, Math.floor(width));
		this.height = Math.max(1, Math.floor(height));
		this.data = new Uint8ClampedArray(this.width * this.height * 4);
		this.words = new Uint32Array(this.data.buffer);
		this.ctx = new SoftwareRasterContext(this);
	}

	getContext(_type: '2d'): SoftwareRasterContext {
		return this.ctx;
	}

	/** A straight-alpha (non-premultiplied) copy of every pixel, as `getImageData` would return it. */
	get pixels(): Uint8ClampedArray {
		return this.readRgba(0, 0, this.width, this.height);
	}

	/** Straight-alpha RGBA of a rectangle; pixels outside the surface read as transparent. */
	readRgba(x: number, y: number, w: number, h: number): Uint8ClampedArray {
		const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
		const { width, height, data } = this;
		for (let row = 0; row < h; row++) {
			const sy = y + row;
			if (sy < 0 || sy >= height) {
				continue;
			}
			for (let col = 0; col < w; col++) {
				const sx = x + col;
				if (sx < 0 || sx >= width) {
					continue;
				}
				const si = (sy * width + sx) * 4;
				const di = (row * w + col) * 4;
				const a = data[si + 3];
				if (a === 255) {
					out[di] = data[si];
					out[di + 1] = data[si + 1];
					out[di + 2] = data[si + 2];
					out[di + 3] = 255;
				} else if (a !== 0) {
					const k = 255 / a;
					out[di] = data[si] * k;
					out[di + 1] = data[si + 1] * k;
					out[di + 2] = data[si + 2] * k;
					out[di + 3] = a;
				}
			}
		}
		return out;
	}

	/**
	 * The unknown-pixel flags of a rectangle (see the module doc), or `null`
	 * when every pixel in it is known.
	 */
	unknownIn(x: number, y: number, w: number, h: number): Uint8Array | null {
		const u = this.unknown;
		if (!u) {
			return null;
		}
		let out: Uint8Array | null = null;
		for (let row = 0; row < h; row++) {
			const sy = y + row;
			if (sy < 0 || sy >= this.height) {
				continue;
			}
			for (let col = 0; col < w; col++) {
				const sx = x + col;
				if (sx >= 0 && sx < this.width && u[sy * this.width + sx]) {
					out ??= new Uint8Array(w * h);
					out[row * w + col] = 1;
				}
			}
		}
		return out;
	}

	/** Marks every pixel touched by the device-space polygon `ring` (within `clip`) as unknown. */
	markUnknown(ring: ArrayLike<number>, clip: ClipMask | null = null): void {
		const bounds = clip ? clip.box : { x0: 0, y0: 0, x1: this.width, y1: this.height };
		this.unknown ??= new Uint8Array(this.width * this.height);
		const u = this.unknown;
		rasterizeRings([ring], 'nonzero', bounds, (y, x0, x1) => {
			for (let x = x0; x < x1; x++) {
				if (!clip || clipAt(clip, x, y)) {
					u[y * this.width + x] = 1;
				}
			}
		});
	}
}

/** True when `value` is a {@link SoftwareRasterCanvas} or its context. */
export function isSoftwareRaster(value: unknown): value is SoftwareRasterCanvas | SoftwareRasterContext {
	return value instanceof SoftwareRasterCanvas || value instanceof SoftwareRasterContext;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Packs RGBA bytes into the 32-bit word that stores them in memory order. */
function packWord(r: number, g: number, b: number, a: number): number {
	const rr = Math.round(r) & 255;
	const gg = Math.round(g) & 255;
	const bb = Math.round(b) & 255;
	const aa = Math.round(a) & 255;
	return (LITTLE_ENDIAN ? (aa << 24) | (bb << 16) | (gg << 8) | rr : (rr << 24) | (gg << 16) | (bb << 8) | aa) >>> 0;
}

function clipAt(clip: ClipMask, x: number, y: number): number {
	const b = clip.box;
	if (x < b.x0 || x >= b.x1 || y < b.y0 || y >= b.y1) {
		return 0;
	}
	return clip.mask ? clip.mask[(y - b.y0) * (b.x1 - b.x0) + (x - b.x0)] : 255;
}

/** Moves point `i` of flat list `p` away from point `j` by `d`. */
function extendEnd(p: number[], i: number, j: number, d: number): void {
	const dx = p[i * 2] - p[j * 2];
	const dy = p[i * 2 + 1] - p[j * 2 + 1];
	const len = Math.hypot(dx, dy);
	if (len > 0) {
		p[i * 2] += (dx / len) * d;
		p[i * 2 + 1] += (dy / len) * d;
	}
}

/** The integer box of a ring that is exactly a pixel-aligned axis-aligned rectangle, else `null`. */
function alignedRect(r: ArrayLike<number>): PixelRect | null {
	let n = r.length >> 1;
	if (n === 5 && r[0] === r[8] && r[1] === r[9]) {
		n = 4;
	}
	if (n !== 4) {
		return null;
	}
	const xs = [r[0], r[2], r[4], r[6]];
	const ys = [r[1], r[3], r[5], r[7]];
	if (![...xs, ...ys].every(Number.isInteger)) {
		return null;
	}
	const horizontalFirst = ys[0] === ys[1] && xs[1] === xs[2] && ys[2] === ys[3] && xs[3] === xs[0];
	const verticalFirst = xs[0] === xs[1] && ys[1] === ys[2] && xs[2] === xs[3] && ys[3] === ys[0];
	if (!horizontalFirst && !verticalFirst) {
		return null;
	}
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Resolves a drawable into premultiplied pixels (a copy unless it is another software canvas). */
function sourcePixels(source: unknown): { data: Uint8ClampedArray; width: number; height: number } | null {
	if (source instanceof SoftwareRasterCanvas) {
		return { data: source.data, width: source.width, height: source.height };
	}
	if (source instanceof SoftwareRasterContext) {
		return sourcePixels(source.canvas);
	}
	const s = source as Partial<RasterPixels> & { getContext?: (t: '2d') => unknown };
	let straight: RasterPixels | null = null;
	if (s && s.data instanceof Uint8ClampedArray && typeof s.width === 'number' && typeof s.height === 'number') {
		straight = { data: s.data, width: s.width, height: s.height };
	} else if (s && typeof s.getContext === 'function' && typeof s.width === 'number' && typeof s.height === 'number') {
		try {
			const c = s.getContext('2d') as { getImageData?: (x: number, y: number, w: number, h: number) => RasterPixels } | null;
			const img = c?.getImageData?.(0, 0, s.width, s.height);
			if (img) {
				straight = { data: img.data, width: s.width, height: s.height };
			}
		} catch {
			straight = null;
		}
	}
	if (!straight || straight.width <= 0 || straight.height <= 0) {
		return null;
	}
	const n = straight.width * straight.height * 4;
	if (straight.data.length < n) {
		return null;
	}
	const data = new Uint8ClampedArray(n);
	const d = straight.data;
	for (let i = 0; i < n; i += 4) {
		const a = d[i + 3];
		if (a === 255) {
			data[i] = d[i];
			data[i + 1] = d[i + 1];
			data[i + 2] = d[i + 2];
			data[i + 3] = 255;
		} else if (a !== 0) {
			const k = a / 255;
			data[i] = d[i] * k;
			data[i + 1] = d[i + 1] * k;
			data[i + 2] = d[i + 2] * k;
			data[i + 3] = a;
		}
	}
	return { data, width: straight.width, height: straight.height };
}

/** Minimal `TextMetrics` for a font-less estimate. */
interface EstimatedTextMetrics {
	width: number;
	actualBoundingBoxLeft: number;
	actualBoundingBoxRight: number;
	actualBoundingBoxAscent: number;
	actualBoundingBoxDescent: number;
	fontBoundingBoxAscent: number;
	fontBoundingBoxDescent: number;
}

/** The Canvas 2D context of a {@link SoftwareRasterCanvas}. */
export class SoftwareRasterContext {
	readonly canvas: SoftwareRasterCanvas;
	private state: RasterState = {
		transform: [...IDENTITY_MATRIX] as Matrix,
		fillStyle: '#000000',
		strokeStyle: '#000000',
		lineWidth: 1,
		lineCap: 'butt',
		lineJoin: 'miter',
		miterLimit: 10,
		lineDash: [],
		lineDashOffset: 0,
		globalAlpha: 1,
		gco: 'source-over',
		font: '10px sans-serif',
		textAlign: 'start',
		textBaseline: 'alphabetic',
		imageSmoothingEnabled: true,
		imageSmoothingQuality: 'low',
		clip: null,
	};
	private stack: RasterState[] = [];
	private readonly path = new PathBuilder();
	private flatCache: { segs: unknown; length: number; polys: Polyline[] } | null = null;
	private rowCache: { key: string; xs: Float64Array; suffixWinding: Int32Array; count: number } | null = null;
	private px = new Float64Array(4);

	constructor(canvas: SoftwareRasterCanvas) {
		this.canvas = canvas;
	}

	// ---- state properties ---------------------------------------------------

	get fillStyle(): unknown {
		return this.state.fillStyle;
	}
	set fillStyle(v: unknown) {
		if (this.acceptStyle(v)) {
			this.state.fillStyle = v;
		}
	}
	get strokeStyle(): unknown {
		return this.state.strokeStyle;
	}
	set strokeStyle(v: unknown) {
		if (this.acceptStyle(v)) {
			this.state.strokeStyle = v;
		}
	}
	private acceptStyle(v: unknown): boolean {
		return (typeof v === 'string' && parseColor(v) !== null) || v instanceof SoftwareGradient || v instanceof SoftwarePattern;
	}
	get lineWidth(): number {
		return this.state.lineWidth;
	}
	set lineWidth(v: number) {
		if (Number.isFinite(v) && v > 0) {
			this.state.lineWidth = v;
		}
	}
	get lineCap(): CanvasLineCap {
		return this.state.lineCap;
	}
	set lineCap(v: CanvasLineCap) {
		if (v === 'butt' || v === 'round' || v === 'square') {
			this.state.lineCap = v;
		}
	}
	get lineJoin(): CanvasLineJoin {
		return this.state.lineJoin;
	}
	set lineJoin(v: CanvasLineJoin) {
		if (v === 'miter' || v === 'round' || v === 'bevel') {
			this.state.lineJoin = v;
		}
	}
	get miterLimit(): number {
		return this.state.miterLimit;
	}
	set miterLimit(v: number) {
		if (Number.isFinite(v) && v > 0) {
			this.state.miterLimit = v;
		}
	}
	get lineDashOffset(): number {
		return this.state.lineDashOffset;
	}
	set lineDashOffset(v: number) {
		if (Number.isFinite(v)) {
			this.state.lineDashOffset = v;
		}
	}
	get globalAlpha(): number {
		return this.state.globalAlpha;
	}
	set globalAlpha(v: number) {
		if (Number.isFinite(v) && v >= 0 && v <= 1) {
			this.state.globalAlpha = v;
		}
	}
	get globalCompositeOperation(): string {
		return this.state.gco;
	}
	set globalCompositeOperation(v: string) {
		if (isCompositeOp(v)) {
			this.state.gco = v;
		}
	}
	get font(): string {
		return this.state.font;
	}
	set font(v: string) {
		this.state.font = v;
	}
	get textAlign(): CanvasTextAlign {
		return this.state.textAlign;
	}
	set textAlign(v: CanvasTextAlign) {
		this.state.textAlign = v;
	}
	get textBaseline(): CanvasTextBaseline {
		return this.state.textBaseline;
	}
	set textBaseline(v: CanvasTextBaseline) {
		this.state.textBaseline = v;
	}
	get imageSmoothingEnabled(): boolean {
		return this.state.imageSmoothingEnabled;
	}
	set imageSmoothingEnabled(v: boolean) {
		this.state.imageSmoothingEnabled = !!v;
	}
	get imageSmoothingQuality(): ImageSmoothingQuality {
		return this.state.imageSmoothingQuality;
	}
	set imageSmoothingQuality(v: ImageSmoothingQuality) {
		this.state.imageSmoothingQuality = v;
	}

	setLineDash(segments: number[]): void {
		if (!Array.isArray(segments) || segments.some((s) => !Number.isFinite(s) || s < 0)) {
			return;
		}
		this.state.lineDash = segments.length % 2 ? [...segments, ...segments] : [...segments];
	}
	getLineDash(): number[] {
		return [...this.state.lineDash];
	}

	// ---- state stack & transforms -----------------------------------------

	save(): void {
		this.stack.push({ ...this.state, transform: [...this.state.transform] as Matrix, lineDash: [...this.state.lineDash] });
	}
	restore(): void {
		const s = this.stack.pop();
		if (s) {
			this.state = s;
		}
	}
	getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
		const [a, b, c, d, e, f] = this.state.transform;
		return { a, b, c, d, e, f };
	}
	setTransform(a: number | DOMMatrix2DInit, b?: number, c?: number, d?: number, e?: number, f?: number): void {
		const m: Matrix =
			typeof a === 'object'
				? [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0]
				: [a, b as number, c as number, d as number, e as number, f as number];
		if (m.every(Number.isFinite)) {
			this.state.transform = m;
		}
	}
	resetTransform(): void {
		this.state.transform = [...IDENTITY_MATRIX] as Matrix;
	}
	transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		if ([a, b, c, d, e, f].every(Number.isFinite)) {
			this.state.transform = multiplyMatrix(this.state.transform, [a, b, c, d, e, f]);
		}
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

	// ---- path construction -------------------------------------------------

	beginPath(): void {
		this.path.reset();
	}
	closePath(): void {
		this.path.closePath();
	}
	moveTo(x: number, y: number): void {
		this.path.moveTo(this.state.transform, x, y);
	}
	lineTo(x: number, y: number): void {
		this.path.lineTo(this.state.transform, x, y);
	}
	bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		this.path.bezierCurveTo(this.state.transform, x1, y1, x2, y2, x, y);
	}
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
		this.path.quadraticCurveTo(this.state.transform, cx, cy, x, y);
	}
	arc(x: number, y: number, r: number, startAngle: number, endAngle: number, counterclockwise = false): void {
		this.path.arc(this.state.transform, x, y, r, startAngle, endAngle, counterclockwise);
	}
	arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
		this.path.arcTo(this.state.transform, x1, y1, x2, y2, r);
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
		this.path.ellipse(this.state.transform, x, y, rx, ry, rotation, startAngle, endAngle, counterclockwise);
	}
	rect(x: number, y: number, w: number, h: number): void {
		this.path.rect(this.state.transform, x, y, w, h);
	}

	/** The current path flattened in device space (cached until the path changes). */
	private flattened(): Polyline[] {
		const segs = this.path.segs;
		const c = this.flatCache;
		if (c && c.segs === segs && c.length === segs.length) {
			return c.polys;
		}
		const polys = flattenPath(segs, FLATTEN_TOLERANCE);
		this.flatCache = { segs, length: segs.length, polys };
		this.rowCache = null;
		return polys;
	}

	private strokeParams(): StrokeParams {
		const s = this.state;
		return {
			lineWidth: s.lineWidth,
			lineCap: s.lineCap,
			lineJoin: s.lineJoin,
			miterLimit: s.miterLimit,
			lineDash: s.lineDash,
			lineDashOffset: s.lineDashOffset,
		};
	}

	// ---- painting ------------------------------------------------------------

	private surfaceBounds(): PixelRect {
		const clip = this.state.clip;
		const b = { x0: 0, y0: 0, x1: this.canvas.width, y1: this.canvas.height };
		if (clip) {
			b.x0 = Math.max(b.x0, clip.box.x0);
			b.y0 = Math.max(b.y0, clip.box.y0);
			b.x1 = Math.min(b.x1, clip.box.x1);
			b.y1 = Math.min(b.y1, clip.box.y1);
		}
		return b;
	}

	/**
	 * Paints `rings` (device space) with `shader` under the current clip,
	 * `globalAlpha` and `globalCompositeOperation`.
	 */
	private paintRings(rings: ReadonlyArray<ArrayLike<number>>, rule: CanvasFillRule, shader: Shader | null): void {
		if (!shader || rings.length === 0) {
			return;
		}
		const bounds = this.surfaceBounds();
		if (bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) {
			return;
		}
		const op = this.state.gco;
		if (UNBOUNDED_OPS.has(op)) {
			this.paintUnbounded(rings, rule, shader, bounds);
			return;
		}
		const ga = this.state.globalAlpha;
		if (ga <= 0) {
			return;
		}
		const { data, width } = this.canvas;
		// The bounds already stop at the clip box; only a mask needs per-pixel work.
		const clip = this.state.clip?.mask ? this.state.clip : null;
		const unknown = this.canvas.unknown;
		const px = this.px;
		const solid = shader.solid;
		const shade = solid ? null : shader.shade;
		const sr0 = solid ? (solid[0] * ga) / 255 : 0;
		const sg0 = solid ? (solid[1] * ga) / 255 : 0;
		const sb0 = solid ? (solid[2] * ga) / 255 : 0;
		const sa0 = solid ? (solid[3] * ga) / 255 : 0;
		if (solid && sa0 <= 0 && (op === 'source-over' || op === 'destination-out' || op === 'source-atop' || op === 'lighter' || op === 'xor')) {
			return;
		}
		const fastOpaque = solid !== undefined && sa0 >= 1 && op === 'source-over';
		const words = fastOpaque ? this.canvas.words : null;
		const word = solid ? packWord(solid[0], solid[1], solid[2], 255) : 0;
		rasterizeRings(rings, rule, bounds, (y, x0, x1, level) => {
			const rowStart = y * width;
			if (words && level === 255 && !clip) {
				// A fully covered run of an opaque colour: one fill.
				words.fill(word, rowStart + x0, rowStart + x1);
				if (unknown) {
					unknown.fill(0, rowStart + x0, rowStart + x1);
				}
				return;
			}
			let di = (rowStart + x0) * 4;
			let pi = rowStart + x0;
			for (let x = x0; x < x1; x++, di += 4, pi++) {
				let c = level;
				if (clip) {
					c = (c * clipAt(clip, x, y)) / 255;
				}
				if (c <= 0) {
					continue;
				}
				const cf = c >= 255 ? 1 : c / 255;
				let sr = sr0;
				let sg = sg0;
				let sb = sb0;
				let sa = sa0;
				if (shade) {
					if (!shade(x, y, px)) {
						continue;
					}
					sr = (px[0] * ga) / 255;
					sg = (px[1] * ga) / 255;
					sb = (px[2] * ga) / 255;
					sa = (px[3] * ga) / 255;
				}
				if (fastOpaque && cf === 1) {
					data[di] = solid![0];
					data[di + 1] = solid![1];
					data[di + 2] = solid![2];
					data[di + 3] = 255;
				} else {
					compositePixel(data, di, sr, sg, sb, sa, cf, op);
				}
				if (unknown && unknown[pi] && cf === 1 && sa >= 0.9999 && (op === 'source-over' || op === 'destination-out')) {
					unknown[pi] = 0;
				}
			}
		});
	}

	/** Operators that clear the destination outside the shape: the whole clip area is composited. */
	private paintUnbounded(rings: ReadonlyArray<ArrayLike<number>>, rule: CanvasFillRule, shader: Shader, b: PixelRect): void {
		const bw = b.x1 - b.x0;
		const bh = b.y1 - b.y0;
		const coverage = new Uint8Array(bw * bh);
		rasterizeRings(rings, rule, b, (y, x0, x1, level) => {
			const o = (y - b.y0) * bw - b.x0;
			coverage.fill(level, o + x0, o + x1);
		});
		const { data, width } = this.canvas;
		const clip = this.state.clip;
		const unknown = this.canvas.unknown;
		const ga = this.state.globalAlpha;
		const op = this.state.gco;
		const px = this.px;
		for (let y = b.y0; y < b.y1; y++) {
			for (let x = b.x0; x < b.x1; x++) {
				const m = clip ? clipAt(clip, x, y) / 255 : 1;
				if (m <= 0) {
					continue;
				}
				const c = coverage[(y - b.y0) * bw + (x - b.x0)] / 255;
				let sr = 0;
				let sg = 0;
				let sb = 0;
				let sa = 0;
				if (c > 0) {
					if (shader.solid) {
						[sr, sg, sb, sa] = shader.solid;
					} else if (shader.shade(x, y, px)) {
						[sr, sg, sb, sa] = px;
					}
					const k = (c * ga) / 255;
					sr *= k;
					sg *= k;
					sb *= k;
					sa *= k;
				}
				const pi = y * width + x;
				compositePixel(data, pi * 4, sr, sg, sb, sa, m, op);
				if (unknown && m >= 1 && op === 'copy') {
					unknown[pi] = 0;
				}
			}
		}
	}

	fill(fillRule: CanvasFillRule = 'nonzero'): void {
		const polys = this.flattened();
		this.paintRings(
			polys.map((p) => p.pts),
			fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
			makeShader(this.state.fillStyle, this.state.transform, this.state.imageSmoothingEnabled),
		);
	}

	stroke(): void {
		this.strokeSegs(this.path.segs, this.flattened());
	}

	/**
	 * Strokes device-space segments: as Skia hairlines when the stroke is at
	 * most one device pixel wide (see `software-raster-hairline.ts`),
	 * otherwise as an outline polygon.
	 */
	private strokeSegs(segs: ReadonlyArray<PathSeg>, flat: Polyline[]): void {
		const shader = makeShader(this.state.strokeStyle, this.state.transform, this.state.imageSmoothingEnabled);
		if (!shader) {
			return;
		}
		const hair = hairlineCoverage(this.state.transform, this.state.lineWidth);
		if (hair === null) {
			const rings = strokeToRings(flat, this.state.transform, this.strokeParams(), FLATTEN_TOLERANCE);
			this.paintRings(rings, 'nonzero', shader);
			return;
		}
		const lines = strokeCenterlines(flattenPath(segs, FLATTEN_TOLERANCE, hairlineCubicSegments), this.state.transform, this.strokeParams());
		// Skia pushes the ends of an open hairline out for square and round caps.
		const outset = this.state.lineCap === 'square' ? 0.5 : this.state.lineCap === 'round' ? Math.PI / 8 : 0;
		const { width, height } = this.canvas;
		const plot = this.hairlinePlotter(shader, hair);
		for (const line of lines) {
			const p = line.pts.slice();
			const n = p.length >> 1;
			if (n < 2) {
				continue;
			}
			if (outset && !line.closed) {
				extendEnd(p, 0, 1, outset);
				extendEnd(p, n - 1, n - 2, outset);
			}
			const segCount = line.closed ? n : n - 1;
			for (let i = 0; i < segCount; i++) {
				const j = (i + 1) % n;
				drawHairline(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], width, height, plot);
			}
		}
	}

	/** Composites single hairline pixels with the paint, clip, alpha and operator. */
	private hairlinePlotter(shader: Shader, coverage: number): (x: number, y: number, alpha: number) => void {
		const { data, width, height } = this.canvas;
		const clip = this.state.clip;
		const op = this.state.gco;
		const ga = this.state.globalAlpha * Math.min(1, coverage);
		const px = this.px;
		return (x, y, alpha) => {
			if (x < 0 || y < 0 || x >= width || y >= height) {
				return;
			}
			let c = alpha / 255;
			if (clip) {
				c *= clipAt(clip, x, y) / 255;
			}
			if (c <= 0) {
				return;
			}
			let sr: number;
			let sg: number;
			let sb: number;
			let sa: number;
			if (shader.solid) {
				[sr, sg, sb, sa] = shader.solid;
			} else {
				if (!shader.shade(x, y, px)) {
					return;
				}
				[sr, sg, sb, sa] = px;
			}
			const k = ga / 255;
			compositePixel(data, (y * width + x) * 4, sr * k, sg * k, sb * k, sa * k, c, op);
		};
	}

	private rectRing(x: number, y: number, w: number, h: number): number[] {
		const m = this.state.transform;
		const pts = [
			[x, y],
			[x + w, y],
			[x + w, y + h],
			[x, y + h],
		];
		const ring: number[] = [];
		for (const [u, v] of pts) {
			ring.push(m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]);
		}
		return ring;
	}

	fillRect(x: number, y: number, w: number, h: number): void {
		if (![x, y, w, h].every(Number.isFinite) || w === 0 || h === 0) {
			return;
		}
		this.paintRings(
			[this.rectRing(x, y, w, h)],
			'nonzero',
			makeShader(this.state.fillStyle, this.state.transform, this.state.imageSmoothingEnabled),
		);
	}

	strokeRect(x: number, y: number, w: number, h: number): void {
		if (![x, y, w, h].every(Number.isFinite)) {
			return;
		}
		const temp = new PathBuilder();
		temp.rect(this.state.transform, x, y, w, h);
		this.strokeSegs(temp.segs, flattenPath(temp.segs, FLATTEN_TOLERANCE));
	}

	clearRect(x: number, y: number, w: number, h: number): void {
		if (![x, y, w, h].every(Number.isFinite) || w === 0 || h === 0) {
			return;
		}
		const saved = { gco: this.state.gco, ga: this.state.globalAlpha };
		this.state.gco = 'destination-out';
		this.state.globalAlpha = 1;
		this.paintRings([this.rectRing(x, y, w, h)], 'nonzero', { solid: [0, 0, 0, 255] });
		this.state.gco = saved.gco;
		this.state.globalAlpha = saved.ga;
	}

	clip(fillRule: CanvasFillRule = 'nonzero'): void {
		const bounds = this.surfaceBounds();
		const prev = this.state.clip;
		const rings = this.flattened()
			.filter((p) => p.pts.length >= 6)
			.map((p) => p.pts);
		const empty: ClipMask = { box: { x0: 0, y0: 0, x1: 0, y1: 0 }, mask: null };
		// A pixel-aligned axis-aligned rectangle (every GDI clip region is a
		// union of them) needs no mask: the box alone is exact.
		const rect = rings.length === 1 ? alignedRect(rings[0]) : null;
		if (rect) {
			const box = {
				x0: Math.max(bounds.x0, rect.x0),
				y0: Math.max(bounds.y0, rect.y0),
				x1: Math.min(bounds.x1, rect.x1),
				y1: Math.min(bounds.y1, rect.y1),
			};
			if (box.x1 <= box.x0 || box.y1 <= box.y0) {
				this.state.clip = empty;
				return;
			}
			let mask: Uint8Array | null = null;
			if (prev?.mask) {
				const w = box.x1 - box.x0;
				mask = new Uint8Array(w * (box.y1 - box.y0));
				for (let y = box.y0; y < box.y1; y++) {
					for (let x = box.x0; x < box.x1; x++) {
						mask[(y - box.y0) * w + (x - box.x0)] = clipAt(prev, x, y);
					}
				}
			}
			this.state.clip = { box, mask };
			return;
		}
		let next = empty;
		let pathBox: PixelRect | null = null;
		for (const r of rings) {
			for (let i = 0; i + 1 < r.length; i += 2) {
				const x = r[i];
				const y = r[i + 1];
				pathBox ??= { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
				pathBox.x0 = Math.min(pathBox.x0, x);
				pathBox.y0 = Math.min(pathBox.y0, y);
				pathBox.x1 = Math.max(pathBox.x1, x);
				pathBox.y1 = Math.max(pathBox.y1, y);
			}
		}
		if (pathBox && Number.isFinite(pathBox.x0 + pathBox.x1 + pathBox.y0 + pathBox.y1)) {
			const area = {
				x0: Math.max(bounds.x0, Math.floor(pathBox.x0)),
				y0: Math.max(bounds.y0, Math.floor(pathBox.y0)),
				x1: Math.min(bounds.x1, Math.ceil(pathBox.x1)),
				y1: Math.min(bounds.y1, Math.ceil(pathBox.y1)),
			};
			if (area.x1 > area.x0 && area.y1 > area.y0) {
				const bw = area.x1 - area.x0;
				const mask = new Uint8Array(bw * (area.y1 - area.y0));
				const scanned = rasterizeRings(rings, fillRule === 'evenodd' ? 'evenodd' : 'nonzero', area, (y, x0, x1, level) => {
					const o = (y - area.y0) * bw - area.x0;
					if (!prev?.mask) {
						mask.fill(level, o + x0, o + x1);
						return;
					}
					for (let x = x0; x < x1; x++) {
						mask[o + x] = Math.round((level * clipAt(prev, x, y)) / 255);
					}
				});
				if (scanned) {
					next = { box: area, mask };
				}
			}
		}
		this.state.clip = next;
	}
	/**
	 * The active clip's coverage (0..255) over a device rectangle, or `null`
	 * when nothing is clipped.
	 */
	clipCoverage(x: number, y: number, w: number, h: number): Uint8Array | null {
		const clip = this.state.clip;
		if (!clip) {
			return null;
		}
		const out = new Uint8Array(Math.max(0, w * h));
		for (let row = 0; row < h; row++) {
			for (let col = 0; col < w; col++) {
				out[row * w + col] = clipAt(clip, x + col, y + row);
			}
		}
		return out;
	}

	isPointInPath(x: number, y: number, fillRule: CanvasFillRule = 'nonzero'): boolean {
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			return false;
		}
		const polys = this.flattened();
		// Rewriting a shape pixel by pixel asks for every x of one row in
		// turn: cache that row's sorted crossings and winding suffix sums.
		const key = `${y}`;
		let row = this.rowCache;
		if (!row || row.key !== key) {
			const xs: number[] = [];
			const dirs: number[] = [];
			for (const poly of polys) {
				const p = poly.pts;
				const n = p.length >> 1;
				if (n < 2) {
					continue;
				}
				for (let i = 0; i < n; i++) {
					const j = i + 1 < n ? i + 1 : 0;
					const x0 = p[i * 2];
					const y0 = p[i * 2 + 1];
					const x1 = p[j * 2];
					const y1 = p[j * 2 + 1];
					if (y0 <= y ? y1 > y : y1 <= y) {
						xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
						dirs.push(y1 > y0 ? 1 : -1);
					}
				}
			}
			const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
			const sortedX = new Float64Array(order.length);
			const suffix = new Int32Array(order.length + 1);
			for (let k = 0; k < order.length; k++) {
				sortedX[k] = xs[order[k]];
			}
			for (let k = order.length - 1; k >= 0; k--) {
				suffix[k] = suffix[k + 1] + dirs[order[k]];
			}
			row = { key, xs: sortedX, suffixWinding: suffix, count: order.length };
			this.rowCache = row;
		}
		// First crossing strictly right of x.
		let lo = 0;
		let hi = row.count;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (row.xs[mid] > x) {
				hi = mid;
			} else {
				lo = mid + 1;
			}
		}
		if (fillRule === 'evenodd') {
			return ((row.count - lo) & 1) === 1;
		}
		return row.suffixWinding[lo] !== 0;
	}

	isPointInStroke(x: number, y: number): boolean {
		const rings = strokeToRings(this.flattened(), this.state.transform, this.strokeParams(), FLATTEN_TOLERANCE);
		return pointInPolylines(
			rings.map((pts) => ({ pts, smooth: [], closed: true })),
			x,
			y,
			'nonzero',
		);
	}

	// ---- gradients & patterns ---------------------------------------------

	createLinearGradient(x0: number, y0: number, x1: number, y1: number): SoftwareGradient {
		return new SoftwareGradient('linear', [x0, y0, x1, y1]);
	}
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): SoftwareGradient {
		if (r0 < 0 || r1 < 0) {
			throw new RangeError('The radius provided is negative');
		}
		return new SoftwareGradient('radial', [x0, y0, r0, x1, y1, r1]);
	}
	createPattern(image: unknown, repetition: string | null): SoftwarePattern | null {
		const src = sourcePixels(image);
		if (!src) {
			return null;
		}
		const rep = repetition === 'repeat-x' || repetition === 'repeat-y' || repetition === 'no-repeat' ? repetition : 'repeat';
		return new SoftwarePattern(src.data.slice(), src.width, src.height, rep);
	}

	// ---- text ------------------------------------------------------------------

	measureText(text: string): EstimatedTextMetrics {
		const size = parseFont(this.state.font).size;
		const width = estimateTextWidth(String(text), size);
		return {
			width,
			actualBoundingBoxLeft: 0,
			actualBoundingBoxRight: width,
			actualBoundingBoxAscent: size * 0.8,
			actualBoundingBoxDescent: size * 0.2,
			fontBoundingBoxAscent: size * 0.9,
			fontBoundingBoxDescent: size * 0.25,
		};
	}

	/** Glyphs cannot be rasterised without a font engine; see the module doc. */
	fillText(text: string, x: number, y: number, maxWidth?: number): void {
		this.recordText(text, x, y, maxWidth, this.state.fillStyle);
	}

	strokeText(text: string, x: number, y: number, maxWidth?: number): void {
		this.recordText(text, x, y, maxWidth, this.state.strokeStyle);
	}

	private recordText(text: string, x: number, y: number, maxWidth: number | undefined, style: unknown): void {
		const str = String(text ?? '');
		if (!str.trim() || ![x, y].every(Number.isFinite) || this.state.globalAlpha <= 0) {
			return;
		}
		const shader = makeShader(style, this.state.transform, true);
		if (!shader || (shader.solid && shader.solid[3] <= 0)) {
			return;
		}
		this.canvas.textDraws++;
		const box = textInkBox(str, x, y, this.state.font, this.state.textAlign, this.state.textBaseline, maxWidth);
		const m = this.state.transform;
		const ring: number[] = [];
		for (const [u, v] of [
			[box.x0, box.y0],
			[box.x1, box.y0],
			[box.x1, box.y1],
			[box.x0, box.y1],
		]) {
			ring.push(m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]);
		}
		this.canvas.markUnknown(ring, this.state.clip);
	}

	// ---- images & pixels -------------------------------------------------

	/**
	 * `drawImage(src, dx, dy)`, `(src, dx, dy, dw, dh)` or
	 * `(src, sx, sy, sw, sh, dx, dy, dw, dh)`, from another software raster,
	 * any `{ data, width, height }` pixel holder, or a canvas-like object
	 * exposing `getContext('2d').getImageData`.
	 */
	drawImage(source: unknown, ...args: number[]): void {
		let src = sourcePixels(source);
		if (!src) {
			return;
		}
		if (source === this.canvas || source === this) {
			src = { ...src, data: src.data.slice() };
		}
		let sx = 0;
		let sy = 0;
		let sw = src.width;
		let sh = src.height;
		let dx: number;
		let dy: number;
		let dw: number;
		let dh: number;
		if (args.length >= 8) {
			[sx, sy, sw, sh, dx, dy, dw, dh] = args;
		} else if (args.length >= 4) {
			[dx, dy, dw, dh] = args;
		} else {
			[dx, dy] = args;
			dw = sw;
			dh = sh;
		}
		if (![sx, sy, sw, sh, dx, dy, dw, dh].every(Number.isFinite) || !sw || !sh || !dw || !dh) {
			return;
		}
		// Canvas normalises negative extents (no mirroring)...
		if (sw < 0) {
			sx += sw;
			sw = -sw;
		}
		if (sh < 0) {
			sy += sh;
			sh = -sh;
		}
		if (dw < 0) {
			dx += dw;
			dw = -dw;
		}
		if (dh < 0) {
			dy += dh;
			dh = -dh;
		}
		// ...and clips the source rectangle to the image, shrinking the destination in proportion.
		const kx = dw / sw;
		const ky = dh / sh;
		const cx0 = Math.max(0, sx);
		const cy0 = Math.max(0, sy);
		const cx1 = Math.min(src.width, sx + sw);
		const cy1 = Math.min(src.height, sy + sh);
		if (cx1 <= cx0 || cy1 <= cy0) {
			return;
		}
		dx += (cx0 - sx) * kx;
		dy += (cy0 - sy) * ky;
		sx = cx0;
		sy = cy0;
		sw = cx1 - cx0;
		sh = cy1 - cy0;
		const place: Matrix = [kx, 0, 0, ky, dx - sx * kx, dy - sy * ky];
		const toDevice = multiplyMatrix(this.state.transform, place);
		const shader = imageShader(
			{
				data: src.data,
				width: src.width,
				height: src.height,
				wrapX: false,
				wrapY: false,
				minX: Math.floor(sx),
				minY: Math.floor(sy),
				maxX: Math.ceil(sx + sw),
				maxY: Math.ceil(sy + sh),
				transparentOutside: false,
				smooth: this.state.imageSmoothingEnabled,
			},
			toDevice,
		);
		const m = toDevice;
		const ring: number[] = [];
		for (const [u, v] of [
			[sx, sy],
			[sx + sw, sy],
			[sx + sw, sy + sh],
			[sx, sy + sh],
		]) {
			ring.push(m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]);
		}
		this.paintRings([ring], 'nonzero', shader);
	}

	createImageData(w: number, h: number): RasterPixels {
		const width = Math.abs(Math.floor(w)) || 1;
		const height = Math.abs(Math.floor(h)) || 1;
		return { data: new Uint8ClampedArray(width * height * 4), width, height };
	}

	getImageData(x: number, y: number, w: number, h: number): RasterPixels & { colorSpace: 'srgb' } {
		let ix = Math.floor(x);
		let iy = Math.floor(y);
		let iw = Math.floor(w);
		let ih = Math.floor(h);
		if (iw < 0) {
			ix += iw;
			iw = -iw;
		}
		if (ih < 0) {
			iy += ih;
			ih = -ih;
		}
		return { data: this.canvas.readRgba(ix, iy, iw, ih), width: iw, height: ih, colorSpace: 'srgb' };
	}

	putImageData(
		image: RasterPixels,
		x: number,
		y: number,
		dirtyX = 0,
		dirtyY = 0,
		dirtyW = image.width,
		dirtyH = image.height,
	): void {
		const { width, height, data } = this.canvas;
		const unknown = this.canvas.unknown;
		const dx = Math.round(x);
		const dy = Math.round(y);
		if (dirtyW < 0) {
			dirtyX += dirtyW;
			dirtyW = -dirtyW;
		}
		if (dirtyH < 0) {
			dirtyY += dirtyH;
			dirtyH = -dirtyH;
		}
		const c0 = Math.max(0, Math.floor(dirtyX));
		const r0 = Math.max(0, Math.floor(dirtyY));
		const c1 = Math.min(image.width, Math.floor(dirtyX + dirtyW));
		const r1 = Math.min(image.height, Math.floor(dirtyY + dirtyH));
		const src = image.data;
		for (let row = r0; row < r1; row++) {
			const ty = dy + row;
			if (ty < 0 || ty >= height) {
				continue;
			}
			for (let col = c0; col < c1; col++) {
				const tx = dx + col;
				if (tx < 0 || tx >= width) {
					continue;
				}
				const si = (row * image.width + col) * 4;
				const di = (ty * width + tx) * 4;
				const a = src[si + 3];
				if (a === 255) {
					data[di] = src[si];
					data[di + 1] = src[si + 1];
					data[di + 2] = src[si + 2];
				} else {
					const k = a / 255;
					data[di] = src[si] * k;
					data[di + 1] = src[si + 1] * k;
					data[di + 2] = src[si + 2] * k;
				}
				data[di + 3] = a;
				if (unknown) {
					unknown[ty * width + tx] = 0;
				}
			}
		}
	}
}

