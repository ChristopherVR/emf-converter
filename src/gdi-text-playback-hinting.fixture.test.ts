import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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

/**
 * Rotated text (`rotate-text-25deg`: 23 pixels between the direct drawing and playback). The dx array that
 * Windows records for a rotated font is not the hinted widths a direct drawing advances by but the running
 * position of the linearly scaled advances, each advance rounded to 1/16 pixel, rounded to whole pixels.
 */
interface RotatedRecord { face: string; ppem: number; degrees: number; units: number[]; recorded: number[] }
const rotated: RotatedRecord[] = JSON.parse(gunzipSync(readFileSync(fixturePath('rotated-text-advances.json.gz'))).toString());
function modelled(r: RotatedRecord): number[] {
	const out: number[] = [];
	let cum = 0;
	let previous = 0;
	for (let i = 0; i < r.units.length; i++) {
		cum += Math.round(((r.units[i] * r.ppem) / 2048) * 16) / 16;
		const position = Math.floor(cum + 0.5);
		out.push(position - previous);
		previous = position;
	}
	return out;
}

describe('dx recorded for rotated text', () => {
	it('is the running 1/16-pixel advance, rounded half up, except where the angle decides a tie', () => {
		expect(rotated).toHaveLength(630);
		const wrong: Record<number, number> = {};
		let advances = 0;
		for (const r of rotated) {
			const m = modelled(r);
			advances += m.length;
			wrong[r.degrees] = (wrong[r.degrees] ?? 0) + m.filter((v, i) => v !== r.recorded[i]).length;
		}
		expect(advances).toBe(46620);
		// Exact at 5 and 25 degrees for 90 faces x sizes each; the rest are ties at x.5.
		expect(wrong).toEqual({ 5: 0, 10: 222, 25: 0, 30: 86, 45: 337, 60: 86, 75: 228 });
	});
	it('resolves a position that is exactly half a pixel up at 5 and 25 degrees and down at some other angles', () => {
		const ties: Record<number, [number, number]> = {};
		for (const r of rotated) {
			let cum = 0;
			let recorded = 0;
			for (let i = 0; i < r.units.length; i++) {
				cum += Math.round(((r.units[i] * r.ppem) / 2048) * 16) / 16;
				recorded += r.recorded[i];
				if (cum - Math.floor(cum) === 0.5) {
					const t = (ties[r.degrees] ??= [0, 0]);
					if (recorded === Math.floor(cum) + 1) {
						t[0]++;
					} else if (recorded === Math.floor(cum)) {
						t[1]++;
					}
				}
			}
		}
		expect(ties).toEqual({ 5: [408, 0], 10: [369, 35], 25: [408, 0], 30: [395, 13], 45: [350, 53], 60: [395, 13], 75: [372, 32] });
	});
	it('the playback of "Rotated" equals a direct drawing with the recorded advances, not with the hinted ones', () => {
		const rows = (capture as unknown as { rotation: Array<{ quality: number; degrees: number; directVsPlayback: number; recordedAdvancesVsPlayback: number; recorded: number[]; direct: number[] }> }).rotation;
		expect(rows).toHaveLength(16);
		for (const row of rows) {
			expect(row.recordedAdvancesVsPlayback, `${row.quality}/${row.degrees}`).toBe(0);
			expect(row.directVsPlayback > 0, `${row.quality}/${row.degrees}`).toBe(row.degrees !== 0);
			expect(row.direct).toEqual([14, 11, 6, 11, 6, 11, 11]);
			expect(row.recorded).toEqual(row.degrees === 0 ? [14, 11, 6, 11, 6, 11, 11] : [14, 12, 5, 11, 6, 11, 11]);
		}
		expect(rows.find((r) => r.quality === 3 && r.degrees === 25)!.directVsPlayback).toBe(36);
	});
	it('the committed recording stores the same advances, so the converter, which replays them, places every glyph as playback does', () => {
		const bytes = readFileSync(fixturePath('rotate-text-25deg.emf'));
		let seen = 0;
		for (let o = 0; o < bytes.length; ) {
			const type = bytes.readInt32LE(o);
			if (type === 84) {
				const n = bytes.readInt32LE(o + 44);
				const offDx = bytes.readInt32LE(o + 72);
				expect(Array.from({ length: n }, (_, i) => bytes.readInt32LE(o + offDx + 4 * i))).toEqual([14, 12, 5, 11, 6, 11, 11]);
				seen++;
			}
			if (type === 14) {
				break;
			}
			o += bytes.readInt32LE(o + 4);
		}
		expect(seen).toBe(1);
	});
	it.skipIf(!windowsFonts())('leaves 31 pixels of rotated glyph shape against the playback (the original differs by 54)', async () => {
		const rendered = await renderFixture('rotate-text-25deg.emf', { fonts: windowsFonts()! });
		expect(rendered).not.toBeNull();
		expect(diffImages(rendered!, await loadReference('rotate-text-25deg'), 0, 0).mismatched).toBe(54);
		expect(diffImages(rendered!, await loadReference('rotate-text-25deg.wide'), 0, 0).mismatched).toBe(31);
	});
});
