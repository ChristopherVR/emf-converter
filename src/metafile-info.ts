/**
 * Metafile inspection: what a file contains, without rendering it.
 *
 * {@link getMetafileInfo} reads the headers and walks the record stream once
 * (plus the EMF+ object records), reusing the converter's own header parsers
 * and size helpers, and reports the format, the pixel size
 * `convertMetafileToDataUrl` would produce at default options, a record
 * histogram, the font faces the drawing names, and the embedded images.
 *
 * The font list is the most useful part: text only matches Windows when the
 * fonts a file names are passed as the `fonts` conversion option.
 *
 * @module metafile-info
 */

import { decodeAnsiRecord } from './emf-ansi';
import { computeSurfaceSize, readUtf16LE } from './emf-canvas-helpers';
import * as K from './emf-constants';
import { getRenderableEmfBounds, parseEmfHeader, parseWmfHeader } from './emf-header-parser';
import { sniffImageMime } from './emf-image-payload';
import { emfWarn } from './emf-logging';
import { walkEmfPlusObjects } from './emf-plus-texture-predecode';
import { extractEmbeddedEmf } from './wmf-embedded-emf';
import { wmfPlayback } from './wmf-mapping';

/** A rectangle as the file's header records it. */
export interface MetafileRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** One font face a metafile names. */
export interface MetafileFont {
	/** The face name as written in the file (the first spelling when several differ only in case). */
	name: string;
	/** `true` when a GDI font record (EMF `EMR_EXTCREATEFONTINDIRECTW`, WMF `META_CREATEFONTINDIRECT`) names it. */
	gdi: boolean;
	/** `true` when an EMF+ font object names it. */
	emfPlus: boolean;
}

/** The result of {@link getMetafileInfo}. */
export interface MetafileInfo {
	/**
	 * `'emf'` (plain GDI records), `'emf+'` (EMF+ only: the GDI records are a
	 * stub), `'emf+dual'` (EMF+ with a GDI fallback) or `'wmf'`.
	 */
	format: 'emf' | 'emf+' | 'emf+dual' | 'wmf';
	/** WMF only: `true` when the file has an Aldus placeable header. */
	placeable?: boolean;
	/** WMF only: `true` when the file carries its original EMF in `META_ESCAPE` comments, which the converter plays instead of the WMF records. */
	playsEmbeddedEmf?: boolean;
	/** EMF: the header's device-pixel bounds (inclusive). WMF: its bounding box in logical units. */
	bounds: MetafileRect;
	/** EMF: the header's picture frame in .01 mm. Placeable WMF: the bounding box converted to .01 mm. Otherwise `null`. */
	frame: MetafileRect | null;
	/** WMF only: logical units per inch from the placeable header (96 when absent). */
	unitsPerInch?: number;
	/** EMF only: the reference device's size in pixels (`szlDevice`), or `null` when the header's is unusable. */
	device: { width: number; height: number } | null;
	/** EMF only: the reference device's size in millimetres (`szlMillimeters`), or `null`. */
	deviceMm: { width: number; height: number } | null;
	/** Reference device resolution: EMF `szlDevice` / `szlMillimeters` (96 when unusable), WMF the converter's 96. */
	dpi: { x: number; y: number };
	/** Pixel width `convertMetafileToDataUrl` produces at default options. */
	width: number;
	/** Pixel height `convertMetafileToDataUrl` produces at default options. */
	height: number;
	/** Records read from the stream (EMF: including the header and EOF; WMF: excluding the header and EOF). */
	recordCount: number;
	/** Records read from the EMF+ streams inside `EMR_COMMENT` records. */
	emfPlusRecordCount: number;
	/** Record count by name (`EMR_*`, `META_*`, `EMFPLUS_*`; `UNKNOWN_0x..` for unnamed types). */
	recordTypes: Record<string, number>;
	/** The distinct font faces the drawing names (declared fonts; not every one is necessarily used). */
	fonts: MetafileFont[];
	/** `true` when any text-drawing record is present. */
	hasText: boolean;
	/**
	 * Embedded images. `count` includes DIBs (`image/bmp`, or the JPEG/PNG
	 * a DIB can carry), EMF+ image objects and nested metafiles
	 * (`image/emf`, `image/wmf`); `mimeTypes` lists the distinct types.
	 */
	images: { count: number; mimeTypes: string[] };
	/** Nested metafiles among `images`. */
	embeddedMetafiles: number;
	/** EMF header description (application and document names, NUL separators shown as newlines), or `null`. */
	description: string | null;
	/** `true` when the record limit was hit or the stream ends in a damaged record. */
	truncated: boolean;
}

