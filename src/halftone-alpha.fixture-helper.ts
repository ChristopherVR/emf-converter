/**
 * The cases behind `__fixtures__/gdi/halftone-alpha.json.gz` (`scripts/gdi-fixtures/generate-halftone-alpha.ts`): what
 * `StretchBlt` / `StretchDIBits` do with the alpha byte of a 32-bit source under HALFTONE (and, for contrast, COLORONCOLOR).
 * Sources are noise colours with one of four alpha plans; the destination is pre-filled with BGRA `20 7F 40 55` (probe flag
 * bit 7) so that a stretch which leaves destination alpha alone is visible.
 */
import { lcg } from './halftone-filtered.fixture-helper';

export interface AlphaCase {
	id: string;
	bw: number;
	bh: number;
	dw: number;
	dh: number;
	/** The probe's flags: bit 0 StretchDIBits, bit 1 COLORONCOLOR instead of HALFTONE, bits 4-6 colour adjustment (3: colorfulness +40). */
	flags: number;
}

/** Alpha plans of a source, in capture order. */
export const ALPHA_PLANS = ['255', '0', '128', 'random'] as const;

export function alphaCases(): AlphaCase[] {
	const cases: AlphaCase[] = [];
	for (const api of [0, 1]) {
		const t = api ? 'dib' : 'blt';
		cases.push(
			{ id: `replicated-16x16-32x32-${t}`, bw: 16, bh: 16, dw: 32, dh: 32, flags: api },
			{ id: `filtered-64x40-128x80-${t}`, bw: 64, bh: 40, dw: 128, dh: 80, flags: api },
			{ id: `filtered-64x40-96x60-${t}`, bw: 64, bh: 40, dw: 96, dh: 60, flags: api },
			{ id: `reduced-64x40-32x20-${t}`, bw: 64, bh: 40, dw: 32, dh: 20, flags: api },
			{ id: `reduced-64x40-50x40-${t}`, bw: 64, bh: 40, dw: 50, dh: 40, flags: api },
			{ id: `same-64x40-${t}`, bw: 64, bh: 40, dw: 64, dh: 40, flags: api },
			{ id: `replicated-16x16-32x32-ca3-${t}`, bw: 16, bh: 16, dw: 32, dh: 32, flags: api | (3 << 4) },
			{ id: `filtered-64x40-128x80-ca3-${t}`, bw: 64, bh: 40, dw: 128, dh: 80, flags: api | (3 << 4) },
			{ id: `coloroncolor-16x16-32x32-${t}`, bw: 16, bh: 16, dw: 32, dh: 32, flags: api | 2 },
			{ id: `coloroncolor-64x40-96x60-${t}`, bw: 64, bh: 40, dw: 96, dh: 60, flags: api | 2 },
		);
	}
	return cases;
}

/** BGRA bytes of a case's source for an alpha plan: the colours depend on the case only, so plans differ in alpha alone. */
export function alphaSource(c: AlphaCase, plan: (typeof ALPHA_PLANS)[number]): Uint8Array {
	const colours = lcg(c.bw * 31 + c.bh * 7 + c.dw);
	const alpha = lcg(c.dh * 131 + 5);
	const bgra = new Uint8Array(c.bw * c.bh * 4);
	for (let i = 0; i < c.bw * c.bh; i++) {
		bgra[i * 4] = Math.floor(colours() * 256);
		bgra[i * 4 + 1] = Math.floor(colours() * 256);
		bgra[i * 4 + 2] = Math.floor(colours() * 256);
		const a = Math.floor(alpha() * 256);
		bgra[i * 4 + 3] = plan === '255' ? 255 : plan === '0' ? 0 : plan === '128' ? 128 : a;
	}
	return bgra;
}
