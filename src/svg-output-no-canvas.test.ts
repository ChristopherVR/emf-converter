/**
 * SVG (and text-free PNG) output needs no canvas implementation: with
 * `@napi-rs/canvas` unavailable in plain Node.js (simulated by mocking its
 * import to throw), SVG conversion records vectors, text, gradients and
 * bitmaps, and evaluates every destination-reading raster operation exactly
 * against the built-in pure-JavaScript raster mirror (`software-raster.ts`).
 * Everything here, including decoding the reference PNGs, runs without any
 * canvas.
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

/** Share of pixels (over the common area, bottom/right edge inset by one) whose largest RGB difference exceeds `tolerance`, both composited over white. */
function mismatch(
	a: { data: Uint8ClampedArray; width: number; height: number },
	b: { data: Uint8ClampedArray; width: number; height: number },
	tolerance: number,
): number {
	const w = Math.min(a.width, b.width) - 1;
	const h = Math.min(a.height, b.height) - 1;
	const over = (d: Uint8ClampedArray, i: number, c: number): number => (d[i + c] * d[i + 3] + 255 * (255 - d[i + 3])) / 255;
	let bad = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const ia = (y * a.width + x) * 4;
			const ib = (y * b.width + x) * 4;
			let worst = 0;
			for (let c = 0; c < 3; c++) {
				worst = Math.max(worst, Math.abs(Math.round(over(a.data, ia, c)) - Math.round(over(b.data, ib, c))));
			}
			if (worst > tolerance) {
				bad++;
			}
		}
	}
	return bad / (w * h);
}

describe('SVG output without any canvas backend', () => {
	it('converts WMF to SVG', async () => {
		const { convertMetafileToSvg } = await import('./index');
		const svg = await convertMetafileToSvg(load('./__fixtures__/sample-crown.wmf'));
		expect(svg).toMatch(/^<svg /);
		expect(svg).toContain('<path ');
	});

	it('embeds DIB blits as PNG images', async () => {
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

	it.each(['rop3-grid-solid', 'rop3-grid-hatch', 'rop3-stretchblt', 'rop3-stretch-sampling'])(
		'evaluates %s exactly against the pure-JS raster mirror (matches real GDI pixel for pixel)',
		async (name) => {
			const { replayToSvgContext } = await import('./emf-converter');
			const { SoftwareRasterContext } = await import('./software-raster');
			const { decodePng } = await import('./png-decoder');
			const svg = await replayToSvgContext(load(`./__fixtures__/gdi/${name}.emf`), { dpiScale: 1 });
			expect(svg!.shadow).toBeInstanceOf(SoftwareRasterContext);
			const shadow = (svg!.shadow as InstanceType<typeof SoftwareRasterContext>).canvas;
			const ref = await decodePng(new Uint8Array(load(`./__fixtures__/gdi/${name}.png`)));
			expect(mismatch({ data: shadow.pixels, width: shadow.width, height: shadow.height }, ref!, 0)).toBe(0);
		},
	);

	it('renders a text-free ROP3 metafile to a PNG identical to real GDI', async () => {
		const { convertMetafileToDataUrl } = await import('./index');
		const { decodePng } = await import('./png-decoder');
		const url = await convertMetafileToDataUrl(load('./__fixtures__/gdi/rop3-grid-pattern-color.emf'), { dpiScale: 1 });
		expect(url).not.toBeNull();
		const png = await decodePng(new Uint8Array(Buffer.from(url!.split(',')[1], 'base64')));
		const ref = await decodePng(new Uint8Array(load('./__fixtures__/gdi/rop3-grid-pattern-color.png')));
		expect(mismatch(png!, ref!, 0)).toBe(0);
	});

	it('refuses PNG output for a metafile with text (no font engine), but still converts it to SVG', async () => {
		const { convertMetafileToDataUrl, convertMetafileToSvg } = await import('./index');
		const buffer = load('./__fixtures__/gdi/rotate-text-25deg.emf');
		await expect(convertMetafileToDataUrl(buffer)).resolves.toBeNull();
		expect(await convertMetafileToSvg(buffer)).toContain('<text ');
	});

	it("bakes EMF+ DrawImage at device resolution with imageResampling: 'exact', decoding the PNG in pure JS", async () => {
		const { convertMetafileToSvgTree } = await import('./index');
		const tree = await convertMetafileToSvgTree(load('./__fixtures__/gdi/image-draw-png.emf'), {
			dpiScale: 1,
			imageResampling: 'exact',
		});
		const images: Array<Record<string, unknown>> = [];
		const walk = (n: { tag: string; attrs: Record<string, unknown>; children?: unknown[] }): void => {
			if (n.tag === 'image') {
				images.push(n.attrs);
			}
			(n.children as Array<typeof n> | undefined)?.forEach(walk);
		};
		walk(tree!);
		expect(images).toHaveLength(2);
		for (const img of images) {
			expect(img.transform).toBeUndefined();
			expect(String(img.href)).toMatch(/^data:image\/png;base64,/);
		}
	});
});
