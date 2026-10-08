import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffImages, fixturePath, loadReference, renderFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';

/**
 * Regeneration of the nine clipped text references on 8 October 2026
 * (`generate.ps1 text-extra,rotation,rotation-affine` into a scratch directory,
 * `text-recorded-advance` for the mechanism). Seven reproduce pixel for pixel as
 * direct drawings; their recordings do not replay to them (the recorded advance
 * array is not the direct drawing's), so they stay the references. The two
 * raster-face cases do not reproduce here: this machine's session has the
 * 120 dpi System and Fixedsys faces (8514sys.fon, 8514fix.fon) in its font set,
 * which the 96 dpi session of the originals did not use, and the converter
 * reproduces each capture exactly once it is given the matching font set.
 */
function eightFiveOneFour(): Buffer[] | null {
	const dir = process.env.GDI_FIXTURE_FONTS ?? join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
	const paths = ['8514sys.fon', '8514fix.fon'].map((f) => join(dir, f));
	return paths.every((p) => existsSync(p)) ? paths.map((p) => readFileSync(p)) : null;
}
interface Capture {
	name: string; height: number; directVsReferencePng: number; directVsPlayback: number; directAnisotropicVsPlayback: number;
	directVsDirectWithRecordedAdvances: number; directWithRecordedAdvancesVsPlayback: number; glyphs: number;
	glyphsWhoseAdvanceDiffers: number; glyphsWhoseAdvanceDiffersFromAntialiasedWidths: number;
}
const captures: Capture[] = JSON.parse(readFileSync(fixturePath('text-recorded-advance.json'), 'utf8'));
const SEGOE = 'textx-segoeui-cell-mono';

describe('direct drawing versus the recording of the same text sheet', () => {
	// name -> [direct vs native playback, glyphs whose direct advance differs from the recorded dx]
	const expected: Record<string, [number, number]> = {
		'textx-arial-q0-default': [503, 4], 'textx-arial-q1-draft': [503, 4], 'textx-arial-q2-proof': [503, 4], 'textx-arial-cleartype': [503, 4],
		'textx-arial-ctnatural': [39661, 105], [SEGOE]: [989, 0],
	};
	it('regenerates the original PNG exactly, so the font environment is reproducible', () => {
		expect(captures.map((c) => c.name)).toEqual(Object.keys(expected));
		for (const c of captures) expect(c.directVsReferencePng, c.name).toBe(0);
	});
	it('differs from native playback by the pinned counts', () => {
		for (const c of captures) {
			const [playback, glyphs] = expected[c.name];
			expect(c.directVsPlayback, c.name).toBe(playback);
			expect(c.glyphsWhoseAdvanceDiffers, c.name).toBe(glyphs);
			expect(c.glyphs, c.name).toBe(c.name === SEGOE ? 390 : 540);
			// The same layout under a 1:1 anisotropic mapping (as playback sets up) is unchanged.
			expect(c.directAnisotropicVsPlayback, c.name).toBe(playback);
		}
	});
	it('the recorded advances are the ANTIALIASED_QUALITY widths whatever lfQuality the font asked for', () => {
		for (const c of captures) expect(c.glyphsWhoseAdvanceDiffersFromAntialiasedWidths, c.name).toBe(0);
	});
	it('drawing directly with the recorded advances equals the playback for every Arial recording, not for Segoe UI', () => {
		for (const c of captures) {
			expect(c.directWithRecordedAdvancesVsPlayback, c.name).toBe(c.name === SEGOE ? 989 : 0);
			expect(c.directVsDirectWithRecordedAdvances, c.name).toBe(c.name === SEGOE ? 0 : c.directVsPlayback);
		}
	});
});

describe('raster System and Fixedsys faces regenerated on this machine', () => {
	// name -> [regenerated vs original over the overlap, regenerated playback vs original playback]
	const expected: Record<string, [number, number]> = {
		'textx-fon-fixedsys': [28896, 32464],
		'textx-fon-system': [16138, 17888],
	};
	it('direct drawing and native playback agree over the overlap but differ from the original reference', async () => {
		for (const [name, [vsOriginal, wideVsOriginalWide]] of Object.entries(expected)) {
			const direct = await loadReference(`${name}.regen`);
			const playback = await loadReference(`${name}.regen.wide`);
			expect(diffImages(direct, playback, 0, 0).mismatched, name).toBe(0);
			expect(diffImages(direct, await loadReference(name), 0, 0).mismatched, name).toBe(vsOriginal);
			expect(diffImages(playback, await loadReference(`${name}.wide`), 0, 0).mismatched, name).toBe(wideVsOriginalWide);
		}
	});
	it.skipIf(!windowsFonts())('the converter given the fixture font set reproduces the original references, captured without the 8514 faces', async () => {
		for (const name of Object.keys(expected)) {
			const rendered = await renderFixture(`${name}.emf`, { fonts: windowsFonts()! });
			expect(rendered, name).not.toBeNull();
			expect(diffImages(rendered!, await loadReference(name), 0, 0).mismatched, name).toBe(0);
		}
	});
	it.skipIf(!windowsFonts() || !eightFiveOneFour())('the converter given 8514sys.fon and 8514fix.fon reproduces the regenerated captures exactly, direct and played back', async () => {
		for (const name of Object.keys(expected)) {
			const rendered = await renderFixture(`${name}.regen.emf`, { fonts: [...windowsFonts()!, ...eightFiveOneFour()!] });
			expect(rendered, name).not.toBeNull();
			expect(diffImages(rendered!, await loadReference(`${name}.regen`), 0, 0).mismatched, name).toBe(0);
			expect(diffImages(rendered!, await loadReference(`${name}.regen.wide`), 0, 0).mismatched, name).toBe(0);
		}
	});
	it.skipIf(!windowsFonts())('without those faces it picks other sizes than this machine does', async () => {
		for (const name of Object.keys(expected)) {
			const rendered = await renderFixture(`${name}.regen.emf`, { fonts: windowsFonts()! });
			expect(diffImages(rendered!, await loadReference(`${name}.regen`), 0, 0).mismatched, name).toBeGreaterThan(10000);
		}
	});
});
