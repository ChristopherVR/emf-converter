import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { fixturePath, renderFixture } from './__fixtures__/gdi-parity-harness';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { preDecodeEmfPlusImages, preDecodeMetafileCaches } from './emf-plus-image-predecode';
import { convertMetafileToSvg } from './index';

function fixtureBuffer(name: string): ArrayBuffer {
	const b = readFileSync(fixturePath(name));
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe('preDecodeEmfPlusImages', () => {
	it('decodes every bitmap Image object of a file ahead of replay', async () => {
		await ensureNodeCanvasModule();
		const cache = await preDecodeEmfPlusImages(new DataView(fixtureBuffer('gpx-image-bilinear.emf')));
		const entries = [...cache.values()];
		expect(entries.length).toBe(2);
		for (const e of entries) {
			expect(e.kind).toBe('bitmap');
		}
		const sizes = entries.map((e) => (e.kind === 'bitmap' ? `${e.width}x${e.height}` : '')).sort();
		expect(sizes).toEqual(['20x16', '64x48']);
	});

	it('prepares an embedded metafile as nested caches instead of a raster', async () => {
		const caches = await preDecodeMetafileCaches(new DataView(fixtureBuffer('gpx-metafile-scaled.emf')));
		const entries = [...caches.images.values()];
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe('metafile');
	});

	it('returns an empty cache for a file without images', async () => {
		const cache = await preDecodeEmfPlusImages(new DataView(fixtureBuffer('gpx-lin-gamma.emf')));
		expect(cache.size).toBe(0);
	});
});

describe('in-order DrawImage', () => {
	it('paints an image under its clip and beneath shapes recorded after it (PNG)', async () => {
		const img = (await renderFixture('gpx-image-clip-zorder.emf'))!;
		const px = (x: number, y: number): number[] => {
			const o = (y * img.width + x) * 4;
			return Array.from(img.data.slice(o, o + 3));
		};
		// Outside the first clip (10, 10, 60, 40) the page stays white.
		expect(px(5, 5)).toEqual([255, 255, 255]);
		// The later green rectangle (40, 30, 50, 40) covers the image.
		expect(px(50, 40)).toEqual([30, 120, 60]);
		// Inside the clip and outside the rectangle, the image shows.
		expect(px(20, 20)).not.toEqual([255, 255, 255]);
	});

	it('embeds the original PNG bytes in record order in SVG output', async () => {
		const svg = (await convertMetafileToSvg(fixtureBuffer('gpx-image-clip-zorder.emf')))!;
		const imageAt = svg.indexOf('<image');
		const laterRect = svg.lastIndexOf('fill="#1e783c"');
		expect(imageAt).toBeGreaterThan(-1);
		expect(svg).toContain('data:image/png;base64,iVBORw0KGgo');
		expect(laterRect).toBeGreaterThan(imageAt);
	});

	it('replays an embedded metafile as vectors in SVG output', async () => {
		const svg = (await convertMetafileToSvg(fixtureBuffer('gpx-metafile-scaled.emf')))!;
		expect(svg).not.toContain('<image');
		expect(svg).toContain('<linearGradient');
		// The nested red rectangle, scaled 1.5x about pixel centres.
		expect(svg).toMatch(/fill="#dc281e"/);
	});
});