/** Options for {@link getMetafileInfo}. */
export interface MetafileInfoOptions {
	/** Record limit per stream, as for the converters. Defaults as theirs do. */
	maxRecords?: number;
	/** ANSI code page for WMF face names, as `ansiCodePage` for the converters. Default 1252. */
	ansiCodePage?: number;
}

/** Deepest nested EMF+ metafile whose fonts are collected (the converter's recursion cap). */
const MAX_NESTING = 3;

// ---------------------------------------------------------------------------
// Record names
// ---------------------------------------------------------------------------

let nameTables: { emr: Map<number, string>; meta: Map<number, string>; plus: Map<number, string> } | null = null;

/** Reverse lookup tables over the constants in `emf-constants.ts`, built on first use. */
function names(): NonNullable<typeof nameTables> {
	if (nameTables) {
		return nameTables;
	}
	const emr = new Map<number, string>();
	const meta = new Map<number, string>();
	const plus = new Map<number, string>();
	for (const [key, value] of Object.entries(K)) {
		if (typeof value !== 'number') {
			continue;
		}
		if (key.startsWith('EMR_') && !key.startsWith('EMR_COMMENT_')) {
			emr.set(value, key);
		} else if (key.startsWith('META_')) {
			meta.set(value, key);
		} else if (key.startsWith('EMFPLUS_') && value >= 0x4001 && value <= 0x403f) {
			plus.set(value, key);
		}
	}
	nameTables = { emr, meta, plus };
	return nameTables;
}

function bump(histogram: Record<string, number>, name: string): void {
	histogram[name] = (histogram[name] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Accumulator shared by the format scanners
// ---------------------------------------------------------------------------

interface Scan {
	recordCount: number;
	emfPlusRecordCount: number;
	recordTypes: Record<string, number>;
	fonts: Map<string, MetafileFont>;
	hasText: boolean;
	imageCount: number;
	mimeTypes: Set<string>;
	embeddedMetafiles: number;
	truncated: boolean;
	/** Set by the first EMF+ header record. */
	plus: 'none' | 'only' | 'dual';
}

function newScan(): Scan {
	return {
		recordCount: 0,
		emfPlusRecordCount: 0,
		recordTypes: {},
		fonts: new Map(),
		hasText: false,
		imageCount: 0,
		mimeTypes: new Set(),
		embeddedMetafiles: 0,
		truncated: false,
		plus: 'none',
	};
}

function addFont(scan: Scan, name: string, source: 'gdi' | 'emfPlus'): void {
	if (!name) {
		return;
	}
	const key = name.toLowerCase();
	const font = scan.fonts.get(key) ?? { name, gdi: false, emfPlus: false };
	font[source] = true;
	scan.fonts.set(key, font);
}

function addImage(scan: Scan, mime: string): void {
	scan.imageCount++;
	scan.mimeTypes.add(mime);
}

/** Folds the fonts and text flag of a nested drawing into the outer scan. */
function mergeNested(scan: Scan, inner: Scan): void {
	for (const f of inner.fonts.values()) {
		if (f.gdi) {
			addFont(scan, f.name, 'gdi');
		}
		if (f.emfPlus) {
			addFont(scan, f.name, 'emfPlus');
		}
	}
	scan.hasText ||= inner.hasText;
}

/** MIME type of a packed DIB: JPEG/PNG when `biCompression` says so, else a plain bitmap. */
function dibMime(view: DataView, off: number): string | null {
	if (off < 0 || off + 20 > view.byteLength) {
		return null;
	}
	const compression = view.getUint32(off + 16, true);
	return compression === 4 ? 'image/jpeg' : compression === 5 ? 'image/png' : 'image/bmp';
}

/** MIME type of compressed image bytes (PNG, JPEG, GIF, WebP, TIFF, BMP), by signature. */
function sniffMime(bytes: Uint8Array): string {
	const known = sniffImageMime(bytes);
	if (known) {
		return known;
	}
	const b = bytes;
	if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) {
		return 'image/tiff';
	}
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
		return 'image/bmp';
	}
	// Arithmetic/CMYK JPEG is not "known" to the embedder but is still a JPEG.
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		return 'image/jpeg';
	}
	return 'application/octet-stream';
}

