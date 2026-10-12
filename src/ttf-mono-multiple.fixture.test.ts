/** Complete native masks for contour-local mono continuation.
 * Three independent seeds include separated, nearby, overlapping, nested,
 * concave and curved components. Windows capture provenance and hashes:
 * environment-mono-multiple.json. Regenerate with generate-mono-multiple.ps1;
 * compare-mono-stubs.ts --multiple-contours records the frozen e7bea83 baseline.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';
import { rasterizeMono, type GlyphBitmap } from './ttf-raster';

interface Capture { group: string; mode: number; ppem: number; index: number; x: number; y: number; w: number; h: number; data: string }
const file = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const load = (name: string): any => JSON.parse(gunzipSync(file(name)).toString());
const prefixes = ['mono-multiple', 'mono-multiple-heldout', 'mono-multiple-validation'];
const captures: Capture[] = [
	...load('text-raster-mono.json.gz').filter((c: any) => c.format === 1 && ['st1', 'st4', 'st5'].includes(c.set))
		.map((c: any) => ({ ...c, group: 'original', mode: +c.set.slice(-1) })),
	...load('mono-stubs.json.gz').map((c: any) => ({ ...c, group: 'independent' })),
	...load('mono-stubs-heldout.json.gz').map((c: any) => ({ ...c, group: 'heldout' })),
	...prefixes.flatMap((prefix) => load(`${prefix}.json.gz`).map((c: any) => ({ ...c, group: prefix }))),
];
const fonts: Record<string, ReturnType<typeof parseFontFile>[number]> = {
	original: parseFontFile(file('raster-polygons-st1.ttf'))[0],
	independent: parseFontFile(file('mono-stub-st1.ttf'))[0],
	heldout: parseFontFile(file('mono-stub-heldout-st1.ttf'))[0],
};
for (const prefix of prefixes) fonts[prefix] = parseFontFile(file(`${prefix}-st1.ttf`))[0];
const evidence = load('mono-multiple-bounds.json.gz') as {
	stats: Record<string, { total: number; afterExact: number }>;
	increases: unknown[];
	bounds: Record<string, [number, number, string?, string?]>;
};

function fingerprint(bitmap: GlyphBitmap | null): string {
	const hash = createHash('sha256').update(JSON.stringify(bitmap ? [bitmap.width, bitmap.height, bitmap.left, bitmap.top] : null));
	if (bitmap) hash.update(bitmap.data);
	return hash.digest('hex');
}

describe('native multiple-contour monochrome decisions', () => {
	it('covers the entire existing corpus and three fresh native seeds', () => {
		expect(captures).toHaveLength(29_696 + 32_256);
		expect(Object.keys(evidence.bounds)).toHaveLength(captures.length);
		expect(evidence.increases).toEqual([]);
	});
	for (const [groupMode, stats] of Object.entries(evidence.stats)) it(`${groupMode}: retains every per-case ceiling and exact control`, () => {
		const [group, mode] = groupMode.split(':');
		const selected = captures.filter((c) => c.group === group && c.mode === +mode);
		expect(selected).toHaveLength(stats.total);
		const sizes = new Map<number, HintedSize>();
		let exact = 0;
		for (const c of selected) {
			let size = sizes.get(c.ppem);
			if (!size) { size = new HintedSize(fonts[group], c.ppem, c.ppem, { version: 35, grayscale: false }); sizes.set(c.ppem, size); }
			const bitmap = rasterizeMono(size.hintGlyph(c.index + 1), c.mode, undefined, true, true);
			const key = `${groupMode}:${c.ppem}:${c.index}`;
			const [before, ceiling, previousHash, improvedHash] = evidence.bounds[key];
			const actual = new Set<string>(), expected = new Set<string>();
			if (bitmap) for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
				if (bitmap.data[y * bitmap.width + x]) actual.add(`${bitmap.left + x},${bitmap.top - 1 - y}`);
			}
			const bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
			for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
				if (bytes[y * stride + (x >> 3)] & (128 >> (x & 7))) expected.add(`${c.x + x},${c.y - 1 - y}`);
			}
			// The full absolute-coordinate union counts outside ink too; no
			// captured surface clipping or negative-coordinate row wrapping.
			const mismatch = [...new Set([...actual, ...expected])].filter((p) => actual.has(p) !== expected.has(p)).length;
			expect(mismatch, key).toBeLessThanOrEqual(ceiling);
			expect(mismatch, `prior ceiling ${key}`).toBeLessThanOrEqual(before);
			if (before === 0) expect(mismatch, `prior exact ${key}`).toBe(0);
			// Preserve all unsupported contour bitmaps, including zero samples;
			// explicitly pin native-backed component improvements where admitted.
			if (previousHash) expect(fingerprint(bitmap), key).toBe(improvedHash ?? previousHash);
			if (mismatch === 0) exact++;
		}
		expect(exact).toBeGreaterThanOrEqual(stats.afterExact);
	});
});
