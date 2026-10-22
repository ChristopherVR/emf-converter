import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * Native GDI ExtTextOut ClearType of zigzag ribbons (V and W, 32 ppem) whose glyph program is a chain of MIRPs along x
 * (generator `scripts/gdi-fixtures/build-cleartype-chain-fonts.py`, probe `GdiClearTypeWidthProbe.cs`, mode
 * `text-gdi-cleartype-chain`, captures `ctc-chain.json.gz`, 576 glyphs at both qualities). Round 10 (R10-A) read from them
 * what the compatible-width mode treats as a stem among the MIRPs of a chain (Arial's W and V place their vertices so):
 * - only a MIRP whose distance type is black (flag bits 0 and 1 = 01) is a stem, whatever its min-distance and rounding
 *   bits (flags 0xF1, 0xF5, 0xF9, 0xFD shift, 0xF0, 0xF2 to 0xF4, 0xF6 to 0xF8, 0xFA to 0xFC do not: 64 glyphs per value);
 * - a point that already belongs to a stem pair is not the first edge of another: along a chain the pairs 1, 3, 5 shift
 *   rigidly by the centre times (BW / natural - 1), the pairs 2, 4 do not, and the last point scales with its own position.
 * Left bearing 0 (the first corner on the origin) and unrounded chains with a MIRP to the advance phantom point are not
 * reproduced yet (the latter because the shift scale there is the hinted advance, not a whole pixel).
 */
const dir = new URL('./__fixtures__/gdi/', import.meta.url);
interface Set { set: string; file: string; family: string; count: number; params: number[][] }
const sets: Set[] = JSON.parse(readFileSync(new URL('ctc-sets.json', dir), 'utf8'));
const caps: { quality: number; index: number; x: number; y: number; w: number; h: number; rgb: string }[] = JSON.parse(gunzipSync(readFileSync(new URL('ctc-chain.json.gz', dir))).toString());
const fonts = new GdiFontCollection([readFileSync(new URL(sets[0].file, dir))]);
const LEVELS = [255, 219, 182, 144, 102, 58, 0];
const W = 48;
const H = 64;

function diff(quality: number, index: number): number {
	const font = fonts.realize({ face: sets[0].family, height: -32, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality })!;
	const mask = gdiTextCoverage(font, { codes: [0xe000 + index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false });
	const ours = new Uint8Array(W * H * 3).fill(255);
	if (mask) for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) for (let ch = 0; ch < 3; ch++) ours[((y + mask.y) * W + x + mask.x) * 3 + ch] = LEVELS[Math.round((mask.data[(y * mask.width + x) * 3 + ch] * 6) / 255)];
	const c = caps.find((k) => k.quality === quality && k.index === index)!;
	const native = new Uint8Array(W * H * 3).fill(255);
	const rgb = Buffer.from(c.rgb, 'base64');
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) for (let i = 0; i < 3; i++) native[((y + c.y) * W + x + c.x) * 3 + i] = rgb[(y * c.w + x) * 3 + i];
	let bad = 0;
	for (let p = 0; p < native.length; p += 3) if (native[p] !== ours[p] || native[p + 1] !== ours[p + 1] || native[p + 2] !== ours[p + 2]) bad++;
	return bad;
}

describe('GDI ClearType compatible widths on zigzag MIRP chains (ctc-chain.json.gz)', () => {
	it('captured every glyph at both qualities', () => {
		expect(sets[0].count).toBe(576);
		expect(caps.filter((c) => c.quality === 5)).toHaveLength(576);
		expect(caps.filter((c) => c.quality === 6)).toHaveLength(576);
	});
	it('reproduces the natural-quality glyphs and the default-quality glyphs of the chain rules', () => {
		const natural = sets[0].params.filter((_, i) => diff(6, i) === 0).length;
		const exactByFlags: Record<number, number> = {};
		sets[0].params.forEach((prm, i) => { if (diff(5, i) === 0) exactByFlags[prm[4]] = (exactByFlags[prm[4]] ?? 0) + 1; });
		expect(natural).toBeGreaterThanOrEqual(540);
		// flags 0xF1, 0xF4, 0xFD: 192 glyphs each (measured exact after the round-10 phantom-point merge: 148, 59 and 70)
		expect(exactByFlags[244]).toBeGreaterThanOrEqual(148);
		expect(exactByFlags[253]).toBeGreaterThanOrEqual(70);
		expect(exactByFlags[241]).toBeGreaterThanOrEqual(59);
	});
});
