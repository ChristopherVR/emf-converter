/**
 * Monochrome dropout stubs read as the TrueType specification words them (rules 4 and 6 of SCANTYPE: the scan segments
 * that form a square with the dropout segment must be crossed by contours, whichever contours), curves flattened for that
 * test, against the complete native `GetGlyphOutline(GGO_BITMAP)` masks of the private polygon fonts: the original,
 * independent and held-out stub sets and the three multiple-contour seeds at SCANTYPE 1, 4 and 5 (`text-raster-mono`,
 * `mono-stubs*`, `mono-multiple*`; 61,952 captures). The rule before (round 8) was FreeType's profile rule with a
 * neighbouring-square refinement for single convex or separated straight contours.
 *
 * `mono-squares-bounds.json.gz` holds, per capture, the differing samples before and after (`compare-mono-squares.ts`
 * against a frozen round 8 `ttf-raster.ts`). The "after" counts are ceilings that only shrink. Windows provenance:
 * `environment-mono-stubs.json`, `environment-mono-multiple.json`.
 *
 * This change is not a pure gain: KNOWN_REGRESSIONS lists the captures that were exact before and are not now. They
 * are all at a pixel centre that a contour passes within about 0.004 pixel (`docs/outstanding-work.md`, round 9 W3).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';
import { rasterizeMono, type GlyphBitmap } from './ttf-raster';

const file = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const load = (name: string): any => JSON.parse(gunzipSync(file(name)).toString());
const prefixes = ['mono-multiple', 'mono-multiple-heldout', 'mono-multiple-validation'];
interface Capture { group: string; mode: number; ppem: number; index: number; x: number; y: number; w: number; h: number; data: string }
const captures: Capture[] = [
	...load('text-raster-mono.json.gz').filter((c: any) => c.format === 1 && ['st1', 'st4', 'st5'].includes(c.set)).map((c: any) => ({ ...c, group: 'original', mode: +c.set.slice(-1) })),
	...load('mono-stubs.json.gz').map((c: any) => ({ ...c, group: 'independent' })),
	...load('mono-stubs-heldout.json.gz').map((c: any) => ({ ...c, group: 'heldout' })),
	...prefixes.flatMap((prefix) => load(`${prefix}.json.gz`).map((c: any) => ({ ...c, group: prefix }))),
];
const evidence = load('mono-squares-bounds.json.gz') as {
	stats: Record<string, { total: number; beforeExact: number; afterExact: number; gained: number; lost: number }>;
	bounds: Record<string, [number, number]>;
};
const fonts: Record<string, ReturnType<typeof parseFontFile>[number]> = {
	original: parseFontFile(file('raster-polygons-st1.ttf'))[0],
	independent: parseFontFile(file('mono-stub-st1.ttf'))[0],
	heldout: parseFontFile(file('mono-stub-heldout-st1.ttf'))[0],
};
for (const prefix of prefixes) fonts[prefix] = parseFontFile(file(`${prefix}-st1.ttf`))[0];

/** Exact before, not exact now (and by how many samples). */
const KNOWN_REGRESSIONS: Record<string, number> = {
	'independent:5:20:417': 1,
	'mono-multiple:5:8:413': 2,
	'mono-multiple:5:12:344': 2,
	'mono-multiple:5:16:292': 2,
	'mono-multiple:5:16:399': 2,
	'mono-multiple:5:32:5': 1,
	'mono-multiple-heldout:1:16:432': 1,
	'mono-multiple-heldout:4:24:282': 10,
	'mono-multiple-validation:1:40:17': 1,
	'mono-multiple-validation:1:40:441': 1,
	'mono-multiple-validation:5:8:301': 2,
	'mono-multiple-validation:5:12:424': 1,
	'mono-multiple-validation:5:16:96': 2,
	'mono-multiple-validation:5:24:375': 3,
	'mono-multiple-validation:5:24:442': 2,
	'mono-multiple-validation:5:40:17': 1,
	'mono-multiple-validation:5:40:216': 2,
	'mono-multiple-validation:5:40:441': 1,
};

function samples(bitmap: GlyphBitmap | null): Set<string> {
	const out = new Set<string>();
	if (bitmap) for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) if (bitmap.data[y * bitmap.width + x]) out.add(`${bitmap.left + x},${bitmap.top - 1 - y}`);
	return out;
}
function native(c: Capture): Set<string> {
	const out = new Set<string>(), bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (bytes[y * stride + (x >> 3)] & (128 >> (x & 7))) out.add(`${c.x + x},${c.y - 1 - y}`);
	return out;
}
const difference = (a: Set<string>, b: Set<string>): number => [...new Set([...a, ...b])].filter((k) => a.has(k) !== b.has(k)).length;

describe('specification squares for monochrome dropout stubs', () => {
	it('covers every capture of the private stub and multiple-contour sets', () => {
		expect(captures).toHaveLength(61_952);
		expect(Object.keys(evidence.bounds)).toHaveLength(captures.length);
	});
	it('pins the regressions: exact in round 8, inexact now', () => {
		const regressions: Record<string, number> = {};
		for (const [key, [before, after]] of Object.entries(evidence.bounds)) if (before === 0 && after > 0) regressions[key] = after;
		expect(regressions).toEqual(KNOWN_REGRESSIONS);
	});
	for (const [groupMode, stats] of Object.entries(evidence.stats)) {
		it(`${groupMode}: ${stats.afterExact} of ${stats.total} exact (${stats.beforeExact} in round 8), no capture beyond its ceiling`, () => {
			const [group, mode] = groupMode.split(':');
			const selected = captures.filter((c) => c.group === group && c.mode === +mode);
			expect(selected).toHaveLength(stats.total);
			const sizes = new Map<number, HintedSize>();
			let exact = 0;
			for (const c of selected) {
				let size = sizes.get(c.ppem);
				if (!size) { size = new HintedSize(fonts[group], c.ppem, c.ppem, { version: 35, grayscale: false }); sizes.set(c.ppem, size); }
				const key = `${groupMode}:${c.ppem}:${c.index}`;
				const mismatch = difference(samples(rasterizeMono(size.hintGlyph(c.index + 1), c.mode, undefined, true, true, false, false, false, false, true)), native(c));
				expect(mismatch, key).toBeLessThanOrEqual(evidence.bounds[key][1]);
				if (mismatch === 0) exact++;
			}
			expect(exact).toBeGreaterThanOrEqual(stats.afterExact);
		});
	}
});
