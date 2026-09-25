/**
 * SVG output needs no canvas implementation: with `@napi-rs/canvas`
 * unavailable in plain Node.js (simulated by mocking its import to throw),
 * PNG conversion returns null but SVG conversion still records vectors,
 * text, gradients, and bitmaps (decoded DIBs via the pure-JS software
 * raster + PNG encoder).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';

vi.mock('@napi-rs/canvas', () => {
	throw new Error("Cannot find module '@napi-rs/canvas' (simulated, not installed)");
});

function load(rel: string): ArrayBuffer {
	const bytes = readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('SVG output without any canvas backend', () => {
	it('converts WMF to SVG while PNG conversion is unavailable', async () => {
		const { convertMetafileToDataUrl, convertMetafileToSvg } = await import('./index');
		const buffer = load('./__fixtures__/sample-crown.wmf');
		await expect(convertMetafileToDataUrl(buffer)).resolves.toBeNull();
		const svg = await convertMetafileToSvg(buffer);
		expect(svg).toMatch(/^<svg /);
		expect(svg).toContain('<path ');
	});

	it('embeds DIB blits as PNG images using the software raster', async () => {
		const { convertMetafileToSvg } = await import('./index');
		const svg = await convertMetafileToSvg(load('./__fixtures__/gdi/rop3-stretchdibits.emf'));
		expect(svg).toContain('<image ');
		expect(svg).toContain('href="data:image/png;base64,');
	});

	it('records gradients as paint servers', async () => {
		const { convertMetafileToSvg } = await import('./index');
		const svg = await convertMetafileToSvg(load('./__fixtures__/gdi/grad-linear-a30-tile.emf'));
		expect(svg).toContain('<linearGradient ');
	});
});
