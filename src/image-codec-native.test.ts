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
// interpolates a 16^4 table of 16-bit nodes tetrahedrally and keeps (sum + 4096) >> 20; `src/jpeg-cmyk.ts` bundles the
// module's nodes (read with probes placed exactly on them, `generate-cmyk-nodes.py`) with its ink position map. Every channel
// of all eight files is exact. The previous fitted table matched 99.74% to all of them, the same table on a linear `v << 8`
// position map 99.3% to 99.6%, the 17^4 grid fitted to GDI+ captures before that 87% to 95% with errors up to 6; the jpeg-js
// fallback matched 1% to 11% (and refused an Adobe-less file).
it.each([
	'cmyk-patches',
	'cmyk-noadobe',
	'cmyk-ramps',
	'cmyk-photo',
	'cmyk-photo-420',
	'ycck-patches',
	'ycck-photo',
	'ycck-photo-420',
])('decodes CMYK/YCCK JPEG %s exactly like GDI+', async (name) => {
	const result = await compareJpeg(name);
	expect(result.exact).toBe(result.total);
	expect(result.max).toBe(0);
});

// CMYK JPEG inside TIFF (PhotometricInterpretation 5): the samples are the ink amounts as stored, not inverted as in an
// Adobe CMYK JPEG, and go through the same ICM transform. Before this case utif decoded the strips as plain RGB.
it('decodes CMYK JPEG strips in a TIFF exactly like GDI+', async () => {
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
	expect(exact).toBe(18432);
	expect(max).toBe(0);
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
	// Native 11-bit bilinear shares raise exact channel values from 148,274 to 151,082; the float32 round-down row stepper raises them to 151,178;
	// the vertical position of a DrawImagePoints draw runs a relative 2^-21 above the exact one (`emf-plus-image-points.fixture.test.ts`): 151,188.
	expect(exact).toBe(151188);
	expect(max).toBeLessThanOrEqual(1);
});

it.each([
	['arithmetic', 151199, 1],
	['cmyk-photo', 151197, 1],
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

// The probe plays each metafile onto a 300 x 200 magenta surface; the metafile (header bounds 0..279 x 0..179, frame 4338 x
// 2784 hundredths of a millimetre) covers 280 x 180 of it. The margin right and below is the surface's own background, so the
// reference is the 280 x 180 extent (as rendered) and the whole surface is kept as `.surface.png`.
it.each(['12bit', 'arithmetic', 'arith-prog-420-dri2', 'cmyk-photo'])('the %s playback reference is the metafile extent, with the full surface kept beside it', async (name) => {
	const file = `codec-jpeg-${name}-playback`;
	const rendered = (await renderFixture(`${file}.emf`))!;
	const reference = await loadReference(file);
	const surface = await loadReference(`${file}.surface`);
	expect([rendered.width, rendered.height]).toEqual([280, 180]);
	expect([reference.width, reference.height]).toEqual([280, 180]);
	expect([surface.width, surface.height]).toEqual([300, 200]);
	for (let y = 0; y < surface.height; y++) {
		for (let x = 0; x < surface.width; x++) {
			const s = (y * surface.width + x) * 4;
			if (x < 280 && y < 180) {
				const r = (y * reference.width + x) * 4;
				if (surface.data[s] !== reference.data[r] || surface.data[s + 1] !== reference.data[r + 1] || surface.data[s + 2] !== reference.data[r + 2]) throw new Error(`${file}: surface differs from reference at ${x},${y}`);
			} else if (surface.data[s] !== 255 || surface.data[s + 1] !== 0 || surface.data[s + 2] !== 255) throw new Error(`${file}: surface margin is not magenta at ${x},${y}`);
		}
	}
});
