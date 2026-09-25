/**
 * Public API: auto-detecting EMF/WMF conversion to PNG or SVG.
 *
 * The conversion pipeline for both formats and both outputs follows the same
 * high-level steps:
 * 1. Parse the file header to determine logical bounds and output dimensions
 *    (tried as EMF first, then WMF, to auto-detect the format).
 * 2. Create a drawing surface: an in-memory canvas (OffscreenCanvas
 *    preferred, HTMLCanvasElement fallback, or the optional `@napi-rs/canvas`
 *    Node.js backend) for PNG output, or an {@link SvgContext} recorder for
 *    SVG output.
 * 3. Replay every metafile record onto the surface in order.
 * 4. Resolve "deferred images", bitmap / embedded-metafile draws that require
 *    async image decoding (via {@link createImageBitmap} or, in Node.js, the
 *    `@napi-rs/canvas` `loadImage` helper). SVG output embeds PNG/JPEG/GIF/
 *    WebP bytes verbatim and nested metafiles as nested SVG, with no decode.
 * 5. Export: a `data:image/png;base64,...` URL, or an SVG tree that can be
 *    serialised to markup, a data URL, React elements, or JSX source.
 *
 * @module emf-converter
 */

import {
	canvasDrawImage,
	canvasGetImageData,
	canvasPutImageData,
	computeSurfaceSize,
	createCanvas,
	createImageDataCompat,
	createTempCanvas,
	decodeDeferredImageBytes,
	decodeImageBytesBuiltIn,
	ensureNodeCanvasModule,
	usingSoftwareCanvas,
	exportCanvasToPngDataUrl,
	DEFAULT_DPI_SCALE,
	type Drawable,
} from './emf-canvas-helpers';
import { decodeDibToImageData } from './emf-dib-decoder';
import { GdiFontCollection } from './gdi-font-engine';
import { decodeBmpFile, payloadSize, sniffImageMime } from './emf-image-payload';
import { parseEmfHeader, getRenderableEmfBounds, parseWmfHeader } from './emf-header-parser';
import { emfLog, emfWarn } from './emf-logging';
import { resampleImage } from './emf-plus-image-resample';
import { preDecodeEmfPlusImages } from './emf-plus-image-predecode';
import { preDecodeEmfPlusTextures } from './emf-plus-texture-predecode';
import { replayEmfRecords } from './emf-record-replay';
import type { AnyCanvas, CanvasContext, DeferredImageDraw, DeferredImageResample } from './emf-types';
import { SoftwareRasterCanvas } from './software-raster';
import { SvgContext } from './svg-context';
import type { ImagePayload } from './svg-context';
import { svgMarkupToDataUrl, svgTreeToDataUrl, svgTreeToString } from './svg-tree';
import type { SvgNode } from './svg-tree';
import { extractEmbeddedEmf } from './wmf-embedded-emf';
import { wmfPlayback } from './wmf-mapping';
import { replayWmfRecords } from './wmf-replay';

/**
 * Configuration options for EMF/WMF conversion.
 */