function parseEmfHeaderSafe(view: DataView): ReturnType<typeof parseEmfHeader> {
	try {
		return parseEmfHeader(view);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// EMF
// ---------------------------------------------------------------------------

/** EMF records that draw text. */
const EMF_TEXT = new Set([K.EMR_EXTTEXTOUTA, K.EMR_EXTTEXTOUTW, K.EMR_POLYTEXTOUTA, K.EMR_POLYTEXTOUTW, K.EMR_SMALLTEXTOUT]);

/** Byte offset of `offBmi` from the record start, for the EMF records that carry a source DIB. */
const EMF_OFF_BMI: Record<number, number> = {
	[K.EMR_BITBLT]: 84,
	[K.EMR_STRETCHBLT]: 84,
	[K.EMR_MASKBLT]: 84,
	[K.EMR_ALPHABLEND]: 84,
	[K.EMR_TRANSPARENTBLT]: 84,
	[K.EMR_PLGBLT]: 96,
	[K.EMR_SETDIBITSTODEVICE]: 48,
	[K.EMR_STRETCHDIBITS]: 48,
};

/** Counts the EMF stream's records and collects GDI fonts and DIBs. */
function scanEmfRecords(view: DataView, scan: Scan, maxRecords: number, maxPlusRecords: number): void {
	const table = names().emr;
	let off = 0;
	while (off + 8 <= view.byteLength) {
		if (scan.recordCount >= maxRecords) {
			scan.truncated = true;
			return;
		}
		const type = view.getUint32(off, true);
		const size = view.getUint32(off + 4, true);
		if (size < 8 || off + size > view.byteLength) {
			scan.truncated = true;
			return;
		}
		scan.recordCount++;
		bump(scan.recordTypes, table.get(type) ?? `UNKNOWN_0x${type.toString(16)}`);
		if (type === K.EMR_EXTCREATEFONTINDIRECTW) {
			// The converter's own layout and length gate (emf-gdi-object-handlers.ts).
			if (size >= 332) {
				addFont(scan, readUtf16LE(view, off + 8 + 32, 32), 'gdi');
			}
		} else if (EMF_TEXT.has(type)) {
			scan.hasText = true;
		} else if (type === K.EMR_COMMENT) {
			scanEmfPlusComment(view, off + 8, off + size, scan, maxPlusRecords);
		} else if (type in EMF_OFF_BMI) {
			const at = EMF_OFF_BMI[type];
			if (size >= at + 8) {
				const offBmi = view.getUint32(off + at, true);
				const cbBmi = view.getUint32(off + at + 4, true);
				if (cbBmi >= 20 && offBmi >= 8 && offBmi + cbBmi <= size) {
					const mime = dibMime(view, off + offBmi);
					if (mime) {
						addImage(scan, mime);
					}
				}
			}
		} else if (type === K.EMR_EOF) {
			return;
		}
		off += size;
	}
}

/** Reads the EMF+ stream of one `EMR_COMMENT` (if it is one): record count, names, header flags, text. */
function scanEmfPlusComment(view: DataView, dataOff: number, end: number, scan: Scan, maxRecords: number): void {
	if (dataOff + 8 > end) {
		return;
	}
	const commentSize = view.getUint32(dataOff, true);
	if (view.getUint32(dataOff + 4, true) !== K.EMFPLUS_SIGNATURE || commentSize <= 4) {
		return;
	}
	const table = names().plus;
	const streamEnd = Math.min(end, dataOff + 8 + commentSize - 4);
	let off = dataOff + 8;
	while (off + 12 <= streamEnd) {
		if (scan.emfPlusRecordCount >= maxRecords) {
			scan.truncated = true;
			return;
		}
		const type = view.getUint16(off, true);
		const flags = view.getUint16(off + 2, true);
		const size = view.getUint32(off + 4, true);
		if (size < 12 || off + size > streamEnd) {
			scan.truncated = true;
			return;
		}
		scan.emfPlusRecordCount++;
		bump(scan.recordTypes, table.get(type) ?? `UNKNOWN_0x${type.toString(16)}`);
		if (type === K.EMFPLUS_HEADER && scan.plus === 'none') {
			// Flags bit 0 is EmfPlusDual: the GDI records repeat the picture.
			scan.plus = (flags & 1) !== 0 ? 'dual' : 'only';
		} else if (type === K.EMFPLUS_DRAWSTRING || type === K.EMFPLUS_DRAWDRIVERSTRING) {
			scan.hasText = true;
		}
		off += size;
	}
}

/** Collects EMF+ font and image objects (continuation runs reassembled as the replay does). */
function scanEmfPlusObjects(view: DataView, scan: Scan, depth: number, maxRecords: number): void {
	walkEmfPlusObjects(view, (obj) => {
		const type = (obj.flags >> 8) & 0x7f;
		const v = obj.view;
		const o = obj.dataOff;
		const n = obj.dataSize;
		if (type === K.EMFPLUS_OBJECTTYPE_FONT && n >= 28) {
			// EmfPlusFont: Version, EmSize, SizeUnit, FontStyleFlags, Reserved, Length, Family.
			const len = v.getUint32(o + 20, true);
			if (len > 0 && 24 + len * 2 <= n) {
				addFont(scan, readUtf16LE(v, o + 24, len), 'emfPlus');
			}
		} else if (type === K.EMFPLUS_OBJECTTYPE_IMAGE && n >= 8) {
			const imgType = v.getUint32(o + 4, true);
			if (imgType === 1 && n >= 28) {
				// EmfPlusBitmap: Width, Height, Stride, PixelFormat, Type (0 pixels, 1 compressed).
				if (v.getUint32(o + 24, true) === 1 && n > 28) {
					addImage(scan, sniffMime(new Uint8Array(v.buffer, v.byteOffset + o + 28, Math.min(n - 28, 16))));
				} else {
					addImage(scan, 'image/bmp');
				}
			} else if (imgType === 2 && n >= 16) {
				// EmfPlusMetafile: Type (1/2 WMF, 3..5 EMF), MetafileDataSize, data.
				const mfType = v.getUint32(o + 8, true);
				const size = v.getUint32(o + 12, true);
				scan.embeddedMetafiles++;
				addImage(scan, mfType <= 2 ? 'image/wmf' : 'image/emf');
				if (mfType >= 3 && depth < MAX_NESTING && size > 0 && 16 + size <= n) {
					// The nested drawing is painted with the same `fonts`, so its faces count.
					const nested = new DataView(v.buffer, v.byteOffset + o + 16, size);
					if (parseEmfHeaderSafe(nested)) {
						const inner = newScan();
						scanEmfRecords(nested, inner, maxRecords, maxRecords);
						scanEmfPlusObjects(nested, inner, depth + 1, maxRecords);
						mergeNested(scan, inner);
					}
				}
			}
		}
	});
}

/** The EMF header's description string, NULs shown as newlines. */
function readDescription(view: DataView): string | null {
	if (view.byteLength < 68) {
		return null;
	}
	const chars = view.getUint32(60, true);
	const off = view.getUint32(64, true);
	if (chars === 0 || off < 88 || off + chars * 2 > view.byteLength) {
		return null;
	}
	const parts: string[] = [];
	let current = '';
	for (let i = 0; i < chars; i++) {
		const code = view.getUint16(off + i * 2, true);
		if (code === 0) {
			parts.push(current);
			current = '';
		} else {
			current += String.fromCharCode(code);
		}
	}
	parts.push(current);
	return parts.filter((p) => p.length > 0).join('\n') || null;
}

function inspectEmf(view: DataView, header: NonNullable<ReturnType<typeof parseEmfHeader>>, opts: MetafileInfoOptions): MetafileInfo | null {
	const render = getRenderableEmfBounds(header);
	if (!render) {
		return null;
	}
	const scan = newScan();
	scanEmfRecords(view, scan, opts.maxRecords ?? K.MAX_RECORDS_DEFAULT, opts.maxRecords ?? K.MAX_RECORDS_EMFPLUS_DEFAULT);
	scanEmfPlusObjects(view, scan, 0, opts.maxRecords ?? K.MAX_RECORDS_DEFAULT);
	// The same helper createCanvas uses, at the converter's default options.
	const size = computeSurfaceSize(render.right - render.left, render.bottom - render.top);
	const frame: MetafileRect = {
		left: view.getInt32(24, true),
		top: view.getInt32(28, true),
		right: view.getInt32(32, true),
		bottom: view.getInt32(36, true),
	};
	const dev = { width: view.getInt32(72, true), height: view.getInt32(76, true) };
	const mm = { width: view.getInt32(80, true), height: view.getInt32(84, true) };
	const hasDevice = dev.width > 0 && dev.height > 0 && mm.width > 0 && mm.height > 0;
	return finish(scan, {
		format: scan.plus === 'none' ? 'emf' : scan.plus === 'dual' ? 'emf+dual' : 'emf+',
		bounds: header.bounds,
		frame,
		device: hasDevice ? dev : null,
		deviceMm: hasDevice ? mm : null,
		dpi: hasDevice ? { x: (dev.width * 25.4) / mm.width, y: (dev.height * 25.4) / mm.height } : { x: 96, y: 96 },
		width: size.w,
		height: size.h,
		description: readDescription(view),
	});
}

type InfoHead = Pick<MetafileInfo, 'format' | 'bounds' | 'frame' | 'device' | 'deviceMm' | 'dpi' | 'width' | 'height' | 'description'> &
	Partial<Pick<MetafileInfo, 'placeable' | 'playsEmbeddedEmf' | 'unitsPerInch'>>;

function finish(scan: Scan, head: InfoHead): MetafileInfo {
	return {
		...head,
		recordCount: scan.recordCount,
		emfPlusRecordCount: scan.emfPlusRecordCount,
		recordTypes: scan.recordTypes,
		fonts: [...scan.fonts.values()],
		hasText: scan.hasText,
		images: { count: scan.imageCount, mimeTypes: [...scan.mimeTypes].sort() },
		embeddedMetafiles: scan.embeddedMetafiles,
		truncated: scan.truncated,
	};
}

// ---------------------------------------------------------------------------
// WMF
// ---------------------------------------------------------------------------

/** Bytes between the record's parameters start and the DIB, for the WMF records that carry one. */
const WMF_DIB_AT: Record<number, number> = {
	[K.META_DIBBITBLT]: 16,
	[K.META_DIBSTRETCHBLT]: 20,
	[K.META_STRETCHDIB]: 22,
	[K.META_SETDIBTODEV]: 18,
};

function scanWmfRecords(view: DataView, start: number, scan: Scan, maxRecords: number, ansiCodePage: number | undefined): void {
	const table = names().meta;
	let off = start;
	while (off + 6 <= view.byteLength) {
		if (scan.recordCount >= maxRecords) {
			scan.truncated = true;
			return;
		}
		const size = view.getUint32(off, true) * 2;
		const type = view.getUint16(off + 4, true);
		if (size < 6 || off + size > view.byteLength) {
			scan.truncated = true;
			return;
		}
		if (type === K.META_EOF) {
			return;
		}
		scan.recordCount++;
		bump(scan.recordTypes, table.get(type) ?? `UNKNOWN_0x${type.toString(16)}`);
		const d = off + 6;
		const end = off + size;
		if (type === K.META_CREATEFONTINDIRECT) {
			if (size >= 24) {
				// The 16-bit LOGFONT's face name (byte 18) is in the device code page, as in wmf-objects.ts.
				const bytes: number[] = [];
				for (let i = 0; i < 32 && d + 18 + i < end; i++) {
					const ch = view.getUint8(d + 18 + i);
					if (ch === 0) {
						break;
					}
					bytes.push(ch);
				}
				addFont(scan, String.fromCharCode(...decodeAnsiRecord(bytes, 1, { ansi: ansiCodePage }).codes), 'gdi');
			}
		} else if (type === K.META_TEXTOUT || type === K.META_EXTTEXTOUT) {
			scan.hasText = true;
		} else if (type in WMF_DIB_AT) {
			const dib = d + WMF_DIB_AT[type];
			// A BITMAPINFOHEADER must follow; the bitmap-less forms are shorter.
			if (dib + 40 <= end) {
				const mime = dibMime(view, dib);
				if (mime) {
					addImage(scan, mime);
				}
			}
		}
		off += size;
	}
}

function inspectWmf(view: DataView, opts: MetafileInfoOptions): MetafileInfo | null {
	const header = parseWmfHeader(view);
	if (!header) {
		return null;
	}
	if (header.boundsRight - header.boundsLeft <= 0 || header.boundsBottom - header.boundsTop <= 0) {
		// The converter refuses these too.
		return null;
	}
	const scan = newScan();
	scanWmfRecords(view, header.headerSize, scan, opts.maxRecords ?? K.MAX_RECORDS_DEFAULT, opts.ansiCodePage);
	const playback = wmfPlayback(view, header);
	const surface = computeSurfaceSize(playback.width, playback.height);
	let width = surface.w;
	let height = surface.h;
	let description: string | null = null;
	let playsEmbeddedEmf = false;
	const embedded = extractEmbeddedEmf(view, header.headerSize);
	if (embedded) {
		// The converter plays this EMF instead of the WMF records.
		const emfView = new DataView(embedded);
		const emfHeader = parseEmfHeaderSafe(emfView);
		const inner = emfHeader ? inspectEmf(emfView, emfHeader, opts) : null;
		if (inner) {
			playsEmbeddedEmf = true;
			width = inner.width;
			height = inner.height;
			description = inner.description;
			for (const f of inner.fonts) {
				addFont(scan, f.name, f.gdi ? 'gdi' : 'emfPlus');
				if (f.gdi && f.emfPlus) {
					addFont(scan, f.name, 'emfPlus');
				}
			}
			scan.hasText ||= inner.hasText;
			scan.imageCount += inner.images.count;
			inner.images.mimeTypes.forEach((m) => scan.mimeTypes.add(m));
			scan.embeddedMetafiles += inner.embeddedMetafiles;
		}
	}
	const bounds = { left: header.boundsLeft, top: header.boundsTop, right: header.boundsRight, bottom: header.boundsBottom };
	const toMm100 = (v: number): number => Math.round((v * 2540) / header.unitsPerInch);
	return finish(scan, {
		format: 'wmf',
		placeable: header.placeable,
		playsEmbeddedEmf,
		bounds,
		frame: header.placeable
			? { left: toMm100(bounds.left), top: toMm100(bounds.top), right: toMm100(bounds.right), bottom: toMm100(bounds.bottom) }
			: null,
		unitsPerInch: header.unitsPerInch,
		device: null,
		deviceMm: null,
		dpi: { x: 96, y: 96 },
		width,
		height,
		description,
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspects an EMF, EMF+ or WMF buffer without rendering it.
 *
 * Returns the format, the header geometry, the pixel size
 * `convertMetafileToDataUrl` produces at default options (computed with the
 * converter's own size helper, so the two agree), a histogram of record
 * names, the font faces the drawing names, whether it draws text, and its
 * embedded images. `fonts` shows which font files to pass to the converters
 * as their `fonts` option: text only matches Windows when they are supplied.
 *
 * Never throws. Returns `null` for a buffer that is not a metafile (or whose
 * bounds the converter would refuse). A truncated or damaged file is
 * reported as far as it can be read, with `truncated: true`.
 *
 * Limits: the font list is what the file declares (a declared font may never
 * be selected); fonts inside nested EMF+ metafiles are included, those in
 * nested WMFs are not; images in a dual-mode file are counted in each
 * record stream that has them.
 *
 * @param buffer  - The raw EMF or WMF file bytes.
 * @param options - Optional {@link MetafileInfoOptions}.
 * @returns A {@link MetafileInfo}, or `null` when the buffer is not a metafile.
 */
export async function getMetafileInfo(buffer: ArrayBuffer, options?: MetafileInfoOptions): Promise<MetafileInfo | null> {
	try {
		const view = new DataView(buffer);
		const opts = options ?? {};
		const emfHeader = parseEmfHeaderSafe(view);
		if (emfHeader) {
			return inspectEmf(view, emfHeader, opts);
		}
		return inspectWmf(view, opts);
	} catch (err) {
		emfWarn('getMetafileInfo: EXCEPTION:', err instanceof Error ? err.message : err);
		return null;
	}
}
