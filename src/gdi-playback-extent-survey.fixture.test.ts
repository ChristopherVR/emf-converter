import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePath, loadReference, renderFixture, windowsFonts, type Rgba } from './__fixtures__/gdi-parity-harness';

/**
 * Round 6 (reference coverage): every fixture whose converter extent differs from its reference PNG and that is not an
 * expanded capture (`playback-extents.json`) was played back natively into a surface of the converter's own extent
 * (`generate.ps1 playback-extent-survey`, `PlaybackExtentProbe.Survey`; the figures in `playback-extent-survey.json` are
 * generator figures from that run: native ink count, native ink bounds in device pixels, and the number of RGB pixels of
 * the original PNG that the playback does not reproduce over their overlap).
 *
 * Result: the converter's origin and size are what Windows paints into, for all 166 cases. 149 playbacks reproduce the
 * original PNG pixel for pixel over its extent; the 17 that do not are the known process-state or font-environment
 * differences (the three colour-adjustment dithers, the nine clipped text references and their kin). For the 162 cases
 * whose playback ink bounds could be compared they are the converter's ink bounds, and the area beyond the reference PNG
 * holds no ink in either, except for the nine text sheets that are clipped references.
 */
interface Survey { name: string; w: number; h: number; ox: number; oy: number; plus: boolean; nativeInk: number; nativeBounds: number[]; overlapMismatch: number }
const survey: Survey[] = JSON.parse(readFileSync(fixturePath('playback-extent-survey.json'), 'utf8'));

/** Sheets whose ink bounds differ from native playback for reasons other than the extent. */
const boundsDiffer = new Set(['emfrec-ca-dither-5-5-0-0', 'emfrec-ca-dither-5-5-3-2', 'emfrec-ca-dither-6-7-0-0', 'textx-segoeui-cell-mono']);
/** Sheets whose reference PNG is clipped: native playback paints ink beyond it (see gdi-playback-extents.fixture.test.ts). */
const clipped = new Set(['rotate-text-25deg', 'textx-arial-cleartype', 'textx-arial-ctnatural', 'textx-arial-q0-default', 'textx-arial-q1-draft', 'textx-arial-q2-proof', 'textx-fon-fixedsys', 'textx-fon-fixedsys.regen', 'textx-fon-system', 'textx-fon-system.regen', 'textx-segoeui-cell-mono']);

function inkBounds(image: Rgba): number[] {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ink = 0;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			const i = (y * image.width + x) * 4;
			if (image.data[i] === 255 && image.data[i + 1] === 255 && image.data[i + 2] === 255) continue;
			ink++;
			if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
		}
	}
	const ox = image.originX ?? 0, oy = image.originY ?? 0;
	return ink === 0 ? [0, 0, 0, 0, 0] : [x0 + ox, y0 + oy, x1 + ox, y1 + oy, ink];
}

describe.skipIf(!windowsFonts())('native playback into the converter extent of every fixture larger than its reference', () => {
	it('covers 166 cases and 149 reproduce their original PNG over its extent', () => {
		expect(survey).toHaveLength(166);
		expect(survey.filter((c) => c.overlapMismatch === 0)).toHaveLength(149);
		expect(survey.filter((c) => c.overlapMismatch !== 0).map((c) => c.name)).toEqual([
			'emfrec-ca-dither-5-5-0-0', 'emfrec-ca-dither-5-5-3-2', 'emfrec-ca-dither-6-7-0-0', 'gpx-pen-center-miter-aa', 'gpx-pen-lingrad', 'gpx-text-lingrad',
			'rotate-text-25deg', 'textx-arial-cleartype', 'textx-arial-ctnatural', 'textx-arial-q0-default', 'textx-arial-q1-draft', 'textx-arial-q2-proof',
			'textx-fon-fixedsys', 'textx-fon-system', 'textx-rotalign-esc', 'textx-rotalign-world', 'textx-segoeui-cell-mono',
		]);
	});
	it('the converter origin, size and ink bounds are the native ones; the margin beyond the reference holds no ink except in clipped references', async () => {
		let sameBounds = 0;
		let blankMargin = 0;
		for (const c of survey) {
			const rendered = (await renderFixture(`${c.name}.emf`, { fonts: windowsFonts()! }))!;
			expect(rendered, c.name).not.toBeNull();
			expect([rendered.width, rendered.height, rendered.originX ?? 0, rendered.originY ?? 0], c.name).toEqual([c.w, c.h, c.ox, c.oy]);
			const bounds = inkBounds(rendered);
			if (bounds.slice(0, 4).join() === c.nativeBounds.join()) sameBounds++;
			else expect(boundsDiffer.has(c.name), c.name).toBe(true);
			const reference = await loadReference(c.name);
			const inside = (b: number[]): boolean => b[0] >= 0 && b[1] >= 0 && b[2] < reference.width && b[3] < reference.height;
			if (!clipped.has(c.name)) {
				expect(inside(c.nativeBounds), `${c.name} native`).toBe(true);
				expect(inside(bounds), `${c.name} rendered`).toBe(true);
				blankMargin++;
			}
		}
		expect(sameBounds).toBe(162);
		expect(blankMargin).toBe(155);
	}, 300_000);
});
