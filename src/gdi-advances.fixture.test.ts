/**
 * Native integer advance widths (`gdi-advances.json.gz`, `GdiAdvanceProbe.cs`; `advance-font-*.json.gz`, `AdvanceFontProbe.cs`):
 * the width an EMF records as Dx and a WMF replays without. GetCharWidth32 and GGO_METRICS agree on every character.
 *
 * Findings pinned here:
 *  - A font with `head.flags` bit 4 clear (`linear`) advances by `round(advance * ppem / upem)`, exactly, in every one of
 *    the 399,000 cases of the program-free font; with the bit set (`hinted`, `program`) the scaled advance is first rounded to
 *    26.6 and then to a pixel (so 44.4922 is 45), with or without a glyph program.
 *  - A real font's `LTSH` table makes a glyph advance linearly from its yPels on: Times New Roman A is hinted up to 68 px and
 *    `round(linear)` from 69, an `hdmx` record for the size coming first. Before this rule 4,731 of 239,680 widths of the
 *    five faces differed, 587 of 101,650 printable ASCII ones; now none of the ASCII or Latin-1 ones does (U+007F of Segoe UI
 *    and Tahoma, a control character, excepted).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';

const load = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());

describe('native advance widths of program-free fonts', () => {
	const sample = (r: { height: number }): boolean => -r.height % 3 === 0;
	for (const kind of ['linear', 'hinted', 'program'] as const) {
		it(`reproduces the ${kind} font's rounding at every sampled size`, () => {
			const collection = new GdiFontCollection([readFileSync(new URL(`./__fixtures__/gdi/parity-advance-${kind}.ttf`, import.meta.url))]);
			const title = kind[0].toUpperCase() + kind.slice(1);
			let compared = 0;
			for (const r of load(`advance-font-${kind}.json.gz`)) {
				if (!sample(r)) continue;
				const font: any = collection.realize({ face: `Parity Advance ${title}`, height: r.height, width: 0, weight: 400, italic: false, charSet: 1,
					pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false });
				for (let u = 1; u <= 2047; u += 1) {
					const gi = font.glyphIndex(0xE000 + u);
					if (font.advance(gi) !== r.adv[u - 1]) expect(font.advance(gi), `${kind} ${r.height} ${u}`).toBe(r.adv[u - 1]);
					compared++;
				}
			}
			expect(compared).toBeGreaterThan(100000);
		});
	}

	it('rounds a linear advance exactly and a hinted one through 26.6', () => {
		const linear = load('advance-font-linear.json.gz');
		const hinted = load('advance-font-hinted.json.gz');
		expect(linear).toHaveLength(195);
		for (let k = 0; k < linear.length; k++) {
			const ppem = -linear[k].height;
			for (let u = 1; u <= 2047; u++) {
				if (Math.floor((u * ppem) / 2048 + 0.5) !== linear[k].adv[u - 1]) expect(Math.floor((u * ppem) / 2048 + 0.5), `linear ${ppem} ${u}`).toBe(linear[k].adv[u - 1]);
				const scaled = Math.floor((u * ppem * 64) / 2048 + 0.5);
				if (Math.floor((scaled + 32) / 64) !== hinted[k].adv[u - 1]) expect(Math.floor((scaled + 32) / 64), `hinted ${ppem} ${u}`).toBe(hinted[k].adv[u - 1]);
			}
		}
	});
});

describe.skipIf(!windowsFonts())('native advance widths of the installed faces', () => {
	it('matches GetCharWidth32 for U+0020..U+00FF at 123 em and 91 cell heights, U+007F aside', () => {
		const collection = new GdiFontCollection(windowsFonts()!);
		const records = load('gdi-advances.json.gz');
		expect(records).toHaveLength(5 * 214);
		let compared = 0;
		for (const r of records) {
			expect(r.adv).toEqual(r.ggo);
			const font: any = collection.realize({ face: r.face, height: r.height, width: 0, weight: 400, italic: false, charSet: 1,
				pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false });
			for (let i = 0; i < r.adv.length; i++) {
				if (i === 0x5f && (r.face === 'Segoe UI' || r.face === 'Tahoma')) continue;
				const ours = font.advance(font.glyphIndex(0x20 + i));
				if (ours !== r.adv[i]) expect(ours, `${r.face} ${r.height} U+${(0x20 + i).toString(16)}`).toBe(r.adv[i]);
				compared++;
			}
		}
		expect(compared).toBeGreaterThan(239000);
	});
});
