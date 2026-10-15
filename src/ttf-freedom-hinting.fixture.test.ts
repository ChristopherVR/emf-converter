/**
 * Native GetGlyphOutline(GGO_NATIVE) of the hinted outline after one TrueType interpreter primitive, in generated CC0 fonts
 * (`build-freedom-fonts.py`, `generate-mono-hinting.ps1`, `freedom-hinting.json.gz`): moves along x and y when the freedom
 * vector is not the projection vector (MDRP, MIRP, SCFS), the cases where the two vectors are one, the vectors SPVTL/SFVTL/SDPVTL
 * leave, and ISECT. They measured GDI's arithmetic: a projection rounds each coordinate's product alone, a move along x and IUP
 * divide with `(a * b + c / 2) / c` truncated toward zero while a move along y rounds half away from zero, the quotient is
 * exact when the vectors are one (copied, or a rounded dot product of exactly 1.0), and a nearly perpendicular freedom vector
 * keeps the sign of its dot product. Portable: no Microsoft font is needed.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';

interface Capture { size: number; variant: number; native: string }
const captures: Record<string, Capture[]> = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/freedom-hinting.json.gz', import.meta.url))).toString());

function nativePoints(encoded: string): number[] {
	const bytes = Buffer.from(encoded, 'base64');
	const points = [bytes.readInt32LE(8) / 1024, bytes.readInt32LE(12) / 1024];
	for (let offset = 16; offset < bytes.length;) {
		const count = bytes.readUInt16LE(offset + 2);
		for (let i = 0; i < count; i++) points.push(bytes.readInt32LE(offset + 4 + i * 8) / 1024, bytes.readInt32LE(offset + 8 + i * 8) / 1024);
		offset += 4 + count * 8;
	}
	return points;
}
function exactCount(kind: string): { exact: number; total: number } {
	const font = parseFontFile(readFileSync(new URL(`./__fixtures__/gdi/freedom-${kind}.ttf`, import.meta.url)))[0];
	let exact = 0;
	for (const c of captures[kind]) {
		const ppem = Math.abs(c.size);
		const hinted = new HintedSize(font, ppem, ppem, { version: 35, grayscale: false, gdiArithmetic: true }).hintGlyph(font.glyphIndex(0xE000 + c.variant));
		const ours = Array.from(hinted.xs).flatMap((x, i) => [x, hinted.ys[i]]);
		const native = nativePoints(c.native);
		if (ours.length === native.length && ours.every((v, i) => v === native[i])) exact++;
	}
	return { exact, total: captures[kind].length };
}

describe('native interpreter primitives of generated fonts', () => {
	it.each([
		['movement', 144], ['mdrp', 144], ['mirp', 144], ['mdrpmin', 144],
		['eqmdrp', 180], ['eqmirp', 180], ['sepmdrp', 180], ['perpmirp', 180],
		['vec06', 36], ['vec07', 36], ['vec08', 36], ['vec09', 36], ['vec86', 36], ['vec87', 36],
	] as const)('%s: all %i controls are native outline point for point', (kind, count) => {
		expect(exactCount(kind)).toEqual({ exact: count, total: count });
	});
	it('ISECT: exact for a horizontal or vertical second line, 431 of 960 for random lines (the native formula is not known)', () => {
		const { exact, total } = exactCount('isect');
		expect(total).toBe(960);
		expect(exact).toBeGreaterThanOrEqual(431);
	});
});
