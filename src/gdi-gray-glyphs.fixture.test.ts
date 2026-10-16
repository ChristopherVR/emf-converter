import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { dropoutMode, rasterizeGray, type Outline } from './ttf-raster';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';

/**
 * GDI's grayscale glyph bitmaps of real fonts (`GetGlyphOutline`, `GGO_GRAY4_BITMAP`, 17 levels) and hinted outlines
 * (`GGO_NATIVE`) against the converter, for every printable ASCII glyph of Arial, Times New Roman, Tahoma, Segoe UI
 * and Courier New at 18, 24, 32, 48 and 72 px (`gdi-gray-glyphs.json.gz`, probe `GrayGlyphProbe.cs`, 7 October 2026
 * Windows fonts; the capture is identical across processes). Sizes where the converter draws the font as monochrome
 * (`gasp` without GASP_DOGRAY: Courier New below 40 px) are skipped: `ExtTextOut` honours the table and
 * `GetGlyphOutline` does not.
 *
 * What the numbers say (round 7, F2):
 *  - Rasterizing GDI's own hinted outline with the converter's grayscale scan converter reproduces GDI's bitmap for
 *    most glyphs (92 of 94 around 20 px, 64 to 78 of 94 at 72 px): scan conversion is not where Arial, Times New Roman,
 *    Tahoma and Courier New differ.
 *  - The converter's hinted outlines now equal GDI's in 93 to 94 of 94 glyphs for Arial, Times New Roman, Tahoma and
 *    Courier New at every size (72 to 78 before round 7 T): GDI's projection rounds each product alone, a move along x
 *    divides with truncation after adding half the divisor, IUP does the same (`gdiArithmetic`, found with the
 *    single-instruction sweeps of `ttf-hint-sweep.fixture.test.ts`).
 *  - Segoe UI's bitmaps match the converter in 56 to 91 of 94 glyphs but its `GGO_NATIVE` outlines are not the outlines its
 *    bitmaps come from, so only the bitmap comparison is pinned for it.
 */