export interface EmfConvertOptions {
	/** Maximum output width in pixels. */
	maxWidth?: number;
	/** Maximum output height in pixels. */
	maxHeight?: number;
	/**
	 * DPI scale factor for higher-resolution output.
	 * Default is 1 (1:1 pixel mapping). Values above 4 are clamped to 4 to
	 * prevent excessive memory usage.
	 */
	dpiScale?: number;
	/**
	 * Hard cap on the output canvas width/height in pixels. Guards against
	 * pathological metafiles. Defaults to {@link MAX_CANVAS_DIMENSION} (8192).
	 */
	maxCanvasDimension?: number;
	/**
	 * Maximum number of records processed per stream before replay stops.
	 * Defaults to 200,000 for GDI/WMF and 500,000 for the finer-grained EMF+
	 * stream. Supplying a value overrides both with the same cap.
	 */
	maxRecords?: number;
	/**
	 * Optional map from a (case-insensitive) Windows face name to a CSS font
	 * family available in the rendering environment, e.g. `{ calibri: 'Carlito',
	 * 'ms shell dlg': 'Tahoma' }`. Applied to GDI, WMF, and EMF+ text.
	 */
	fontFamilyMap?: Record<string, string>;
	/**
	 * Smooth shape edges instead of reproducing Windows' own rasterisation.
	 *
	 * PNG output defaults to `false`: plain-GDI vector shapes (Rectangle,
	 * Ellipse, RoundRect, Polygon, Polyline, arcs, bracketed paths, wide
	 * pens) are rasterised the way Windows GDI does, with its 28.4
	 * fixed-point geometry, fill rule, line algorithm and Bezier flattening,
	 * and EMF+ fills, strokes and clips follow the GDI+ `SmoothingMode` the
	 * file records (None, Default and HighSpeed aliased on GDI+'s pixel grid,
	 * AntiAlias and HighQuality with GDI+'s 8 x 4-sample antialiasing), so the
	 * PNG matches what Windows paints pixel for pixel.
	 *
	 * `true` draws every edge with Canvas's own antialiasing instead (still
	 * with GDI's geometry, pen widths, caps, joins and dash patterns), which
	 * looks smoother than Windows, especially for files recorded without
	 * GDI+ antialiasing.
	 *
	 * SVG output defaults to smooth vector edges (an SVG is meant to scale);
	 * `false` there embeds Windows' aliased shape pixels as image patches.
	 */
	gdiAntialias?: boolean;
	/**
	 * Font files to render GDI and WMF text with, exactly as Windows GDI
	 * does: TrueType `.ttf` / `.ttc` and raster `.fon` / `.fnt` bytes
	 * (`loadSystemFonts()` reads the installed ones in Node.js). The
	 * LOGFONT is realised against these files (face, weight, slant,
	 * `lfHeight`/`lfWidth`, charset fallback), each TrueType glyph is grid-fitted by the font's own TrueType
	 * instructions and scan-converted with TrueType dropout control
	 * (non-antialiased, 4x4 grayscale or ClearType per the LOGFONT's
	 * `lfQuality`), and glyphs are placed on GDI's integer device grid with
	 * GDI's own advance widths, cell metrics, underline and strike-out.
	 * Raster faces (MS Sans Serif, Helv, System, Terminal, ...) are drawn
	 * from their bitmaps at the size and whole-number stretch GDI picks.
	 * Supply the fonts the metafile names (for Windows-authored files, the
	 * matching files from `C:\Windows\Fonts`); a face that is missing is
	 * substituted the way GDI's font mapper would (by pitch and family),
	 * and without this option text is drawn with the canvas font engine.
	 * Ignored by SVG output, which keeps text as `<text>` but takes its
	 * per-glyph positions and metrics from these fonts.
	 */
	fonts?: Array<ArrayBuffer | ArrayBufferView>;
	/**
	 * Windows' system-wide font smoothing, which GDI applies to fonts that
	 * ask for `DEFAULT_QUALITY`, `DRAFT_QUALITY` or `PROOF_QUALITY` (most
	 * metafiles): `'cleartype'` (Windows' default), `'gray'` (standard
	 * antialiasing) or `'mono'` (smoothing off). Only used with `fonts`.
	 */
	fontSmoothing?: 'cleartype' | 'gray' | 'mono';
}

/**
 * Options for the SVG outputs ({@link convertMetafileToSvg} and friends).
 * `maxWidth`/`maxHeight`/`dpiScale`/`maxCanvasDimension` set the SVG's
 * coordinate space (its `viewBox` and default `width`/`height`) and the
 * resolution of any embedded raster content; vector content stays sharp at
 * any display size.
 */
