/**
 * The texture pre-decode pass against a TextureFill brush split across
 * EMFPLUS_OBJECT continuation records spread over several EMR_COMMENTs.
 *
 * The split metafile is synthesised from the real GDI+ fixture
 * `texture-fill-compressed.emf` (a compressed-PNG TextureFill brush filling
 * the whole frame): its single brush OBJECT record is cut into three
 * continuation chunks, each in its own EMR_COMMENT, so the replayed result
 * can be checked against the same real GDI+ reference PNG.
 */
import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { diffImages, fixturePath, loadReference } from './__fixtures__/gdi-parity-harness';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { EMFPLUS_OBJECT, EMFPLUS_SIGNATURE, EMR_COMMENT, EMR_HEADER } from './emf-constants';
import { preDecodeEmfPlusTextures } from './emf-plus-texture-predecode';
import { convertMetafileToDataUrl } from './index';

interface PlusRecord {
	type: number;
	flags: number;
	data: Uint8Array;
}

/** Serialises EMF+ records into one EMR_COMMENT record. */
function emfPlusComment(records: PlusRecord[]): Uint8Array {
	const body = records.reduce((n, r) => n + 12 + r.data.length, 0);
	const out = new Uint8Array(16 + body);
	const v = new DataView(out.buffer);
	v.setUint32(0, EMR_COMMENT, true);
	v.setUint32(4, out.length, true);
	v.setUint32(8, 4 + body, true);
	v.setUint32(12, EMFPLUS_SIGNATURE, true);
	let o = 16;
	for (const r of records) {
		v.setUint16(o, r.type, true);
		v.setUint16(o + 2, r.flags, true);
		v.setUint32(o + 4, 12 + r.data.length, true);
		v.setUint32(o + 8, r.data.length, true);
		out.set(r.data, o + 12);
		o += 12 + r.data.length;
	}
	return out;
}

/**
 * Rewrites `texture-fill-compressed.emf` so its brush object arrives as
 * three continuation chunks in three EMR_COMMENTs. `prefixEveryChunk` puts
 * the 4-byte TotalObjectSize on every chunk (the [MS-EMFPLUS] layout),
 * otherwise only on the first. Returns the new file and the offset of the
 * first chunk's data (the expected cache key).
 */
function splitBrushFixture(prefixEveryChunk: boolean): { bytes: Uint8Array; firstChunkDataOff: number } {
	const src = new Uint8Array(readFileSync(fixturePath('texture-fill-compressed.emf')));
	const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
	const parts: Uint8Array[] = [];
	let firstChunkDataOff = -1;
	let size = 0;
	let off = 0;
	let replaced = false;
	while (off + 8 <= src.length) {
		const type = v.getUint32(off, true);
		const recSize = v.getUint32(off + 4, true);
		const rec = src.subarray(off, off + recSize);
		if (!replaced && type === EMR_COMMENT && v.getUint32(off + 12, true) === EMFPLUS_SIGNATURE) {
			// Parse the comment's EMF+ records.
			const end = off + 12 + v.getUint32(off + 8, true);
			const records: PlusRecord[] = [];
			for (let p = off + 16; p + 12 <= end; ) {
				const s = v.getUint32(p + 4, true);
				records.push({
					type: v.getUint16(p, true),
					flags: v.getUint16(p + 2, true),
					data: src.slice(p + 12, p + 12 + v.getUint32(p + 8, true)),
				});
				p += s;
			}
			const idx = records.findIndex((r) => r.type === EMFPLUS_OBJECT);
			if (idx < 0) {
				// A comment without the brush (e.g. the EMF+ header alone): keep it.
				parts.push(rec);
				size += rec.length;
				off += recSize;
				continue;
			}
			const brush = records[idx];
			const total = brush.data.length;
			const cut = [0, 80, 160, total];
			const chunk = (k: number, withPrefix: boolean): Uint8Array => {
				const payload = brush.data.subarray(cut[k], cut[k + 1]);
				if (!withPrefix) {
					return payload.slice();
				}
				const d = new Uint8Array(4 + payload.length);
				new DataView(d.buffer).setUint32(0, total, true);
				d.set(payload, 4);
				return d;
			};
			const continued = brush.flags | 0x8000;
			const first = emfPlusComment([
				...records.slice(0, idx),
				{ type: EMFPLUS_OBJECT, flags: continued, data: chunk(0, true) },
			]);
			const second = emfPlusComment([{ type: EMFPLUS_OBJECT, flags: continued, data: chunk(1, prefixEveryChunk) }]);
			const third = emfPlusComment([
				{ type: EMFPLUS_OBJECT, flags: brush.flags, data: chunk(2, false) },
				...records.slice(idx + 1),
			]);
			// The first chunk's data sits after the first comment's other records.
			const before = records.slice(0, idx).reduce((n, r) => n + 12 + r.data.length, 0);
			firstChunkDataOff = size + 16 + before + 12;
			for (const c of [first, second, third]) {
				parts.push(c);
				size += c.length;
			}
			replaced = true;
		} else {
			parts.push(rec);
			size += rec.length;
		}
		off += recSize;
	}
	const bytes = new Uint8Array(size);
	let o = 0;
	for (const p of parts) {
		bytes.set(p, o);
		o += p.length;
	}
	// Patch EMR_HEADER nBytes / nRecords for the extra records.
	const hv = new DataView(bytes.buffer);
	expect(hv.getUint32(0, true)).toBe(EMR_HEADER);
	hv.setUint32(48, size, true);
	hv.setUint32(52, hv.getUint32(52, true) + 2, true);
	return { bytes, firstChunkDataOff };
}

async function decodeDataUrl(url: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
	const napi = await import('@napi-rs/canvas');
	const img = await napi.loadImage(Buffer.from(url.split(',')[1], 'base64'));
	const canvas = napi.createCanvas(img.width, img.height);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, img.width, img.height);
	ctx.drawImage(img, 0, 0);
	return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

describe('preDecodeEmfPlusTextures with a continuation-split TextureFill brush', () => {
	it.each([
		['TotalObjectSize on every continued chunk', true],
		['TotalObjectSize on the first chunk only', false],
	])('pre-decodes the reassembled brush, keyed by its first chunk (%s)', async (_label, prefixEveryChunk) => {
		await ensureNodeCanvasModule();
		const { bytes, firstChunkDataOff } = splitBrushFixture(prefixEveryChunk);
		const cache = await preDecodeEmfPlusTextures(new DataView(bytes.buffer));
		expect([...cache.keys()]).toEqual([firstChunkDataOff]);
		const tex = cache.get(firstChunkDataOff)!;
		expect(tex.width).toBe(16);
		expect(tex.height).toBe(16);
	});

	it('replays the split brush pixel-exactly against the real GDI+ reference', async () => {
		const { bytes } = splitBrushFixture(true);
		const url = await convertMetafileToDataUrl(bytes.buffer as ArrayBuffer, { dpiScale: 1 });
		expect(url).not.toBeNull();
		const diff = diffImages(await decodeDataUrl(url!), await loadReference('texture-fill-compressed'), 8);
		expect(diff.mismatchRatio).toBe(0);
	});
});
