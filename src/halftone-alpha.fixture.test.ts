import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { colorAdjustRgb, DEFAULT_COLOR_ADJUSTMENT, splitColorAdjustment } from './emf-gdi-color-adjust';
import { ditherStartX, ditherStartY } from './emf-gdi-halftone-dither';
import { stretchHalftone } from './emf-gdi-stretch';
import { ALPHA_PLANS, alphaCases, alphaSource } from './halftone-alpha.fixture-helper';

/**
 * What HALFTONE `StretchBlt` / `StretchDIBits` do with the alpha byte of a 32-bit source (`generate-halftone-alpha.ts`): with the
 * destination pre-filled with alpha 0x55, every HALFTONE stretch (replicated, filtered, reduced, same size, with and without a
 * colour adjustment, either API) ends with destination alpha 0, so alpha is neither filtered nor replicated nor kept: it is
 * dropped. The colours never depend on the source alpha. COLORONCOLOR, for contrast, copies the alpha of the nearest source
 * pixel. The converter ignores source alpha and writes opaque pixels, as the opaque reference PNGs of the playback captures show.
 */
interface Result { id: string; plan: string; distinctAlpha: number; alphas: number[]; nearestAlpha: number; rgbSha256: string }
const capture: { prefill: number[]; plans: string[]; results: Result[] } = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-alpha.json.gz', import.meta.url))).toString());
const cases = alphaCases();

function converterRgb(c: (typeof cases)[number], plan: (typeof ALPHA_PLANS)[number]): { rgb: Buffer; alpha: Set<number> } {
	const bgra = alphaSource(c, plan);
	const rgba = new Uint8ClampedArray(c.bw * c.bh * 4);
	for (let i = 0; i < c.bw * c.bh; i++) { rgba[i * 4] = bgra[i * 4 + 2]; rgba[i * 4 + 1] = bgra[i * 4 + 1]; rgba[i * 4 + 2] = bgra[i * 4]; rgba[i * 4 + 3] = bgra[i * 4 + 3]; }
	const mode = (c.flags >> 4) & 7;
	const split = mode ? splitColorAdjustment({ ...DEFAULT_COLOR_ADJUSTMENT, colorfulness: 40 }) : undefined;
	const out = stretchHalftone({ width: c.bw, height: c.bh, data: rgba }, 0, 0, c.bw, c.bh, c.dw, c.dh,
		split?.palette ? v => colorAdjustRgb(v, split.palette) : undefined, false, false,
		split?.palette ? { startX: ditherStartX(0, 0), startY: ditherStartY(0, 0) } : undefined).data;
	const rgb = Buffer.alloc(c.dw * c.dh * 3);
	const alpha = new Set<number>();
	for (let i = 0; i < c.dw * c.dh; i++) { rgb.set([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]], i * 3); alpha.add(out[i * 4 + 3]); }
	return { rgb, alpha };
}

describe('native HALFTONE stretches of a 32-bit source with alpha', () => {
	const byCase = new Map<string, Result[]>();
	for (const r of capture.results) byCase.set(r.id, [...(byCase.get(r.id) ?? []), r]);

	it('holds every case under four alpha plans', () => {
		expect(capture.prefill).toEqual([0x20, 0x7f, 0x40, 0x55]);
		expect(capture.results).toHaveLength(cases.length * ALPHA_PLANS.length);
		expect(cases).toHaveLength(20);
	});

	it('writes destination alpha 0 on every HALFTONE branch and API, whatever the source alpha', () => {
		for (const c of cases.filter(x => !(x.flags & 2))) {
			for (const r of byCase.get(c.id)!) expect({ id: c.id, plan: r.plan, alphas: r.alphas }).toEqual({ id: c.id, plan: r.plan, alphas: [0] });
		}
	});

	it('never lets the source alpha change the colours', () => {
		for (const c of cases) {
			const runs = byCase.get(c.id)!;
			expect(new Set(runs.map(r => r.rgbSha256)).size, c.id).toBe(1);
		}
	});

	it('copies the nearest source alpha under COLORONCOLOR instead', () => {
		for (const c of cases.filter(x => x.flags & 2)) {
			const random = byCase.get(c.id)!.find(r => r.plan === 'random')!;
			expect(random.nearestAlpha, c.id).toBe(c.dw * c.dh);
			expect(random.distinctAlpha, c.id).toBeGreaterThan(50);
			for (const plan of ['255', '0', '128']) expect(byCase.get(c.id)!.find(r => r.plan === plan)!.alphas, `${c.id} ${plan}`).toEqual([Number(plan)]);
		}
	});

	it('is reproduced by the converter: the native colours, opaque output, source alpha ignored', () => {
		let exact = 0;
		const inexact: string[] = [];
		for (const c of cases.filter(x => !(x.flags & 2))) {
			const native = byCase.get(c.id)![0].rgbSha256;
			const { rgb, alpha } = converterRgb(c, '255');
			expect([...alpha], c.id).toEqual([255]);
			const other = converterRgb(c, 'random');
			expect(other.rgb.equals(rgb), c.id).toBe(true);
			if (createHash('sha256').update(rgb).digest('hex') === native) exact++; else inexact.push(c.id);
		}
		expect({ exact, inexact }).toEqual({ exact: 16, inexact: [] });
	});
});
