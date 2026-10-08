import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

/**
 * Red-eye history dependence, one fresh Windows process per run (`generate.ps1 redeye-state`, `RedEyeStageProbe.RunSequence`):
 * 30 call sequences, each run in 6 separate processes, every call a whole-image area (R pure red, G grey, U uniform red-ish,
 * P two-valued checker field with a given luma spread, T pure red with one lighter pixel).
 *
 * - the first call of a process is exact against the converter in all 180 captures, so the converter reproduces what a fresh
 *   process does (a pure-red area gets strength 1/4);
 * - a call that follows a spread field of 16 x 16 or more can come back with a different strength (30, 61, 80, 91 levels of red
 *   removed at the middle pixel of a pure-red area), and for 7 sequences the same calls in different processes give different
 *   outputs, which only unreset memory explains. A stateless converter cannot reproduce them, so the item is closed as such.
 */
interface Step { token: string; width: number; height: number; source: string; output: string }
interface Record { spec: string; runs: Step[][] }
const records: Record[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/redeye-state.json.gz', import.meta.url))).toString());

const model = (step: Step) => applyRedEyeCorrection(
	new Uint8ClampedArray(Buffer.from(step.source, 'base64')),
	step.width,
	step.height,
	[{ left: 0, top: 0, right: step.width, bottom: step.height }],
);
const exact = (step: Step) => {
	const actual = model(step);
	const expected = Buffer.from(step.output, 'base64');
	for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) return false;
	return true;
};
/** Red removed from the middle pixel by the native call. */
const removed = (step: Step) => {
	const k = ((step.height >> 1) * step.width + (step.width >> 1)) * 4;
	return Buffer.from(step.source, 'base64')[k] - Buffer.from(step.output, 'base64')[k];
};

describe('native red-eye history dependence across processes', () => {
	it('captures 30 sequences in 6 fresh processes each', () => {
		expect(records).toHaveLength(30);
		for (const r of records) expect(r.runs, r.spec).toHaveLength(6);
	});
	it('reproduces every first call of a process exactly (180 of 180)', () => {
		let n = 0;
		let ok = 0;
		for (const r of records) for (const run of r.runs) { n++; if (exact(run[0])) ok++; }
		expect({ n, ok }).toEqual({ n: 180, ok: 180 });
	});
	it('reproduces calls after a grey, uniform or pure-red area exactly, and the pure-red strength of a fresh process (30, 26, 29, 32 for 24, 12, 20, 48)', () => {
		const fresh = (spec: string) => new Set(records.find((r) => r.spec === spec)!.runs.map((run) => removed(run[run.length - 1])));
		expect([...fresh('R24')]).toEqual([30]);
		expect([...fresh('R12')]).toEqual([26]);
		expect([...fresh('R20')]).toEqual([29]);
		expect([...fresh('R48')]).toEqual([32]);
		expect([...fresh('G24;R24')]).toEqual([30]);
		expect([...fresh('R24;R24;R24')]).toEqual([30]);
	});
	it('gives 282 of 360 calls exactly; the 78 others all come after a two-valued field of 16 x 16 or more in the same process', () => {
		let calls = 0;
		let ok = 0;
		const late = new Set<string>();
		for (const r of records) {
			for (const run of r.runs) {
				run.forEach((step, k) => {
					calls++;
					if (exact(step)) ok++;
					else late.add(`${r.spec}#${k}`);
				});
			}
		}
		expect({ calls, ok }).toEqual({ calls: 360, ok: 282 });
		for (const key of late) {
			const [spec, k] = key.split('#');
			const tokens = spec.split(';');
			expect(tokens.slice(0, Number(k)).join(';'), key).toMatch(/(^|;)P(16|20|24|48):/);
		}
	});
	it('gives different outputs for the same calls in different processes for 7 sequences', () => {
		const varying = records.filter((r) => new Set(r.runs.map((run) => run.map((s) => s.output).join('|'))).size > 1).map((r) => r.spec);
		expect(varying).toEqual([
			'P24:40:160;R24',
			'R24;P24:40:160;R24',
			'P24:40:160;R24;R24',
			'P24:40:160;U24;R24',
			'P24:40:90;R24',
			'P24:40:105;R24',
			'P24:40:160;P24:40:40;R24',
		]);
		// One sequence in detail: the last call removes 91 levels in five processes and 30 in one.
		const last = records.find((r) => r.spec === 'P24:40:160;R24')!.runs.map((run) => removed(run[1]));
		expect([...last].sort((a, b) => a - b)).toEqual([30, 91, 91, 91, 91, 91]);
	});
});
