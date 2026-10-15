/**
 * `textx-eto-mono`: the reference PNG is a direct drawing of the ExtTextOut sheet. Playing the recorded metafile back
 * natively (`textx-eto-mono.playback.png`, `play-metafile.ps1`) differs from it in 377 pixels, all in the ETO_GLYPH_INDEX
 * runs: GDI records the advances of a glyph-index run without a dx array differently from a direct call's, and the
 * records carry them. The converter plays the records back, and matches the native playback in every pixel.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffImages, fixturePath, loadReference, renderFixture, windowsFonts, type Rgba } from './__fixtures__/gdi-parity-harness';

async function loadPng(path: string): Promise<Rgba> {
	const napi = await import('@napi-rs/canvas');
	const image = await napi.loadImage(readFileSync(path));
	const canvas = napi.createCanvas(image.width, image.height);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, image.width, image.height);
	ctx.drawImage(image, 0, 0);
	return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

describe.skipIf(!windowsFonts())('ExtTextOut sheet against native playback', () => {
	it('matches the native playback of the recording exactly, while the direct drawing differs in the glyph-index runs', async () => {
		const rendered = await renderFixture('textx-eto-mono.emf', { fonts: windowsFonts()! });
		expect(rendered).not.toBeNull();
		const playback = await loadPng(fixturePath('textx-eto-mono.playback.png'));
		expect(diffImages(rendered!, playback, 0, 0).mismatched).toBe(0);
		expect(diffImages(rendered!, await loadReference('textx-eto-mono'), 0, 0).mismatched).toBe(377);
		expect(diffImages(playback, await loadReference('textx-eto-mono'), 0, 0).mismatched).toBe(377);
	});
});
