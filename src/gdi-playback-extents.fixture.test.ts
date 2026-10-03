import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffImages, fixturePath, inkOutside, loadReference, renderFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';

interface ExtentCase { name: string; w: number; h: number; ox: number; oy: number; maxMismatched: number; maxDiff: number }
const cases: ExtentCase[] = JSON.parse(readFileSync(fixturePath('playback-extents.json'), 'utf8'));

it('expanded native captures reproduce every pixel of their original references', async () => {
	expect(cases).toHaveLength(87);
	for (const c of cases) {
		const expanded = await loadReference(c.name, true);
		expect([expanded.width, expanded.height, expanded.originX, expanded.originY], c.name).toEqual([c.w, c.h, c.ox, c.oy]);
		const d = diffImages(expanded, await loadReference(c.name), 0, 0);
		expect(d.mismatched, c.name).toBe(0);
	}
});

describe.skipIf(!windowsFonts())('playback across the complete recorded device extent', () => {
	it('keeps the 60 exact controls exact and pins every remaining full-area residual', async () => {
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
		expect(exact).toBe(60);
	});
});
