/**
 * Async pre-decode pass for EMF+ TextureFill brushes whose embedded image is
 * a compressed (PNG/JPEG) bitmap.
 *
 * The main record-replay pipeline (`emf-record-replay.ts` / `emf-plus-replay.ts`)
 * is entirely synchronous, because Canvas 2D drawing calls are synchronous and
 * a brush must be fully resolved before the shape it paints is filled. A
 * compressed embedded image needs an async image decode
 * (`createImageBitmap`/`@napi-rs/canvas`'s `loadImage`), which
 * `parseEmfPlusBrushObject`'s synchronous, per-record parse cannot perform;
 * `DrawImage`/`DrawImagePoints` sidestep the same problem by deferring the
 * actual image draw until after replay completes (`processDeferredImages`),
 * but a brush's fill happens inline with vector drawing and cannot be
 * deferred the same way.
 *
 * This module runs BEFORE replay starts: it walks the raw metafile once,
 * looking only for `EMFPLUS_OBJECT` records whose type is Brush and whose
 * data is a TextureFill brush with a compressed embedded image (an
 * uncompressed pixel bitmap is already handled synchronously and is left
 * alone), decodes each one asynchronously, and returns a cache keyed by the
 * object record's own `dataOff` in the ORIGINAL buffer. The real replay pass
 * threads this cache through `EmfPlusReplayCtx.textureCache`; when the
 * synchronous brush parser hits the same compressed brush again (at the same
 * `dataOff`, since both passes walk the identical buffer), it uses the
 * cached pixels instead of falling back to a flat colour.
 *
 * Scope: only single-record (non-continuation) Brush objects are pre-decoded.
 * A texture brush split across `EMFPLUS_OBJECT` continuation records (large
 * enough to exceed one record) is rare in practice and is left as the
 * existing documented fallback (flat colour); the assembled continuation
 * buffer's offsets do not correspond to this scan's offsets into the
 * original buffer, so caching by `dataOff` would not be meaningful there.
 *
 * @module emf-plus-texture-predecode
 */

import {
	createTempCanvas,
	canvasDrawImage,
	canvasGetImageData,
	decodeDeferredImageBytes,
} from './emf-canvas-helpers';
import {
	EMFPLUS_BRUSHTYPE_TEXTUREFILL,
	EMFPLUS_OBJECT,
	EMFPLUS_OBJECTTYPE_BRUSH,
	EMFPLUS_SIGNATURE,
	EMR_COMMENT,
	EMR_EOF,
} from './emf-constants';
import {
	findCompressedTextureImageBytes,
	looksLikeGraphicsVersion,
	textureBrushImageOffset,
} from './emf-plus-brush-parser';
import { emfLog, emfWarn } from './emf-logging';
import type { EmfPlusDecodedTexture, EmfPlusTextureCache } from './emf-types';

/** One candidate compressed-texture image found during the scan. */
interface Candidate {
	/** The enclosing `EMFPLUS_OBJECT` record's `dataOff` (the cache key). */
	dataOff: number;
	byteStart: number;
	byteEnd: number;
}

/**
 * Scans one EMF+ record sub-stream (the payload of a single EMR_COMMENT) for
 * non-continuation Brush objects, collecting compressed TextureFill image
 * byte ranges. Mirrors just enough of `replayEmfPlusRecords`' record-walking
 * loop to find OBJECT records; it does not track drawing state, since object
 * records are self-contained.
 */
function scanEmfPlusStream(view: DataView, offset: number, length: number, out: Candidate[]): void {
	const end = offset + length;
	let off = offset;
	let recordCount = 0;
	const MAX_RECORDS = 500000;
	while (off + 12 <= end && recordCount < MAX_RECORDS) {
		const recType = view.getUint16(off, true);
		const recFlags = view.getUint16(off + 2, true);
		const recSize = view.getUint32(off + 4, true);
		const recDataSize = view.getUint32(off + 8, true);
		if (recSize < 12 || off + recSize > end) {
			break;
		}
		recordCount++;
		const dataOff = off + 12;
		const isContinuation = (recFlags & 0x8000) !== 0;
		if (recType === EMFPLUS_OBJECT && !isContinuation) {
			const objectType = (recFlags >> 8) & 0x7f;
			if (objectType === EMFPLUS_OBJECTTYPE_BRUSH && recDataSize >= 8) {
				const recEnd = dataOff + recDataSize;
				const hasVersion = looksLikeGraphicsVersion(view.getUint32(dataOff, true));
				const typeOff = dataOff + (hasVersion ? 4 : 0);
				if (typeOff + 8 <= recEnd) {
					const brushType = view.getUint32(typeOff, true);
					if (brushType === EMFPLUS_BRUSHTYPE_TEXTUREFILL) {
						const b = typeOff + 4;
						const imgOff = textureBrushImageOffset(view, b, recEnd);
						if (imgOff !== null) {
							const bytes = findCompressedTextureImageBytes(view, imgOff, recEnd);
							if (bytes) {
								out.push({ dataOff, byteStart: bytes.start, byteEnd: bytes.end });
							}
						}
					}
				}
			}
		}
		off += recSize;
	}
}

