/**
 * SVG output of the EMF+ records added with the `emfplus-records` fixtures,
 * with no canvas backend at all (`@napi-rs/canvas` mocked away, as in plain
 * Node.js): curves stay vector paths, a hatch brush becomes a `<pattern>`,
 * regions and containers keep their geometry, and the hidden raster mirror
 * that backs exact raster operations reproduces GDI+'s pixels.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@napi-rs/canvas', () => {
	throw new Error("Cannot find module '@napi-rs/canvas' (simulated, not installed)");
});

function load(rel: string): ArrayBuffer {
	const bytes = readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function svgOf(name: string): Promise<string> {
	const { convertMetafileToSvg } = await import('./index');
	const svg = await convertMetafileToSvg(load(`./__fixtures__/gdi/${name}.emf`), { dpiScale: 1 });
	expect(svg).toMatch(/^<svg /);
	return svg!;
}

describe('EMF+ records in SVG output (no canvas backend)', () => {
	it('keeps Beziers and cardinal splines as cubic path segments', async () => {
		for (const name of ['gpx-rec-beziers', 'gpx-rec-curve', 'gpx-rec-closedcurve']) {
			const svg = await svgOf(name);
			expect(svg).toMatch(/<path [^>]*d="[^"]*[cC]/);
		}
	});

	it('paints a hatch brush through a repeating <pattern>', async () => {
		const svg = await svgOf('gpx-rec-hatch');
		expect(svg).toContain('<pattern ');
	});

	it('fills a region and replays relative-point, container and terminal-server records', async () => {
		for (const name of ['gpx-rec-fillregion', 'gpx-rec-relative', 'gpx-rec-container', 'gpx-rec-tsclip', 'gpx-rec-strokefillpath']) {
			const svg = await svgOf(name);
			expect(svg).toContain('<path ');
		}
	});

	it('stops at a well-formed MultiFormatStart, as GDI+ does', async () => {
		const start = await svgOf('gpx-rec-multiformat-start');
		const ignored = await svgOf('gpx-rec-multiformat-ignored');
		const fills = (svg: string): number => (svg.match(/<path /g) ?? []).length;
		expect(fills(ignored)).toBeGreaterThan(fills(start));
	});

	it('renders the records to PNG with the pure-JavaScript rasteriser, matching GDI+', async () => {
		const { convertMetafileToDataUrl } = await import('./index');
		const { decodePng } = await import('./png-decoder');
		const { getRenderableEmfBounds, parseEmfHeader } = await import('./emf-header-parser');
		for (const name of ['gpx-rec-fillregion', 'gpx-rec-hatch', 'gpx-rec-container', 'gpx-rec-compositing']) {
			const bytes = load(`./__fixtures__/gdi/${name}.emf`);
			const url = await convertMetafileToDataUrl(bytes, { dpiScale: 1 });
			const png = await decodePng(new Uint8Array(Buffer.from(url!.split(',')[1], 'base64')));
			const ref = await decodePng(new Uint8Array(load(`./__fixtures__/gdi/${name}.png`)));
			// The converter's canvas starts at the header bounds' top-left (device coordinates).
			const bounds = getRenderableEmfBounds(parseEmfHeader(new DataView(bytes))!)!;
			let bad = 0;
			const w = Math.min(png!.width + bounds.left, ref!.width) - 1;
			const h = Math.min(png!.height + bounds.top, ref!.height) - 1;
			const over = (d: Uint8ClampedArray, i: number, c: number): number => (d[i + c] * d[i + 3] + 255 * (255 - d[i + 3])) / 255;
			for (let y = Math.max(0, bounds.top); y < h; y++) {
				for (let x = Math.max(0, bounds.left); x < w; x++) {
					const ia = ((y - bounds.top) * png!.width + (x - bounds.left)) * 4;
					const ib = (y * ref!.width + x) * 4;
					for (let c = 0; c < 3; c++) {
						if (Math.abs(over(png!.data, ia, c) - over(ref!.data, ib, c)) > 8) {
							bad++;
							break;
						}
					}
				}
			}
			expect(bad, name).toBe(0);
		}
	});
});
