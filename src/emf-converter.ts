/**
 * Public API, a single auto-detecting entry point consumed by the rest of
 * the application.
 *
 * The conversion pipeline for both formats follows the same high-level steps:
 * 1. Parse the file header to determine logical bounds and canvas dimensions
 *    (tried as EMF first, then WMF, to auto-detect the format).
 * 2. Create an in-memory canvas (OffscreenCanvas preferred, HTMLCanvasElement
 *    fallback, or the optional `@napi-rs/canvas` Node.js backend).
 * 3. Replay every metafile record onto the canvas context in order.
 * 4. Resolve "deferred images", bitmap / embedded-metafile draws that require
 *    async image decoding (via {@link createImageBitmap} or, in Node.js, the
 *    `@napi-rs/canvas` `loadImage` helper).
 * 5. Export the canvas contents as a `data:image/png;base64,...` URL.
 *
 * @module emf-converter
 */

import {
	canvasDrawImage,
	createCanvas,
	decodeDeferredImageBytes,
	ensureNodeCanvasModule,
	exportCanvasToPngDataUrl,
	DEFAULT_DPI_SCALE,
} from './emf-canvas-helpers';
import { parseEmfHeader, getRenderableEmfBounds, parseWmfHeader } from './emf-header-parser';
import { emfLog, emfWarn } from './emf-logging';
import { replayEmfRecords } from './emf-record-replay';
import type { CanvasContext, DeferredImageDraw } from './emf-types';
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
	 * Default is 2 (HiDPI). Set to 1 for 1:1 pixel mapping.
	 * Values above 4 are clamped to 4 to prevent excessive memory usage.
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
}

// ---------------------------------------------------------------------------
// Deferred-image post-processing
// ---------------------------------------------------------------------------

/**
 * Processes images whose drawing was deferred during the synchronous record
 * replay pass. Each entry may be a raster image (PNG/BMP bytes) or an
 * embedded metafile that must be recursively converted before it can be drawn.
 *
 * The canvas transform is set per-image so the bitmap lands at the correct
 * position, then reset to identity when all images have been drawn.
 *
 * @param ctx            - The 2D rendering context of the output canvas.
 * @param deferredImages - The list of deferred image-draw descriptors
 *                         accumulated during GDI / EMF+ record replay.
 */
const MAX_METAFILE_RECURSION = 3;

