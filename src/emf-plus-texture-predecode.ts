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
 * brush object's `cacheKey`: the `dataOff` (in the ORIGINAL buffer) of its
 * `EMFPLUS_OBJECT` record, or of the first record of a continuation run.
 * The real replay pass threads this cache through
 * `EmfPlusReplayCtx.textureCache`; when the synchronous brush parser hits
 * the same compressed brush again (with the same key, since both passes
 * walk the identical buffer), it uses the cached pixels instead of falling
 * back to a flat colour.
 *
 * A brush large enough to be split across `EMFPLUS_OBJECT` continuation
 * records (routinely spread over several `EMR_COMMENT` records) is
 * reassembled here by {@link feedEmfPlusObjectRecord}, the very function
 * the replay uses, with one accumulator carried across the whole file, so
 * the assembled bytes and the cache key agree between the two passes.
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
	createContinuationAccumulator,
	feedEmfPlusObjectRecord,
	type AssembledEmfPlusObject,
	type ContinuationAccumulator,
} from './emf-plus-continuation';
import {
	findCompressedTextureImageBytes,
	looksLikeGraphicsVersion,
	textureBrushImageOffset,
} from './emf-plus-brush-parser';
import { emfLog, emfWarn } from './emf-logging';
import type { EmfPlusDecodedTexture, EmfPlusTextureCache } from './emf-types';

/** One candidate compressed-texture image found during the scan. */
interface Candidate {
	/** The brush object's cache key (see {@link AssembledEmfPlusObject.cacheKey}). */
	key: number;
	/** The bytes holding the image: the original view, or an assembled continuation buffer. */
	view: DataView;
	byteStart: number;
	byteEnd: number;
}

/**
 * Collects the compressed TextureFill image byte range of one complete EMF+
 * object, if it is such a brush.
 */
function collectTextureCandidate(obj: AssembledEmfPlusObject, out: Candidate[]): void {
	const objectType = (obj.flags >> 8) & 0x7f;
	if (objectType !== EMFPLUS_OBJECTTYPE_BRUSH || obj.dataSize < 8) {
		return;
	}
	const { view, dataOff } = obj;
	const recEnd = dataOff + obj.dataSize;
	const hasVersion = looksLikeGraphicsVersion(view.getUint32(dataOff, true));
	const typeOff = dataOff + (hasVersion ? 4 : 0);
	if (typeOff + 8 > recEnd || view.getUint32(typeOff, true) !== EMFPLUS_BRUSHTYPE_TEXTUREFILL) {
		return;
	}
	const imgOff = textureBrushImageOffset(view, typeOff + 4, recEnd);
	if (imgOff === null) {
		return;
	}
	const bytes = findCompressedTextureImageBytes(view, imgOff, recEnd);
	if (bytes) {
		out.push({ key: obj.cacheKey, view, byteStart: bytes.start, byteEnd: bytes.end });
	}
}

/**
 * Scans one EMF+ record sub-stream (the payload of a single EMR_COMMENT) for
 * Brush objects, collecting compressed TextureFill image byte ranges.
 * Mirrors just enough of `replayEmfPlusRecords`' record-walking loop to find
 * OBJECT records (reassembling continuation runs through `acc`, which
 * persists across sub-streams); it does not track drawing state, since
 * object records are self-contained.
 */
function scanEmfPlusStream(
	view: DataView,
	offset: number,
	length: number,
	acc: ContinuationAccumulator,
	out: Candidate[],
): void {
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
		if (recType === EMFPLUS_OBJECT) {
			const assembled = feedEmfPlusObjectRecord(acc, view, recFlags, off + 12, recDataSize);
			if (assembled) {
				collectTextureCandidate(assembled, out);
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
	const acc = createContinuationAccumulator();
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
				scanEmfPlusStream(view, dataOff + 8, commentDataSize - 4, acc, candidates);
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
		const decoded = await decodeCompressedBytesToRgba(c.view, c.byteStart, c.byteEnd);
		if (decoded) {
			cache.set(c.key, decoded);
			emfLog(`preDecodeEmfPlusTextures: decoded texture for key=0x${c.key.toString(16)}: ${decoded.width}x${decoded.height}`);
		}
	}
	return cache;
}
