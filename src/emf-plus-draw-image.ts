/**
 * In-order EMF+ `DrawImage` / `DrawImagePoints`.
 *
 * An image draw is painted the moment its record is replayed, so it keeps
 * its true z-order (shapes recorded after it paint over it) and the clip
 * active at that record, exactly as GDI+ paints it. That needs the image's
 * content synchronously, which the async pre-decode pass
 * (`emf-plus-image-predecode.ts`) provides through
 * `EmfPlusReplayCtx.imageCache`:
 *
 * - PNG output composites the bitmap resampled the way GDI+ does
 *   (`emf-plus-image-resample.ts`) at an integer device offset under an
 *   identity transform (so Canvas copies it unfiltered), through the
 *   canvas's live clip.
 * - SVG output embeds the ORIGINAL encoded bytes of a browser-native image
 *   (PNG/JPEG/GIF/WebP) at the current paint position and clip, never a
 *   re-encoded copy; other formats (a GDI+ pixel bitmap, BMP) are embedded
 *   as pixels. When the SVG context has a hidden raster mirror (for exact
 *   raster operations) the GDI+-resampled bitmap is painted onto it too, so
 *   a later destination-reading operation sees the image.
 * - An embedded metafile is replayed record by record straight into the
 *   destination (see {@link drawNestedMetafile}), so it stays vector.
 *
 * A draw this module cannot resolve (no decoder was available ahead of
 * time) returns `false`, and the caller keeps the older deferred path.
 *
 * @module emf-plus-draw-image
 */

import { canvasDrawImage, canvasPutImageData, createImageDataCompat, createTempCanvas } from './emf-canvas-helpers';
import { decodeBmpFile, payloadSize, sniffImageMime } from './emf-image-payload';
import { mulMatrix } from './emf-plus-brush-gradient';
import { MAX_NESTED_METAFILE_DEPTH } from './emf-plus-image-predecode';
import { resampleImage } from './emf-plus-image-resample';
import { plusWorldMatrix } from './emf-plus-state-handlers';
import { isSvgContext } from './svg-context';
import type { ImagePayload, SvgContext } from './svg-context';
import type {
	CanvasContext,
	DeferredImageDraw,
	EmfPlusImage,
	EmfPlusPreDecodedImage,
	EmfPlusReplayCtx,
	ReplayOptions,
	TransformMatrix,
} from './emf-types';

type DecodedBitmap = Extract<EmfPlusPreDecodedImage, { kind: 'bitmap' }>;

/** The drawing surface size, when the context exposes its canvas. */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/** A scratch canvas holding `w` x `h` RGBA pixels, or `null` without canvas support. */
function pixelsCanvas(rgba: Uint8ClampedArray, w: number, h: number): ReturnType<typeof createTempCanvas> {
	const temp = createTempCanvas(w, h);
	if (!temp) {
		return null;
	}
	canvasPutImageData(temp.ctx, createImageDataCompat(rgba, w, h), 0, 0);
	return temp;
}

/**
 * Paints a decoded bitmap onto a raster context: resampled per device
 * pixel the way GDI+ does and composited at an integer offset when the
 * draw has a resampling spec, otherwise scaled by Canvas under the
 * recorded transform. Either way it goes through the context's live clip.
 * Returns `false` when the backend cannot take it.
 */
export function paintBitmapRaster(ctx: CanvasContext, bitmap: DecodedBitmap, draw: DeferredImageDraw): boolean {
	const size = surfaceSize(ctx);
	if (draw.resample && size) {
		const block = resampleImage(bitmap.rgba, bitmap.width, bitmap.height, draw.resample, size);
		if (block) {
			const out = pixelsCanvas(block.rgba, block.w, block.h);
			if (!out) {
				return false;
			}
			ctx.save();
			try {
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.imageSmoothingEnabled = false;
				canvasDrawImage(ctx, out.canvas, block.x, block.y, block.w, block.h);
			} finally {
				ctx.restore();
			}
			return true;
		}
	}
	const src = pixelsCanvas(bitmap.rgba, bitmap.width, bitmap.height);
	if (!src) {
		return false;
	}
	ctx.save();
	try {
		ctx.setTransform(...draw.transform);
		canvasDrawImage(ctx, src.canvas, draw.dx, draw.dy, draw.dw, draw.dh);
	} finally {
		ctx.restore();
	}
	return true;
}

