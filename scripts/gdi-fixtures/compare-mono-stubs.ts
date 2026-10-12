/** Research comparison and per-case regression evidence.
 * bun scripts/gdi-fixtures/compare-mono-stubs.ts <pre-change ttf-raster.ts>
 * The supplied baseline is a frozen source snapshot; no baseline bitmap is
 * substituted for a Windows reference. Native inputs remain the GGO_BITMAP captures.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseFontFile } from '../../src/ttf-font';
import { HintedSize } from '../../src/ttf-hinting';
import { rasterizeMono, type GlyphBitmap } from '../../src/ttf-raster';

const directory = 'src/__fixtures__/gdi/';
const load = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(directory + name)).toString());
if (!process.argv[2]) throw new Error('Pass a frozen pre-change ttf-raster.ts source for the baseline.');
const baseline = (await import(resolve(process.argv[2]))).rasterizeMono as typeof rasterizeMono;
const inputs = [
	...load('text-raster-mono.json.gz').filter((c) => c.format === 1 && ['st1', 'st4', 'st5'].includes(c.set)).map((c) => ({ ...c, group: 'original', mode: +c.set.slice(-1) })),
	...load('mono-stubs.json.gz').map((c) => ({ ...c, group: 'independent' })),
	...load('mono-stubs-heldout.json.gz').map((c) => ({ ...c, group: 'heldout' })),
];
const fonts = {
	original: parseFontFile(readFileSync(directory + 'raster-polygons-st1.ttf'))[0],
	independent: parseFontFile(readFileSync(directory + 'mono-stub-st1.ttf'))[0],
	heldout: parseFontFile(readFileSync(directory + 'mono-stub-heldout-st1.ttf'))[0],
};
const sizes = new Map<string, HintedSize>();
function samples(bitmap: GlyphBitmap | null): Set<string> {
	const out = new Set<string>();
	if (bitmap) for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
		if (bitmap.data[y * bitmap.width + x]) out.add(`${bitmap.left + x},${bitmap.top - 1 - y}`);
	}
	return out;
}
function native(c: any): Set<string> {
	const out = new Set<string>(), bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
		if (bytes[y * stride + (x >> 3)] & (128 >> (x & 7))) out.add(`${c.x + x},${c.y - 1 - y}`);
	}
	return out;
}
function difference(a: Set<string>, b: Set<string>): number {
	let count = 0;
	for (const key of new Set([...a, ...b])) if (a.has(key) !== b.has(key)) count++;
	return count;
}
const bounds: Record<string, [number, number, string?]> = {};
const stats: Record<string, any> = {};
const increases: any[] = [];
for (const c of inputs) {
	const sizeKey = `${c.group}:${c.ppem}`;
	let size = sizes.get(sizeKey);
	if (!size) {
		size = new HintedSize(fonts[c.group as keyof typeof fonts], c.ppem, c.ppem, { version: 35, grayscale: false });
		sizes.set(sizeKey, size);
	}
	const outline = size.hintGlyph(c.index + 1), reference = native(c);
	const prior = baseline(outline, c.mode);
	const before = difference(samples(prior), reference);
	const after = difference(samples(rasterizeMono(outline, c.mode, undefined, true, true)), reference);
	const key = `${c.group}:${c.mode}:${c.ppem}:${c.index}`;
	bounds[key] = [before, after];
	if (outline.endPts.length !== 1 || Array.from(outline.onCurve).some((p) => !p)) {
		const hash = createHash('sha256').update(JSON.stringify(prior ? [prior.width, prior.height, prior.left, prior.top] : null));
		if (prior) hash.update(prior.data);
		bounds[key].push(hash.digest('hex'));
	}
	const bucket = stats[`${c.group}:${c.mode}`] ??= { total: 0, beforeExact: 0, afterExact: 0, gained: 0, lost: 0, beforePixels: 0, afterPixels: 0 };
	bucket.total++; bucket.beforeExact += +(before === 0); bucket.afterExact += +(after === 0);
	bucket.gained += +(after === 0 && before !== 0); bucket.lost += +(after !== 0 && before === 0);
	bucket.beforePixels += before; bucket.afterPixels += after;
	if (after > before) increases.push({ key, before, after });
}
const output = { schemaVersion: 1, baseline: 'pre-change native-parity text round', stats, increases, bounds };
writeFileSync(directory + 'mono-stub-bounds.json.gz', gzipSync(JSON.stringify(output)));
console.log(JSON.stringify({ stats, increases }, null, 2));