const data: any[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/gdi-gray-glyphs.json.gz', import.meta.url))).toString());
const collection = new GdiFontCollection(windowsFonts() ?? []);
const hasFonts = windowsFonts() !== null;

function nativeOutline(buf: Buffer): Outline | null {
	const xs: number[] = [];
	const ys: number[] = [];
	const onCurve: boolean[] = [];
	const endPts: number[] = [];
	let p = 0;
	while (p < buf.length) {
		const end = p + buf.readUInt32LE(p);
		const sx = Math.round((buf.readInt32LE(p + 8) / 65536) * 64);
		const sy = Math.round((buf.readInt32LE(p + 12) / 65536) * 64);
		const start = xs.length;
		xs.push(sx);
		ys.push(sy);
		onCurve.push(true);
		let q = p + 16;
		while (q < end) {
			const type = buf.readUInt16LE(q);
			const n = buf.readUInt16LE(q + 2);
			for (let i = 0; i < n; i++) {
				xs.push(Math.round((buf.readInt32LE(q + 4 + i * 8) / 65536) * 64));
				ys.push(Math.round((buf.readInt32LE(q + 8 + i * 8) / 65536) * 64));
				onCurve.push(type === 1 ? true : i === n - 1);
			}
			q += 4 + n * 8;
		}
		const last = xs.length - 1;
		if (last > start && xs[last] === sx && ys[last] === sy && onCurve[last]) {
			xs.pop();
			ys.pop();
			onCurve.pop();
		}
		endPts.push(xs.length - 1);
		p = end;
	}
	return xs.length ? ({ xs, ys, onCurve, endPts } as Outline) : null;
}

function nativeLevels(r: any): Map<string, number> {
	const out = new Map<string, number>();
	if (!r.w || !r.h) return out;
	const buf = Buffer.from(r.data, 'base64');
	const stride = (r.w + 3) & ~3;
	for (let row = 0; row < r.h; row++) {
		for (let col = 0; col < r.w; col++) {
			const v = buf[row * stride + col];
			if (v) out.set(`${r.x + col},${r.y - 1 - row}`, v);
		}
	}
	return out;
}

function levelsOf(bitmap: { width: number; height: number; left: number; top: number; data: ArrayLike<number> } | null): Map<string, number> {
	const out = new Map<string, number>();
	if (bitmap) {
		for (let row = 0; row < bitmap.height; row++) {
			for (let col = 0; col < bitmap.width; col++) {
				const v = bitmap.data[row * bitmap.width + col];
				if (v) out.set(`${bitmap.left + col},${bitmap.top - 1 - row}`, v);
			}
		}
	}
	return out;
}

const same = (a: Map<string, number>, b: Map<string, number>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

interface Tally {
	glyphs: number;
	bitmapExact: number;
	rasterOfNativeOutline: number;
	hintedOutlineExact: number;
}

function tally(face: string, size: number): Tally | null {
	const font = collection.realize({ face, height: -size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: false, gdiPlus: false }) as any;
	if (font.mode === 'mono') return null;
	const t: Tally = { glyphs: 0, bitmapExact: 0, rasterOfNativeOutline: 0, hintedOutlineExact: 0 };
	const outlines = new Map<number, any>();
	for (const r of data) if (r.face === face && r.size === size && r.format === 2) outlines.set(r.code, r);
	for (const r of data) {
		if (r.face !== face || r.size !== size || r.format !== 5) continue;
		t.glyphs++;
		const index = font.glyphIndex(r.code);
		const native = nativeLevels(r);
		if (same(levelsOf(font.glyph(index).bitmap), native)) t.bitmapExact++;
		const o = outlines.get(r.code);
		const outline = o ? nativeOutline(Buffer.from(o.data, 'base64')) : null;
		const src = font.outline(index);
		if (outline) {
			const dropout = src.scanSet ? dropoutMode(src.scanControl, src.scanType) : 2;
			if (same(levelsOf(rasterizeGray(outline, dropout)), native)) t.rasterOfNativeOutline++;
			if (outline.xs.length === src.xs.length && outline.xs.every((x, i) => x === src.xs[i] && outline.ys[i] === src.ys[i])) t.hintedOutlineExact++;
		}
	}
	return t;
}

describe.skipIf(!hasFonts)('GDI grayscale glyph bitmaps of real fonts (GGO_GRAY4_BITMAP, GGO_NATIVE)', () => {
	// face|size -> [glyphs, bitmaps equal, native outline rasterized equal, hinted outlines equal]: floors; the bitmap column measured 16 October 2026 (round 9: a scan line exactly on a horizontal edge is inked, Segoe UI 12 more).
	// (Segoe UI's GGO_NATIVE outlines are not the outlines its bitmaps come from; Courier New below 40 px is monochrome.)
	const expected: Record<string, [number, number, number, number]> = {
		'Arial|18': [94,91,91,94],
		'Arial|24': [94,92,92,94],
		'Arial|32': [94,91,91,94],
		'Arial|48': [94,78,78,94],
		'Arial|72': [94,63,64,93],
		'Times New Roman|18': [94,94,93,93],
		'Times New Roman|24': [94,93,94,93],
		'Times New Roman|32': [94,89,90,93],
		'Times New Roman|48': [94,85,86,93],
		'Times New Roman|72': [94,72,73,93],
		'Tahoma|18': [94,94,94,94],
		'Tahoma|24': [94,92,92,94],
		'Tahoma|32': [94,91,91,94],
		'Tahoma|48': [94,83,83,94],
		'Tahoma|72': [94,75,75,94],
		'Segoe UI|18': [94,92,16,15],
		'Segoe UI|24': [94,92,15,16],
		'Segoe UI|32': [94,88,19,16],
		'Segoe UI|48': [94,79,18,16],
		'Segoe UI|72': [94,61,15,17],
		'Courier New|48': [94,89,89,94],
		'Courier New|72': [94,73,73,93],
	};
	it('pins the capture', () => {
		const sizes = new Set(data.map((r) => `${r.face}|${r.size}`));
		expect(sizes.size).toBe(25);
		expect(data.length).toBe(25 * 94 * 2);
	});
	it.each([...new Set(data.map((r) => `${r.face}|${r.size}`))])('%s', (key) => {
		const [face, size] = key.split('|');
		const t = tally(face, Number(size));
		if (!t) return;
		const e = expected[key];
		expect(e, key).toBeDefined();
		expect(t.glyphs).toBe(e[0]);
		expect(t.bitmapExact).toBeGreaterThanOrEqual(e[1]);
		expect(t.rasterOfNativeOutline).toBeGreaterThanOrEqual(e[2]);
		expect(t.hintedOutlineExact).toBeGreaterThanOrEqual(e[3]);
	});
});