/**
 * The SVG payload for an image: its original bytes when they are a
 * browser-native format, else decoded pixels (pre-decoded, or a BMP decoded
 * in pure JavaScript), else `null`.
 */
export function svgImagePayload(img: EmfPlusImage, bitmap: DecodedBitmap | null): ImagePayload | null {
	if (!img.data) {
		return null;
	}
	const bytes = new Uint8Array(img.data.slice(0));
	const mime = sniffImageMime(bytes);
	if (mime) {
		return { kind: 'encoded', bytes, mime };
	}
	if (bitmap) {
		return { kind: 'rgba', data: bitmap.rgba, width: bitmap.width, height: bitmap.height };
	}
	return decodeBmpFile(bytes.buffer as ArrayBuffer);
}

/**
 * Embeds a bitmap into an SVG context at the current paint position and
 * clip (and mirrors it onto the hidden raster, when there is one).
 */
function paintBitmapSvg(svg: SvgContext, img: EmfPlusImage, bitmap: DecodedBitmap | null, draw: DeferredImageDraw): boolean {
	const payload = svgImagePayload(img, bitmap);
	if (!payload) {
		return false;
	}
	const slot = svg.reserveSlot();
	const block =
		svg.imageResampling === 'exact' && bitmap && draw.resample
			? resampleImage(bitmap.rgba, bitmap.width, bitmap.height, draw.resample, {
					w: svg.canvas.width,
					h: svg.canvas.height,
				})
			: null;
	const natural = draw.resample ? payloadSize(payload) : null;
	if (block) {
		// Baked at device resolution with GDI+'s own kernel: exactly the
		// pixels the PNG output paints.
		const pixels: ImagePayload = { kind: 'rgba', data: block.rgba, width: block.w, height: block.h };
		svg.fillSlot(slot, pixels, [1, 0, 0, 1, 0, 0], block.x, block.y, block.w, block.h);
	} else if (draw.resample && natural) {
		const r = draw.resample;
		svg.fillSlotCropped(slot, payload, r.toDevice, natural, r.srcX, r.srcY, r.srcW, r.srcH);
	} else {
		svg.fillSlot(slot, payload, draw.transform, draw.dx, draw.dy, draw.dw, draw.dh);
	}
	if (svg.shadow && bitmap) {
		paintBitmapRaster(svg.shadow, bitmap, draw);
	}
	return true;
}

/**
 * A `DrawImage`/`DrawImagePoints` record's source rectangle: its unit
 * (`UnitPixel` = 2 for a bitmap), the rectangle, and `toWorld`, which maps
 * source coordinates to world coordinates (the destination rectangle or
 * parallelogram).
 */
export interface ImageDrawSource {
	unit: number;
	srcX: number;
	srcY: number;
	srcW: number;
	srcH: number;
	toWorld: (sx: number, sy: number, sw: number, sh: number) => TransformMatrix;
}

/** GDI+ `UnitPixel`: the source-rectangle unit of a metafile image drawn in its own device pixels. */
const UNIT_PIXEL = 2;

/**
 * Replays a nested EMF's records into `ctx` under `toCanvas` (its device
 * pixels to canvas pixels), returning its own deferred image draws, or
 * `null` when the bytes are not an EMF. Registered by
 * `emf-record-replay.ts` (see {@link registerNestedMetafileReplayer}),
 * which this module cannot import without an import cycle.
 */
export type NestedMetafileReplayer = (
	bytes: ArrayBuffer,
	ctx: CanvasContext,
	canvasW: number,
	canvasH: number,
	toCanvas: TransformMatrix,
	options: ReplayOptions,
) => DeferredImageDraw[] | null;

let nestedReplayer: NestedMetafileReplayer | null = null;

/** Installs the nested-metafile replayer (called once by `emf-record-replay.ts`). */
export function registerNestedMetafileReplayer(fn: NestedMetafileReplayer): void {
	nestedReplayer = fn;
}

