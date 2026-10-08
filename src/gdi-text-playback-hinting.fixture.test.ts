import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffImages, fixturePath, loadReference, renderFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';

/**
 * `text-playback-hinting` (TextPlaybackProbe.cs, 8 October 2026). Native playback of a recorded Segoe UI
 * sheet differs from the same text drawn directly in glyph shape at some cell heights
 * (`textx-segoeui-cell-mono`: 989 pixels). The recording stores exScale / eyScale (hundredths of a
 * millimetre per device pixel) in every GM_COMPATIBLE EMR_EXTTEXTOUTW and playback draws the text through
 * diag(eyScale / exScale, 1). The probe re-draws the sheet under that transform and sweeps the factor.
 */
interface Line { height: number; baseline: number; differing: number; stretchedDiffering?: number; firstChangeMicro?: number }
interface Sheet { name: string; face: string; quality: number; width: number; height: number; exScale: number; eyScale: number; stretch: number; lines: Line[] }
interface Capture { sheets: Sheet[]; original: { width: number; height: number; directVsPlayback: number; stretchedVsPlayback: number } | null }
const capture: Capture = JSON.parse(readFileSync(fixturePath('text-playback-hinting.json'), 'utf8'));
const sheet = (name: string): Sheet => capture.sheets.find((s) => s.name === name)!;
const DIFFERING = [24, 35, 36, 39, 40, 56, 58, 59, 64];

describe('playback versus direct drawing of recorded text sheets', () => {
	it('differs only for Segoe UI cell heights, at the same nine heights in black-and-white and grayscale', () => {
		for (const s of capture.sheets) {
			const heights = s.lines.filter((l) => l.differing > 0).map((l) => l.height);
			expect(heights, s.name).toEqual(s.face === 'Segoe UI' && s.lines[0].height > 0 ? DIFFERING : []);
		}
		expect(sheet('textpb-segoeui-cell-q3').lines.filter((l) => l.differing > 0).map((l) => l.differing)).toEqual([214, 203, 198, 342, 481, 587, 833, 703, 489]);
	});
	it('the recording stores a horizontal stretch of eyScale / exScale (this machine: 15.546875 and 15.55556; the committed 2560 x 1440 recording: 23.3203125 and 23.33333, the same ratio)', () => {
		for (const s of capture.sheets) {
			expect(s.exScale, s.name).toBeCloseTo(15.546875, 6);
			expect(s.stretch, s.name).toBeCloseTo(s.eyScale / s.exScale, 6);
			expect(s.stretch, s.name).toBeGreaterThan(1.00055);
			expect(s.stretch, s.name).toBeLessThan(1.00056);
		}
	});
	it('drawing glyph by glyph under diag(eyScale / exScale, 1) reproduces the playback at every Segoe UI height', () => {
		const q3 = sheet('textpb-segoeui-cell-q3').lines;
		expect(q3.every((l) => l.stretchedDiffering === 0)).toBe(true);
		// Grayscale: whole-string rounding differs from glyph-by-glyph in four small lines only.
		const q4 = sheet('textpb-segoeui-cell-q4').lines.filter((l) => (l.stretchedDiffering ?? 0) > 0);
		expect(q4.map((l) => [l.height, l.stretchedDiffering])).toEqual([[9, 3], [10, 3], [11, 1], [12, 12]]);
		// The committed 989-pixel sheet: 989 pixels direct, none stretched.
		expect(capture.original).toEqual({ width: 480, height: 464, directVsPlayback: 989, stretchedVsPlayback: 0 });
	});
	it('a height differs exactly when the stretch passes its threshold', () => {
		const s = sheet('textpb-segoeui-cell-q3');
		const micro = Math.floor((s.stretch - 1) * 1e6);
		for (const l of s.lines) {
			const changed = (l.firstChangeMicro ?? 0) > 0 && l.firstChangeMicro! <= micro;
			expect(changed, String(l.height)).toBe(l.differing > 0);
		}
		// Thresholds (1e-6 units) of the neighbours that stay unchanged: 34 changes at 615 of 558.
		expect(s.lines.find((l) => l.height === 34)!.firstChangeMicro).toBe(615);
		expect(s.lines.find((l) => l.height === 35)!.firstChangeMicro).toBe(530);
		expect(s.lines.find((l) => l.height === 59)!.firstChangeMicro).toBe(25);
		expect(s.lines.find((l) => l.height === 64)!.firstChangeMicro).toBe(485);
		// Heights 8 to 23 and 25, 26 do not change before a stretch of 2e-3.
		expect(s.lines.filter((l) => !l.firstChangeMicro).map((l) => l.height)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26]);
	});
});

describe.skipIf(!windowsFonts())('the converter draws the direct shapes', () => {
	// name -> [converter vs direct drawing, converter vs native playback] over the whole sheet
	const expected: Record<string, [number, number]> = {
		'textpb-segoeui-cell-q3': [174, 4220],
		'textpb-segoeui-em-q3': [81, 81],
	};
	it('matches the direct drawing on the nine flagged heights, not the playback', async () => {
		for (const [name, [direct, played]] of Object.entries(expected)) {
			const rendered = await renderFixture(`${name}.emf`, { fonts: windowsFonts()! });
			expect(rendered, name).not.toBeNull();
			expect(diffImages(rendered!, await loadReference(`${name}.direct`), 0, 0).mismatched, name).toBe(direct);
			expect(diffImages(rendered!, await loadReference(name), 0, 0).mismatched, name).toBe(played);
		}
	});
});
