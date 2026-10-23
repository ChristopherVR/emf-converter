/**
 * Vector PDF output from an SVG tree.
 *
 * The SVG backend (`svg-context.ts`) replays every metafile record onto a
 * small, regular set of SVG elements. This module serialises that tree as a
 * PDF 1.7 document, so PDF output reuses all of the replay logic:
 *
 * - `path` fills and strokes become path-painting operators (fill rule,
 *   line width / cap / join / miter limit / dashes, the element's
 *   `transform`); `fill-opacity`, `stroke-opacity`, image `opacity` and
 *   `mix-blend-mode` go through `ExtGState`.
 * - `clipPath` chains become `W n` clips (an intersection per level).
 * - `linearGradient` / `radialGradient` become shading patterns (axial /
 *   radial shadings with stitched exponential functions, extended on both
 *   sides, which is SVG's `pad`); gradients with varying stop opacity add a
 *   luminosity soft mask holding the alpha ramp.
 * - `pattern` tiles become tiling patterns.
 * - `image` elements embed JPEG as `DCTDecode` verbatim and everything else
 *   as Flate-compressed RGB with an `SMask` for alpha; nested metafiles
 *   (embedded SVG data URLs) become form XObjects.
 * - `text` becomes real text (see `pdf-font.ts`) at the per-glyph positions
 *   the tree gives.
 *
 * @module pdf-svg
 */

import { decodeImageBytesBuiltIn } from './emf-canvas-helpers';
import { emfWarn } from './emf-logging';
import { PdfFontBook, type PdfFont } from './pdf-font';
import { PdfWriter, num, pdfTextString, latin1Bytes } from './pdf-writer';
import { parseSvgMarkup } from './svg-parse';
import type { SvgNode } from './svg-tree';

/** Decoded straight-alpha RGBA pixels returned by a custom image decoder. */
export interface PdfDecodedImage {
	data: Uint8ClampedArray | Uint8Array;
	width: number;
	height: number;
}

/** Options for {@link svgTreeToPdf} (and, with the SVG options, `convertMetafileToPdf`). */
export interface PdfOptions {
	/**
	 * The page size. `'drawing'` (default) makes the page exactly the
	 * drawing, 1 CSS pixel = 0.75 pt. `{ width, height }` (points) makes a
	 * page of that size with the drawing scaled to fit and centred.
	 */
	pageSize?: 'drawing' | { width: number; height: number };
	/**
	 * TrueType fonts (`.ttf` / `.ttc` bytes) to embed. Text whose font family
	 * matches one of them is embedded as a subset of that face, so it looks
	 * as the font draws it and stays selectable and searchable. Other text
	 * uses the standard PDF fonts (Helvetica, Times, Courier), whose glyph
	 * shapes differ from the original font.
	 */
	fonts?: Array<ArrayBuffer | ArrayBufferView>;
	/** Deflate content streams and image data. Default `true`. */
	compress?: boolean;
	/** Document title for the PDF information dictionary. */
	title?: string;
	/**
	 * Decodes an embedded image that is neither JPEG nor handled by the
	 * bundled decoders (PNG, BMP, GIF, TIFF), returning straight RGBA, or
	 * `null` to skip the image. The default has no WebP decoder.
	 */
	decodeImage?: (bytes: Uint8Array, mime: string) => Promise<PdfDecodedImage | null> | PdfDecodedImage | null;
}

// ---------------------------------------------------------------------------
// Matrices, colours, small parsers
// ---------------------------------------------------------------------------

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

const isIdentity = (m: Matrix): boolean => m.every((v, i) => v === IDENTITY[i]);
const matrixOp = (m: Matrix): string => `${m.map(num).join(' ')} cm`;

/** Parses an SVG `transform` list (matrix / translate / scale / rotate), or the identity. */
function parseTransform(value: string | number | undefined): Matrix {
	let m: Matrix = [...IDENTITY];
	if (value === undefined) {
		return m;
	}
	const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
	let t: RegExpExecArray | null;
	while ((t = re.exec(String(value)))) {
		const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
		let n: Matrix | null = null;
		if (t[1] === 'matrix' && a.length === 6) {
			n = a as Matrix;
		} else if (t[1] === 'translate') {
			n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
		} else if (t[1] === 'scale') {
			n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
		} else if (t[1] === 'rotate') {
			const r = ((a[0] ?? 0) * Math.PI) / 180;
			const c = Math.cos(r);
			const s = Math.sin(r);
			n = [c, s, -s, c, 0, 0];
			if (a.length === 3) {
				n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
			}
		}
		if (n && n.every(Number.isFinite)) {
			m = mul(m, n);
		}
	}
	return m;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
	black: [0, 0, 0],
	white: [255, 255, 255],
	red: [255, 0, 0],
	green: [0, 128, 0],
	lime: [0, 255, 0],
	blue: [0, 0, 255],
	yellow: [255, 255, 0],
	cyan: [0, 255, 255],
	aqua: [0, 255, 255],
	magenta: [255, 0, 255],
	fuchsia: [255, 0, 255],
	gray: [128, 128, 128],
	grey: [128, 128, 128],
	silver: [192, 192, 192],
	maroon: [128, 0, 0],
	navy: [0, 0, 128],
	olive: [128, 128, 0],
	purple: [128, 0, 128],
	teal: [0, 128, 128],
	orange: [255, 165, 0],
};

