/**
 * GDI+'s own image-effect results, read out of the `plus-effect-*` fixtures.
 *
 * When GDI+ records `DrawImage` with an effect (`GdipDrawImageFX`) into an
 * EMF+ metafile it writes the source image, the effect
 * (`EmfPlusSerializableObject`) and the flag-E `DrawImagePoints`, and then
 * a second image object holding the effected bitmap GDI+ computed, drawn by
 * a plain `DrawImagePoints` over the same destination. Each pair therefore
 * gives the source pixels, the effect and GDI+'s exact output for them,
 * which `emf-plus-image-effects.fixture.test.ts` compares the converter's
 * effects against, pixel for pixel.
 *
 * Test-only: lives under `__fixtures__`, is never exported from the package.
 */
import { readFileSync } from 'node:fs';

import {
	EMFPLUS_DRAWIMAGEPOINTS,
	EMFPLUS_OBJECT,
	EMFPLUS_SERIALIZABLEOBJECT,
	EMFPLUS_SIGNATURE,
	EMR_COMMENT,
	EMR_EOF,
} from '../emf-constants';
import { parseSerializableObject, readGuid, type EmfPlusImageEffect } from '../emf-plus-image-effects';
import { decodePng, type DecodedPng } from '../png-decoder';
import { fixturePath } from './gdi-parity-harness';

/** One effected draw: GDI+'s input, effect and output. */
export interface BakedEffect {
	/** The whole source image. */
	source: DecodedPng;
	effect: EmfPlusImageEffect;
	/** The draw's source rectangle (x, y, width, height) in `source` pixels. */
	srcRect: [number, number, number, number];
	/** GDI+'s effected bitmap; its pixel (0, 0) is source pixel (srcRect x, y). */
	baked: DecodedPng;
}

/** ColorLookupTableEffectGuid: GDI+ records a ColorCurve effect under it (see `parseSerializableObject`). */
const COLOR_LUT_GUID = 'A7CE72A9-0F7F-40D7-B3CC-D0C02D5C3212';

/**
 * The effect of a SerializableObject record. A 12-byte object under the
 * ColorLookupTable GUID is read as the ColorCurve GDI+ meant, so its
 * algorithm can be measured even though playback ignores it.
 */
function readEffect(view: DataView, off: number, size: number): EmfPlusImageEffect | null {
	if (size === 32 && readGuid(view, off) === COLOR_LUT_GUID && view.getUint32(off + 16, true) === 12) {
		return {
			kind: 'colorCurve',
			adjustment: view.getInt32(off + 20, true),
			channel: view.getInt32(off + 24, true),
			intensity: view.getInt32(off + 28, true),
		};
	}
	return parseSerializableObject(view, off, size);
}

/** Decodes an EmfPlusImage object holding a bitmap (compressed or 32bpp ARGB). */
async function decodeImageObject(bytes: Uint8Array): Promise<DecodedPng> {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint32(4, true) !== 1) {
		throw new Error('not a bitmap image object');
	}
	if (v.getUint32(24, true) === 1) {
		const png = await decodePng(bytes.subarray(28));
		if (!png) {
			throw new Error('undecodable compressed bitmap');
		}
		return png;
	}
	const width = v.getInt32(8, true);
	const height = v.getInt32(12, true);
	const stride = v.getInt32(16, true);
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = 28 + y * stride + x * 4;
			data.set([bytes[o + 2], bytes[o + 1], bytes[o], bytes[o + 3]], (y * width + x) * 4);
		}
	}
	return { width, height, data };
}

/** Every effected draw of the fixture `<name>.emf` with GDI+'s own result. */
export async function readBakedEffects(name: string): Promise<BakedEffect[]> {
	const file = readFileSync(fixturePath(`${name}.emf`));
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const objects = new Map<number, Uint8Array>();
	let partial: { id: number; parts: Uint8Array[]; total: number } | null = null;
	let effect: EmfPlusImageEffect | null = null;
	let pending: { image: Uint8Array; effect: EmfPlusImageEffect; srcRect: [number, number, number, number] } | null = null;
	const found: Array<{ image: Uint8Array; effect: EmfPlusImageEffect; srcRect: [number, number, number, number]; baked: Uint8Array }> = [];
	for (let off = 0; off + 8 <= file.length; ) {
		const type = view.getUint32(off, true);
		const size = view.getUint32(off + 4, true);
		if (type === EMR_EOF || size < 8) {
			break;
		}
		if (type === EMR_COMMENT && view.getUint32(off + 12, true) === EMFPLUS_SIGNATURE) {
			const end = off + 12 + view.getUint32(off + 8, true);
			for (let p = off + 16; p + 12 <= end; ) {
				const recType = view.getUint16(p, true);
				const flags = view.getUint16(p + 2, true);
				const recSize = view.getUint32(p + 4, true);
				const dataSize = view.getUint32(p + 8, true);
				const data = p + 12;
				if (recType === EMFPLUS_OBJECT) {
					const id = flags & 0xff;
					if (flags & 0x8000) {
						if (!partial || partial.id !== id) {
							partial = { id, parts: [], total: view.getUint32(data, true) };
						}
						partial.parts.push(file.subarray(data + 4, data + dataSize));
					} else if (partial && partial.id === id) {
						partial.parts.push(file.subarray(data, data + dataSize));
					} else {
						objects.set(id, new Uint8Array(file.subarray(data, data + dataSize)));
					}
					if (partial && partial.id === id && partial.parts.reduce((n, b) => n + b.length, 0) >= partial.total) {
						const all = new Uint8Array(partial.total);
						let at = 0;
						for (const b of partial.parts) {
							all.set(b.subarray(0, partial.total - at), at);
							at += b.length;
						}
						objects.set(id, all);
						partial = null;
					}
				} else if (recType === EMFPLUS_SERIALIZABLEOBJECT) {
					effect = readEffect(view, data, dataSize);
				} else if (recType === EMFPLUS_DRAWIMAGEPOINTS) {
					const image = objects.get(flags & 0xff);
					const rect = [0, 1, 2, 3].map((k) => view.getFloat32(data + 8 + 4 * k, true)) as [number, number, number, number];
					if (image && flags & 0x2000 && effect) {
						pending = { image, effect, srcRect: rect };
					} else if (image && pending) {
						found.push({ ...pending, baked: image });
						pending = null;
					}
				}
				p += recSize;
			}
		}
		off += size;
	}
	const out: BakedEffect[] = [];
	for (const f of found) {
		out.push({ source: await decodeImageObject(f.image), effect: f.effect, srcRect: f.srcRect, baked: await decodeImageObject(f.baked) });
	}
	return out;
}
