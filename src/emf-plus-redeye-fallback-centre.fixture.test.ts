import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadReference } from './__fixtures__/gdi-parity-harness';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

/**
 * The red-eye residuals of the `plus-only-effect-redeye-*` fixtures (379, 59 and 3 pixels) were first put down to process state
 * (strength left by earlier calls of the same process). They are not:
 *
 * - `redeye-playback`: native playback of the recordings, each context a fresh Windows process with a different history in front
 *   of the call (none, the same recording again, the other recordings, the Dual twins, the generator's own order), is the committed
 *   reference in every context (0 differing pixels in all of them).
 * - `redeye-fixture-direct`: the effect applied through `GdipBitmapApplyEffect` to the generator's eyes image and ramps image in a
 *   fresh process is the playback reference too, so a stateless converter can match it, and now does.
 * - `redeye-fallback-centre`: the ramps image holds so much red far from the middle that the centroid is discarded; GDI+ then
 *   centres the correction on the centroid of the area's darkness `255 - luma` over every pixel, not on the middle. Pure red ramps
 *   at the top of grey and black fields (`B` tokens) read it out: the corrected disc follows the darkness weights.
 * - `redeye-scenes`: 36 held-out scenes (seeded smooth fields with red clusters), captured after the model was fixed.
 */
interface Step { token: string; width: number; height: number; source: string; output: string }
interface Record { spec: string; runs: Step[][] }
const gz = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString()) as Record[];

/** The areas of the fixtures: `w` whole image, `b` the two areas of the "both" fixture, `l` the left one. */
function areasOf(token: string, width: number, height: number) {
	const m = token.slice(1).split(':')[0];
	if (token[0] === 'K' || token[0] === 'Q') {
		return m === 'w' ? [[0, 0, width, height]] : m === 'b' ? [[12, 12, 36, 36], [60, 12, 84, 36]] : [[12, 12, 36, 36]];
	}
	return [[0, 0, width, height]];
}
function mismatched(step: Step): number {
	const actual = applyRedEyeCorrection(
		new Uint8ClampedArray(Buffer.from(step.source, 'base64')),
		step.width,
		step.height,
		areasOf(step.token, step.width, step.height).map(([left, top, right, bottom]) => ({ left, top, right, bottom })),
	);
	const expected = Buffer.from(step.output, 'base64');
	let pixels = 0;
	for (let i = 0; i < actual.length; i += 4) {
		if (actual[i] !== expected[i] || actual[i + 1] !== expected[i + 1] || actual[i + 2] !== expected[i + 2]) pixels++;
	}
	return pixels;
}
/** Per capture: the model's mismatched pixels, keyed by token, only where it is not exact. */
function inexactOf(records: Record[]): { n: number; inexact: Record<string, number> } {
	const inexact: Record<string, number> = {};
	let n = 0;
	for (const r of records) {
		for (const step of r.runs[0]) {
			n++;
			const pixels = mismatched(step);
			if (pixels) inexact[step.token] = pixels;
		}
	}
	return { n, inexact };
}

describe('native red-eye playback and the fixtures that carried the residuals', () => {
	it('plays the recordings back as the committed references in every fresh process, whatever came before (17 contexts, 0 differing pixels)', () => {
		const contexts = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/redeye-playback.json', import.meta.url), 'utf8')) as Array<{ context: string; playbacks: Array<{ fixture: string; differing: number }> }>;
		expect(contexts).toHaveLength(17);
		let playbacks = 0;
		for (const c of contexts) {
			expect(c.playbacks, c.context).toHaveLength(c.context.split(';').length);
			for (const p of c.playbacks) {
				playbacks++;
				expect(p.differing, `${c.context} -> ${p.fixture}`).toBe(0);
			}
		}
		expect(playbacks).toBe(32);
	});

	it('applies the effect to the generator images in a fresh process as the playback reference does, and the model equals it', async () => {
		const records = gz('redeye-fixture-direct');
		expect(records.map((r) => r.spec)).toEqual(['Ql;Kl', 'Qb;Kb', 'Qw;Kw', 'Qw', 'Kw']);
		const fixtureOf = (token: string) => `plus-only-effect-redeye-${{ w: 'whole', b: 'both', l: 'left' }[token.slice(1, 2) as 'w' | 'b' | 'l']}`;
		for (const r of records) {
			for (const step of r.runs[0]) {
				// The eyes image sits at (24, 16) and the ramps image at (24, 80) of the 304 x 160 reference.
				const ref = await loadReference(fixtureOf(step.token), true);
				const [ox, oy] = step.token[0] === 'Q' ? [24, 16] : [24, 80];
				const out = Buffer.from(step.output, 'base64');
				let differing = 0;
				for (let y = 0; y < step.height; y++) {
					for (let x = 0; x < step.width; x++) {
						const i = (y * step.width + x) * 4;
						const j = ((y + oy) * ref.width + x + ox) * 4;
						if (out[i] !== ref.data[j] || out[i + 1] !== ref.data[j + 1] || out[i + 2] !== ref.data[j + 2]) differing++;
					}
				}
				expect(differing, `${r.spec} ${step.token} against ${fixtureOf(step.token)}`).toBe(0);
				expect(mismatched(step), `${r.spec} ${step.token}`).toBe(0);
			}
		}
	});

	it('centres a far-off centroid on the darkness-weighted centroid of the area: the fixture ramps and black or grey fields with a red ramp', () => {
		const { n, inexact } = inexactOf(gz('redeye-fallback-centre'));
		expect(n).toBe(28);
		// Exact: the ramps image, grey fields of levels 10 to 150 and band heights 4 to 24, black fields of nine sizes.
		// Not reproduced: grey levels from 151 up (no correction at 128 x 128, another set at 256 x 64) and two rounding-sized
		// residuals (a 128 x 128 and a 160 x 160 black field, 4 and 1 pixels).
		expect(inexact).toEqual({
			'B128:128:0:16:-1:0:0:128:0:151': 814,
			'B128:128:0:16:-1:0:0:128:0:170': 787,
			'B128:128:0:16:-1:0:0:128:0:0': 4,
			'B160:160:0:20:-1:0:0:160:0:0': 1,
			'B256:64:0:8:-1:0:0:256:0:170': 207,
		});
	});

	it('is exact in 30 of 36 held-out scenes captured after the model was fixed (17 before the darkness-weighted centre and float32 arithmetic)', () => {
		const { n, inexact } = inexactOf(gz('redeye-scenes'));
		expect(n).toBe(36);
		expect(inexact).toEqual({ 'H57:48:2': 466, 'H91:64:6': 952, 'H56:79:22': 8, 'H47:66:31': 724, 'H84:70:32': 373, 'H44:78:34': 774 });
	});
});
