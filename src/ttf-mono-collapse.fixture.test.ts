/** Native signed-phase sweep around the collapsed monochrome control box.
 * Regenerate with scripts/gdi-fixtures/generate-mono-collapse.ps1; capture
 * environment and fixture hashes are in environment-mono-collapse.json.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';
import { rasterizeMono } from './ttf-raster';

interface Capture { mode: number; ppem: number; index: number; x: number; y: number; w: number; h: number; data: string }
const file = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const captures: Capture[] = JSON.parse(gunzipSync(file('mono-collapse.json.gz')).toString());

describe('native monochrome collapsed control boxes', () => {
	for (const mode of [1, 5]) it(`SCANTYPE ${mode}: exact at every signed phase, on both axes and around one-pixel thickness`, () => {
		const selected = captures.filter((c) => c.mode === mode);
		expect(selected).toHaveLength(5120);
		const font = parseFontFile(file(`mono-collapse-st${mode}.ttf`))[0];
		const size = new HintedSize(font, 32, 32, { version: 35, grayscale: false });
		for (const c of selected) {
			const key = `${mode}:${c.index}`;
			expect(c.ppem, key).toBe(32);
			const bitmap = rasterizeMono(size.hintGlyph(c.index + 1), mode, undefined, true, true);
			expect(bitmap, key).not.toBeNull();
			expect([bitmap!.width, bitmap!.height, bitmap!.left, bitmap!.top], key).toEqual([c.w, c.h, c.x, c.y]);
			const actual = new Set<string>(), expected = new Set<string>();
			for (let y = 0; y < bitmap!.height; y++) for (let x = 0; x < bitmap!.width; x++) {
				if (bitmap!.data[y * bitmap!.width + x]) actual.add(`${bitmap!.left + x},${bitmap!.top - 1 - y}`);
			}
			const bytes = Buffer.from(c.data, 'base64'), stride = Math.ceil(c.w / 32) * 4;
			for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
				if (bytes[y * stride + (x >> 3)] & (128 >> (x & 7))) expected.add(`${c.x + x},${c.y - 1 - y}`);
			}
			// Compare every absolute-coordinate sample, including ink outside the
			// captured box. Negative positions cannot wrap into adjacent rows.
			expect([...actual].sort(), key).toEqual([...expected].sort());
		}
	});
});
