/**
 * Async pre-decode pass for EMF+ Image objects, so `DrawImage` /
 * `DrawImagePoints` paint synchronously, in record order.
 *
 * Record replay is synchronous (see `emf-plus-texture-predecode.ts` for the
 * same constraint on texture brushes), while decoding a PNG/JPEG/BMP needs
 * an async image decoder. Image draws used to be deferred until after
 * replay (`processDeferredImages`), which in PNG output painted every image
 * on top of everything recorded after it and without the clip that was
 * active when it was recorded. This pass runs BEFORE replay: it walks the
 * raw metafile once, finds every `EMFPLUS_OBJECT` Image object (continuation
 * runs reassembled by the replay's own code, so the cache key agrees), and
 * prepares its content:
 *
 * - a raster bitmap is decoded to RGBA pixels;
 * - an embedded metafile is not rasterised at all: its own compressed
 *   texture brushes and Image objects are pre-decoded recursively, so the
 *   nested metafile can later be replayed straight into the destination
 *   context (`emf-plus-draw-image.ts`).
 *
 * The replay pass then finds each drawn image in
 * `EmfPlusReplayCtx.imageCache` by the object's `cacheKey`. A miss (no image
 * decoder in this environment, or an undecodable format) keeps the old
 * deferred path, and SVG output never needs the decoded pixels of a
 * browser-native image (it embeds the original PNG/JPEG bytes).
 *
 * @module emf-plus-image-predecode
 */

import { EMFPLUS_OBJECTTYPE_IMAGE } from './emf-constants';
import { emfLog, emfWarn } from './emf-logging';
import { parseEmfPlusImageObject } from './emf-plus-object-complex';
import {
	decodeCompressedBytesToRgba,
	preDecodeEmfPlusTextures,
	walkEmfPlusObjects,
} from './emf-plus-texture-predecode';
import type { EmfPlusImageCache, EmfPlusMetafileCaches } from './emf-types';

/** Deepest metafile-in-metafile nesting pre-decoded (matches the converter's recursion cap). */
export const MAX_NESTED_METAFILE_DEPTH = 3;

/** One Image object found by the scan. */
interface ImageCandidate {
	key: number;
	type: number;
	data: ArrayBuffer | SharedArrayBuffer;
}

/**
 * Pre-decodes every EMF+ Image object in `view` (see the module doc).
 * `depth` is the metafile nesting depth of `view` itself. Never throws:
 * a failed decode just leaves that image out of the cache.
 */
export async function preDecodeEmfPlusImages(view: DataView, depth: number = 0): Promise<EmfPlusImageCache> {
	const cache: EmfPlusImageCache = new Map();
	const candidates: ImageCandidate[] = [];
	try {
		walkEmfPlusObjects(view, (obj) => {
			const objectType = (obj.flags >> 8) & 0x7f;
			if (objectType !== EMFPLUS_OBJECTTYPE_IMAGE || obj.dataSize < 8) {
				return;
			}
			const parsed = parseEmfPlusImageObject(obj.view, obj.dataOff, obj.dataSize, obj.flags & 0xff);
			if (parsed.data && parsed.data.byteLength > 0) {
				candidates.push({ key: obj.cacheKey, type: parsed.type, data: parsed.data });
			}
		});
	} catch (err) {
		emfWarn('preDecodeEmfPlusImages: scan failed:', err instanceof Error ? err.message : err);
		return cache;
	}
	for (const c of candidates) {
		const nestedView = new DataView(c.data, 0, c.data.byteLength);
		if (c.type === 2) {
			if (depth >= MAX_NESTED_METAFILE_DEPTH) {
				continue;
			}
			cache.set(c.key, { kind: 'metafile', caches: await preDecodeMetafileCaches(nestedView, depth + 1) });
			continue;
		}
		const decoded = await decodeCompressedBytesToRgba(nestedView, 0, c.data.byteLength);
		if (decoded) {
			cache.set(c.key, { kind: 'bitmap', ...decoded });
			emfLog(`preDecodeEmfPlusImages: decoded image key=0x${c.key.toString(16)}: ${decoded.width}x${decoded.height}`);
		}
	}
	return cache;
}

/**
 * Everything a replay of the metafile in `view` pre-decodes: its compressed
 * texture brush images and its Image objects (recursively for nested
 * metafiles). `depth` is the nesting depth of `view`.
 */
export async function preDecodeMetafileCaches(view: DataView, depth: number = 0): Promise<EmfPlusMetafileCaches> {
	return {
		textures: await preDecodeEmfPlusTextures(view),
		images: await preDecodeEmfPlusImages(view, depth),
	};
}
