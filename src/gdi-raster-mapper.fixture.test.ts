import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { fixturePath, windowsFonts } from './__fixtures__/gdi-parity-harness';

/**
 * `text-raster-mapper` (RasterMapperProbe.cs, 8 October 2026): GetTextMetrics of ten raster faces at every
 * lfHeight from -60 to 60 on a 144 dpi session. The System and Fixedsys faces come from the 20 pixel
 * 8514sys.fon / 8514fix.fon next to the 16 and 15 pixel VGA ones; the originals of `textx-fon-system` and
 * `textx-fon-fixedsys` (a 96 dpi session) used the VGA ones alone, which is the fixture font set.
 */
interface Row { face: string; height: number; tmHeight: number }
interface Capture { logPixelsX: number; logPixelsY: number; stock: Record<string, { tmHeight: number; aspectX: number; tmWeight: number }>; rows: Row[] }
const capture: Capture = JSON.parse(readFileSync(fixturePath('raster-mapper.json'), 'utf8'));
const FACES = ['MS Sans Serif', 'MS Serif', 'Courier', 'Small Fonts', 'System', 'Terminal', 'Fixedsys', 'Helv', 'Tms Rmn', 'MS Shell Dlg'];

function extra(): Buffer[] | null {
	const dir = process.env.GDI_FIXTURE_FONTS ?? join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
	const paths = ['8514sys.fon', '8514fix.fon'].map((f) => join(dir, f));
	return paths.every((p) => existsSync(p)) ? paths.map((p) => readFileSync(p)) : null;
}

/** Heights (of 120) at which the converter's mapper picks the cell height Windows reports. */
function agreement(sources: readonly Buffer[]): Record<string, number> {
	const collection = new GdiFontCollection(sources, 'cleartype');
	const out: Record<string, number> = {};
	for (const face of FACES) {
		out[face] = capture.rows.filter((r) => r.face === face).filter((r) => {
			const font = collection.realize({ face, height: r.height, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 }) as unknown as { face?: { pixHeight: number }; scale?: number; ascent: number; descent: number } | null;
			// A raster face reports its cell stretched by a whole number; MS Shell Dlg is a TrueType face.
			return font !== null && (font.face ? font.face.pixHeight * font.scale! : font.ascent + font.descent) === r.tmHeight;
		}).length;
	}
	return out;
}

describe('raster font mapper on a 144 dpi session', () => {
	it('is the capture of a 144 dpi session whose stock fonts are the 120 dpi faces', () => {
		expect(capture.logPixelsX).toBe(144);
		expect(capture.rows).toHaveLength(1200);
		expect(capture.stock.SYSTEM_FONT).toMatchObject({ tmHeight: 20, aspectX: 120, tmWeight: 700 });
		expect(capture.stock.SYSTEM_FIXED_FONT.tmHeight).toBe(20);
		expect(capture.stock.OEM_FIXED_FONT.tmHeight).toBe(20);
		// System offers 16, 20, 32, 40, 48, 60 and 64 pixel cells here, Fixedsys 15, 20, 30, 40, 45, 60 and 75.
		expect([...new Set(capture.rows.filter((r) => r.face === 'System').map((r) => r.tmHeight))].sort((a, b) => a - b)).toEqual([16, 20, 32, 40, 48, 60, 64]);
		expect([...new Set(capture.rows.filter((r) => r.face === 'Fixedsys').map((r) => r.tmHeight))].sort((a, b) => a - b)).toEqual([15, 20, 30, 40, 45, 60, 75]);
	});
	it.skipIf(!windowsFonts())('the converter given the fixture font set misses System and Fixedsys, which it never saw the 20 pixel faces of', () => {
		expect(agreement(windowsFonts()!)).toEqual({
			'MS Sans Serif': 119, 'MS Serif': 117, Courier: 118, 'Small Fonts': 117, System: 79, Terminal: 116, Fixedsys: 81, Helv: 119, 'Tms Rmn': 117, 'MS Shell Dlg': 117,
		});
	});
	it.skipIf(!windowsFonts() || !extra())('at lfHeight 61 to 130 (where the 6x to 8x costs were fitted) it picks the native cell height at 919 of 980 heights and the width at 929', () => {
		// `raster-mapper-wide.json.gz`: the seven raster families at lfHeight -130..-61 and 61..130 (weight 400) and weight 700 at -60..60.
		interface Wide { rows: Array<Row & { weight: number; tmAveCharWidth: number }> }
		const wide: Wide = JSON.parse(gunzipSync(readFileSync(fixturePath('raster-mapper-wide.json.gz'))).toString());
		const collection = new GdiFontCollection([...windowsFonts()!, ...extra()!], 'cleartype');
		const counts = { regular: 0, height: 0, width: 0, both: 0, bold: 0, boldHeight: 0 };
		for (const r of wide.rows) {
			const font = collection.realize({ face: r.face, height: r.height, width: 0, weight: r.weight, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 }) as unknown as { face: { pixHeight: number; avgWidth: number }; scale: number; scaleX: number };
			const heightOk = font.face.pixHeight * font.scale === r.tmHeight;
			if (r.weight === 400) {
				const widthOk = font.face.avgWidth * font.scaleX === r.tmAveCharWidth;
				counts.regular++;
				counts.height += heightOk ? 1 : 0;
				counts.width += widthOk ? 1 : 0;
				counts.both += heightOk && widthOk ? 1 : 0;
			} else {
				counts.bold++;
				counts.boldHeight += heightOk ? 1 : 0;
			}
		}
		// Before the vertical factors 6 to 8 were allowed (and the horizontal one capped at 5): 631 of the 980 heights. Fitting the three
		// costs on the 490 negative heights alone gives 456 of the 490 positive ones (291 and 340 before), so the fit is not memorised.
		expect(counts).toEqual({ regular: 980, height: 919, width: 929, both: 918, bold: 840, boldHeight: 818 });
	});
	it.skipIf(!windowsFonts() || !extra())('given 8514sys.fon and 8514fix.fon it picks the native cell height at 118 of 120 System and 117 of 120 Fixedsys heights', () => {
		expect(agreement([...windowsFonts()!, ...extra()!])).toEqual({
			'MS Sans Serif': 119, 'MS Serif': 117, Courier: 118, 'Small Fonts': 117, System: 118, Terminal: 116, Fixedsys: 117, Helv: 119, 'Tms Rmn': 117, 'MS Shell Dlg': 117,
		});
	});
});
