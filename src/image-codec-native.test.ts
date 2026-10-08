import { readdirSync, readFileSync } from 'node:fs';
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

// Windows converts CMYK/YCCK JPEG through the ICM colour-management module (RSWOP profile to sRGB, best mode), which
// resamples the profile onto a 16^4 table of 16-bit colours and interpolates it tetrahedrally; `src/jpeg-cmyk.ts`
// bundles that table (solved from `mscms.dll` samples, `generate-cmyk-lut.ts`) with the grid positions of the profile's
// input curve. 99.74% to all of the channel values are exact (the photos 99.74% to 99.80%, the CMYK patch files all of
// them) and none is off by more than one level. The same table on a linear `v << 8` position map matched 99.3% to 99.6%, the
// 17^4 grid fitted to GDI+ captures before that 87% to 95% with errors up to 6; the jpeg-js fallback matched 1% to 11%
// (and refused an Adobe-less file).
it.each([
	['cmyk-patches', 49152],
	['cmyk-noadobe', 49152],
	['cmyk-ramps', 49040],
	['cmyk-photo', 18384],
	['cmyk-photo-420', 18393],
	['ycck-patches', 49024],
	['ycck-photo', 18396],
	['ycck-photo-420', 18384],
])('decodes CMYK/YCCK JPEG %s like GDI+ (exact channel values, largest error one level)', async (name, exactCount) => {
	const result = await compareJpeg(name);
	expect(result.exact).toBe(exactCount);
	expect(result.max).toBeLessThanOrEqual(1);
	expect(result.exact / result.total).toBeGreaterThan(0.99);
});

// CMYK JPEG inside TIFF (PhotometricInterpretation 5): the samples are the ink amounts as stored, not inverted as in an
// Adobe CMYK JPEG, and go through the same ICM transform. Before this case utif decoded the strips as plain RGB.
it('decodes CMYK JPEG strips in a TIFF like GDI+ (exact channel values, largest error one level)', async () => {
	await ensureNodeCanvasModule();
	const bytes = new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-tiff-jpeg-cmyk-strips.bin', import.meta.url)));
	const image = (await decodeDeferredImageBytes(bytes.buffer))!;
	const surface = createTempCanvas(image.width, image.height)!;
	canvasDrawImage(surface.ctx, image.drawable, 0, 0, image.width, image.height);
	const got = canvasGetImageData(surface.ctx, 0, 0, image.width, image.height).data;
	const expected = (await decodePng(new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-tiff-jpeg-cmyk-strips.png', import.meta.url)))))!;
	let exact = 0;
	let max = 0;
	for (let i = 0; i < got.length; i++) {
		if (i % 4 === 3) continue;
		const d = Math.abs(got[i] - expected.data[i]);
		if (d === 0) exact++;
		max = Math.max(max, d);
	}
	image.close();
	expect([image.width, image.height]).toEqual([96, 64]);
	expect(exact).toBe(18385);
	expect(max).toBeLessThanOrEqual(1);
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

// Arithmetic-coded JPEG beyond the single libjpeg-turbo sample: `scripts/gdi-fixtures/arith-jpeg-encoder.ts` (a port
// of libjpeg's jcarith.c) writes sequential and progressive files with restart intervals, custom DAC conditioning,
// 4:2:0/4:2:2/4:4:0 sampling, greyscale, CMYK and YCCK, and Pillow (libjpeg-turbo) decodes each to the same pixels as
// a Huffman file with the same coefficients. GDI+ decodes all 28 variants, progressive and restart ones included.
const arithFixtures = readdirSync(new URL('./__fixtures__/gdi/', import.meta.url))
	.filter(f => /^codec-jpeg-arith-.*\.bin$/.test(f) && !f.endsWith('-huffman.bin'))
	.map(f => f.slice('codec-jpeg-'.length, -'.bin'.length))
	.sort();
const arithIsFourComponent = (name: string): boolean => /cmyk|ycck/.test(name);

it('has the 28 native arithmetic JPEG captures', () => {
	expect(arithFixtures).toHaveLength(28);
	expect(arithFixtures.filter(name => arithIsFourComponent(name))).toHaveLength(5);
});

it.each(arithFixtures.filter(name => !arithIsFourComponent(name)))('decodes arithmetic JPEG %s exactly like GDI+', async name => {
	const result = await compareJpeg(name);
	expect(result.exact).toBe(result.total);
});

// Four-component files go through Windows' colour-managed CMYK conversion, which the entropy decoder does not
// control (src/jpeg-cmyk.ts). What the decoder owns is the coefficients, so each file must decode to the same pixels
// as the Huffman-coded copy of those coefficients, and GDI+ must accept it.
it.each(arithFixtures.filter(name => arithIsFourComponent(name)))('decodes four-component arithmetic JPEG %s like its Huffman copy', async name => {
	const read = (file: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/${file}`, import.meta.url)));
	const arithmetic = decodeJpegPixels(read(`codec-jpeg-${name}.bin`));
	const huffman = decodeJpegPixels(read(`codec-jpeg-${name}-huffman.bin`));
	expect(arithmetic.width).toBe(37);
	expect(Array.from(arithmetic.data)).toEqual(Array.from(huffman.data));
	const native = (await decodePng(read(`codec-jpeg-${name}.png`)))!;
	expect([native.width, native.height]).toEqual([arithmetic.width, arithmetic.height]);
});

it('sorts every arithmetic JPEG variant into the bundled family', () => {
	for (const name of arithFixtures) {
		expect(jpegFamily(new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/codec-jpeg-${name}.bin`, import.meta.url))))).toBe('bundled');
	}
});

it('plays an EMF+ DrawImage of a progressive 4:2:0 arithmetic JPEG with restart intervals like GDI+', async () => {
	const rendered = (await renderFixture('codec-jpeg-arith-prog-420-dri2-playback.emf'))!;
	const reference = await loadReference('codec-jpeg-arith-prog-420-dri2-playback');
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
	// The decoded 37 x 19 source is exact (above); the one-level differences are the 7x enlargement done by DrawImage.
	expect(exact).toBe(148274);
	expect(max).toBeLessThanOrEqual(1);
});

it.each([
	['arithmetic', 151086, 1],
	['cmyk-photo', 150664, 1],
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