/**
 * Walks the raw EMF byte stream's `EMR_COMMENT`/EMF+ sub-streams looking for
 * `EMR_COMMENT` records at the top level (WMF has no EMF+ records at all, so
 * this is a no-op for WMF input).
 */
function scanEmfForTextureCandidates(view: DataView): Candidate[] {
	const candidates: Candidate[] = [];
	let offset = 0;
	const maxOffset = view.byteLength;
	let recordCount = 0;
	const MAX_RECORDS = 500000;
	while (offset + 8 <= maxOffset && recordCount < MAX_RECORDS) {
		const recType = view.getUint32(offset, true);
		const recSize = view.getUint32(offset + 4, true);
		if (recSize < 8 || offset + recSize > maxOffset) {
			break;
		}
		recordCount++;
		if (recType === EMR_COMMENT && recSize >= 16) {
			const dataOff = offset + 8;
			const commentDataSize = view.getUint32(dataOff, true);
			const sig = view.getUint32(dataOff + 4, true);
			if (sig === EMFPLUS_SIGNATURE && commentDataSize > 4) {
				scanEmfPlusStream(view, dataOff + 8, commentDataSize - 4, candidates);
			}
		} else if (recType === EMR_EOF) {
			break;
		}
		offset += recSize;
	}
	return candidates;
}

/** Decodes compressed image bytes (a PNG/JPEG/etc. blob) into top-down RGBA pixels. */
async function decodeCompressedBytesToRgba(
	view: DataView,
	start: number,
	end: number,
): Promise<EmfPlusDecodedTexture | null> {
	const byteLength = end - start;
	if (byteLength <= 0) {
		return null;
	}
	// Copy into a plain ArrayBuffer: `view.buffer` may be a SharedArrayBuffer,
	// which the Blob constructor `decodeDeferredImageBytes` uses does not
	// accept under strict TypeScript typing (see the same copy in
	// `emf-converter.ts`'s `processDeferredImages`).
	const src = new Uint8Array(view.buffer, view.byteOffset + start, byteLength);
	const bytes = new ArrayBuffer(byteLength);
	new Uint8Array(bytes).set(src);
	try {
		const decoded = await decodeDeferredImageBytes(bytes);
		if (!decoded) {
			return null;
		}
		const { width, height } = decoded;
		if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
			decoded.close();
			return null;
		}
		const temp = createTempCanvas(width, height);
		if (!temp) {
			decoded.close();
			return null;
		}
		canvasDrawImage(temp.ctx, decoded.drawable, 0, 0, width, height);
		decoded.close();
		const pixels = canvasGetImageData(temp.ctx, 0, 0, width, height);
		return { width, height, rgba: new Uint8ClampedArray(pixels.data.buffer.slice(0)) };
	} catch (err) {
		emfWarn(
			'preDecodeEmfPlusTextures: failed to decode a compressed texture image:',
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * Pre-decodes every compressed EMF+ TextureFill brush image found in `view`,
 * returning a cache the real replay pass consults via
 * `EmfPlusReplayCtx.textureCache`. Returns an empty map for WMF input, or an
 * EMF file with no such brushes (the overwhelming common case), so callers
 * can always `await` this unconditionally without a format check.
 */
export async function preDecodeEmfPlusTextures(view: DataView): Promise<EmfPlusTextureCache> {
	const cache: EmfPlusTextureCache = new Map();
	let candidates: Candidate[];
	try {
		candidates = scanEmfForTextureCandidates(view);
	} catch (err) {
		emfWarn('preDecodeEmfPlusTextures: scan failed:', err instanceof Error ? err.message : err);
		return cache;
	}
	if (candidates.length === 0) {
		return cache;
	}
	emfLog(`preDecodeEmfPlusTextures: found ${candidates.length} compressed-texture candidate(s)`);
	for (const c of candidates) {
		const decoded = await decodeCompressedBytesToRgba(view, c.byteStart, c.byteEnd);
		if (decoded) {
			cache.set(c.dataOff, decoded);
			emfLog(`preDecodeEmfPlusTextures: decoded texture at dataOff=0x${c.dataOff.toString(16)}: ${decoded.width}x${decoded.height}`);
		}
	}
	return cache;
}
