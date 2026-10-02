import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stretchHalftone } from './emf-gdi-stretch';

/**
 * Native HALFTONE StretchBlt captures of mixed-axis ratios
 * (`halftone-mixed-probe`, four patterns and four mirror modes each). Sizes
 * listed in EXACT match Windows byte for byte; the others differ by a few levels
 * (exact-tie checker patterns, odd-size edge columns) or are tiny single-row
 * buffers.
 */
interface Sample { sw: number; sh: number; dw: number; dh: number; pattern: number; mirror: number; input: string; output: string }

const samples: Sample[] = JSON.parse(
	gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-mixed-samples.json.gz', import.meta.url))).toString());

const EXACT = new Set(['16x12->11x18 p0', '16x12->11x18 p1', '16x12->11x18 p2', '16x12->11x18 p3', '16x12->24x18 p0', '16x12->24x18 p1', '16x12->24x18 p2', '16x12->24x18 p3', '16x12->24x8 p0', '16x12->24x8 p1', '16x12->24x8 p2', '16x12->24x8 p3', '16x12->32x24 p0', '16x12->32x24 p1', '16x12->32x24 p2', '16x12->32x24 p3', '16x12->32x6 p0', '16x12->32x6 p1', '16x12->32x6 p2', '16x12->32x6 p3', '16x12->43x4 p0', '16x12->43x4 p1', '16x12->43x4 p3', '16x12->5x32 p1', '16x12->5x32 p2', '16x12->5x32 p3', '16x12->8x24 p0', '16x12->8x24 p1', '16x12->8x24 p2', '16x12->8x24 p3', '17x13->12x20 p0', '17x13->12x20 p1', '17x13->12x20 p2', '17x13->12x20 p3', '17x13->26x20 p0', '17x13->26x20 p1', '17x13->26x20 p2', '17x13->26x20 p3', '17x13->26x9 p0', '17x13->26x9 p1', '17x13->26x9 p2', '17x13->26x9 p3', '17x13->34x26 p0', '17x13->34x26 p1', '17x13->34x26 p2', '17x13->34x26 p3', '17x13->34x6 p0', '17x13->34x6 p1', '17x13->34x6 p2', '17x13->34x6 p3', '17x13->46x4 p0', '17x13->46x4 p1', '17x13->46x4 p2', '17x13->46x4 p3', '17x13->6x35 p0', '17x13->6x35 p3', '17x13->8x26 p0', '17x13->8x26 p2', '17x13->8x26 p3', '3x2->1x5 p0', '3x2->1x5 p1', '3x2->1x5 p2', '3x2->1x5 p3', '3x2->2x3 p0', '3x2->2x3 p1', '3x2->2x3 p2', '3x2->2x3 p3', '3x2->2x4 p0', '3x2->2x4 p1', '3x2->2x4 p2', '3x2->2x4 p3', '3x2->4x1 p0', '3x2->4x1 p1', '3x2->4x1 p2', '3x2->4x1 p3', '3x2->4x3 p0', '3x2->4x3 p1', '3x2->4x3 p2', '3x2->4x3 p3', '3x2->6x1 p0', '3x2->6x1 p1', '3x2->6x1 p2', '3x2->6x1 p3', '3x2->6x4 p0', '3x2->6x4 p1', '3x2->6x4 p2', '3x2->6x4 p3', '3x2->8x1 p0', '3x2->8x1 p1', '3x2->8x1 p2', '3x2->8x1 p3']);

const render = (s: Sample): Buffer => {
	const bytes = Buffer.from(s.input, 'base64');
	const data = new Uint8ClampedArray(bytes.length);
	for (let i = 0; i < bytes.length; i += 4) data.set([bytes[i + 2], bytes[i + 1], bytes[i], 255], i);
	const out = stretchHalftone({ width: s.sw, height: s.sh, data }, 0, 0, s.sw, s.sh,
		s.mirror & 1 ? -s.dw : s.dw, s.mirror & 2 ? -s.dh : s.dh);
	const rgb = Buffer.alloc(s.dw * s.dh * 3);
	for (let i = 0; i < s.dw * s.dh; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = out.data[i * 4 + c];
	return rgb;
};

describe('native mixed-axis HALFTONE captures', () => {
	it('matches Windows exactly for the verified ratios', () => {
		let checked = 0;
		for (const s of samples) {
			if (!EXACT.has(`${s.sw}x${s.sh}->${s.dw}x${s.dh} p${s.pattern}`)) continue;
			checked++;
			expect(render(s).equals(Buffer.from(s.output, 'base64')), `${s.sw}x${s.sh}->${s.dw}x${s.dh} p${s.pattern} m${s.mirror}`).toBe(true);
		}
		expect(checked).toBeGreaterThan(200);
	});

	it('keeps the remaining approximate ratios within a fraction of a level on average', () => {
		let sum = 0;
		let count = 0;
		for (const s of samples) {
			const expected = Buffer.from(s.output, 'base64');
			const actual = render(s);
			for (let i = 0; i < expected.length; i++) sum += Math.abs(expected[i] - actual[i]);
			count += expected.length;
		}
		// 0.0125 measured across all 384 captures (0.228 before single-row destinations were
		// despeckled and collapsed to their last row, 0.285 before the area-resampling kernel).
		expect(sum / count).toBeLessThan(0.02);
	});
});
