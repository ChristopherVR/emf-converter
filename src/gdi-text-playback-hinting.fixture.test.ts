import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { diffImages, fixturePath, loadReference, renderEmfBytes, renderFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';

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

describe.skipIf(!windowsFonts())('the converter draws the native playback shapes', () => {
	// name -> [converter vs direct drawing, converter vs native playback] over the whole sheet
	const expected: Record<string, [number, number]> = {
		// Native direct-drawing references: collapsed-box dropout placement
		// closes another eight pixels per sheet (cell 169/4215, em 80/80 before); GDI's own hinting arithmetic and the
		// single-rounding cell height (Segoe UI cell 9 is 7 ppem) and the rounded implied on-curve points took the cell
		// sheet to 45/4095 and the em sheet to 19/19. Round 9: the converter reads the record's exScale / eyScale and
		// re-grid-fits (switches off grid-fitting for) the nine flagged heights like native playback does
		// (`playbackStretchReacts`: patching the two scales equal makes native playback equal the direct drawing), which
		// takes the cell sheet to 93 pixels from the playback (45 of them the direct drawing's own residual) and leaves it
		// 4,113 from the direct drawing. The round 9 specification stub squares and finer arcs then take the cell sheet
		// to 44 from the playback (4,070 from the direct drawing) and the em sheet to 8/8. Round 11: the native scan converter
		// (`ttf-msscan.ts`) takes both sheets to the playback exactly (0 and 0), 4,050 (the unpatched recording's own difference,
		// below) and 0 from the direct drawing.
		'textpb-segoeui-cell-q3': [4050, 0],
		'textpb-segoeui-em-q3': [0, 0],
	};
	it('matches the native playback on the nine flagged heights, not the direct drawing', async () => {
		for (const [name, [direct, played]] of Object.entries(expected)) {
			const rendered = await renderFixture(`${name}.emf`, { fonts: windowsFonts()! });
			expect(rendered, name).not.toBeNull();
			expect(diffImages(rendered!, await loadReference(`${name}.direct`), 0, 0).mismatched, name).toBe(direct);
			expect(diffImages(rendered!, await loadReference(name), 0, 0).mismatched, name).toBe(played);
		}
	}, 60_000);
	it('takes the stretch from the records: with every eyScale patched to its exScale the sheet is the unstretched, direct one again', async () => {
		// Native: playing the patched recording (`scripts/gdi-fixtures/patch-text-scales.ts`) draws exactly the direct
		// drawing (0 of 2,102,400 pixels differ, 4,050 for the unpatched recording); since the round 9 stub squares the
		// converter's patched sheet is exactly the direct drawing too (45 pixels before).
		const bytes = Buffer.from(readFileSync(fixturePath('textpb-segoeui-cell-q3.emf')));
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let patched = 0;
		for (let off = 0; off + 8 <= bytes.length; off += view.getUint32(off + 4, true)) {
			if (view.getUint32(off, true) === 84) {
				view.setFloat32(off + 8 + 16 + 8, view.getFloat32(off + 8 + 16 + 4, true), true);
				patched++;
			}
			if (view.getUint32(off + 4, true) === 0) break;
		}
		expect(patched).toBe(57);
		const rendered = (await renderEmfBytes(bytes, { fonts: windowsFonts()! }))!;
		expect(diffImages(rendered, await loadReference('textpb-segoeui-cell-q3.direct'), 0, 0).mismatched).toBe(0);
	}, 60_000);
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
	it.skipIf(!windowsFonts())('is exact against the playback (the original, a direct drawing, differs by 23 from the converter): the rotated glyph is hinted at the rounded major ppem and rotated as GDI does', async () => {
		const rendered = await renderFixture('rotate-text-25deg.emf', { fonts: windowsFonts()! });
		expect(rendered).not.toBeNull();
		expect(diffImages(rendered!, await loadReference('rotate-text-25deg'), 0, 0).mismatched).toBe(23);
		expect(diffImages(rendered!, await loadReference('rotate-text-25deg.wide'), 0, 0).mismatched).toBe(0);
	});
});
