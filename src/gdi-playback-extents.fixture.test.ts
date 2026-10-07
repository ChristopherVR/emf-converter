import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffImages, fixturePath, inkOutside, loadReference, renderFixture, windowsFonts, type Rgba } from './__fixtures__/gdi-parity-harness';

interface ExtentCase { name: string; w: number; h: number; ox: number; oy: number; maxMismatched: number; maxDiff: number }
const cases: ExtentCase[] = JSON.parse(readFileSync(fixturePath('playback-extents.json'), 'utf8'));

it('expanded native captures reproduce every pixel of their original references', async () => {
	expect(cases).toHaveLength(94);
	for (const c of cases) {
		const expanded = await loadReference(c.name, true);
		expect([expanded.width, expanded.height, expanded.originX, expanded.originY], c.name).toEqual([c.w, c.h, c.ox, c.oy]);
		const d = diffImages(expanded, await loadReference(c.name), 0, 0);
		expect(d.mismatched, c.name).toBe(0);
	}
}, 60_000);

describe.skipIf(!windowsFonts())('playback across the complete recorded device extent', () => {
	it('covers the flattened path ink without translating its native flattening grid', async () => {
		const rendered = await renderFixture('emfrec-path-flatten.emf', { fonts: windowsFonts()! });
		expect(rendered).not.toBeNull();
		const original = await loadReference('emfrec-path-flatten');
		const expanded = await loadReference('emfrec-path-flatten', true);
		// The negative header bound is an off-curve control point. Translating
		// native playback changes FlattenPath's device grid; only the painted
		// right margin needs a larger surface.
		expect(inkOutside(rendered!, original)).toBe(340);
		expect(inkOutside(rendered!, expanded)).toBe(0);
		expect(diffImages(rendered!, expanded, 0, 0).mismatched).toBe(0);
	});
	it('keeps the 68 exact controls exact and pins every remaining full-area residual', async () => {
		let exact = 0;
		for (const c of cases) {
			const rendered = await renderFixture(`${c.name}.emf`, { fonts: windowsFonts()! });
			expect(rendered, c.name).not.toBeNull();
			const native = await loadReference(c.name, true);
			expect(inkOutside(rendered!, native), c.name).toBe(0);
			const d = diffImages(rendered!, native, 0, 0);
			expect(d.mismatched, c.name).toBeLessThanOrEqual(c.maxMismatched);
			expect(d.maxDiff, c.name).toBeLessThanOrEqual(c.maxDiff);
			if (c.maxMismatched === 0) exact++;
		}
		expect(exact).toBe(68);
	}, 60_000);
});

interface OpenCase { name: string; w: number; h: number; ox: number; oy: number; shares: string[] }
const open: OpenCase[] = JSON.parse(readFileSync(fixturePath('playback-extents-open.json'), 'utf8'));

async function loadWide(c: OpenCase): Promise<Rgba> {
	const { createCanvas, loadImage } = await import('@napi-rs/canvas');
	const img = await loadImage(readFileSync(fixturePath(`${c.name}.wide.png`)));
	const canvas = createCanvas(img.width, img.height);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, img.width, img.height);
	ctx.drawImage(img, 0, 0);
	return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data, originX: c.ox, originY: c.oy };
}

/**
 * Native `PlayEnhMetaFile` into a surface of the converter's own canvas size
 * (`.wide.png`, see `playback-extents-open.json`). These captures do not
 * reproduce their original reference over the overlap (fonts, hinting), so
 * they are not references; they only measure how far Windows paints.
 */
describe.skipIf(!windowsFonts())('references that Windows paints beyond (open extent candidates)', () => {
	// name -> [original overlap mismatches, native ink beyond the original PNG]
	const expected: Record<string, [number, number]> = {
		'textx-arial-q0-default': [503, 21426], 'textx-arial-q1-draft': [503, 21426], 'textx-arial-q2-proof': [503, 21426], 'textx-arial-cleartype': [503, 21426],
		'textx-arial-ctnatural': [39661, 21357], 'textx-fon-fixedsys': [21624, 13652], 'textx-fon-system': [12850, 15548],
		'textx-segoeui-cell-mono': [989, 2023], 'rotate-text-25deg': [23, 140],
	};
	it('the converter canvas covers every native ink pixel, so the originals are the clipped side', async () => {
		for (const c of open) {
			const wide = await loadWide(c);
			const names = [c.name, ...c.shares];
			for (const name of names) {
				const rendered = await renderFixture(`${name}.emf`, { fonts: windowsFonts()! });
				expect(rendered, name).not.toBeNull();
				expect([rendered!.width, rendered!.height], name).toEqual([c.w, c.h]);
				expect(inkOutside(wide, rendered!), name).toBe(0);
				const original = await loadReference(name);
				const [overlap, beyond] = expected[name];
				expect(diffImages(wide, original, 0, 0).mismatched, name).toBe(overlap);
				expect(inkOutside(wide, original), name).toBe(beyond);
			}
		}
	}, 60_000);
});
