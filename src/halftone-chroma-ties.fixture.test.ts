import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CHROMA_TIE_FLIPS } from './emf-gdi-chroma-tie-data';
import { colorAdjustmentMapper, DEFAULT_COLOR_ADJUSTMENT } from './emf-gdi-color-adjust';

/**
 * The entries of Windows' 32^3 halftone colour cubes where the native colorfulness / tint result differs by one level from the
 * u'v' formula (`generate-chroma-ties.ts`, capture `halftone-chroma-ties.json.gz` of 11 native cubes). The formula lands on
 * exact halves for the hue-preserving gamut normalisation of a colorfulness-only adjustment (255 * (c - lo) / (hi - lo)) and
 * within 5e-4 of a half elsewhere, and Windows breaks those ties by float noise of its own: whatever the sign of the double
 * error, the index ratio or the order of float32 operations, about half go each way (1,658 exact halves in four cubes, 52% up;
 * the float32 variants of the chroma stage tried leave 1,320 of the 1,331 misses of the nine first cubes).
 */
interface Capture { settings: { colorfulness: number; redGreenTint: number; sha256: string; misses: number; flips: number[] }[] }
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-chroma-ties.json.gz', import.meta.url))).toString());
const PALETTE = Array.from({ length: 32 }, (_, n) => Math.round((n * 255) / 31));

function misses(colorfulness: number, redGreenTint: number, chromaTies: boolean): number[] {
	const map = colorAdjustmentMapper({ ...DEFAULT_COLOR_ADJUSTMENT, colorfulness, redGreenTint }, { chromaTies });
	return map.length === 0 ? [] : [...Array(32768).keys()].map(i => map((PALETTE[i >> 10] << 16) | (PALETTE[(i >> 5) & 31] << 8) | PALETTE[i & 31]));
}

describe('native halftone chroma cubes', () => {
	it('holds the eleven captured settings, each as the module stores them', () => {
		expect(capture.settings.map(s => [s.colorfulness, s.redGreenTint])).toEqual([[40, 0], [40, 20], [50, 20], [-40, 0], [100, 0], [-100, 0], [20, 0], [70, 0], [0, 30], [0, -50], [0, 60]]);
		expect(capture.settings.map(s => s.misses)).toEqual([201, 60, 51, 47, 356, 16, 179, 282, 63, 59, 60]);
		for (const s of capture.settings) {
			expect(CHROMA_TIE_FLIPS[`${s.colorfulness},${s.redGreenTint}`], `${s.colorfulness},${s.redGreenTint}`).toEqual(s.flips);
			expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it('is off by exactly the stored flips without the corrections and agrees with them with', () => {
		for (const s of capture.settings) {
			const plain = misses(s.colorfulness, s.redGreenTint, false);
			const fixed = misses(s.colorfulness, s.redGreenTint, true);
			let differing = 0;
			for (let i = 0; i < 32768; i++) {
				for (let c = 0; c < 3; c++) {
					const shift = 16 - 8 * c;
					const d = ((fixed[i] >> shift) & 255) - ((plain[i] >> shift) & 255);
					if (d) differing++;
				}
			}
			expect(differing, `${s.colorfulness},${s.redGreenTint}`).toBe(s.misses);
			// Every flip moves the formula one level toward the native value, up or down as recorded.
			for (const f of s.flips) {
				const index = Math.floor(f / 2 / 3), channel = (f >> 1) % 3, shift = 16 - 8 * channel;
				expect(((fixed[index] >> shift) & 255) - ((plain[index] >> shift) & 255), `${s.colorfulness},${s.redGreenTint} entry ${f}`).toBe(f & 1 ? 1 : -1);
			}
		}
	});

	it('leaves settings that were not measured, and every other palette colour, on the formula', () => {
		const a = colorAdjustmentMapper({ ...DEFAULT_COLOR_ADJUSTMENT, colorfulness: 41 });
		const b = colorAdjustmentMapper({ ...DEFAULT_COLOR_ADJUSTMENT, colorfulness: 41 }, { chromaTies: false });
		for (let i = 0; i < 32768; i += 7) {
			const v = (PALETTE[i >> 10] << 16) | (PALETTE[(i >> 5) & 31] << 8) | PALETTE[i & 31];
			expect(a(v)).toBe(b(v));
		}
		// A colour that is not a palette entry is not corrected either.
		const c = colorAdjustmentMapper({ ...DEFAULT_COLOR_ADJUSTMENT, colorfulness: 40 });
		const d = colorAdjustmentMapper({ ...DEFAULT_COLOR_ADJUSTMENT, colorfulness: 40 }, { chromaTies: false });
		for (const v of [0x010203, 0x7f8081, 0xfeff00, 0x123456]) expect(c(v)).toBe(d(v));
	});
});
