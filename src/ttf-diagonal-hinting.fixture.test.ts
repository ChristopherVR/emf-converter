import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';

interface Capture { kind: 'movement' | 'projection' | 'vectors'; size: number; index: number; native: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-diagonal-hinting.json.gz', import.meta.url))).toString());
const fonts = Object.fromEntries(['movement', 'projection', 'vectors'].map(kind => [kind,
	parseFontFile(readFileSync(new URL(`./__fixtures__/gdi/diagonal-${kind}.ttf`, import.meta.url)))[0]]));

// Per-capture ceilings pin all currently exact controls; aggregate improvements
// may never pay for a regression in a different instruction/glyph/size case.
const projectionInexact = new Set('16:2,16:5,16:7,16:11,16:13,16:27,16:28,16:30,16:36,23:1,23:2,23:3,23:6,23:17,23:18,23:19,23:21,23:22,23:27,23:29,23:32,23:34,32:2,32:5,32:9,32:17,32:18,32:23,32:28,32:32,32:34,41:1,41:5,41:11,41:16,41:18,41:21,41:24,41:25,41:27,41:30,41:31'.split(','));
const movementInexact = new Set('16:5,16:7,16:11,16:13,16:27,16:28,16:30,16:36,23:1,23:2,23:3,23:6,23:17,23:19,23:22,23:23,23:27,23:29,23:31,23:32,23:34,23:36,32:2,32:5,32:8,32:14,32:17,32:18,32:23,32:28,32:32,32:34,41:1,41:2,41:5,41:11,41:16,41:18,41:21,41:24,41:25,41:27,41:30,41:31,41:33,41:36'.split(','));
const movementTwoCoordinates = new Set('16:13,16:28,16:36,23:22,32:23,32:32,32:34,41:5,41:16,41:21,41:24'.split(','));

function nativePoints(encoded: string): number[] {
	const bytes = Buffer.from(encoded, 'base64');
	const points = [bytes.readInt32LE(8) / 1024, bytes.readInt32LE(12) / 1024];
	for (let offset = 16; offset < bytes.length;) {
		expect(bytes.readUInt16LE(offset)).toBe(1); // TT_PRIM_LINE: all four diagnostic points are on-curve.
		const count = bytes.readUInt16LE(offset + 2);
		for (let i = 0; i < count; i++) points.push(bytes.readInt32LE(offset + 4 + i * 8) / 1024, bytes.readInt32LE(offset + 8 + i * 8) / 1024);
		offset += 4 + count * 8;
	}
	return points;
}

describe('public GDI diagonal TrueType instruction controls', () => {
	it.each([['vectors', 144, 0], ['projection', 102, 42], ['movement', 98, 57]] as const)(
		'preserves independently measured %s controls and their unresolved arithmetic bounds', (kind, minimumExact, maximumDifference) => {
			const records = captures.filter(c => c.kind === kind);
			expect(records).toHaveLength(144);
			let exact = 0, total = 0;
			for (const c of records) {
				const hinted = new HintedSize(fonts[kind], c.size, c.size, { version: 35, grayscale: false }).hintGlyph(c.index);
				const ours = Array.from(hinted.xs).flatMap((x, i) => [x, hinted.ys[i]]);
				const native = nativePoints(c.native);
				expect(ours).toHaveLength(native.length);
				const differences = ours.map((v, i) => Math.abs(v - native[i]));
				expect(Math.max(...differences)).toBeLessThanOrEqual(kind === 'vectors' ? 0 : 1);
				const key = c.size + ':' + c.index;
				const ceiling = kind === 'vectors' ? 0 : kind === 'projection' ? (projectionInexact.has(key) ? 1 : 0)
					: movementTwoCoordinates.has(key) ? 2 : movementInexact.has(key) ? 1 : 0;
				expect(differences.filter(v => v !== 0).length, kind + ':' + key).toBeLessThanOrEqual(ceiling);
				if (!differences.some(v => v)) exact++;
				total += differences.reduce((sum, v) => sum + v, 0);
			}
			expect(exact).toBeGreaterThanOrEqual(minimumExact);
			expect(total).toBeLessThanOrEqual(maximumDifference);
		});
});