async function processDeferredImages(
	ctx: CanvasContext,
	deferredImages: DeferredImageDraw[],
	recursionDepth: number = 0,
): Promise<void> {
	emfLog(
		`processDeferredImages: processing ${deferredImages.length} deferred images (recursionDepth=${recursionDepth})...`,
	);

	for (let idx = 0; idx < deferredImages.length; idx++) {
		const img = deferredImages[idx];
		emfLog(
			`  Deferred image [${idx}]: isMetafile=${img.isMetafile}, dataLen=${img.imageData.byteLength}, ` +
				`dest=(${img.dx.toFixed(1)},${img.dy.toFixed(1)},${img.dw.toFixed(1)},${img.dh.toFixed(1)}), ` +
				`transform=[${img.transform.map((v) => v.toFixed(3)).join(',')}]`,
		);
		try {
			// Copy to a plain ArrayBuffer, since SharedArrayBuffer is not accepted
			// as a BlobPart by the Blob constructor in TypeScript 5.x strict mode.
			const plainBuffer = new ArrayBuffer(img.imageData.byteLength);
			const dstBytes = new Uint8Array(plainBuffer);
			dstBytes.set(new Uint8Array(img.imageData));

			// Restore the affine transform that was active when the image draw was
			// originally encountered, so the bitmap is placed correctly on canvas.
			ctx.setTransform(
				img.transform[0],
				img.transform[1],
				img.transform[2],
				img.transform[3],
				img.transform[4],
				img.transform[5],
			);

			if (img.isMetafile) {
				// Embedded metafiles must be recursively converted to a raster image
				// before they can be drawn.
				if (recursionDepth >= MAX_METAFILE_RECURSION) {
					emfWarn(
						`  Deferred image [${idx}]: skipping embedded metafile, recursion depth ${recursionDepth} >= ${MAX_METAFILE_RECURSION}`,
					);
					continue;
				}
				emfLog(`  Deferred image [${idx}]: recursively converting embedded metafile...`);
				const metafileDataUrl = await convertMetafileToDataUrl(
					plainBuffer,
					undefined,
					recursionDepth + 1,
				);
				if (metafileDataUrl) {
					// Decode the data-URL back to raw bytes so it can be handed to the
					// active canvas backend's image decoder.
					emfLog(
						`  Deferred image [${idx}]: metafile converted, dataUrl length=${metafileDataUrl.length}`,
					);
					const byteString = atob(metafileDataUrl.split(',')[1]);
					const mimeMatch = metafileDataUrl.match(/data:([^;]+)/);
					const mime = mimeMatch ? mimeMatch[1] : 'image/png';
					const ab = new ArrayBuffer(byteString.length);
					const ia = new Uint8Array(ab);
					for (let i = 0; i < byteString.length; i++) {
						ia[i] = byteString.charCodeAt(i);
					}
					emfLog(`  Deferred image [${idx}]: decoding ${ab.byteLength} byte image (${mime})...`);
					const decoded = await decodeDeferredImageBytes(ab, mime);
					if (decoded) {
						emfLog(`  Deferred image [${idx}]: decoded ${decoded.width}×${decoded.height}`);
						canvasDrawImage(ctx, decoded.drawable, img.dx, img.dy, img.dw, img.dh);
						decoded.close();
					} else {
						emfWarn(`  Deferred image [${idx}]: no image decoder available`);
					}
				} else {
					emfWarn(`  Deferred image [${idx}]: metafile conversion returned null`);
				}
			} else {
				emfLog(`  Deferred image [${idx}]: decoding ${plainBuffer.byteLength} byte image...`);
				const decoded = await decodeDeferredImageBytes(plainBuffer);
				if (decoded) {
					emfLog(`  Deferred image [${idx}]: decoded ${decoded.width}×${decoded.height}`);
					canvasDrawImage(ctx, decoded.drawable, img.dx, img.dy, img.dw, img.dh);
					decoded.close();
				} else {
					emfWarn(`  Deferred image [${idx}]: no image decoder available`);
				}
			}
		} catch (imgErr) {
			const errMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
			emfWarn(`  Deferred image [${idx}]: DRAW FAILED: ${errMsg}`);
			console.warn(
				'[emf-converter] Deferred image draw failed:',
				imgErr instanceof Error ? imgErr.message : imgErr,
				`(isMetafile=${img.isMetafile}, dataLen=${img.imageData.byteLength})`,
			);
		}
	}
	// Reset to identity so subsequent callers start with a clean transform.
	ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---------------------------------------------------------------------------
// convertMetafileToDataUrl
// ---------------------------------------------------------------------------

/**
 * Converts an EMF (Enhanced Metafile) or WMF (Windows Metafile) binary buffer
 * to a PNG data-URL string, auto-detecting which of the two formats it is.
 *
 * Detection tries the EMF path first: {@link parseEmfHeader} is a cheap,
 * side-effect-free probe that returns `null` immediately unless the buffer
 * starts with a valid `EMR_HEADER` record, so it doubles as a safe format
 * sniff. When that probe fails, the buffer is parsed as WMF instead.
 *
 * For EMF: parses the EMF header, iterates over all EMR records, and replays
 * them onto an in-memory canvas. Embedded EMF+ (GDI+) records found inside
 * EMR_COMMENT payloads are handled transparently.
 *
 * For WMF: parses the optional Aldus placeable header and the standard WMF
 * header, then replays all META_* records onto a canvas.
 *
 * The canvas is rendered at a configurable DPI scale (default 1x, 1:1 pixel
 * mapping) via {@link EmfConvertOptions.dpiScale}. On the first call in a
 * given process, the optional Node.js canvas backend (`@napi-rs/canvas`) is
 * loaded once and cached; see {@link ensureNodeCanvasModule}.
 *
 * Returns `null` when:
 * - The buffer matches neither a valid EMF header nor a valid WMF header.
 * - The logical bounds are zero-sized or negative.
 * - No canvas API is available (browser/worker canvas, or the optional
 *   `@napi-rs/canvas` package in plain Node.js).
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
	// before any synchronous replay work begins. createCanvas/createTempCanvas
	// are called synchronously deep inside the replay pipeline and consult the
	// cached result rather than awaiting anything themselves.
	await ensureNodeCanvasModule();

	if (recursionDepth > MAX_METAFILE_RECURSION) {
		emfWarn(
			`convertMetafileToDataUrl: recursion depth ${recursionDepth} exceeds limit ${MAX_METAFILE_RECURSION}, refusing to convert`,
		);
		return null;
	}

	emfLog(`convertMetafileToDataUrl: input buffer ${buffer.byteLength} bytes`);
	if (buffer.byteLength >= 16) {
		const hdrBytes = new Uint8Array(buffer, 0, 16);
		emfLog(
			`convertMetafileToDataUrl: first 16 bytes: [${Array.from(hdrBytes)
				.map((b) => b.toString(16).padStart(2, '0'))
				.join(' ')}]`,
		);
	}

	const view = new DataView(buffer);
	let emfHeader: ReturnType<typeof parseEmfHeader> = null;
	try {
		emfHeader = parseEmfHeader(view);
	} catch (err) {
		emfWarn(
			'convertMetafileToDataUrl: parseEmfHeader threw during detection:',
			err instanceof Error ? err.message : err,
		);
		emfHeader = null;
	}
	if (emfHeader) {
		emfLog('convertMetafileToDataUrl: detected EMF (valid EMR_HEADER)');
		return convertEmfInternal(buffer, view, emfHeader, options, recursionDepth);
	}
	emfLog('convertMetafileToDataUrl: not EMF, trying WMF');
	return convertWmfInternal(buffer, view, options, recursionDepth);
}

// ---------------------------------------------------------------------------
// EMF path
// ---------------------------------------------------------------------------

async function convertEmfInternal(
	buffer: ArrayBuffer,
	view: DataView,
	header: NonNullable<ReturnType<typeof parseEmfHeader>>,
	options: EmfConvertOptions | undefined,
	recursionDepth: number,
): Promise<string | null> {
	const opts = options ?? {};
	const dpiScale = opts.dpiScale ?? DEFAULT_DPI_SCALE;
	const effectiveMaxWidth = opts.maxWidth;
	const effectiveMaxHeight = opts.maxHeight;
	const replayOptions = {
		maxRecords: opts.maxRecords,
		maxRecordsEmfPlus: opts.maxRecords,
		fontFamilyMap: opts.fontFamilyMap,
	};

	try {
		emfLog('=== convertEmfInternal START ===');
		emfLog(
			`Input buffer: ${buffer.byteLength} bytes, maxWidth=${effectiveMaxWidth}, maxHeight=${effectiveMaxHeight}, dpiScale=${dpiScale}`,
		);

		const renderBounds = getRenderableEmfBounds(header);
		if (!renderBounds) {
			emfLog('convertEmfInternal: getRenderableEmfBounds returned null, returning null');
			return null;
		}

		const logicalW = renderBounds.right - renderBounds.left;
		const logicalH = renderBounds.bottom - renderBounds.top;
		emfLog(`convertEmfInternal: logicalSize=${logicalW}×${logicalH}`);

		const setup = createCanvas(
			logicalW,
			logicalH,
			effectiveMaxWidth,
			effectiveMaxHeight,
			dpiScale,
			opts.maxCanvasDimension,
		);
		if (!setup) {
			emfLog('convertEmfInternal: createCanvas returned null, returning null');
			return null;
		}

		const { canvas, ctx } = setup;
		emfLog(
			`convertEmfInternal: canvas created ${canvas.width}×${canvas.height} (dpiScale=${dpiScale})`,
		);

		ctx.save();

		emfLog('convertEmfInternal: starting replayEmfRecords...');
		const deferredImages = replayEmfRecords(
			view,
			ctx,
			renderBounds,
			canvas.width,
			canvas.height,
			dpiScale,
			replayOptions,
		);
		emfLog(`convertEmfInternal: replayEmfRecords returned ${deferredImages.length} deferred images`);

		// Restore the canvas state saved before replay, this clears any
		// clipping regions that GDI record handlers may have installed.
		ctx.restore();

		await processDeferredImages(ctx, deferredImages, recursionDepth);

		emfLog('convertEmfInternal: exporting canvas to PNG data URL...');
		const result = await exportCanvasToPngDataUrl(canvas);
		if (result) {
			emfLog(`convertEmfInternal: SUCCESS, data URL length=${result.length}`);
		} else {
			emfWarn('convertEmfInternal: exportCanvasToPngDataUrl returned null');
		}
		emfLog('=== convertEmfInternal END ===');
		return result;
	} catch (err) {
		emfWarn('convertEmfInternal: EXCEPTION:', err instanceof Error ? err.message : err);
		console.warn('[emf-converter] EMF conversion failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// WMF path
// ---------------------------------------------------------------------------

async function convertWmfInternal(
	buffer: ArrayBuffer,
	view: DataView,
	options: EmfConvertOptions | undefined,
	recursionDepth: number,
): Promise<string | null> {
	const opts = options ?? {};
	const dpiScale = opts.dpiScale ?? DEFAULT_DPI_SCALE;
	const effectiveMaxWidth = opts.maxWidth;
	const effectiveMaxHeight = opts.maxHeight;
	const replayOptions = {
		maxRecords: opts.maxRecords,
		fontFamilyMap: opts.fontFamilyMap,
	};

	try {
		emfLog(
			'=== convertWmfInternal START ===',
			`buffer=${buffer.byteLength} bytes, dpiScale=${dpiScale}`,
		);
		const header = parseWmfHeader(view);
		if (!header) {
			emfLog('convertWmfInternal: parseWmfHeader returned null');
			return null;
		}

		const logicalW = header.boundsRight - header.boundsLeft;
		const logicalH = header.boundsBottom - header.boundsTop;
		emfLog(`convertWmfInternal: logicalSize=${logicalW}×${logicalH}`);

		if (logicalW <= 0 || logicalH <= 0) {
			emfLog('convertWmfInternal: invalid dimensions, returning null');
			return null;
		}

		const setup = createCanvas(
			logicalW,
			logicalH,
			effectiveMaxWidth,
			effectiveMaxHeight,
			dpiScale,
			opts.maxCanvasDimension,
		);
		if (!setup) {
			return null;
		}

		const { canvas, ctx } = setup;

		ctx.save();
		replayWmfRecords(view, ctx, header, canvas.width, canvas.height, replayOptions);
		ctx.restore();

		const result = await exportCanvasToPngDataUrl(canvas);
		emfLog(`convertWmfInternal: result=${result ? `dataUrl len=${result.length}` : 'null'}`);
		emfLog('=== convertWmfInternal END ===');
		return result;
	} catch (err) {
		emfWarn('convertWmfInternal: EXCEPTION:', err instanceof Error ? err.message : err);
		console.warn('[emf-converter] WMF conversion failed:', err instanceof Error ? err.message : err);
		return null;
	}
}
