import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertMetafileToDataUrl } from './emf-converter';
import { getMetafileInfo } from './metafile-info';

const FIXTURES = join(__dirname, '__fixtures__');

function load(name: string): ArrayBuffer {
	const b = readFileSync(join(FIXTURES, name));
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Pixel size from a PNG data URL's IHDR chunk. */
function pngSize(url: string): { w: number; h: number } {
	const bytes = Buffer.from(url.split(',')[1], 'base64');
	return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

describe('getMetafileInfo', () => {
	it('reads a plain EMF with text and GDI fonts', async () => {
		const info = await getMetafileInfo(load('gdi/emfrec-text-c1-ext-arial.emf'));
		expect(info).not.toBeNull();
		expect(info!.format).toBe('emf');
		expect(info!.bounds).toEqual({ left: 0, top: 0, right: 239, bottom: 129 });
		expect(info!.frame).toEqual({ left: 0, top: 0, right: 3731, bottom: 2022 });
		expect(info!.device).toEqual({ width: 3840, height: 2160 });
		expect(info!.deviceMm).toEqual({ width: 597, height: 336 });
		expect(info!.dpi.x).toBeCloseTo(163.38, 1);
		// Header bounds are inclusive: 0..239 is 240 pixels.
		expect([info!.width, info!.height]).toEqual([240, 130]);
		expect(info!.recordCount).toBe(39);
		expect(info!.emfPlusRecordCount).toBe(0);
		expect(info!.recordTypes.EMR_EXTCREATEFONTINDIRECTW).toBe(5);
		expect(info!.recordTypes.EMR_EXTTEXTOUTW).toBe(3);
		expect(info!.hasText).toBe(true);
		expect(info!.fonts).toEqual([
			{ name: 'Arial', gdi: true, emfPlus: false },
			{ name: 'Microsoft Sans Serif', gdi: true, emfPlus: false },
		]);
		expect(info!.images).toEqual({ count: 0, mimeTypes: [] });
		expect(info!.truncated).toBe(false);
	});

	it('reads a placeable WMF with a font and text', async () => {
		const info = await getMetafileInfo(load('gdi/text-arial-hm13.wmf'));
		expect(info!.format).toBe('wmf');
		expect(info!.placeable).toBe(true);
		expect(info!.unitsPerInch).toBe(96);
		expect(info!.bounds).toEqual({ left: 0, top: 0, right: 360, bottom: 40 });
		expect([info!.width, info!.height]).toEqual([360, 40]);
		expect(info!.recordCount).toBe(15);
		expect(info!.recordTypes.META_TEXTOUT).toBe(1);
		expect(info!.hasText).toBe(true);
		expect(info!.fonts.map((f) => f.name)).toEqual(['Arial', 'System']);
		expect(info!.fonts.every((f) => f.gdi && !f.emfPlus)).toBe(true);
	});

	it('converts the placeable header to a frame in .01 mm', async () => {
		const info = await getMetafileInfo(load('sample-crown.wmf'));
		expect(info!.placeable).toBe(true);
		expect(info!.unitsPerInch).toBe(1000);
		expect(info!.bounds).toEqual({ left: -4008, top: -3378, right: 4008, bottom: 3378 });
		expect(info!.frame).toEqual({ left: -10180, top: -8580, right: 10180, bottom: 8580 });
		// 8016 units at 1000 per inch on the 96 dpi reference device.
		expect([info!.width, info!.height]).toEqual([770, 649]);
		expect(info!.recordCount).toBe(220);
		expect(info!.hasText).toBe(false);
		expect(info!.fonts).toEqual([]);
	});

	it('reports a non-placeable WMF as such', async () => {
		const info = await getMetafileInfo(load('gdi/wmf-nonplaceable.wmf'));
		expect(info!.format).toBe('wmf');
		expect(info!.placeable).toBe(false);
		expect(info!.frame).toBeNull();
	});

	it('tells EMF+ only from EMF+ dual and reads EMF+ fonts', async () => {
		const only = await getMetafileInfo(load('gdi/gpx-text-lingrad.emf'));
		expect(only!.format).toBe('emf+');
		expect(only!.emfPlusRecordCount).toBe(10);
		expect(only!.recordTypes.EMFPLUS_DRAWSTRING).toBe(1);
		expect(only!.hasText).toBe(true);
		expect(only!.fonts).toEqual([{ name: 'ARIAL', gdi: false, emfPlus: true }]);

		const dual = await getMetafileInfo(load('gdi/plus-effect-blur-r1.emf'));
		expect(dual!.format).toBe('emf+dual');
		expect(dual!.emfPlusRecordCount).toBe(24);
		expect(dual!.recordTypes.EMR_STRETCHDIBITS).toBe(5);
	});

	it('lists embedded image types', async () => {
		const jpeg = await getMetafileInfo(load('gdi/codec-jpeg-12bit-playback.emf'));
		expect(jpeg!.images).toEqual({ count: 1, mimeTypes: ['image/jpeg'] });

		const dib = await getMetafileInfo(load('gdi/wmf-bitmaps.wmf'));
		expect(dib!.images).toEqual({ count: 25, mimeTypes: ['image/bmp'] });

		const nested = await getMetafileInfo(load('gdi/gpx-metafile-scaled.emf'));
		expect(nested!.embeddedMetafiles).toBe(1);
		expect(nested!.images).toEqual({ count: 1, mimeTypes: ['image/emf'] });
	});

	it('follows the EMF a WMF carries, as the converter does', async () => {
		const info = await getMetafileInfo(load('gdi/wmf-embedded-emf.wmf'));
		expect(info!.format).toBe('wmf');
		expect(info!.playsEmbeddedEmf).toBe(true);
		expect([info!.width, info!.height]).toEqual([248, 130]);
	});

	it('agrees with convertMetafileToDataUrl on the output size', async () => {
		const names = [
			'sample-clip-gdi.emf',
			'sample-gradient-clip.emf',
			'sample-crown.wmf',
			'gdi/wmf-bitmaps.wmf',
			'gdi/wmf-nonplaceable.wmf',
			'gdi/wmf-embedded-emf.wmf',
			'gdi/gpx-text-lingrad.emf',
			'gdi/gpx-metafile-scaled.emf',
			'gdi/plus-effect-blur-r1.emf',
			'gdi/emfrec-text-c1-ext-arial.emf',
			'gdi/text-arial-hm13.wmf',
		];
		for (const name of names) {
			const buffer = load(name);
			const info = await getMetafileInfo(buffer);
			const url = await convertMetafileToDataUrl(buffer);
			expect(url, name).not.toBeNull();
			expect(pngSize(url!), name).toEqual({ w: info!.width, h: info!.height });
		}
	});

	it('returns null for non-metafiles', async () => {
		expect(await getMetafileInfo(new ArrayBuffer(0))).toBeNull();
		expect(await getMetafileInfo(new ArrayBuffer(300))).toBeNull();
		expect(await getMetafileInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>').buffer as ArrayBuffer)).toBeNull();
		expect(await getMetafileInfo(load('gdi/codec-gif.png'))).toBeNull();
	});

	it('honours maxRecords and flags truncation', async () => {
		const info = await getMetafileInfo(load('sample-crown.wmf'), { maxRecords: 10 });
		expect(info!.recordCount).toBe(10);
		expect(info!.truncated).toBe(true);
	});

	it('never throws on truncated or corrupted input', async () => {
		const names = [
			'gdi/emfrec-text-c1-ext-arial.emf',
			'gdi/gpx-text-lingrad.emf',
			'gdi/gpx-metafile-scaled.emf',
			'gdi/plus-effect-blur-r1.emf',
			'gdi/wmf-bitmaps.wmf',
			'gdi/wmf-embedded-emf.wmf',
			'sample-crown.wmf',
		];
		let seed = 12345;
		const rand = (n: number): number => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return seed % n;
		};
		for (const name of names) {
			const full = new Uint8Array(load(name));
			const cuts = new Set([0, 1, 7, 8, 21, 22, 87, 88, 89, 100, 300, full.length - 1, full.length >> 1]);
			for (let i = 0; i < 15; i++) {
				cuts.add(rand(full.length));
			}
			for (const cut of cuts) {
				if (cut < 0 || cut > full.length) {
					continue;
				}
				const info = await getMetafileInfo(full.slice(0, cut).buffer);
				if (info) {
					expect(info.width).toBeGreaterThan(0);
				}
			}
			for (let i = 0; i < 40; i++) {
				const copy = full.slice();
				for (let k = 0; k < 6; k++) {
					copy[rand(copy.length)] = rand(256);
				}
				await getMetafileInfo(copy.buffer);
			}
		}
	});
});