export interface SvgConvertOptions extends EmfConvertOptions {
	/**
	 * Evaluate raster operations that read the destination (exact ROP3 blits,
	 * bitwise ROP2, pattern-brush fills combined through ROP2, and
	 * `gdiAntialias: false` shapes) against a hidden raster mirror of the
	 * drawing, and embed the pixels they change as image patches. The mirror
	 * is the canvas backend when one exists (browser/worker canvas, or
	 * `@napi-rs/canvas` in Node.js) and the built-in pure-JavaScript
	 * rasteriser otherwise, so this needs no canvas. The built-in mirror
	 * cannot draw glyphs: where a raster operation reads pixels under text,
	 * every pixel whose result does not depend on the glyphs stays exact and
	 * the rest is handed to the SVG renderer as a blend-mode layer (exact for
	 * inversion and for masks whose channels are all 0 or 255). With `false`,
	 * no mirror is kept and those operations fall back to SVG blend modes
	 * (`mix-blend-mode`), which are exact for the common mask ROPs on
	 * black/white masks and approximate otherwise. Default `true`.
	 */
	exactRasterOps?: boolean;
	/**
	 * How EMF+ `DrawImage` bitmaps are scaled. `'renderer'` (the default)
	 * embeds the original image and lets the SVG renderer scale it with its
	 * own smoothing, which stays sharp at any display size. `'exact'` bakes
	 * each draw at device resolution with the GDI+-matching resampler (the
	 * PNG output's `InterpolationMode`/`PixelOffsetMode` model), so the SVG
	 * shows what GDI+ painted pixel for pixel at its nominal size. PNG and
	 * BMP images are decoded in pure JavaScript; JPEG, GIF and other formats
	 * need a canvas backend to decode and otherwise keep `'renderer'`
	 * scaling, as do draws GDI+ scales with a filter the resampler does not
	 * model (bicubic, high-quality).
	 */
	imageResampling?: 'renderer' | 'exact';
	/**
	 * Emit `width`/`height` attributes on the root `<svg>` (the `viewBox` is
	 * always emitted). Set `false` for a fluid SVG that fills its container.
	 * Default `true`.
	 */
	includeSize?: boolean;
	/**
	 * Prefix for every generated element id (clip paths, gradients,
	 * patterns). Ids must be unique within an HTML document, so give each
	 * inlined SVG its own prefix. Defaults to a per-process counter
	 * (`emf1-`, `emf2-`, ...).
	 */
	idPrefix?: string;
}

const MAX_METAFILE_RECURSION = 3;

// ---------------------------------------------------------------------------
// Shared replay
// ---------------------------------------------------------------------------

/** A drawing surface the replay can target. */
interface Surface {
	ctx: CanvasContext;
	width: number;
	height: number;
}

/** Creates the output surface once the logical size is known. */
type SurfaceFactory = (logicalW: number, logicalH: number) => Surface | null;

/**
 * Detects the format, replays every record onto the surface the factory
 * creates, and returns that surface plus the deferred image draws. `null`
 * when the buffer is neither a valid EMF nor WMF, its bounds are empty, the
 * surface could not be created, or replay threw.
 */
