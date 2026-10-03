import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

interface Capture { points: [number, number][]; center: [number, number]; focus: [number, number]; bgra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-vertical-focus-line.json.gz', import.meta.url))).toString());
// Residuals away from the collapsed line retain individual ceilings.
const residuals: Record<number, [number, number]> = { 2: [1, 12], 5: [1, 12], 8: [1, 12], 10: [1, 9], 11: [2, 91], 13: [1, 9], 14: [2, 91], 16: [1, 9], 17: [2, 91], 71: [1, 139] };

it('preserves coloured vertical focus lines at three scales and every triangle order', () => {
	expect(captures).toHaveLength(108);
	for (const [i, c] of captures.entries()) {
		const sampler = pathGradientSampler({
			boundary: c.points.map(([x, y]) => ({ x, y })),
			center: { x: c.center[0], y: c.center[1] }, focus: { x: c.focus[0], y: c.focus[1] },
			centerArgb: 0xffc06020, boundaryArgb: [0xff2080c0, 0xff2080c0, 0xff2080c0],
			blend: null, preset: null, transform: null,
		}, 'clamp', [1, 0, 0, 1, 0, 0])!;
		const rgba = new Uint8ClampedArray(100 * 80 * 4);
		sampler(0, 0, 100, 80, rgba);
		const native = Buffer.from(c.bgra, 'base64');
		let differing = 0, maximum = 0;
		for (let p = 0; p < 100 * 80; p++) {
			let difference = 0;
			for (let channel = 0; channel < 3; channel++) {
				const actual = rgba[p * 4 + 3] ? rgba[p * 4 + channel] : 255;
				difference = Math.max(difference, Math.abs(actual - native[p * 4 + 2 - channel]));
			}
			if (p % 100 === c.center[0]) {
				expect(difference, `capture ${i}, focus row ${Math.floor(p / 100)}`).toBeLessThanOrEqual(1);
			}
			if (difference > 1) differing++;
			maximum = Math.max(maximum, difference);
		}
		const [count, max] = residuals[i] ?? [0, 1];
		expect(differing, `capture ${i}`).toBeLessThanOrEqual(count);
		expect(maximum, `capture ${i}`).toBeLessThanOrEqual(max);
	}
});