/** Parses an opaque SVG colour (`#rgb`, `#rrggbb`, `rgb()`, a basic name) into 0..255 channels. */
function parseColor(s: string): [number, number, number] | null {
	const v = s.trim().toLowerCase();
	let m = /^#([0-9a-f]{6})/.exec(v);
	if (m) {
		const n = parseInt(m[1], 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
	if (m) {
		return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
	}
	m = /^rgba?\(([^)]*)\)$/.exec(v);
	if (m) {
		const p = m[1].split(/[\s,/]+/).filter(Boolean);
		const ch = (x: string | undefined): number =>
			Math.max(0, Math.min(255, x === undefined ? 0 : x.endsWith('%') ? (parseFloat(x) * 255) / 100 : parseFloat(x)));
		return [ch(p[0]), ch(p[1]), ch(p[2])];
	}
	return NAMED_COLORS[v] ?? null;
}

const rgbOps = (c: [number, number, number]): string => c.map((v) => num(v / 255)).join(' ');

const numAttr = (v: string | number | undefined, fallback = 0): number => {
	const n = typeof v === 'number' ? v : v === undefined ? NaN : parseFloat(v);
	return Number.isFinite(n) ? n : fallback;
};

function numberList(v: string | number | undefined): number[] {
	if (v === undefined) {
		return [];
	}
	return String(v)
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(Number)
		.filter(Number.isFinite);
}

function parseStyleAttr(style: string | number | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const decl of String(style ?? '').split(';')) {
		const i = decl.indexOf(':');
		if (i > 0) {
			out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
		}
	}
	return out;
}

const BLEND_NAMES: Record<string, string> = {
	multiply: 'Multiply',
	screen: 'Screen',
	overlay: 'Overlay',
	darken: 'Darken',
	lighten: 'Lighten',
	'color-dodge': 'ColorDodge',
	'color-burn': 'ColorBurn',
	'hard-light': 'HardLight',
	'soft-light': 'SoftLight',
	difference: 'Difference',
	exclusion: 'Exclusion',
	hue: 'Hue',
	saturation: 'Saturation',
	color: 'Color',
	luminosity: 'Luminosity',
};

