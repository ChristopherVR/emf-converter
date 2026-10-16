import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { blendClearTypeChannel, clearTypeBlendTables } from './emf-plus-exact-fill';

/**
 * GDI+ ClearTypeGridFit text blend, isolated: `text-cleartype-blend-plus.json.gz`
 * (`scripts/gdi-fixtures/ClearTypeBlendPlusProbe.cs`, `generate-cleartype-blend-plus.ps1`) draws the same four strings
 * at the same positions over a flat background in 80 combinations of text colour, background colour and TextContrast
 * (0 to 12), directly onto a bitmap like the `gpx-*` and `textx-plus-*` references. Black on white at contrast 0 gives
 * every channel's coverage (255 minus the pixel); every other draw is then a pure function of the pixel's three
 * coverages, the text and background values and gamma = 1 + contrast / 10.
 *
 * Measured (16 October 2026): the blend is not a float gamma-space mix but 8-bit table arithmetic,
 *   lin[v] = round(255 * (v / 255)^gamma)
 *   mix    = lin[bg] + round((lin[fg] - lin[bg]) * k)           (k the exact coverage, see below)
 *   out    = round(255 * (mix / 255)^(1 / gamma))
 * A channel without coverage keeps the background, and a pixel with all three channels fully covered is the text
 * colour, but a fully covered channel of a partly covered pixel goes through the tables (30 comes back as 31 at
 * contrast 2). The coverage k is exact sixths: the filter's 42, 85, 127, 170 and 212 stand for 1/6 ... 5/6 (127 is one
 * half, not 127/255, worth a level in a third of the blends). The float mix the converter used before agreed with 72.8%
 * of the partially covered samples; this arithmetic with every pixel whose channels are all sixths bar 523 of
 * 1,843,600, which the native filter covers "fully but not quite" (the same pixels come back as the text colour in
 * some blends and as table round trips in others). The coverage levels between sixths (77, 113, 148, ...; the
 * converter's own 6 x 1 filter never produces them) are blended half-level truncated and agree for most pixels.
 */
const capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-cleartype-blend-plus.json.gz', import.meta.url))).toString());

describe('GDI+ ClearType blend arithmetic against native DrawString', () => {
	const width: number = capture.width;
	const height: number = capture.height;
	const cases = capture.cases.map((c: any) => ({ ...c, px: Buffer.from(c.rgb, 'base64') }));
	const reference = cases.find((c: any) => c.contrast === 0 && c.fg[0] === 0 && c.fg[1] === 0 && c.bg[0] === 255);
	const coverage = new Uint8Array(width * height * 3);
	for (let i = 0; i < coverage.length; i++) coverage[i] = 255 - reference.px[i];
	const sixths = new Set([0, 42, 85, 127, 170, 212, 255]);

	function score(select: (coverage: Uint8Array) => boolean): { exact: number; total: number } {
		let exact = 0;
		let total = 0;
		for (const c of cases) {
			const tables = clearTypeBlendTables(1 + c.contrast / 10);
			for (let p = 0; p < width * height; p++) {
				const cover = coverage.subarray(p * 3, p * 3 + 3);
				if (!select(cover)) continue;
				total++;
				const full = cover[0] === 255 && cover[1] === 255 && cover[2] === 255;
				let same = true;
				for (let ch = 0; ch < 3; ch++) {
					if (blendClearTypeChannel(tables, cover[ch], c.fg[ch], c.bg[ch], 1, full) !== c.px[p * 3 + ch]) same = false;
				}
				if (same) exact++;
			}
		}
		return { exact, total };
	}

	it("pixels whose channels are all sixths of coverage (the converter filter's own levels): all but 523 of 1,843,600", () => {
		expect(cases).toHaveLength(80);
		expect(score((cover) => cover.every((a) => sixths.has(a)))).toEqual({ exact: 1843077, total: 1843600 });
	});

	it('pixels with a coverage level between the sixths: 3,105 of 4,400', () => {
		expect(score((cover) => !cover.every((a) => sixths.has(a)))).toEqual({ exact: 3105, total: 4400 });
	});
});
