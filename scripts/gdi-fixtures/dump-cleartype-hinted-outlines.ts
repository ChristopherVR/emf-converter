// Dumps the grid-fitted ClearType outlines our interpreter produces for the glyphs of gdi-cleartype-compat.json.gz (30
// glyphs of Arial, Segoe UI and Tahoma at 9 to 24 px, natural quality), with the rasterizer settings the font would give
// them (dropout mode, vertical smoothing), to .scratch/cleartype-hinted-outlines.json. build-cleartype-hinted-fonts.py
// turns them into program-free private fonts, so that native GDI draws exactly the outlines we rasterize and the
// difference between the two is the scan converter and the filter alone (the hinting is taken out of the comparison).
// Run from the repository root: bun scripts/gdi-fixtures/dump-cleartype-hinted-outlines.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { windowsFonts } from '../../src/__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from '../../src/gdi-font-engine';

interface Capture { face: string; size: number; quality: number; code: number }
const compat: Capture[] = JSON.parse(gunzipSync(readFileSync('src/__fixtures__/gdi/gdi-cleartype-compat.json.gz')).toString());
const system = new GdiFontCollection(windowsFonts()!);
const out: unknown[] = [];
for (const c of compat) {
	if (c.quality !== 6) continue;
	const font = system.realize({ face: c.face, height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 6 })! as any;
	const gi = font.glyphIndex(c.code);
	const o = font.ctOutline(gi);
	const src = font.outline(gi);
	const range = font.ttf.gasp.find((r: { maxPpem: number }) => c.size <= r.maxPpem);
	const smooth = font.ttf.gasp.length === 0 ? true : range ? (range.behavior & 8) !== 0 : false;
	// 0 = off (SCANCTRL says no), otherwise the SCANTYPE the program selected; -1 = the program never ran SCANCTRL.
	const mode = src.scanSet ? (src.scanControl ? src.scanType : 0) : -1;
	out.push({
		face: c.face, size: c.size, code: c.code, smooth, mode,
		xs: Array.from(o.xs as ArrayLike<number>), ys: Array.from(o.ys as ArrayLike<number>),
		on: Array.from(o.onCurve as ArrayLike<number>, Number), end: Array.from(o.endPts as ArrayLike<number>),
	});
}
mkdirSync('.scratch', { recursive: true });
writeFileSync('.scratch/cleartype-hinted-outlines.json', JSON.stringify(out));
console.log(out.length, 'glyphs');