/** The `url(#id)` target of a paint / clip-path attribute. */
function urlRef(v: string | number | undefined): string | null {
	const m = /^url\(\s*#([^)\s]+)\s*\)$/.exec(String(v ?? '').trim());
	return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Path data -> PDF path operators
// ---------------------------------------------------------------------------

/** Converts SVG path data to PDF path-construction operators. Arcs degrade to straight lines. */
export function svgPathToPdf(d: string): string {
	const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
	const out: string[] = [];
	let i = 0;
	let cmd = '';
	let cx = 0;
	let cy = 0;
	let sx = 0;
	let sy = 0;
	// Last control point (absolute) for smooth curves, and its kind.
	let lcx = 0;
	let lcy = 0;
	let lastKind = '' as 'c' | 'q' | '';
	let needMove = false;
	const n = (): number => parseFloat(toks[i++]);
	const hasNum = (): boolean => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
	const ensureMove = (): void => {
		if (needMove) {
			out.push(`${num(sx)} ${num(sy)} m`);
			needMove = false;
		}
	};
	const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
		ensureMove();
		out.push(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)} c`);
		lcx = x2;
		lcy = y2;
		lastKind = 'c';
		cx = x;
		cy = y;
	};
	while (i < toks.length) {
		if (/^[a-zA-Z]$/.test(toks[i])) {
			cmd = toks[i++];
			if (cmd === 'z' || cmd === 'Z') {
				out.push('h');
				cx = sx;
				cy = sy;
				needMove = true;
				lastKind = '';
				continue;
			}
		} else if (!cmd) {
			break;
		}
		const rel = cmd === cmd.toLowerCase();
		const ox = rel ? cx : 0;
		const oy = rel ? cy : 0;
		const upper = cmd.toUpperCase();
		if (upper !== 'C' && upper !== 'S' && upper !== 'Q' && upper !== 'T') {
			lastKind = '';
		}
		if (!hasNum()) {
			cmd = '';
			continue;
		}
		switch (upper) {
			case 'M': {
				const x = n() + ox;
				const y = n() + oy;
				out.push(`${num(x)} ${num(y)} m`);
				cx = sx = x;
				cy = sy = y;
				needMove = false;
				cmd = rel ? 'l' : 'L';
				break;
			}
			case 'L': {
				const x = n() + ox;
				const y = n() + oy;
				ensureMove();
				out.push(`${num(x)} ${num(y)} l`);
				cx = x;
				cy = y;
				break;
			}
			case 'H': {
				const x = n() + ox;
				ensureMove();
				out.push(`${num(x)} ${num(cy)} l`);
				cx = x;
				break;
			}
			case 'V': {
				const y = n() + oy;
				ensureMove();
				out.push(`${num(cx)} ${num(y)} l`);
				cy = y;
				break;
			}
			case 'C': {
				const x1 = n() + ox;
				const y1 = n() + oy;
				const x2 = n() + ox;
				const y2 = n() + oy;
				cubic(x1, y1, x2, y2, n() + ox, n() + oy);
				break;
			}
			case 'S': {
				const x1 = lastKind === 'c' ? 2 * cx - lcx : cx;
				const y1 = lastKind === 'c' ? 2 * cy - lcy : cy;
				const x2 = n() + ox;
				const y2 = n() + oy;
				cubic(x1, y1, x2, y2, n() + ox, n() + oy);
				break;
			}
			case 'Q':
			case 'T': {
				let qx: number;
				let qy: number;
				if (upper === 'Q') {
					qx = n() + ox;
					qy = n() + oy;
				} else {
					qx = lastKind === 'q' ? 2 * cx - lcx : cx;
					qy = lastKind === 'q' ? 2 * cy - lcy : cy;
				}
				const x = n() + ox;
				const y = n() + oy;
				const px = cx;
				const py = cy;
				cubic(px + (2 / 3) * (qx - px), py + (2 / 3) * (qy - py), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
				lcx = qx;
				lcy = qy;
				lastKind = 'q';
				break;
			}
			case 'A': {
				i += 5;
				const x = n() + ox;
				const y = n() + oy;
				ensureMove();
				out.push(`${num(x)} ${num(y)} l`);
				cx = x;
				cy = y;
				emfWarn('PDF: SVG arc segment approximated by a straight line');
				break;
			}
			default:
				i = toks.length;
		}
	}
	return out.join(' ');
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

type Prepared =
	| { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number; components: number; invertedCmyk: boolean }
	| { kind: 'raster'; rgb: Uint8Array; alpha: Uint8Array | null; width: number; height: number }
	| { kind: 'svg'; tree: SvgNode; width: number; height: number };

function base64Decode(b64: string): Uint8Array {
	const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	const val = (c: number): number =>
		c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 71 : c >= 48 && c <= 57 ? c + 4 : c === 43 ? 62 : 63;
	let o = 0;
	for (let i = 0; i < clean.length; i += 4) {
		const a = val(clean.charCodeAt(i));
		const b = val(clean.charCodeAt(i + 1));
		const c = i + 2 < clean.length ? val(clean.charCodeAt(i + 2)) : 0;
		const d = i + 3 < clean.length ? val(clean.charCodeAt(i + 3)) : 0;
		const triple = (a << 18) | (b << 12) | (c << 6) | d;
		if (o < out.length) out[o++] = (triple >> 16) & 255;
		if (o < out.length) out[o++] = (triple >> 8) & 255;
		if (o < out.length) out[o++] = triple & 255;
	}
	return out;
}

function utf8Decode(bytes: Uint8Array): string {
	if (typeof TextDecoder !== 'undefined') {
		return new TextDecoder().decode(bytes);
	}
	let s = '';
	for (const b of bytes) {
		s += String.fromCharCode(b);
	}
	return s;
}

/** Reads the frame header of a JPEG: size, component count, and whether an Adobe marker inverts CMYK. */
function readJpegHeader(b: Uint8Array): { width: number; height: number; components: number; adobe: boolean } | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
		return null;
	}
	let adobe = false;
	let p = 2;
	while (p + 4 <= b.length) {
		if (b[p] !== 0xff) {
			p++;
			continue;
		}
		const marker = b[p + 1];
		if (marker === 0xff) {
			p++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			p += 2;
			continue;
		}
		const len = (b[p + 2] << 8) | b[p + 3];
		if (marker === 0xee && len >= 12 && b[p + 4] === 0x41 && b[p + 5] === 0x64 && b[p + 6] === 0x6f) {
			adobe = true;
		}
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (p + 10 > b.length) {
				return null;
			}
			return { height: (b[p + 5] << 8) | b[p + 6], width: (b[p + 7] << 8) | b[p + 8], components: b[p + 9], adobe };
		}
		p += 2 + len;
	}
	return null;
}

function rasterFromRgba(data: ArrayLike<number>, width: number, height: number): Prepared {
	const n = width * height;
	const rgb = new Uint8Array(n * 3);
	const alpha = new Uint8Array(n);
	let translucent = false;
	for (let i = 0; i < n; i++) {
		rgb[i * 3] = data[i * 4];
		rgb[i * 3 + 1] = data[i * 4 + 1];
		rgb[i * 3 + 2] = data[i * 4 + 2];
		const a = data[i * 4 + 3];
		alpha[i] = a;
		if (a !== 255) {
			translucent = true;
		}
	}
	return { kind: 'raster', rgb, alpha: translucent ? alpha : null, width, height };
}

// ---------------------------------------------------------------------------
// Content streams and resources
// ---------------------------------------------------------------------------

type ResCategory = 'ExtGState' | 'Pattern' | 'XObject' | 'Font' | 'Shading';
const RES_PREFIX: Record<ResCategory, string> = { ExtGState: 'G', Pattern: 'P', XObject: 'X', Font: 'F', Shading: 'S' };

/** The resource dictionary of one content stream (page, tile, or form). */
class Resources {
	private readonly maps = new Map<ResCategory, Map<number, string>>();

	/** The name (with leading slash) under which `obj` is used in this stream. */
	use(category: ResCategory, obj: number): string {
		let m = this.maps.get(category);
		if (!m) {
			m = new Map();
			this.maps.set(category, m);
		}
		let name = m.get(obj);
		if (!name) {
			name = `${RES_PREFIX[category]}${m.size + 1}`;
			m.set(obj, name);
		}
		return `/${name}`;
	}

	dict(): string {
		let out = '<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI]';
		for (const [cat, m] of this.maps) {
			out += ` /${cat} << ${[...m].map(([obj, name]) => `/${name} ${obj} 0 R`).join(' ')} >>`;
		}
		return out + ' >>';
	}
}

interface Content {
	ops: string[];
	res: Resources;
	/** The stream's visible area in its own base space (for soft-mask extents). */
	bounds: [number, number, number, number];
}

interface Scope {
	defs: Map<string, SvgNode>;
}

function indexIds(node: SvgNode, defs: Map<string, SvgNode>): void {
	const id = node.attrs.id;
	if (id !== undefined) {
		defs.set(String(id), node);
	}
	for (const c of node.children ?? []) {
		indexIds(c, defs);
	}
}

interface Stop {
	offset: number;
	color: [number, number, number];
	alpha: number;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

class PdfBuilder {
	readonly writer = new PdfWriter();
	readonly fontBook: PdfFontBook;
	readonly prepared = new Map<string, Prepared | null>();
	private readonly gsCache = new Map<string, number>();
	private readonly cache = new Map<string, number>();
	private readonly imageObjs = new Map<Prepared, { smooth?: number; sharp?: number }>();
	private readonly alphaImages = new Map<Prepared, number>();
	private readonly smaskObjs = new Map<string, number>();
	private readonly formObjs = new Map<string, number>();
	readonly compress: boolean;
	private readonly warned = new Set<string>();

	constructor(private readonly options: PdfOptions) {
		this.compress = options.compress ?? true;
		this.fontBook = new PdfFontBook(this.writer, options.fonts ?? [], this.compress);
	}

	warnOnce(msg: string): void {
		if (!this.warned.has(msg)) {
			this.warned.add(msg);
			emfWarn(`PDF: ${msg}`);
		}
	}

	// ---- image preparation (async decode, before the synchronous walk) ----

	async prepare(node: SvgNode): Promise<void> {
		if (node.tag === 'image') {
			const href = node.attrs.href ?? node.attrs['xlink:href'];
			if (typeof href === 'string' && !this.prepared.has(href)) {
				this.prepared.set(href, null);
				this.prepared.set(href, await this.prepareImage(href));
			}
		}
		for (const c of node.children ?? []) {
			await this.prepare(c);
		}
	}

	private async prepareImage(href: string): Promise<Prepared | null> {
		const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(href);
		if (!m) {
			this.warnOnce('external image reference skipped (only data: URLs are embedded)');
			return null;
		}
		const mime = m[1].toLowerCase();
		const bytes = m[2].includes(';base64')
			? base64Decode(m[3])
			: latin1Bytes(decodeURIComponent(m[3]));
		if (mime === 'image/svg+xml') {
			const tree = parseSvgMarkup(utf8Decode(bytes));
			if (!tree) {
				this.warnOnce('nested SVG image could not be parsed');
				return null;
			}
			await this.prepare(tree);
			const vb = numberList(tree.attrs.viewBox);
			return { kind: 'svg', tree, width: vb[2] ?? numAttr(tree.attrs.width, 1), height: vb[3] ?? numAttr(tree.attrs.height, 1) };
		}
		const jpeg = readJpegHeader(bytes);
		if (jpeg && (jpeg.components === 1 || jpeg.components === 3 || jpeg.components === 4) && jpeg.width > 0 && jpeg.height > 0) {
			return {
				kind: 'jpeg',
				bytes,
				width: jpeg.width,
				height: jpeg.height,
				components: jpeg.components,
				invertedCmyk: jpeg.components === 4 && jpeg.adobe,
			};
		}
		let pixels: PdfDecodedImage | null = null;
		try {
			pixels = await decodeImageBytesBuiltIn(bytes);
			if (!pixels && this.options.decodeImage) {
				pixels = await this.options.decodeImage(bytes, mime);
			}
		} catch {
			pixels = null;
		}
		if (!pixels || pixels.width <= 0 || pixels.height <= 0) {
			this.warnOnce(`image skipped: no decoder for ${mime || 'unknown'} data`);
			return null;
		}
		return rasterFromRgba(pixels.data, pixels.width, pixels.height);
	}

	// ---- shared PDF objects ----

	private imageObj(p: Extract<Prepared, { kind: 'jpeg' | 'raster' }>, smooth: boolean): number {
		const slot = this.imageObjs.get(p) ?? {};
		this.imageObjs.set(p, slot);
		const existing = smooth ? slot.smooth : slot.sharp;
		if (existing) {
			return existing;
		}
		const interp = `/Interpolate ${smooth}`;
		let obj: number;
		if (p.kind === 'jpeg') {
			// The DCT filter is named in the dictionary, so Flate must not be layered on top.
			const cs = p.components === 1 ? '/DeviceGray' : p.components === 3 ? '/DeviceRGB' : '/DeviceCMYK';
			obj = this.writer.addStream(
				`/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace ${cs} /BitsPerComponent 8 ` +
					`${p.invertedCmyk ? '/Decode [1 0 1 0 1 0 1 0] ' : ''}/Filter /DCTDecode ${interp}`,
				p.bytes,
				false,
			);
		} else {
			let smask = '';
			if (p.alpha) {
				let so = this.alphaImages.get(p);
				if (!so) {
					so = this.writer.addStream(
						`/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceGray /BitsPerComponent 8 ${interp}`,
						p.alpha,
						this.compress,
					);
					this.alphaImages.set(p, so);
				}
				smask = ` /SMask ${so} 0 R`;
			}
			obj = this.writer.addStream(
				`/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ${interp}${smask}`,
				p.rgb,
				this.compress,
			);
		}
		if (smooth) slot.smooth = obj;
		else slot.sharp = obj;
		return obj;
	}

	/** An ExtGState for fill / stroke alpha, a blend mode, and an optional soft mask. */
	private gsObj(alpha: number, blend: string | null, smask: number): number {
		const key = `${num(alpha)}|${blend ?? ''}|${smask}`;
		let obj = this.gsCache.get(key);
		if (!obj) {
			obj = this.writer.add(
				`<< /Type /ExtGState /ca ${num(alpha)} /CA ${num(alpha)}${blend ? ` /BM /${blend}` : ''}` +
					`${smask ? ` /SMask << /Type /Mask /S /Luminosity /G ${smask} 0 R >>` : ''} >>`,
			);
			this.gsCache.set(key, obj);
		}
		return obj;
	}

	private cached(key: string, build: () => number): number {
		let obj = this.cache.get(key);
		if (obj === undefined) {
			obj = build();
			this.cache.set(key, obj);
		}
		return obj;
	}

	// ---- gradients ----

	private gradientStops(g: SvgNode): Stop[] {
		const stops: Stop[] = [];
		for (const s of g.children ?? []) {
			if (s.tag !== 'stop') {
				continue;
			}
			const offset = Math.max(0, Math.min(1, numAttr(s.attrs.offset, 0)));
			const color = parseColor(String(s.attrs['stop-color'] ?? '#000000')) ?? [0, 0, 0];
			stops.push({ offset, color, alpha: Math.max(0, Math.min(1, numAttr(s.attrs['stop-opacity'], 1))) });
		}
		stops.sort((a, b) => a.offset - b.offset);
		return stops;
	}

	/** A stitched exponential function over `[0 1]` for the stops, with `channels` extracting each stop's value(s). */
	private stopFunction(stops: Stop[], channels: (s: Stop) => number[]): number {
		const pts = [...stops];
		if (pts[0].offset > 0) {
			pts.unshift({ ...pts[0], offset: 0 });
		}
		if (pts[pts.length - 1].offset < 1) {
			pts.push({ ...pts[pts.length - 1], offset: 1 });
		}
		const seg = (a: Stop, b: Stop): number =>
			this.writer.add(
				`<< /FunctionType 2 /Domain [0 1] /C0 [${channels(a).map(num).join(' ')}] /C1 [${channels(b).map(num).join(' ')}] /N 1 >>`,
			);
		if (pts.length === 2) {
			return seg(pts[0], pts[1]);
		}
		const fns: number[] = [];
		for (let i = 0; i + 1 < pts.length; i++) {
			fns.push(seg(pts[i], pts[i + 1]));
		}
		const bounds = pts.slice(1, -1).map((p) => num(p.offset));
		return this.writer.add(
			`<< /FunctionType 3 /Domain [0 1] /Functions [${fns.map((f) => `${f} 0 R`).join(' ')}] /Bounds [${bounds.join(' ')}] ` +
				`/Encode [${fns.map(() => '0 1').join(' ')}] >>`,
		);
	}

	/**
	 * The shading dictionary for a gradient node: colour (RGB) or its alpha
	 * ramp (gray). `null` for a degenerate gradient (painted as the last
	 * stop's solid colour by the caller).
	 */
	private shadingObj(g: SvgNode, stops: Stop[], alphaRamp: boolean): number | null {
		const key = `sh:${g.attrs.id}:${alphaRamp}`;
		const a = g.attrs;
		let coords: string;
		let type: number;
		if (g.tag === 'linearGradient') {
			const x1 = numAttr(a.x1);
			const y1 = numAttr(a.y1);
			const x2 = numAttr(a.x2);
			const y2 = numAttr(a.y2);
			if (x1 === x2 && y1 === y2) {
				return null;
			}
			coords = [x1, y1, x2, y2].map(num).join(' ');
			type = 2;
		} else {
			const fx = numAttr(a.fx, numAttr(a.cx));
			const fy = numAttr(a.fy, numAttr(a.cy));
			const fr = Math.max(0, numAttr(a.fr));
			const cx = numAttr(a.cx);
			const cy = numAttr(a.cy);
			const r = Math.max(0, numAttr(a.r));
			if (r === 0 && fr === 0) {
				return null;
			}
			coords = [fx, fy, fr, cx, cy, r].map(num).join(' ');
			type = 3;
		}
		return this.cached(key, () => {
			const fn = this.stopFunction(stops, alphaRamp ? (s) => [s.alpha] : (s) => s.color.map((v) => v / 255));
			return this.writer.add(
				`<< /ShadingType ${type} /ColorSpace ${alphaRamp ? '/DeviceGray' : '/DeviceRGB'} /Coords [${coords}] /Function ${fn} 0 R /Extend [true true] >>`,
			);
		});
	}

	/**
	 * Applies a paint to the content: ExtGState (alpha, blend, soft mask) and
	 * the colour / pattern. Returns false when nothing would be visible.
	 */
	applyPaint(
		c: Content,
		paint: string,
		opacity: number,
		blend: string | null,
		stroke: boolean,
		ctm: Matrix,
		scope: Scope,
	): boolean {
		if (opacity <= 0 || paint === 'none') {
			return false;
		}
		let smask = 0;
		let colorOp: string;
		const ref = urlRef(paint);
		if (ref) {
			const node = scope.defs.get(ref);
			if (!node) {
				return false;
			}
			if (node.tag === 'linearGradient' || node.tag === 'radialGradient') {
				const stops = this.gradientStops(node);
				if (stops.length === 0) {
					return false;
				}
				const gt = parseTransform(node.attrs.gradientTransform);
				const alphas = new Set(stops.map((s) => s.alpha));
				const shading = this.shadingObj(node, stops, false);
				if (alphas.size === 1) {
					opacity *= stops[0].alpha;
				}
				if (opacity <= 0) {
					return false;
				}
				if (shading === null) {
					// Degenerate geometry paints the last stop's colour.
					const last = stops[stops.length - 1];
					colorOp = `${rgbOps(last.color)} ${stroke ? 'RG' : 'rg'}`;
				} else {
					if (alphas.size > 1) {
						smask = this.alphaMask(c, node, stops, gt, ctm);
					}
					const pattern = this.cached(`gp:${node.attrs.id}:${mul(ctm, gt).map(num).join(',')}`, () =>
						this.writer.add(`<< /Type /Pattern /PatternType 2 /Shading ${shading} 0 R /Matrix [${mul(ctm, gt).map(num).join(' ')}] >>`),
					);
					colorOp = `/Pattern ${stroke ? 'CS' : 'cs'} ${c.res.use('Pattern', pattern)} ${stroke ? 'SCN' : 'scn'}`;
				}
			} else if (node.tag === 'pattern') {
				const pattern = this.tilingPattern(node, ctm, scope);
				if (!pattern) {
					return false;
				}
				colorOp = `/Pattern ${stroke ? 'CS' : 'cs'} ${c.res.use('Pattern', pattern)} ${stroke ? 'SCN' : 'scn'}`;
			} else {
				return false;
			}
		} else {
			const col = parseColor(paint);
			if (!col) {
				return false;
			}
			colorOp = `${rgbOps(col)} ${stroke ? 'RG' : 'rg'}`;
		}
		if (opacity < 1 || blend || smask) {
			c.ops.push(`${c.res.use('ExtGState', this.gsObj(Math.min(1, opacity), blend, smask))} gs`);
		}
		c.ops.push(colorOp);
		return true;
	}

	/** A luminosity soft mask holding a gradient's alpha ramp, in the user space of `ctm`. */
	private alphaMask(c: Content, g: SvgNode, stops: Stop[], gt: Matrix, ctm: Matrix): number {
		const shading = this.shadingObj(g, stops, true);
		if (shading === null) {
			return 0;
		}
		const i = inv(ctm);
		let bbox = [-1e5, -1e5, 1e5, 1e5];
		if (i) {
			const [x0, y0, x1, y1] = c.bounds;
			const pts = [
				[x0, y0],
				[x1, y0],
				[x0, y1],
				[x1, y1],
			].map(([x, y]) => [i[0] * x + i[2] * y + i[4], i[1] * x + i[3] * y + i[5]]);
			bbox = [
				Math.min(...pts.map((p) => p[0])),
				Math.min(...pts.map((p) => p[1])),
				Math.max(...pts.map((p) => p[0])),
				Math.max(...pts.map((p) => p[1])),
			];
		}
		const key = `sm:${g.attrs.id}:${ctm.map(num).join(',')}:${bbox.map(num).join(',')}`;
		let obj = this.smaskObjs.get(key);
		if (obj === undefined) {
			const res = new Resources();
			const name = res.use('Shading', shading);
			obj = this.writer.addStream(
				`/Type /XObject /Subtype /Form /FormType 1 /BBox [${bbox.map(num).join(' ')}] ` +
					`/Group << /S /Transparency /CS /DeviceGray >> /Resources ${res.dict()}`,
				latin1Bytes(`${isIdentity(gt) ? '' : matrixOp(gt) + '\n'}${name} sh`),
				this.compress,
			);
			this.smaskObjs.set(key, obj);
		}
		return obj;
	}

	private tilingPattern(p: SvgNode, ctm: Matrix, scope: Scope): number | null {
		const tw = numAttr(p.attrs.width);
		const th = numAttr(p.attrs.height);
		if (tw <= 0 || th <= 0) {
			return null;
		}
		const m = mul(ctm, parseTransform(p.attrs.patternTransform));
		return this.cached(`tp:${p.attrs.id}:${m.map(num).join(',')}`, () => {
			const tile: Content = { ops: [], res: new Resources(), bounds: [0, 0, tw, th] };
			for (const child of p.children ?? []) {
				this.render(child, tile, IDENTITY, scope);
			}
			return this.writer.addStream(
				`/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 ${num(tw)} ${num(th)}] ` +
					`/XStep ${num(tw)} /YStep ${num(th)} /Matrix [${m.map(num).join(' ')}] /Resources ${tile.res.dict()}`,
				latin1Bytes(tile.ops.join('\n')),
				this.compress,
			);
		});
	}

	// ---- rendering ----

	private clipOps(c: Content, value: string | number | undefined, scope: Scope, depth = 0): void {
		const id = urlRef(value);
		const node = id ? scope.defs.get(id) : undefined;
		if (!node || node.tag !== 'clipPath' || depth > 64) {
			return;
		}
		this.clipOps(c, node.attrs['clip-path'], scope, depth + 1);
		const parts: string[] = [];
		let evenodd = false;
		for (const child of node.children ?? []) {
			if (child.attrs['clip-path'] !== undefined) {
				this.clipOps(c, child.attrs['clip-path'], scope, depth + 1);
			}
			const t = child.attrs.transform !== undefined ? parseTransform(child.attrs.transform) : null;
			if (t) {
				// Rare: bake the transform into the clip by wrapping it in cm (restored by the caller's Q).
				c.ops.push(matrixOp(t));
			}
			if (child.tag === 'path') {
				parts.push(svgPathToPdf(String(child.attrs.d ?? '')));
			} else if (child.tag === 'rect') {
				const x = numAttr(child.attrs.x);
				const y = numAttr(child.attrs.y);
				parts.push(`${num(x)} ${num(y)} ${num(numAttr(child.attrs.width))} ${num(numAttr(child.attrs.height))} re`);
			}
			if (child.attrs['clip-rule'] === 'evenodd') {
				evenodd = true;
			}
		}
		const path = parts.join(' ').trim();
		c.ops.push(path ? `${path} ${evenodd ? 'W*' : 'W'} n` : '0 0 0 0 re W n');
	}

	/** Renders a node under `ctm` (user space to the stream's base space). */
	render(node: SvgNode, c: Content, ctm: Matrix, scope: Scope): void {
		switch (node.tag) {
			case 'defs':
			case 'clipPath':
			case 'linearGradient':
			case 'radialGradient':
			case 'pattern':
				return;
			case 'g': {
				c.ops.push('q');
				let m = ctm;
				if (node.attrs.transform !== undefined) {
					const t = parseTransform(node.attrs.transform);
					c.ops.push(matrixOp(t));
					m = mul(ctm, t);
				}
				this.clipOps(c, node.attrs['clip-path'], scope);
				for (const child of node.children ?? []) {
					this.render(child, c, m, scope);
				}
				c.ops.push('Q');
				return;
			}
			case 'path':
				this.renderPath(node, c, ctm, scope);
				return;
			case 'text':
				this.renderText(node, c, ctm, scope);
				return;
			case 'image':
				this.renderImage(node, c, ctm, scope);
				return;
			default:
				this.warnOnce(`unsupported SVG element <${node.tag}> skipped`);
		}
	}

	private renderPath(node: SvgNode, c: Content, ctm: Matrix, scope: Scope): void {
		const a = node.attrs;
		const d = svgPathToPdf(String(a.d ?? ''));
		if (!d) {
			return;
		}
		const style = parseStyleAttr(a.style);
		const blend = BLEND_NAMES[style['mix-blend-mode']] ?? null;
		const t = a.transform !== undefined ? parseTransform(a.transform) : null;
		const m = t ? mul(ctm, t) : ctm;
		if (!isFinite(m[0] + m[3]) || m[0] * m[3] - m[1] * m[2] === 0) {
			return;
		}
		const fill = a.fill === undefined ? '#000000' : String(a.fill);
		if (fill !== 'none') {
			c.ops.push('q');
			if (t) {
				c.ops.push(matrixOp(t));
			}
			if (this.applyPaint(c, fill, numAttr(a['fill-opacity'], 1), blend, false, m, scope)) {
				c.ops.push(`${d} ${a['fill-rule'] === 'evenodd' ? 'f*' : 'f'}`);
			}
			c.ops.push('Q');
		}
		if (a.stroke !== undefined && a.stroke !== 'none') {
			c.ops.push('q');
			if (t) {
				c.ops.push(matrixOp(t));
			}
			if (this.applyPaint(c, String(a.stroke), numAttr(a['stroke-opacity'], 1), blend, true, m, scope)) {
				c.ops.push(`${num(numAttr(a['stroke-width'], 1))} w`);
				const cap = { butt: 0, round: 1, square: 2 }[String(a['stroke-linecap'] ?? 'butt')] ?? 0;
				const join = { miter: 0, round: 1, bevel: 2 }[String(a['stroke-linejoin'] ?? 'miter')] ?? 0;
				c.ops.push(`${cap} J ${join} j`);
				c.ops.push(`${num(Math.max(1, numAttr(a['stroke-miterlimit'], 10)))} M`);
				const dash = numberList(a['stroke-dasharray']);
				if (dash.length && dash.some((v) => v > 0) && dash.every((v) => v >= 0)) {
					c.ops.push(`[${dash.map(num).join(' ')}] ${num(numAttr(a['stroke-dashoffset'], 0))} d`);
				}
				c.ops.push(`${d} S`);
			}
			c.ops.push('Q');
		}
	}

	private renderImage(node: SvgNode, c: Content, ctm: Matrix, scope: Scope): void {
		const href = node.attrs.href ?? node.attrs['xlink:href'];
		const p = typeof href === 'string' ? this.prepared.get(href) : null;
		if (!p || typeof href !== 'string') {
			return;
		}
		const a = node.attrs;
		const x = numAttr(a.x);
		const y = numAttr(a.y);
		const w = numAttr(a.width);
		const h = numAttr(a.height);
		if (w === 0 || h === 0) {
			return;
		}
		const style = parseStyleAttr(a.style);
		const blend = BLEND_NAMES[style['mix-blend-mode']] ?? null;
		const opacity = numAttr(a.opacity, 1);
		if (opacity <= 0) {
			return;
		}
		c.ops.push('q');
		if (a.transform !== undefined) {
			c.ops.push(matrixOp(parseTransform(a.transform)));
		}
		this.clipOps(c, a['clip-path'], scope);
		if (opacity < 1 || blend) {
			c.ops.push(`${c.res.use('ExtGState', this.gsObj(opacity, blend, 0))} gs`);
		}
		if (p.kind === 'svg') {
			const form = this.nestedForm(href, p);
			// Viewbox space -> the image rectangle (preserveAspectRatio="none").
			c.ops.push(matrixOp([w / p.width, 0, 0, h / p.height, x, y]));
			c.ops.push(`${c.res.use('XObject', form)} Do`);
		} else {
			const smooth = !(style['image-rendering'] === 'pixelated' || a['image-rendering'] === 'optimizeSpeed');
			const obj = this.imageObj(p, smooth);
			c.ops.push(matrixOp([w, 0, 0, -h, x, y + h]));
			c.ops.push(`${c.res.use('XObject', obj)} Do`);
		}
		c.ops.push('Q');
	}

	private nestedForm(href: string, p: Extract<Prepared, { kind: 'svg' }>): number {
		let obj = this.formObjs.get(href);
		if (obj === undefined) {
			const vb = numberList(p.tree.attrs.viewBox);
			const bounds: [number, number, number, number] = [vb[0] ?? 0, vb[1] ?? 0, (vb[0] ?? 0) + p.width, (vb[1] ?? 0) + p.height];
			const content: Content = { ops: [], res: new Resources(), bounds };
			const scope: Scope = { defs: new Map() };
			indexIds(p.tree, scope.defs);
			for (const child of p.tree.children ?? []) {
				this.render(child, content, IDENTITY, scope);
			}
			obj = this.writer.addStream(
				`/Type /XObject /Subtype /Form /FormType 1 /BBox [${bounds.map(num).join(' ')}] ` +
					`/Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources ${content.res.dict()}`,
				latin1Bytes(content.ops.join('\n')),
				this.compress,
			);
			this.formObjs.set(href, obj);
		}
		return obj;
	}

	private renderText(node: SvgNode, c: Content, ctm: Matrix, scope: Scope): void {
		const text = node.text;
		const a = node.attrs;
		if (!text) {
			return;
		}
		const size = numAttr(a['font-size'], 10);
		if (!(size > 0)) {
			return;
		}
		const style = parseStyleAttr(a.style);
		const blend = BLEND_NAMES[style['mix-blend-mode']] ?? null;
		const weight = String(a['font-weight'] ?? '');
		const bold = weight === 'bold' || weight === 'bolder' || numAttr(weight, 400) >= 600;
		const italic = /italic|oblique/.test(String(a['font-style'] ?? ''));
		const families = String(a['font-family'] ?? 'sans-serif');
		const font: PdfFont = this.fontBook.resolve(families, bold, italic);
		const t = a.transform !== undefined ? parseTransform(a.transform) : null;
		const m = t ? mul(ctm, t) : ctm;
		c.ops.push('q');
		if (t) {
			c.ops.push(matrixOp(t));
		}
		if (!this.applyPaint(c, String(a.fill ?? '#000000'), numAttr(a['fill-opacity'], 1), blend, false, m, scope)) {
			c.ops.pop();
			if (t) c.ops.pop();
			return;
		}

		const xs = numberList(a.x);
		const ys = numberList(a.y);
		const glyphs: Array<{ hex: string; advance: number } | null> = [];
		const cps: number[] = [];
		for (let k = 0; k < text.length; k++) {
			const cp = text.codePointAt(k)!;
			cps[k] = cp;
			glyphs[k] = cp < 0x20 ? null : font.glyph(cp);
			if (cp > 0xffff) {
				k++;
				cps[k] = -1; // low surrogate: no glyph of its own
				glyphs[k] = null;
			}
		}
		// Single-position text (canvas fillText): alignment, baseline and textLength apply.
		let stretch = 1;
		let shiftX = 0;
		let shiftY = 0;
		if (xs.length <= 1) {
			const width = font.width(text) * size;
			const target = numAttr(a.textLength, 0);
			if (target > 0 && width > target) {
				stretch = target / width;
			}
			const anchor = a['text-anchor'];
			shiftX = anchor === 'middle' ? (-width * stretch) / 2 : anchor === 'end' ? -width * stretch : 0;
			const baseline = a['dominant-baseline'];
			shiftY =
				baseline === 'text-before-edge'
					? font.ascent * size
					: baseline === 'central'
						? ((font.ascent - font.descent) / 2) * size
						: baseline === 'text-after-edge'
							? -font.descent * size
							: baseline === 'hanging'
								? font.ascent * size * 0.8
								: baseline === 'ideographic'
									? -font.descent * size
									: 0;
		}
		const x0 = xs[0] ?? 0;
		c.ops.push('BT', `${c.res.use('Font', font.obj)} ${num(size)} Tf`);
		let px = x0;
		let padv = 0;
		for (let k = 0; k < text.length; k++) {
			if (cps[k] === -1) {
				continue;
			}
			const x = k < xs.length ? xs[k] : k === 0 ? x0 : px + padv * size;
			const y = ys.length ? ys[Math.min(k, ys.length - 1)] : 0;
			const g = glyphs[k];
			const adv = g ? g.advance : 0.5;
			if (g) {
				const tx = x0 + (x - x0) * stretch + shiftX;
				c.ops.push(`${num(stretch)} 0 0 -1 ${num(tx)} ${num(y + shiftY)} Tm <${g.hex}> Tj`);
			}
			px = x;
			padv = adv;
		}
		c.ops.push('ET', 'Q');
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function pxSize(v: string | number | undefined): number | null {
	if (v === undefined || /%/.test(String(v))) {
		return null;
	}
	const n = parseFloat(String(v));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Serialises an SVG tree (as produced by `convertMetafileToSvgTree`) as a
 * vector PDF 1.7 document.
 *
 * Only the SVG constructs the metafile backend emits are mapped: see the
 * module comment. Unknown elements are skipped. Returns `null` for a tree
 * that is not an `<svg>` with a size, or when serialisation fails.
 *
 * @param tree    - The root `<svg>` node.
 * @param options - See {@link PdfOptions}.
 */
export async function svgTreeToPdf(tree: SvgNode, options: PdfOptions = {}): Promise<Uint8Array | null> {
	try {
		if (tree.tag !== 'svg') {
			return null;
		}
		const vb = numberList(tree.attrs.viewBox);
		const widthPx = pxSize(tree.attrs.width) ?? (vb.length === 4 ? vb[2] : null);
		const heightPx = pxSize(tree.attrs.height) ?? (vb.length === 4 ? vb[3] : null);
		if (!widthPx || !heightPx) {
			return null;
		}
		const builder = new PdfBuilder(options);
		await builder.prepare(tree);

		// User space -> CSS px (viewBox), then px -> points with the y axis flipped.
		const [vbx, vby, vbw, vbh] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb : [0, 0, widthPx, heightPx];
		const toPx: Matrix = [widthPx / vbw, 0, 0, heightPx / vbh, (-vbx * widthPx) / vbw, (-vby * heightPx) / vbh];
		let pageW = widthPx * 0.75;
		let pageH = heightPx * 0.75;
		let scale = 0.75;
		let offX = 0;
		let offY = 0;
		const custom = typeof options.pageSize === 'object' ? options.pageSize : null;
		if (custom && custom.width > 0 && custom.height > 0) {
			pageW = custom.width;
			pageH = custom.height;
			scale = Math.min(pageW / widthPx, pageH / heightPx);
			offX = (pageW - widthPx * scale) / 2;
			offY = (pageH - heightPx * scale) / 2;
		}
		const toPage: Matrix = [scale, 0, 0, -scale, offX, pageH - offY];
		const base = mul(toPage, toPx);

		const content: Content = { ops: [], res: new Resources(), bounds: [0, 0, pageW, pageH] };
		const scope: Scope = { defs: new Map() };
		indexIds(tree, scope.defs);
		content.ops.push(matrixOp(base));
		if (custom) {
			// A page larger than the drawing must not show anything outside the drawing's viewport.
			content.ops.push(`${num(vbx)} ${num(vby)} ${num(vbw)} ${num(vbh)} re W n`);
		}
		for (const child of tree.children ?? []) {
			builder.render(child, content, base, scope);
		}
		builder.fontBook.finish();

		const w = builder.writer;
		const pages = w.reserve();
		const page = w.reserve();
		const contentObj = w.addStream('', latin1Bytes(content.ops.join('\n')), builder.compress);
		w.set(
			page,
			`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${num(pageW)} ${num(pageH)}] /Contents ${contentObj} 0 R ` +
				`/Resources ${content.res.dict()} /Group << /Type /Group /S /Transparency /CS /DeviceRGB /I true >> >>`,
		);
		w.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
		const catalog = w.add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
		const info = w.add(
			`<< /Producer ${pdfTextString('emf-converter')}${options.title ? ` /Title ${pdfTextString(options.title)}` : ''} >>`,
		);
		return await w.finish(catalog, info);
	} catch (err) {
		emfWarn('PDF: serialisation failed:', err instanceof Error ? err.message : err);
		return null;
	}
}
