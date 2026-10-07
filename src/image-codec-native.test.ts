import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { canvasDrawImage, canvasGetImageData, createTempCanvas, decodeDeferredImageBytes, ensureNodeCanvasModule } from './emf-canvas-helpers';
import { sniffImageMime } from './emf-image-payload';
import { decodeJpegPixels, jpegFamily } from './jpeg-decoder';
import { decodePng } from './png-decoder';
import { loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

it('uses bundled TIFF decoding when the installed canvas backend cannot load it', async () => {
	await ensureNodeCanvasModule();
	const bytes = new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-tiff.bin', import.meta.url)));
	const image = (await decodeDeferredImageBytes(bytes.buffer))!;
	expect(image).not.toBeNull();
	const surface = createTempCanvas(image.width, image.height)!;
	canvasDrawImage(surface.ctx, image.drawable, 0, 0, image.width, image.height);
	const expected = (await decodePng(new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-tiff.png', import.meta.url)))))!;
	expect(canvasGetImageData(surface.ctx, 0, 0, image.width, image.height).data).toEqual(expected.data);
	image.close();
});

/** Channel values (R, G, B) of `fixture` decoded by the converter that equal what GDI+ drew, and the largest difference. */
async function compareJpeg(name: string): Promise<{ exact: number; total: number; max: number }> {
	await ensureNodeCanvasModule();
	const bytes = new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-jpeg-${name}.bin`, import.meta.url)));
	const image = (await decodeDeferredImageBytes(bytes.buffer))!;
	const surface = createTempCanvas(image.width, image.height)!;
	canvasDrawImage(surface.ctx, image.drawable, 0, 0, image.width, image.height);
	const got = canvasGetImageData(surface.ctx, 0, 0, image.width, image.height).data;
	const expected = (await decodePng(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-jpeg-${name}.png`, import.meta.url)))))!;
	let exact = 0;
	let max = 0;
	for (let i = 0; i < got.length; i++) {
		if (i % 4 === 3) continue;
		const d = Math.abs(got[i] - expected.data[i]);
		if (d === 0) exact++;
		max = Math.max(max, d);
	}
	image.close();
	return { exact, total: (got.length / 4) * 3, max };
}

// Windows converts CMYK/YCCK JPEG through a colour-managed transform that cannot be reproduced bit for bit; a fitted
// 17^4 grid (src/jpeg-cmyk.ts) reproduces 87-95% of the channel values exactly. The jpeg-js fallback used before
// matched 1% to 11% of them (and refused an Adobe-less file) with errors up to 135.
it.each([
	['cmyk-patches', 42944, 2],
	['cmyk-noadobe', 42944, 2],
	['cmyk-ramps', 46672, 3],
	['cmyk-photo', 16791, 6],
	['cmyk-photo-420', 16856, 6],
	['ycck-patches', 44608, 4],
	['ycck-photo', 16413, 4],
	['ycck-photo-420', 16448, 4],
])('decodes CMYK/YCCK JPEG %s like GDI+ (exact channel values, largest error)', async (name, exactCount, maxError) => {
	const result = await compareJpeg(name);
	expect(result.exact).toBe(exactCount);
	expect(result.max).toBeLessThanOrEqual(maxError);
	expect(result.exact / result.total).toBeGreaterThan(0.85);
});

it('decodes arithmetic-coded JPEG exactly like GDI+', async () => {
	// testimgari.jpg from libjpeg-turbo, which GDI+ decodes (it is the Huffman test image transcoded losslessly).
	const result = await compareJpeg('arithmetic');
	expect(result.exact).toBe(result.total);
});

it('sorts JPEG files into the families the converter handles', () => {
	const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-jpeg-${name}.bin`, import.meta.url)));
	expect(jpegFamily(fixture('444'))).toBe('standard');
	expect(jpegFamily(fixture('progressive'))).toBe('standard');
	expect(jpegFamily(fixture('cmyk-photo'))).toBe('bundled');
	expect(jpegFamily(fixture('ycck-photo'))).toBe('bundled');
	expect(jpegFamily(fixture('arithmetic'))).toBe('bundled');
	expect(jpegFamily(fixture('12bit'))).toBe('unsupported');
	expect(jpegFamily(new Uint8Array([1, 2, 3, 4]))).toBeNull();
});

it('draws nothing for a 12-bit JPEG, as GDI+ does ("Unsupported JPEG data precision 12")', async () => {
	await ensureNodeCanvasModule();
	const bytes = new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-jpeg-12bit.bin', import.meta.url)));
	expect(await decodeDeferredImageBytes(bytes.buffer)).toBeNull();
	expect(() => decodeJpegPixels(bytes)).toThrow();
	expect(sniffImageMime(bytes)).toBeNull();
	// An EMF+ DrawImage of that file leaves the white surface untouched in GDI+'s playback and in ours.
	const rendered = (await renderFixture('codec-jpeg-12bit-playback.emf'))!;
	const reference = await loadReference('codec-jpeg-12bit-playback');
	for (let y = 0; y < rendered.height; y++) {
		for (let x = 0; x < rendered.width; x++) {
			for (let k = 0; k < 3; k++) expect(rendered.data[(y * rendered.width + x) * 4 + k]).toBe(reference.data[(y * reference.width + x) * 4 + k]);
		}
	}
});

it.each([
	['arithmetic', 151086, 1],
	['cmyk-photo', 141750, 3],
])('plays an EMF+ DrawImage of the %s JPEG like GDI+ (exact channel values, largest error)', async (name, exactCount, maxError) => {
	const rendered = (await renderFixture(`codec-jpeg-${name}-playback.emf`))!;
	const reference = await loadReference(`codec-jpeg-${name}-playback`);
	let exact = 0;
	let max = 0;
	for (let y = 0; y < rendered.height; y++) {
		for (let x = 0; x < rendered.width; x++) {
			for (let k = 0; k < 3; k++) {
				const d = Math.abs(rendered.data[(y * rendered.width + x) * 4 + k] - reference.data[(y * reference.width + x) * 4 + k]);
				if (d === 0) exact++;
				max = Math.max(max, d);
			}
		}
	}
	expect(exact).toBe(exactCount);
	expect(max).toBeLessThanOrEqual(maxError);
});