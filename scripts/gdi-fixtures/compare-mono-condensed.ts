/** Compare native system-font captures with a frozen pre-change mono raster.
 * bun scripts/gdi-fixtures/compare-mono-condensed.ts <pre-change ttf-raster.ts>
 * bun scripts/gdi-fixtures/compare-mono-condensed.ts --tighten
 *   keeps each committed `before` and lowers each ceiling to the current mismatch (never raises one), so a hinting
 *   improvement is pinned without needing the frozen source again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { GdiFontCollection } from '../../src/gdi-font-engine';
import { dropoutMode, type GlyphBitmap } from '../../src/ttf-raster';
import { windowsFonts } from '../../src/__fixtures__/gdi-parity-harness';

const directory = 'src/__fixtures__/gdi/';
if (!process.argv[2]) throw new Error('Pass the frozen pre-change ttf-raster.ts source, or --tighten.');
const tighten = process.argv[2] === '--tighten';
const previous = tighten ? JSON.parse(gunzipSync(readFileSync(directory + 'mono-condensed-bounds.json.gz')).toString()) : null;
const baseline = tighten ? null : (await import(resolve(process.argv[2]))).rasterizeMono;
const captures = JSON.parse(gunzipSync(readFileSync(directory + 'mono-condensed.json.gz')).toString());
const collection = new GdiFontCollection(windowsFonts()!);
const samples = (bitmap: GlyphBitmap | null): Set<string> => {
	const out = new Set<string>();
	if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) {
		if (bitmap.data[row * bitmap.width + col]) out.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
	}
	return out;
};
const bounds: Record<string, [number, number]> = {};
const stats = { total: 0, beforeExact: 0, afterExact: 0, beforePixels: 0, afterPixels: 0, gained: 0, lost: 0, increased: 0 };
for (const c of captures) {
	const font = collection.realize({ face: c.face, height: -c.ppem, width: c.width, weight: c.weight, italic: c.italic,
		charSet: 1, pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false }) as any;
	const index = font.glyphIndex(c.code), src = font.outline(index);
	const outline = font.syntheticItalic ? { ...src, xs: Float64Array.from(src.xs, (x: number, i: number) => Math.round(x + src.ys[i] * 0x5700 / 65536)) } : src;
	if (font.syntheticBold) throw new Error('Capture font unavailable: synthetic bold is not a valid comparison input.');
	const mode = dropoutMode(src.scanSet ? src.scanControl : c.ppem <= 32, src.scanType);
	const reference = new Set<string>(), bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
	for (let row = 0; row < c.h; row++) for (let col = 0; col < c.w; col++) {
		if (bytes[row * stride + (col >> 3)] & (128 >> (col & 7))) reference.add(`${c.x + col},${c.y - 1 - row}`);
	}
	const difference = (bitmap: GlyphBitmap | null): number => {
		const actual = samples(bitmap);
		return [...new Set([...actual, ...reference])].filter((p) => actual.has(p) !== reference.has(p)).length;
	};
	const key = `${c.face}:${c.ppem}:${c.width}:${c.weight}:${+c.italic}:${c.code}`;
	const before = tighten ? previous.bounds[key][0] : difference(baseline(outline, mode));
	const current = difference(font.glyph(index).bitmap);
	const after = tighten ? Math.min(previous.bounds[key][1], current) : current;
	if (tighten && current > previous.bounds[key][1]) throw new Error(`${key} is above its committed ceiling (${current} > ${previous.bounds[key][1]})`);
	bounds[key] = [before, after];
	stats.total++; stats.beforeExact += +(before === 0); stats.afterExact += +(after === 0);
	stats.beforePixels += before; stats.afterPixels += after;
	stats.gained += +(before !== 0 && after === 0); stats.lost += +(before === 0 && after !== 0); stats.increased += +(after > before);
}
writeFileSync(directory + 'mono-condensed-bounds.json.gz', gzipSync(JSON.stringify({ stats, bounds })));
console.log(stats);
