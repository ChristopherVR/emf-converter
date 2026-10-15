/**
 * The RoundRect corner under a scaling map is one function in every graphics mode (`compat-roundrect-modes-probe`,
 * `CompatPlaybackProbe.RoundRectModes`, `compat-roundrect-modes.json.gz`): the same 5,600 boxes per scale (10 left edges, extents of
 * 12 to 39 units, corner extents of 1 to 20) recorded in `GM_COMPATIBLE` under a map, in `GM_ADVANCED` under the same map and in
 * `GM_ADVANCED` under a float world scale on an identity map, played back, with native `GetPath` of each, for the x scales 4/3,
 * 11/10, 21/16 and 5/3. Native paths are identical across the three modes, so the half extent `round(hb * c / w)`
 * (`roundRectCorners`, see `emf-compat-roundrect-sweep.fixture.test.ts`) is not a compat-only rule, not a 28.4 conversion at the
 * map stage and not a separate rounding of the record to reference device scale.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';

interface Run {
	window: number;
	viewport: number;
	mode: number;
	/** [left, right, corner, eight end points x, y, point count] as recorded (a compat record's right is the call's less one). */
	records: number[][];
}

const runs: Run[] = JSON.parse(gunzipSync(readFileSync(fixturePath('compat-roundrect-modes.json.gz'))).toString());

describe('RoundRect corner extents across graphics modes', () => {
	it('holds 4 scales x 3 modes x 5,600 records', () => {
		expect(runs).toHaveLength(12);
		expect(runs.every((r) => r.records.length === 5600)).toBe(true);
	});

	it('gives identical native paths in GM_COMPATIBLE, GM_ADVANCED under a map and GM_ADVANCED under a world scale', () => {
		let differing = 0;
		for (let i = 0; i < runs.length; i += 3) {
			for (let k = 0; k < 5600; k++) {
				const [a, b, c] = [runs[i].records[k], runs[i + 1].records[k], runs[i + 2].records[k]];
				// The x coordinates of the eight end points and the point count (a compat record stores the call's bottom less one as well).
				const key = (r: number[]): string => [...r.slice(0, 3), ...r.slice(3, 19).filter((_, j) => j % 2 === 0), r[19]].join();
				if (key(a) !== key(b) || key(a) !== key(c)) differing++;
			}
		}
		expect(differing).toBe(0);
	});

	it('is round(hb * c / w) in single precision, hb the half of the rounded device extent rounded up', () => {
		let wrong = 0;
		for (const run of runs) {
			const s = run.viewport / run.window;
			for (const r of run.records) {
				const [l, right, c] = r;
				const w = right - l;
				const device = Math.floor(16 * right * s + 0.5) - Math.floor(16 * l * s + 0.5);
				const hb = Math.ceil(device / 2);
				const half = Math.floor(Math.fround(hb * Math.fround(Math.min(c, w) / w)) + 0.5);
				if (Math.abs(r[3] - r[5]) !== half) wrong++;
			}
		}
		expect(wrong).toBe(0);
	});
});
