import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { halftoneDespeckle } from './emf-gdi-stretch';

/**
 * Native HALFTONE 2x captures behind the despeckle's brightness weights and tie side
 * (`generate-halftone-despeckle-sweep.ts`): 6,400 isolated checker blocks and 500 checker-dense images.
 */
interface Capture {
	blocks: number[][];
	images: { w: number; h: number; input: string; output: string }[];
}
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-despeckle-sweep.json.gz', import.meta.url))).toString('utf8'));
const rgb = (hex: string): Int32Array => Int32Array.from(Buffer.from(hex, 'hex'));

describe('native despeckle brightness weights and ties', () => {
	it('pulls the top-left/bottom-right pair unless the other pair is strictly brighter under 4R + 8G + B', () => {
		let ties = 0;
		let wrong = 0;
		for (const [pr, pg, pb, qr, qg, qb, changed] of capture.blocks) {
			if (changed === 2) continue;
			const brighter = 4 * (pr - qr) + 8 * (pg - qg) + (pb - qb);
			if (brighter === 0) ties++;
			if ((brighter >= 0 ? 1 : 0) !== changed) wrong++;
		}
		expect(capture.blocks).toHaveLength(6400);
		expect(ties).toBe(3371);
		expect(wrong).toBe(0);
	});

	it('every weighting other than a multiple of (4, 8, 1) contradicts a capture', () => {
		const consistent: string[] = [];
		for (let r = 0; r <= 40; r++) for (let g = 0; g <= 80; g++) for (let b = 0; b <= 20; b++) {
			if (r + g + b === 0) continue;
			let ok = true;
			for (const [pr, pg, pb, qr, qg, qb, changed] of capture.blocks) {
				if (changed === 2) continue;
				if ((r * (pr - qr) + g * (pg - qg) + b * (pb - qb) >= 0 ? 1 : 0) !== changed) { ok = false; break; }
			}
			if (ok) consistent.push(`${r},${g},${b}`);
		}
		expect(consistent).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(k => `${4 * k},${8 * k},${k}`));
	});

	it('halftoneDespeckle reproduces all 500 checker-dense images exactly', () => {
		expect(capture.images).toHaveLength(500);
		for (const [i, c] of capture.images.entries()) {
			const px = rgb(c.input);
			halftoneDespeckle(px, c.w, c.h);
			expect([...px], `image ${i} ${c.w}x${c.h}`).toEqual([...rgb(c.output)]);
		}
	});
});