async function replayMetafile(
	buffer: ArrayBuffer,
	options: EmfConvertOptions | undefined,
	createSurface: SurfaceFactory,
): Promise<{ surface: Surface; deferredImages: DeferredImageDraw[] } | null> {
	emfLog(`replayMetafile: input buffer ${buffer.byteLength} bytes`);
	if (buffer.byteLength >= 16) {
		const hdrBytes = new Uint8Array(buffer, 0, 16);
		emfLog(
			`replayMetafile: first 16 bytes: [${Array.from(hdrBytes)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join(' ')}]`,
		);
	}
	const opts = options ?? {};
	const dpiScale = opts.dpiScale ?? DEFAULT_DPI_SCALE;
	let view = new DataView(buffer);

	// Detection tries EMF first: parseEmfHeader is a cheap, side-effect-free
	// probe that returns null unless the buffer starts with EMR_HEADER.
	let emfHeader: ReturnType<typeof parseEmfHeader> = null;
	try {
		emfHeader = parseEmfHeader(view);
	} catch (err) {
		emfWarn('replayMetafile: parseEmfHeader threw during detection:', err instanceof Error ? err.message : err);
	}
	if (!emfHeader) {
		// A WMF written by GetWinMetaFileBits carries the original EMF in
		// META_ESCAPE comments; Windows plays that EMF instead of the WMF
		// records when it is intact (wmf-embedded-emf.ts), and so do we.
		try {
			const wmfHeader = parseWmfHeader(view);
			const embedded = wmfHeader ? extractEmbeddedEmf(view, wmfHeader.headerSize) : null;
			if (embedded) {
				const embeddedView = new DataView(embedded);
				emfHeader = parseEmfHeader(embeddedView);
				if (emfHeader) {
					emfLog('replayMetafile: WMF carries an embedded EMF; playing the EMF');
					view = embeddedView;
				}
			}
		} catch (err) {
			emfWarn('replayMetafile: embedded-EMF probe threw:', err instanceof Error ? err.message : err);
		}
	}

	if (emfHeader) {
		emfLog('replayMetafile: detected EMF (valid EMR_HEADER)');
		try {
			// Decode any compressed EMF+ TextureFill brush images up front: the
			// replay pass is synchronous end-to-end and cannot perform the async
			// image decode a compressed brush needs mid-fill (unlike DrawImage,
			// whose actual draw is deferred). A no-op for files without them.
			const textureCache = await preDecodeEmfPlusTextures(view);
			// Likewise every EMF+ Image object, so DrawImage paints in record order
			// under the clip active at that record (emf-plus-draw-image.ts).
			const imageCache = await preDecodeEmfPlusImages(view);
			const renderBounds = getRenderableEmfBounds(emfHeader);
			if (!renderBounds) {
				emfLog('replayMetafile: getRenderableEmfBounds returned null');
				return null;
			}
			const surface = createSurface(
				renderBounds.right - renderBounds.left,
				renderBounds.bottom - renderBounds.top,
			);
			if (!surface) {
				emfLog('replayMetafile: surface creation failed');
				return null;
			}
			surface.ctx.save();
			const deferredImages = replayEmfRecords(
				view,
				surface.ctx,
				renderBounds,
				surface.width,
				surface.height,
				dpiScale,
				{
					maxRecords: opts.maxRecords,
					maxRecordsEmfPlus: opts.maxRecords,
					fontFamilyMap: opts.fontFamilyMap,
					textureCache,
					imageCache,
					gdiAntialias: opts.gdiAntialias,
					fonts: fontCollection(opts),
				},
			);
			// Clears any clipping regions record handlers installed.
			surface.ctx.restore();
			emfLog(`replayMetafile: EMF replay done, ${deferredImages.length} deferred images`);
			return { surface, deferredImages };
		} catch (err) {
			emfWarn('replayMetafile: EMF EXCEPTION:', err instanceof Error ? err.message : err);
			console.warn('[emf-converter] EMF conversion failed:', err instanceof Error ? err.message : err);
			return null;
		}
	}

	emfLog('replayMetafile: not EMF, trying WMF');
	try {
		const header = parseWmfHeader(view);
		if (!header) {
			emfLog('replayMetafile: parseWmfHeader returned null');
			return null;
		}
		if (header.boundsRight - header.boundsLeft <= 0 || header.boundsBottom - header.boundsTop <= 0) {
			emfLog('replayMetafile: invalid WMF dimensions');
			return null;
		}
		// The picture's size on the 96 dpi reference device (wmf-mapping.ts).
		const playback = wmfPlayback(view, header);
		const surface = createSurface(playback.width, playback.height);
		if (!surface) {
			return null;
		}
		surface.ctx.save();
		replayWmfRecords(view, surface.ctx, header, surface.width, surface.height, {
			maxRecords: opts.maxRecords,
			fontFamilyMap: opts.fontFamilyMap,
			gdiAntialias: opts.gdiAntialias,
			fonts: fontCollection(opts),
		});
		surface.ctx.restore();
		return { surface, deferredImages: [] };
	} catch (err) {
		emfWarn('replayMetafile: WMF EXCEPTION:', err instanceof Error ? err.message : err);
		console.warn('[emf-converter] WMF conversion failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

/** The parsed `fonts` option (cached per array), or undefined without one. */
function fontCollection(opts: EmfConvertOptions): GdiFontCollection | undefined {
	if (!opts.fonts || opts.fonts.length === 0) {
		return undefined;
	}
	const collection = GdiFontCollection.for(opts.fonts, opts.fontSmoothing ?? 'cleartype');
	return collection.size > 0 ? collection : undefined;
}

/** Copies possibly-shared image bytes into a plain `ArrayBuffer`. */
function toPlainBuffer(data: ArrayBuffer | SharedArrayBuffer): ArrayBuffer {
	const plain = new ArrayBuffer(data.byteLength);
	new Uint8Array(plain).set(new Uint8Array(data));
	return plain;
}

// ---------------------------------------------------------------------------
// PNG output
// ---------------------------------------------------------------------------

/**
 * Draws a decoded raster image resampled per device pixel the way GDI+
 * does (see `emf-plus-image-resample.ts`), compositing the result at an
 * integer device offset under an identity transform so Canvas copies it
 * unfiltered. Returns `false`, having drawn nothing, when the backend lacks
 * the pixel access this needs or the mapping is degenerate; the caller then
 * falls back to a plain Canvas `drawImage`.
 */
function drawResampledImage(
	ctx: CanvasContext,
	decoded: { drawable: Drawable; width: number; height: number },
	spec: DeferredImageResample,
): boolean {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const surfaceW = canvas?.width;
	const surfaceH = canvas?.height;
	if (typeof surfaceW !== 'number' || typeof surfaceH !== 'number') {
		return false;
	}
	const { width, height } = decoded;
	const source = createTempCanvas(width, height);
	if (!source) {
		return false;
	}
	canvasDrawImage(source.ctx, decoded.drawable, 0, 0, width, height);
	const pixels = canvasGetImageData(source.ctx, 0, 0, width, height);
	const block = resampleImage(pixels.data, width, height, spec, { w: surfaceW, h: surfaceH });
	if (!block) {
		return false;
	}
	const out = createTempCanvas(block.w, block.h);
	if (!out) {
		return false;
	}
	canvasPutImageData(out.ctx, createImageDataCompat(block.rgba, block.w, block.h), 0, 0);
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.imageSmoothingEnabled = false;
	canvasDrawImage(ctx, out.canvas, block.x, block.y, block.w, block.h);
	ctx.restore();
	return true;
}

/**
 * Processes images whose drawing was deferred during the synchronous record
 * replay pass. Each entry may be a raster image (PNG/BMP bytes) or an
 * embedded metafile that must be recursively converted before it can be drawn.
 *
 * The canvas transform is set per-image so the bitmap lands at the correct
 * position, then reset to identity when all images have been drawn.
 */
async function processDeferredImages(
	ctx: CanvasContext,
	deferredImages: DeferredImageDraw[],
	recursionDepth: number,
): Promise<boolean> {
	emfLog(`processDeferredImages: ${deferredImages.length} deferred images (recursionDepth=${recursionDepth})`);
	let complete = true;
	for (let idx = 0; idx < deferredImages.length; idx++) {
		const img = deferredImages[idx];
		try {
			const plainBuffer = toPlainBuffer(img.imageData);
			// Restore the affine transform active when the draw was recorded.
			ctx.setTransform(...img.transform);

			let bytes = plainBuffer;
			let mime: string | undefined;
			if (img.isMetafile) {
				if (recursionDepth >= MAX_METAFILE_RECURSION) {
					emfWarn(`  Deferred image [${idx}]: skipping embedded metafile, recursion depth ${recursionDepth}`);
					continue;
				}
				const metafileDataUrl = await convertMetafileToDataUrl(plainBuffer, undefined, recursionDepth + 1);
				if (!metafileDataUrl) {
					emfWarn(`  Deferred image [${idx}]: metafile conversion returned null`);
					complete = false;
					continue;
				}
				const byteString = atob(metafileDataUrl.split(',')[1]);
				mime = metafileDataUrl.match(/data:([^;]+)/)?.[1] ?? 'image/png';
				bytes = new ArrayBuffer(byteString.length);
				const ia = new Uint8Array(bytes);
				for (let i = 0; i < byteString.length; i++) {
					ia[i] = byteString.charCodeAt(i);
				}
			}
			const decoded = await decodeDeferredImageBytes(bytes, mime);
			if (decoded) {
				if (!(img.resample && drawResampledImage(ctx, decoded, img.resample))) {
					canvasDrawImage(ctx, decoded.drawable, img.dx, img.dy, img.dw, img.dh);
				}
				decoded.close();
			} else {
				emfWarn(`  Deferred image [${idx}]: no image decoder available`);
				complete = false;
			}
		} catch (imgErr) {
			complete = false;
			const errMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
			emfWarn(`  Deferred image [${idx}]: DRAW FAILED: ${errMsg}`);
			console.warn(
				'[emf-converter] Deferred image draw failed:',
				errMsg,
				`(isMetafile=${img.isMetafile}, dataLen=${img.imageData.byteLength})`,
			);
		}
	}
	// Reset to identity so subsequent callers start with a clean transform.
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	return complete;
}

/**
 * Converts an EMF (Enhanced Metafile) or WMF (Windows Metafile) binary buffer
 * to a PNG data-URL string, auto-detecting which of the two formats it is.
 *
 * Detection tries the EMF path first: {@link parseEmfHeader} is a cheap,
 * side-effect-free probe that returns `null` immediately unless the buffer
 * starts with a valid `EMR_HEADER` record, so it doubles as a safe format
 * sniff. When that probe fails, the buffer is parsed as WMF instead.
 *
 * Returns `null` when:
 * - The buffer matches neither a valid EMF header nor a valid WMF header.
 * - The logical bounds are zero-sized or negative.
 * - No canvas API is available (browser/worker canvas, or the optional
 *   `@napi-rs/canvas` package in plain Node.js) AND the drawing contains
 *   text or an image format only a canvas can decode (JPEG, GIF, ...).
 *   Without a canvas the built-in pure-JavaScript rasteriser renders
 *   everything else (vectors, clipping, gradients, bitmaps, PNG/BMP
 *   images, every raster operation), but it has no font engine, so rather
 *   than return an image silently missing its text it returns `null`. SVG
 *   output ({@link convertMetafileToSvg}) needs no canvas at all.
 *
 * @param buffer  - The raw EMF or WMF file bytes.
 * @param options - Optional {@link EmfConvertOptions} controlling output size,
 *   DPI scale, record limits, and font mapping.
 * @param recursionDepth - Internal: tracks nested embedded-metafile depth.
 * @returns A `data:image/png;base64,...` string, or `null` on failure.
 */
export async function convertMetafileToDataUrl(
	buffer: ArrayBuffer,
	options?: EmfConvertOptions,
	recursionDepth: number = 0,
): Promise<string | null> {
	// Resolve (and cache) the optional Node.js canvas backend once, up front,
	// before any synchronous replay work begins.
	await ensureNodeCanvasModule();
	if (recursionDepth > MAX_METAFILE_RECURSION) {
		emfWarn(`convertMetafileToDataUrl: recursion depth ${recursionDepth} exceeds limit ${MAX_METAFILE_RECURSION}`);
		return null;
	}
	// PNG output reproduces what Windows paints unless smoothing is asked for.
	const opts: EmfConvertOptions = { ...options, gdiAntialias: options?.gdiAntialias ?? false };
	let canvas: AnyCanvas | null = null;
	const result = await replayMetafile(buffer, opts, (w, h) => {
		const setup = createCanvas(
			w,
			h,
			opts.maxWidth,
			opts.maxHeight,
			opts.dpiScale ?? DEFAULT_DPI_SCALE,
			opts.maxCanvasDimension,
		);
		if (!setup) {
			return null;
		}
		canvas = setup.canvas;
		return { ctx: setup.ctx, width: setup.canvas.width, height: setup.canvas.height };
	});
	if (!result || !canvas) {
		return null;
	}
	try {
		const complete = await processDeferredImages(result.surface.ctx, result.deferredImages, recursionDepth);
		const soft = (canvas as unknown) instanceof SoftwareRasterCanvas ? (canvas as unknown as SoftwareRasterCanvas) : null;
		if (soft && (soft.textDraws > 0 || !complete)) {
			// The software rasteriser has no font engine, and no decoder for
			// JPEG/GIF/TIFF: a PNG missing text or an image would be silently
			// wrong, so refuse it (SVG output renders both).
			emfWarn(
				`convertMetafileToDataUrl: no canvas backend and the drawing ${
					soft.textDraws > 0 ? `contains text (${soft.textDraws} runs)` : 'contains an image only a canvas can decode'
				}; install @napi-rs/canvas for PNG output, or use SVG output`,
			);
			return null;
		}
		const url = await exportCanvasToPngDataUrl(canvas);
		if (!url) {
			emfWarn('convertMetafileToDataUrl: exportCanvasToPngDataUrl returned null');
		}
		return url;
	} catch (err) {
		emfWarn('convertMetafileToDataUrl: EXCEPTION:', err instanceof Error ? err.message : err);
		console.warn('[emf-converter] Conversion failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// SVG output
// ---------------------------------------------------------------------------

let svgDocumentCounter = 0;

export { sniffImageMime };


/**
 * Decodes image bytes to straight RGBA: PNG and BMP in pure JavaScript,
 * anything else through the canvas backend when one exists.
 */
async function decodeToRgba(bytes: ArrayBuffer): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
	const builtIn = await decodeImageBytesBuiltIn(new Uint8Array(bytes));
	if (builtIn || usingSoftwareCanvas()) {
		return builtIn;
	}
	const decoded = await decodeDeferredImageBytes(bytes);
	if (!decoded) {
		return null;
	}
	try {
		const temp = createTempCanvas(decoded.width, decoded.height);
		if (!temp) {
			return null;
		}
		canvasDrawImage(temp.ctx, decoded.drawable, 0, 0, decoded.width, decoded.height);
		const px = canvasGetImageData(temp.ctx, 0, 0, decoded.width, decoded.height);
		return { data: px.data, width: decoded.width, height: decoded.height };
	} finally {
		decoded.close();
	}
}

/**
 * `imageResampling: 'exact'`: resamples a deferred EMF+ image draw per
 * device pixel the way GDI+ does (`emf-plus-image-resample.ts`, the same
 * model the PNG output uses), returning the device-space block to embed at
 * identity, or `null` when the image cannot be decoded here or GDI+'s
 * filter for it is not modelled.
 */
async function resampleExact(
	bytes: ArrayBuffer,
	spec: DeferredImageResample,
	surface: { width: number; height: number },
): Promise<{ x: number; y: number; w: number; h: number; rgba: Uint8ClampedArray } | null> {
	const pixels = await decodeToRgba(bytes);
	if (!pixels) {
		return null;
	}
	return resampleImage(pixels.data, pixels.width, pixels.height, spec, { w: surface.width, h: surface.height });
}

/**
 * Resolves deferred image draws into their reserved SVG slots (so each keeps
 * its recorded z-order and clip): browser-native formats are embedded
 * verbatim, BMP is decoded in JS, embedded metafiles become nested SVG, and
 * anything else (e.g. TIFF) is decoded through the canvas backend when one
 * exists.
 */
async function processDeferredImagesSvg(
	svg: SvgContext,
	deferredImages: DeferredImageDraw[],
	options: SvgConvertOptions,
	recursionDepth: number,
): Promise<void> {
	for (let idx = 0; idx < deferredImages.length; idx++) {
		const img = deferredImages[idx];
		try {
			const bytes = toPlainBuffer(img.imageData);
			let payload: ImagePayload | null = null;
			if (img.isMetafile) {
				if (recursionDepth >= MAX_METAFILE_RECURSION) {
					emfWarn(`  Deferred image [${idx}]: skipping embedded metafile, recursion depth ${recursionDepth}`);
					continue;
				}
				const nested = await convertMetafileToSvgTree(
					bytes,
					{ ...options, includeSize: true, idPrefix: undefined },
					recursionDepth + 1,
				);
				if (nested) {
					payload = { kind: 'url', url: svgTreeToDataUrl(nested) };
				}
			} else {
				const u8 = new Uint8Array(bytes);
				const mime = sniffImageMime(u8);
				if (mime) {
					payload = { kind: 'encoded', bytes: u8, mime };
				} else {
					payload = decodeBmpFile(bytes);
					if (!payload) {
						const decoded = await decodeDeferredImageBytes(bytes);
						if (decoded) {
							const temp = createCanvas(decoded.width, decoded.height, undefined, undefined, 1);
							if (temp) {
								canvasDrawImage(temp.ctx, decoded.drawable, 0, 0, decoded.width, decoded.height);
								const px = temp.ctx.getImageData(0, 0, decoded.width, decoded.height);
								payload = {
									kind: 'rgba',
									data: px.data as Uint8ClampedArray,
									width: decoded.width,
									height: decoded.height,
								};
							}
							decoded.close();
						}
					}
				}
			}
			if (!payload) {
				emfWarn(`  Deferred image [${idx}]: unsupported image data for SVG output`);
				continue;
			}
			const slot = (img.svgSlot as SvgNode | undefined) ?? svg.reserveSlot();
			if (img.resample && options.imageResampling === 'exact' && !img.isMetafile) {
				const block = await resampleExact(bytes, img.resample, svg.canvas);
				if (block) {
					svg.fillSlot(slot, { kind: 'rgba', data: block.rgba, width: block.w, height: block.h }, [1, 0, 0, 1, 0, 0], block.x, block.y, block.w, block.h);
					continue;
				}
				emfWarn(`  Deferred image [${idx}]: exact resampling unavailable (image not decodable here); renderer scaling used`);
			}
			const natural = img.resample ? payloadSize(payload) : null;
			if (img.resample && natural) {
				// Exact source-rect → device mapping (crop, rotation, shear);
				// the browser's own smooth scaling stands in for GDI+'s kernel.
				const r = img.resample;
				svg.fillSlotCropped(slot, payload, r.toDevice, natural, r.srcX, r.srcY, r.srcW, r.srcH);
			} else {
				svg.fillSlot(slot, payload, img.transform, img.dx, img.dy, img.dw, img.dh);
			}
		} catch (err) {
			emfWarn(`  Deferred image [${idx}]: SVG embed failed: ${err instanceof Error ? err.message : err}`);
		}
	}
}

/**
 * Converts an EMF or WMF buffer (format auto-detected) into an SVG document
 * tree, the common source for every SVG output form: serialise it with
 * {@link svgTreeToString} / {@link svgTreeToDataUrl}, render it in React
 * with {@link svgTreeToReact}, or generate component source with
 * {@link svgTreeToJsx}.
 *
 * This needs no canvas implementation: vectors, text, gradients, clipping,
 * and bitmaps are all recorded in pure JavaScript, and destination-reading
 * raster operations are evaluated exactly against a raster mirror of the
 * drawing (see {@link SvgConvertOptions.exactRasterOps}), which is the
 * canvas backend when one exists (it also measures text) and the built-in
 * pure-JavaScript rasteriser otherwise.
 *
 * @returns The root `<svg>` node, or `null` for an invalid/empty metafile.
 */
export async function convertMetafileToSvgTree(
	buffer: ArrayBuffer,
	options?: SvgConvertOptions,
	recursionDepth: number = 0,
): Promise<SvgNode | null> {
	const svg = await replayToSvgContext(buffer, options, recursionDepth);
	return svg ? svg.toTree({ includeSize: options?.includeSize }) : null;
}

/**
 * Replays a metafile onto a new {@link SvgContext} (deferred images
 * included) and returns the context itself, whose `shadow` holds the raster
 * mirror. Internal: {@link convertMetafileToSvgTree} is the public entry.
 */
export async function replayToSvgContext(
	buffer: ArrayBuffer,
	options?: SvgConvertOptions,
	recursionDepth: number = 0,
): Promise<SvgContext | null> {
	await ensureNodeCanvasModule();
	if (recursionDepth > MAX_METAFILE_RECURSION) {
		return null;
	}
	const opts = options ?? {};
	const dpiScale = opts.dpiScale ?? DEFAULT_DPI_SCALE;
	const idPrefix = opts.idPrefix ?? `emf${++svgDocumentCounter}-`;
	let svg: SvgContext | null = null;
	const result = await replayMetafile(buffer, opts, (lw, lh) => {
		const size = computeSurfaceSize(lw, lh, opts.maxWidth, opts.maxHeight, dpiScale, opts.maxCanvasDimension);
		const shadow =
			opts.exactRasterOps === false
				? null
				: (createCanvas(lw, lh, opts.maxWidth, opts.maxHeight, dpiScale, opts.maxCanvasDimension)?.ctx ?? null);
		svg = new SvgContext(size.w, size.h, { shadow, idPrefix, imageResampling: opts.imageResampling });
		return { ctx: svg as unknown as CanvasContext, width: size.w, height: size.h };
	});
	if (!result || !svg) {
		return null;
	}
	const target: SvgContext = svg;
	await processDeferredImagesSvg(target, result.deferredImages, opts, recursionDepth);
	return target;
}

/**
 * Converts an EMF or WMF buffer into standalone SVG markup
 * (`<svg xmlns="http://www.w3.org/2000/svg" ...>...</svg>`).
 *
 * @returns The SVG markup, or `null` for an invalid/empty metafile.
 */
export async function convertMetafileToSvg(buffer: ArrayBuffer, options?: SvgConvertOptions): Promise<string | null> {
	const tree = await convertMetafileToSvgTree(buffer, options);
	return tree ? svgTreeToString(tree) : null;
}

/**
 * Converts an EMF or WMF buffer into a base64 SVG data URL
 * (`data:image/svg+xml;base64,...`), usable directly as an `<img src>`.
 *
 * @returns The data URL, or `null` for an invalid/empty metafile.
 */
export async function convertMetafileToSvgDataUrl(
	buffer: ArrayBuffer,
	options?: SvgConvertOptions,
): Promise<string | null> {
	const markup = await convertMetafileToSvg(buffer, options);
	return markup ? svgMarkupToDataUrl(markup) : null;
}
