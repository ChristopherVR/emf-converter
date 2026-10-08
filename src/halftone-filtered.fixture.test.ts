import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { colorAdjustRgb, DEFAULT_COLOR_ADJUSTMENT, splitColorAdjustment } from './emf-gdi-color-adjust';
import { ditherStartX, ditherStartY } from './emf-gdi-halftone-dither';
import { halftoneBranch } from './emf-gdi-halftone-branch';
import { halftoneFilterEnlarge, stretchHalftone } from './emf-gdi-stretch';
import {
	PROFILE_LENGTH, filteredCases, filteredSource, profileSource,
} from './halftone-filtered.fixture-helper';

interface Capture {
	cases: { id: string; output: string }[];
	profiles: { axis: 'v' | 'h'; seed: number; scale: number; line: string }[];
}
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/halftone-filtered.json.gz', import.meta.url))).toString());
const cases = filteredCases();

// Residuals of the dithered (combined colour adjustment) cases: [pixels, channel values, largest error].
// Every other case is pinned exact. The remainder is the colour-adjustment residual the replicated branch
// has as well (the chroma stage, at most two levels) plus the mirrored vertical phase.
const dithered: Record<string, [number, number, number]> = {
	'dithered-2x-m3-f0': [50, 50, 2], 'dithered-2x-m3-f4': [50, 50, 2], 'dithered-2x-m3-f8': [81, 85, 2],
	'dithered-3x-m3-f0': [146, 149, 2], 'dithered-3x-m3-f8': [190, 194, 2],
	'dithered-2x-m4-f0': [49, 49, 2], 'dithered-2x-m4-f8': [80, 84, 2],
	'dithered-7x-m3-f0': [573, 573, 2],
	'dithered-160x100-m3-f0': [102, 102, 2], 'dithered-160x100-m3-f8': [134, 136, 2],
};

function run(c: (typeof cases)[number]): { pixels: number; values: number; maximum: number } {
	const rgb = filteredSource(c.kind, c.w, c.h);
	const source = new Uint8ClampedArray(c.w * c.h * 4);
	for (let i = 0; i < c.w * c.h; i++) {
		source[i * 4] = rgb[i * 3]; source[i * 4 + 1] = rgb[i * 3 + 1]; source[i * 4 + 2] = rgb[i * 3 + 2]; source[i * 4 + 3] = 255;
	}
	const mode = (c.flags >> 4) & 7;
	const gamma = mode === 4 ? 15000 : 10000;
	const split = mode ? splitColorAdjustment({ ...DEFAULT_COLOR_ADJUSTMENT, colorfulness: 40, redGamma: gamma, greenGamma: gamma, blueGamma: gamma }) : undefined;
	const actual = stretchHalftone({ width: c.w, height: c.h, data: source }, 0, 0, c.w, c.h,
		c.flags & 4 ? -c.dw : c.dw, c.flags & 8 ? -c.dh : c.dh,
		split?.palette ? v => colorAdjustRgb(v, split.palette) : undefined, false, false,
		split?.palette ? { startX: ditherStartX(0, 0), startY: ditherStartY(0, 0) } : undefined,
		split?.curves ? v => colorAdjustRgb(v, split.curves) : undefined).data;
	const expected = Buffer.from(capture.cases.find(x => x.id === c.id)!.output, 'base64');
	let pixels = 0, values = 0, maximum = 0;
	for (let i = 0; i < c.dw * c.dh; i++) {
		let bad = false;
		for (let k = 0; k < 3; k++) {
			const d = Math.abs(actual[i * 4 + k] - expected[i * 3 + k]);
			if (d) { values++; bad = true; maximum = Math.max(maximum, d); }
		}
		if (bad) pixels++;
	}
	return { pixels, values, maximum };
}

describe('native HALFTONE filtered enlargements', () => {
	it('retains the captured cases and their one-axis profiles', () => {
		expect(capture.cases).toHaveLength(cases.length);
		expect(cases).toHaveLength(48);
		expect(capture.profiles).toHaveLength(30);
		for (const c of cases) expect(halftoneBranch(Int32Array.from(filteredSource(c.kind, c.w, c.h)), c.w, c.h), c.id).toBe('filter');
	});

	it('reproduces whole-factor enlargements by 2 to 5, mixed whole factors and larger ratios exactly', () => {
		let exact = 0;
		for (const c of cases.filter(x => x.group === 'whole' || x.group === 'large')) {
			const { pixels } = run(c);
			expect(pixels, c.id).toBe(0);
			exact++;
		}
		expect(exact).toBe(16);
	});

	it('reproduces fractional ratios up to 5x on both axes by runs: the weights follow the length of the run of destination pixels a source pixel gets', () => {
		// 1.025x to 4.98x, 2x by 1.025x, and 2.5x mirrored on either axis: every one pixel-exact.
		const group = cases.filter(x => x.group === 'fractional');
		expect(group).toHaveLength(10);
		for (const c of group) expect(run(c).pixels, c.id).toBe(0);
	});

	it('reproduces an enlargement of one axis (the other keeps its size) by the 1-D sharpen and the kernel table', () => {
		let exact = 0;
		for (const c of cases.filter(x => x.group === 'oneaxis')) {
			const { values, maximum } = run(c);
			// 64 x 41 (a 1.025x axis) misses three values by one level: the kernel table is a share off there.
			if (c.id === 'oneaxis-64x41') {
				expect(values, c.id).toBeLessThanOrEqual(3);
				expect(maximum, c.id).toBeLessThanOrEqual(1);
			} else {
				expect(values, c.id).toBe(0);
				exact++;
			}
		}
		expect(exact).toBe(8);
	});

	it('reproduces mirrored blits as the mirror image of the unmirrored one', () => {
		for (const c of cases.filter(x => x.group === 'mirrored')) expect(run(c).pixels, c.id).toBe(0);
	});

	it('dithers and maps the source (and its extension rows) before filtering under a combined colour adjustment', () => {
		for (const c of cases.filter(x => x.group === 'dithered')) {
			const { pixels, values, maximum } = run(c);
			const [p, v, m] = dithered[c.id];
			expect(pixels, c.id).toBeLessThanOrEqual(p);
			expect(values, c.id).toBeLessThanOrEqual(v);
			expect(maximum, c.id).toBeLessThanOrEqual(m);
		}
	});

	it('reproduces the interpolation weights of every phase of every whole factor from 2 to 16 on both axes', () => {
		// One level per row (or column) of an otherwise constant image: the response of one axis alone,
		// so each phase is a rounded weighted sum of three sharpened levels with no second pass.
		for (const p of capture.profiles) {
			const source = profileSource(p.axis, p.seed);
			const out = halftoneFilterEnlarge(Int32Array.from(source.rgb), source.w, source.h, source.w * p.scale, source.h * p.scale);
			const line = Buffer.from(p.line, 'base64');
			const width = source.w * p.scale;
			let bad = 0;
			for (let t = 0; t < PROFILE_LENGTH * p.scale; t++) {
				for (let k = 0; k < 3; k++) {
					const at = p.axis === 'v' ? (t * width + 3) * 3 + k : (3 * width + t) * 3 + k;
					if (out[at] !== line[t * 3 + k]) bad++;
				}
			}
			expect(bad, `${p.axis} x${p.scale}`).toBe(0);
		}
	});
});