/**
 * Draws an embedded metafile image by replaying its records straight into
 * the destination context, instead of rasterising it on its own and
 * scaling the bitmap: every shape stays exact at the destination scale (and
 * vector in SVG output), under the clip active at the `DrawImage` record
 * intersected with the destination parallelogram, which GDI+ clips a
 * metafile's playback to. The source rectangle is in the nested metafile's
 * device pixels (GDI+ records its frame converted to pixels), so
 * `toWorld` of it places those pixels on the destination. Returns
 * `false` when the metafile cannot be replayed this way (a WMF, a source
 * unit other than pixels, the nesting cap, or no replayer registered).
 */
function drawNestedMetafile(
	rCtx: EmfPlusReplayCtx,
	img: EmfPlusImage,
	cached: EmfPlusPreDecodedImage | undefined,
	source: ImageDrawSource | undefined,
): boolean {
	const depth = rCtx.nestingDepth ?? 0;
	if (!nestedReplayer || !source || !img.data || source.unit !== UNIT_PIXEL || depth >= MAX_NESTED_METAFILE_DEPTH) {
		return false;
	}
	const { srcX, srcY, srcW, srcH } = source;
	if (!(srcW > 0 && srcH > 0) || ![srcX, srcY, srcW, srcH].every(Number.isFinite)) {
		return false;
	}
	const size = surfaceSize(rCtx.ctx);
	if (!size) {
		return false;
	}
	// GDI+ scales a metafile's pixel grid about pixel CENTRES: the nested
	// device point x lands at (x + 0.5) * scale - 0.5 plus the destination
	// origin, so pixel centres map onto pixel centres (confirmed against the
	// gpx-metafile-* fixtures, where every nested shape edge lands exactly
	// where this puts it and nowhere else).
	const toCanvas = mulMatrix(
		[1, 0, 0, 1, -0.5, -0.5],
		mulMatrix(mulMatrix(plusWorldMatrix(rCtx), source.toWorld(srcX, srcY, srcW, srcH)), [1, 0, 0, 1, 0.5, 0.5]),
	);
	const bytes = img.data.slice(0) as ArrayBuffer;
	const caches = cached && cached.kind === 'metafile' ? cached.caches : undefined;
	const { ctx } = rCtx;
	ctx.save();
	let deferred: DeferredImageDraw[] | null = null;
	try {
		ctx.setTransform(toCanvas[0], toCanvas[1], toCanvas[2], toCanvas[3], toCanvas[4], toCanvas[5]);
		ctx.beginPath();
		ctx.rect(srcX, srcY, srcW, srcH);
		ctx.clip();
		deferred = nestedReplayer(bytes, ctx, size.w, size.h, toCanvas, {
			textureCache: caches?.textures,
			imageCache: caches?.images,
			fontFamilyMap: rCtx.fontFamilyMap,
			gdiAntialias: rCtx.gdiAntialias,
			nestingDepth: depth + 1,
		});
	} finally {
		ctx.restore();
	}
	if (!deferred) {
		return false;
	}
	rCtx.deferredImages.push(...deferred);
	return true;
}

/**
 * Paints an EMF+ image draw now, in record order (see the module doc).
 * Returns `false`, having drawn nothing, when the image's content is not
 * available synchronously; the caller then defers the draw.
 */
export function drawEmfPlusImageNow(
	rCtx: EmfPlusReplayCtx,
	img: EmfPlusImage,
	draw: DeferredImageDraw,
	source?: ImageDrawSource,
): boolean {
	const cached = img.cacheKey !== undefined ? rCtx.imageCache?.get(img.cacheKey) : undefined;
	if (img.type === 2) {
		return drawNestedMetafile(rCtx, img, cached, source);
	}
	const bitmap = cached && cached.kind === 'bitmap' ? cached : null;
	if (isSvgContext(rCtx.ctx)) {
		return paintBitmapSvg(rCtx.ctx, img, bitmap, draw);
	}
	return bitmap ? paintBitmapRaster(rCtx.ctx, bitmap, draw) : false;
}
