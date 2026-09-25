/**
 * Raster operations over text in SVG output with the pure-JavaScript raster
 * mirror, which cannot draw glyphs: pixels under text are UNKNOWN to it, and
 * `splitUnknownDestination` keeps each raster op exact wherever the result
 * does not depend on them, handing the rest to the SVG renderer as blend
 * layers (see `emf-rop2-exact.ts`).
 */
import { describe, expect, it } from 'vitest';

import { rewritePixels, splitUnknownDestination } from './emf-rop2-exact';
import type { CanvasContext } from './emf-types';
import { SoftwareRasterCanvas } from './software-raster';
import { SvgContext } from './svg-context';
import type { SvgNode } from './svg-tree';

function nodes(tree: SvgNode, tag: string): SvgNode[] {
	const out: SvgNode[] = [];
	const walk = (n: SvgNode): void => {
		if (n.tag === tag) {
			out.push(n);
		}
		n.children?.forEach(walk);
	};
	walk(tree);
	return out;
}

/** An SVG context over a white page with a line of text at (10, 30), mirrored by the pure-JS raster. */
function pageWithText(): { svg: SvgContext; shadow: SoftwareRasterCanvas } {
	const shadow = new SoftwareRasterCanvas(120, 50);
	const svg = new SvgContext(120, 50, { shadow: shadow.ctx as unknown as CanvasContext, idPrefix: 'u-' });
	svg.fillStyle = '#ffffff';
	svg.fillRect(0, 0, 120, 50);
	svg.fillStyle = '#000000';
	svg.font = '20px Arial';
	svg.fillText('Hello', 10, 30);
	return { svg, shadow };
}

describe('splitUnknownDestination', () => {
	const px = (c: number): number[] => [(c >> 16) & 255, (c >> 8) & 255, c & 255, 255];

	it('classifies each unknown pixel by how its result depends on the destination', () => {
		// Pixels: known; unknown + constant; unknown + D; unknown + ~D; unknown + per-channel mix; unknown + bit mix.
		const results: Array<(d: number) => number> = [
			(d) => ~d & 0xffffff,
			() => 0x123456,
			(d) => d,
			(d) => ~d & 0xffffff,
			(d) => (d & 0x00ff00) | 0xff0000 | (~d & 0xff), // R const 255, G = D, B = ~D
			(d) => d ^ 0x808080,
		];
		const overlay = new Uint8ClampedArray(results.flatMap((f) => px(f(0x336699))));
		const unknown = Uint8Array.from([0, 1, 1, 1, 1, 1]);
		const layers = splitUnknownDestination(overlay, 6, unknown, (i, d) => results[i](d), (i) =>
			i === 5 ? { color: 0x808080, mode: 'difference' } : null,
		);
		const alpha = (i: number): number => overlay[i * 4 + 3];
		expect([0, 1, 2, 3, 4, 5].map(alpha)).toEqual([255, 255, 0, 0, 0, 0]);
		const byMode = Object.fromEntries(layers.map((l) => [l.mode, l.data]));
		expect(Object.keys(byMode).sort()).toEqual(['difference', 'multiply']);
		const at = (data: Uint8ClampedArray, i: number): number[] => Array.from(data.slice(i * 4, i * 4 + 4));
		// D: untouched by both layers.
		expect(at(byMode.multiply, 2)[3]).toBe(0);
		expect(at(byMode.difference, 2)[3]).toBe(0);
		// ~D: difference with white only.
		expect(at(byMode.multiply, 3)[3]).toBe(0);
		expect(at(byMode.difference, 3)).toEqual([255, 255, 255, 255]);
		// Per-channel mix: multiply zeroes R (constant), difference sets R = 255 and inverts B.
		expect(at(byMode.multiply, 4)).toEqual([0, 255, 255, 255]);
		expect(at(byMode.difference, 4)).toEqual([255, 0, 255, 255]);
		// Bit mix: the approximation (merged into the same difference layer).
		expect(at(byMode.difference, 5)).toEqual([128, 128, 128, 255]);
	});
});

describe('raster operations over text with the pure-JS mirror', () => {
	it('marks text pixels unknown and makes an opaque fill known again', () => {
		const { svg, shadow } = pageWithText();
		expect(svg.unknownPixels(10, 12, 40, 20)).not.toBeNull();
		expect(svg.unknownPixels(100, 40, 10, 5)).toBeNull();
		expect(shadow.textDraws).toBe(1);
		svg.fillStyle = '#00ff00';
		svg.fillRect(0, 0, 120, 50);
		expect(svg.unknownPixels(0, 0, 120, 50)).toBeNull();
	});

	it('inverts over text through a difference layer, and exactly elsewhere', async () => {
		const { svg } = pageWithText();
		const box = { x: 0, y: 0, w: 120, h: 50 };
		expect(rewritePixels(svg as unknown as CanvasContext, box, (_x, _y, d) => ~d & 0xffffff)).toBe(true);
		const tree = await svg.toTree();
		const images = nodes(tree, 'image');
		const blend = images.filter((n) => String(n.attrs.style).includes('mix-blend-mode:difference'));
		expect(blend).toHaveLength(1);
		// The exact overlay still carries every pixel away from the text.
		expect(images.length).toBe(2);
		// The blend patch sits outside any clip group, straight under the root.
		expect(tree.children).toContain(blend[0]);
	});

	it('keeps destination-independent results exact even over text', async () => {
		const { svg } = pageWithText();
		rewritePixels(svg as unknown as CanvasContext, { x: 0, y: 0, w: 120, h: 50 }, () => 0x00ff00);
		const tree = await svg.toTree();
		expect(nodes(tree, 'image').every((n) => !String(n.attrs.style ?? '').includes('mix-blend-mode'))).toBe(true);
	});
});
