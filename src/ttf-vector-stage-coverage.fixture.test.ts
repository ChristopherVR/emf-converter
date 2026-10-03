import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

interface Capture {
	kind: 'dual' | 'mdoriginal' | 'mdrp' | 'mirp' | 'scfs'; size: number; hint: number; index: number;
	width: number; height: number; x: number; y: number; rgba: string;
}
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const captures: Capture[] = JSON.parse(gunzipSync(fixture('text-vector-stage-coverage.json.gz')).toString());
// Baseline error ceilings belong to the test, never the native capture or runtime.
// Zero ceilings preserve every independently exact image as arithmetic changes.
const bounds: Record<string, [number, number]> = JSON.parse(fixture('text-vector-stage-coverage-bounds.json').toString());
const fonts = new GdiFontCollection(['dual', 'mdoriginal', 'mdrp', 'mirp', 'scfs'].map(kind => fixture(`vector-stage-${kind}.ttf`)));

describe('public GDI+ private-font unequal projection-vector stage coverage', () => {
	it.each(['dual', 'mdoriginal', 'mdrp', 'mirp', 'scfs'] as const)('preserves every %s rendering-mode control', kind => {
		const records = captures.filter(c => c.kind === kind);
		expect(records).toHaveLength(512);
		for (const c of records) {
			const key = `${c.kind}:${c.size}:${c.hint}:${c.index}:${c.x}:${c.y}`;
			const font = fonts.realize({
				face: `Parity Vector Stage ${kind[0].toUpperCase()}${kind.slice(1)}`, height: -c.size, width: 0,
				weight: 400, italic: false, charSet: 1, pitchAndFamily: 0,
				quality: c.hint === 1 ? 3 : c.hint === 5 ? 6 : 4,
				unhinted: c.hint === 4, ignoreGasp: c.hint === 4, gdiPlus: true,
			});
			expect(font, key).not.toBeNull();
			const mask = gdiTextCoverage(font!, {
				codes: [0xe000 + c.index - 1], glyphIndices: false, x: c.x, y: c.y, dx: null, dy: null,
				textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1,
				options: 0, rect: null, matrix: null, underline: false, strikeOut: false,
			}, { grayLevels: 15 });
			expect(mask, key).not.toBeNull();
			const m = mask!, native = Buffer.from(c.rgba, 'base64');
			expect(native.length, key).toBe(c.width * c.height * 4);
			let count = 0, sum = 0;
			for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
				const xx = x - m.x, yy = y - m.y;
				const inside = xx >= 0 && xx < m.width && yy >= 0 && yy < m.height;
				for (let channel = 0; channel < 3; channel++) {
					const actual = inside ? 255 - m.data[(yy * m.width + xx) * m.channels + (m.channels === 3 ? channel : 0)] : 255;
					const difference = Math.abs(actual - native[(y * c.width + x) * 4 + channel]);
					count += difference !== 0 ? 1 : 0; sum += difference;
				}
			}
			expect(bounds[key], key).toBeDefined();
			expect(count, key).toBeLessThanOrEqual(bounds[key][0]);
			expect(sum, key).toBeLessThanOrEqual(bounds[key][1]);
		}
	}, 15000);
});
