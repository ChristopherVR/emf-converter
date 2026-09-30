import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { canvasDrawImage, canvasGetImageData, createTempCanvas, decodeDeferredImageBytes, ensureNodeCanvasModule } from './emf-canvas-helpers';
import { decodePng } from './png-decoder';

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
