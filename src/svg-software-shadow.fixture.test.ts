/**
 * The pure-JavaScript raster mirror (`software-raster.ts`) against the
 * `@napi-rs/canvas` one, for SVG output.
 *
 * The SVG backend reads its raster mirror only to evaluate destination-
 * reading raster operations; the patches it embeds are the pixels those
 * operations change. For every real-GDI fixture, in both the default and
 * the `gdiAntialias: false` mode, the SVG produced with the built-in mirror
 * (no canvas backend) must be byte-for-byte the SVG produced with the
 * `@napi-rs/canvas` mirror: that is, SVG output is exactly the same with or
 * without a canvas backend.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { diffImages, fixturePath, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';
import { setSoftwareCanvasOnly } from './emf-canvas-helpers';
import { convertMetafileToSvg, convertMetafileToSvgTree, replayToSvgContext } from './emf-converter';
import { decodePng } from './png-decoder';
import { SoftwareRasterContext } from './software-raster';
import type { SvgNode } from './svg-tree';

const FIXTURES = readdirSync(fileURLToPath(new URL('./__fixtures__/gdi/', import.meta.url)))
	.filter((f) => f.endsWith('.emf'))
	.map((f) => f.slice(0, -4));

function load(name: string): ArrayBuffer {
	const bytes = readFileSync(fixturePath(`${name}.emf`));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

afterEach(() => setSoftwareCanvasOnly(false));

describe('SVG output is identical with the pure-JS raster mirror', () => {
	it.each(FIXTURES.flatMap((name) => [[name, true] as const, [name, false] as const]))(
		'%s (gdiAntialias: %s)',
		async (name, antialias) => {
			const options = { dpiScale: 1, idPrefix: 't-', gdiAntialias: antialias };
			const withCanvas = await convertMetafileToSvg(load(name), options);
			setSoftwareCanvasOnly(true);
			const withoutCanvas = await convertMetafileToSvg(load(name), options);
			expect(withoutCanvas).toBe(withCanvas);
		},
		30_000,
	);

	it('really uses the pure-JS mirror in software-only mode', async () => {
		setSoftwareCanvasOnly(true);
		const ctx = await replayToSvgContext(load('rop3-stretchblt'), { dpiScale: 1 });
		expect(ctx!.shadow).toBeInstanceOf(SoftwareRasterContext);
	});
});

describe("imageResampling: 'exact'", () => {
	function images(tree: SvgNode): SvgNode[] {
		const out: SvgNode[] = [];
		const walk = (n: SvgNode): void => {
			if (n.tag === 'image') {
				out.push(n);
			}
			n.children?.forEach(walk);
		};
		walk(tree);
		return out;
	}

	it.each([false, true])('embeds exactly the pixels the PNG output paints (software only: %s)', async (software) => {
		setSoftwareCanvasOnly(software);
		const tree = await convertMetafileToSvgTree(load('image-draw-png'), { dpiScale: 1, imageResampling: 'exact' });
		const png = (await renderFixture('image-draw-png.emf'))!;
		const reference = await loadReference('image-draw-png');
		const blocks = images(tree!);
		expect(blocks).toHaveLength(2);
		// Paint the embedded blocks onto white, as the PNG harness composites.
		const width = Number(tree!.attrs.width);
		const height = Number(tree!.attrs.height);
		const data = new Uint8ClampedArray(width * height * 4).fill(255);
		for (const node of blocks) {
			expect(node.attrs.transform).toBeUndefined();
			const px = (await decodePng(new Uint8Array(Buffer.from(String(node.attrs.href).split(',')[1], 'base64'))))!;
			const x0 = Number(node.attrs.x);
			const y0 = Number(node.attrs.y);
			expect(Number(node.attrs.width)).toBe(px.width);
			for (let y = 0; y < px.height; y++) {
				for (let x = 0; x < px.width; x++) {
					const s = (y * px.width + x) * 4;
					const d = ((y0 + y) * width + x0 + x) * 4;
					const a = px.data[s + 3] / 255;
					for (let c = 0; c < 3; c++) {
						data[d + c] = px.data[s + c] * a + data[d + c] * (1 - a);
					}
				}
			}
		}
		const baked = { width, height, data, originX: png.originX, originY: png.originY };
		expect(diffImages(baked, png, 0, 0).mismatchRatio).toBe(0);
		expect(diffImages(baked, reference, 8).mismatchRatio).toBeLessThanOrEqual(0.001);
	});

	it("keeps renderer scaling by default ('renderer')", async () => {
		const tree = await convertMetafileToSvgTree(load('image-draw-png'), { dpiScale: 1 });
		for (const node of images(tree!)) {
			expect(String(node.attrs.href)).toMatch(/^data:image\/png;base64,/);
		}
		expect(JSON.stringify(tree)).toContain('matrix(');
	});
});
