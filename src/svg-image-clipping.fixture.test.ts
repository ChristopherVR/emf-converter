import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { convertMetafileToSvgTree, svgTreeToString } from './index';
import { SvgContext } from './svg-context';
import type { SvgNode } from './svg-tree';

it('intersects a large complement with its parent clip before rasterisation', async () => {
	const ctx = new SvgContext(160, 100);
	ctx.beginPath(); ctx.rect(100, 20, 40, 60); ctx.clip();
	ctx.beginPath();
	ctx.rect(-16777216, -16777216, 33554432, 33554432);
	ctx.rect(90, 50, 60, 20); ctx.clip('evenodd');
	ctx.fillStyle = '#204080'; ctx.fillRect(85, 10, 70, 80);
	const { createCanvas, loadImage } = await import('@napi-rs/canvas');
	const image = await loadImage(Buffer.from(svgTreeToString(await ctx.toTree())));
	const canvas = createCanvas(160, 100), raster = canvas.getContext('2d');
	raster.drawImage(image, 0, 0);
	const pixels = raster.getImageData(0, 0, 160, 100).data;
	for (let y = 0; y < 100; y++) for (let x = 0; x < 160; x++) {
		const covered = x >= 100 && x < 140 && y >= 20 && y < 80 && (y < 50 || y >= 70);
		expect(pixels[(y * 160 + x) * 4 + 3], `(${x},${y})`).toBe(covered ? 255 : 0);
	}
});

it('preserves native DrawImage clip chains, device placement and later paint order', async () => {
	const bytes = readFileSync(fixturePath('gpx-image-clip-zorder.emf'));
	const tree = (await convertMetafileToSvgTree(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
		{ dpiScale: 1, imageResampling: 'exact', idPrefix: 'imageclip-' }))!;
	const clips = tree.children!.find(n => n.tag === 'defs')!.children!.filter(n => n.tag === 'clipPath');
	const exclusion = clips.find(n => n.children![0].attrs['clip-rule'] === 'evenodd')!;
	expect(exclusion.attrs['clip-path']).toBeUndefined();
	expect(exclusion.children![0].attrs['clip-path']).toMatch(/^url\(#imageclip-/);
	const imageGroups = tree.children!.filter(n => n.tag === 'g');
	expect(imageGroups).toHaveLength(2);
	expect(imageGroups[1].attrs['clip-path']).toBe(`url(#${exclusion.attrs.id})`);
	const images: SvgNode[] = [];
	function walk(n: SvgNode): void { if (n.tag === 'image') images.push(n); n.children?.forEach(walk); }
	tree.children!.forEach(walk);
	expect(images).toHaveLength(2);
	expect(images.map(n => [n.attrs.x, n.attrs.y, n.attrs.width, n.attrs.height])).toEqual([['0', '0', '91', '71'], ['84', '9', '72', '82']]);
	expect(images.every(n => n.attrs.transform === undefined)).toBe(true);
	expect(tree.children!.at(-1)!.attrs.fill).toBe('#c81e1e');
});
