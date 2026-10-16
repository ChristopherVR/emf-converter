/** Per-case evidence for the specification-squares stub rule of the monochrome scan converter.
 *
 *   git show d28c941:src/ttf-raster.ts > .scratch/ttf-raster.round8.ts
 *   bun scripts/gdi-fixtures/compare-mono-squares.ts .scratch/ttf-raster.round8.ts
 *
 * The frozen module is the renderer before the change (round 8, FreeType-derived profile rule); `rasterizeMono` of the
 * working tree is the one after. Both are compared with the complete native `GetGlyphOutline(GGO_BITMAP)` masks of the
 * private polygon fonts (the original, independent and held-out stub sets and the three multiple-contour seeds, 61,952
 * captures at SCANTYPE 1, 4 and 5) and the differing-sample count of each is written to
 * `mono-squares-bounds.json.gz` ({ baseline, bounds: { "group:mode:ppem:index": [before, after] } }), which
 * `src/ttf-mono-squares.fixture.test.ts` keeps as per-case ceilings.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseFontFile } from '../../src/ttf-font';
import { HintedSize } from '../../src/ttf-hinting';
import { rasterizeMono, type GlyphBitmap } from '../../src/ttf-raster';

const directory = 'src/__fixtures__/gdi/';
const load = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(directory + name)).toString());
if (!process.argv[2]) throw new Error('Pass the frozen pre-change ttf-raster.ts source.');
const before = (await import(resolve(process.argv[2]))).rasterizeMono as typeof rasterizeMono;
const prefixes = ['mono-multiple', 'mono-multiple-heldout', 'mono-multiple-validation'];
const inputs = [
	...load('text-raster-mono.json.gz').filter((c) => c.format === 1 && ['st1', 'st4', 'st5'].includes(c.set)).map((c) => ({ ...c, group: 'original', mode: +c.set.slice(-1) })),
	...load('mono-stubs.json.gz').map((c) => ({ ...c, group: 'independent' })),
	...load('mono-stubs-heldout.json.gz').map((c) => ({ ...c, group: 'heldout' })),
	...prefixes.flatMap((prefix) => load(`${prefix}.json.gz`).map((c) => ({ ...c, group: prefix }))),
];
const fonts: Record<string, ReturnType<typeof parseFontFile>[number]> = {
	original: parseFontFile(readFileSync(directory + 'raster-polygons-st1.ttf'))[0],
	independent: parseFontFile(readFileSync(directory + 'mono-stub-st1.ttf'))[0],
	heldout: parseFontFile(readFileSync(directory + 'mono-stub-heldout-st1.ttf'))[0],
};
for (const prefix of prefixes) fonts[prefix] = parseFontFile(readFileSync(directory + `${prefix}-st1.ttf`))[0];
const sizes = new Map<string, HintedSize>();
const samples = (bitmap: GlyphBitmap | null): Set<string> => {
	const out = new Set<string>();
	if (bitmap) for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) if (bitmap.data[y * bitmap.width + x]) out.add(`${bitmap.left + x},${bitmap.top - 1 - y}`);
	return out;
};
const difference = (a: Set<string>, b: Set<string>): number => [...new Set([...a, ...b])].filter((k) => a.has(k) !== b.has(k)).length;
const bounds: Record<string, [number, number]> = {};
const stats: Record<string, { total: number; beforeExact: number; afterExact: number; gained: number; lost: number }> = {};
for (const c of inputs) {
	const sizeKey = `${c.group}:${c.ppem}`;
	let size = sizes.get(sizeKey);
	if (!size) { size = new HintedSize(fonts[c.group], c.ppem, c.ppem, { version: 35, grayscale: false }); sizes.set(sizeKey, size); }
	const outline = size.hintGlyph(c.index + 1);
	const bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4, reference = new Set<string>();
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (bytes[y * stride + (x >> 3)] & (128 >> (x & 7))) reference.add(`${c.x + x},${c.y - 1 - y}`);
	const b = difference(samples(before(outline, c.mode, undefined, true, true)), reference);
	const a = difference(samples(rasterizeMono(outline, c.mode, undefined, true, true, false, false, false, false, true)), reference);
	bounds[`${c.group}:${c.mode}:${c.ppem}:${c.index}`] = [b, a];
	const s = (stats[`${c.group}:${c.mode}`] ??= { total: 0, beforeExact: 0, afterExact: 0, gained: 0, lost: 0 });
	s.total++; s.beforeExact += +(b === 0); s.afterExact += +(a === 0); s.gained += +(a === 0 && b !== 0); s.lost += +(a !== 0 && b === 0);
}
writeFileSync(directory + 'mono-squares-bounds.json.gz', gzipSync(JSON.stringify({ schemaVersion: 1, baseline: 'd28c941, round 8', stats, bounds })));
console.log(JSON.stringify(stats, null, 1));
console.log('regressions:', Object.entries(bounds).filter(([, v]) => v[0] === 0 && v[1] > 0).map(([k, v]) => `${k} 0->${v[1]}`).join(' '));
