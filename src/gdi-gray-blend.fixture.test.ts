import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { blendGrayChannel } from './gdi-gray-blend';
import { layoutGdiRun, type GdiTextRun } from './gdi-text-render';

/**
 * GDI grayscale text blend (`ANTIALIASED_QUALITY`) against a native capture (`gray-blend.json.gz`, probe
 * `scripts/gdi-fixtures/GrayBlendProbe.cs`): "Ag@a" in 40 px Arial drawn with `TextOut` / `ExtTextOut` onto a 32-bit
 * DIB section. The coverage level of every pixel (0 to 16) is its grey in the black-on-white sheet; the capture
 * holds, per coverage level, the output for grey text over grey backgrounds (every third grey, plus 255) in
 * TRANSPARENT and OPAQUE mode, and 80 random colour pairs in each of TRANSPARENT, OPAQUE and TRANSPARENT with an
 * `ETO_OPAQUE` rectangle (surface a different colour). A full 256 x 256 sweep of the same probe (`GRAY_GRID=full`)
 * fixed the model: transparent text is `d + floor((s - d) * a)` with `a` by coverage and by which of text and
 * backdrop is lighter in the channel; text drawn with a background fill goes through an 8-bit linear domain.
 */
interface Capture {
	width: number;
	height: number;
	coverage: string;
	values: number[];
	mixed: number;
	transparent: string;
	opaque: string;
	cases: Array<{ mode: number; fg: number[]; bg: number[]; rgb: string }>;
	sweeps: Array<{ face: string; height: number; italic: number; weight?: number; text: string; sweep: { cx: number; cy: number; configs: Array<{ edge: number; delta: number; opaque: number; transparent: number }> } }>;
}
const capture: Capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/gray-blend.json.gz', import.meta.url))).toString());
const coverage = Buffer.from(capture.coverage, 'base64');

describe('GDI grayscale text blend (native capture)', () => {
	it('captured one output per coverage level in every pairing', () => {
		expect(capture.mixed).toBe(0);
		const levels = new Set<number>(coverage);
		// Level 1 has the same grey as level 0 on white, so the sheet cannot tell them apart: the class of "0" is every
		// pixel that left the backdrop alone (checked below, in colour).
		for (const k of [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) expect(levels.has(k), `coverage ${k}`).toBe(true);
	});

	for (const [name, opaque] of [['transparent', false], ['opaque', true]] as const) {
		it(`reproduces every captured grey pair at coverage 2 to 15 (${name} text)`, () => {
			const table = Buffer.from(capture[name], 'base64');
			const n = capture.values.length;
			let bad = 0;
			let checked = 0;
			for (let si = 0; si < n; si++) {
				for (let di = 0; di < n; di++) {
					for (let k = 2; k <= 15; k++) {
						checked++;
						if (blendGrayChannel(capture.values[si], capture.values[di], k, opaque) !== table[(si * n + di) * 17 + k]) bad++;
					}
				}
			}
			expect(checked).toBe(n * n * 14);
			expect(bad).toBe(0);
		});

		it(`leaves coverage 0 and 1 on the backdrop and paints coverage 16 in the text colour (${name} text)`, () => {
			const table = Buffer.from(capture[name], 'base64');
			const n = capture.values.length;
			for (let si = 0; si < n; si++) {
				for (let di = 0; di < n; di++) {
					expect(blendGrayChannel(capture.values[si], capture.values[di], 0, opaque)).toBe(capture.values[di]);
					expect(blendGrayChannel(capture.values[si], capture.values[di], 1, opaque)).toBe(capture.values[di]);
					expect(blendGrayChannel(capture.values[si], capture.values[di], 16, opaque)).toBe(capture.values[si]);
					expect(table[(si * n + di) * 17 + 16]).toBe(capture.values[si]);
					expect(table[(si * n + di) * 17]).toBe(capture.values[di]);
				}
			}
		});
	}

	it('reproduces random colours per channel in every drawing mode', () => {
		const picked: number[] = [];
		coverage.forEach((k, i) => {
			if (k >= 2 && k <= 15) picked.push(i);
		});
		const bad: number[] = [0, 0, 0, 0, 0, 0];
		const total: number[] = [0, 0, 0, 0, 0, 0];
		const unchanged = [0, 0, 0, 0, 0, 0];
		for (const c of capture.cases) {
			const rgb = Buffer.from(c.rgb, 'base64');
			expect(rgb.length).toBe(picked.length * 3);
			// The surface under the text: the background colour, except where an ETO_OPAQUE or clipped drawing left a different one.
			const surface = c.mode === 2 || c.mode === 3 || c.mode === 5 ? c.fg.map((v) => v ^ 0x55) : c.bg;
			picked.forEach((pixel, j) => {
				const inside = pixel % capture.width < 60;
				for (let ch = 0; ch < 3; ch++) {
					const out = rgb[j * 3 + ch];
					// Modes: 0 TRANSPARENT; 1 OPAQUE; 2 ETO_OPAQUE over everything; 3 ETO_OPAQUE over the left half (smaller than the
					// text, so the rectangle is filled and the text blended TRANSPARENT over it, and over the surface beyond it);
					// 4 ETO_CLIPPED alone; 5 OPAQUE clipped to the left half (outside it nothing is drawn).
					let expected: number;
					if (c.mode === 5 && !inside) {
						expected = surface[ch];
						unchanged[c.mode]++;
					} else if (c.mode === 3 && !inside) {
						expected = blendGrayChannel(c.fg[ch], surface[ch], coverage[pixel], false);
					} else {
						const opaque = c.mode === 1 || c.mode === 2 || c.mode === 5;
						expected = blendGrayChannel(c.fg[ch], c.bg[ch], coverage[pixel], opaque);
					}
					total[c.mode]++;
					if (expected !== out) bad[c.mode]++;
				}
			});
		}
		expect(total.every((n) => n > 100_000)).toBe(true);
		expect(bad).toEqual([0, 0, 0, 0, 0, 0]);
		expect(unchanged[5]).toBeGreaterThan(50_000);
	});
});

describe.skipIf(!windowsFonts())('which ETO_OPAQUE rectangles take the opaque blend', () => {
	// Each rectangle edge swept across the text cell with the others far outside: the rectangle must reach the text cell
	// and every glyph bitmap (the first glyph's left bearing, the last glyph's overhang), measured per edge.
	const collection = new GdiFontCollection(windowsFonts()!);
	for (const s of capture.sweeps) {
		it(`${s.face} ${-s.height}px${s.italic ? ' italic' : ''} "${s.text}"`, () => {
			const font = collection.realize({ face: s.face, height: s.height, width: 0, weight: s.weight ?? 400, italic: !!s.italic, charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: false, gdiPlus: false }) as any;
			if (font.mode === 'mono') return;
			const run: GdiTextRun = { codes: [...s.text].map((ch: string) => ch.charCodeAt(0)), glyphIndices: false, x: 4, y: 4, dx: null, dy: null, textAlign: 0, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false };
			const lay = layoutGdiRun(font, run);
			const x0 = 4, y0 = 4;
			let l = x0, t = y0, r = x0 + Math.round(lay.total), b = y0 + font.ascent + font.descent;
			for (const g of lay.placed) {
				l = Math.min(l, g.x);
				t = Math.min(t, g.y);
				r = Math.max(r, g.x + g.bitmap.width);
				b = Math.max(b, g.y + g.bitmap.height);
			}
			const names = ['left', 'top', 'right', 'bottom'];
			const bounds: Record<string, number[]> = { left: [], top: [], right: [], bottom: [] };
			for (const c of s.sweep.configs) if (c.opaque > c.transparent) bounds[names[c.edge]].push(c.delta);
			// a measured edge needs the capture to contain pixels on both sides of the threshold (the sweep spans -4..4)
			const nativeLeft = Math.max(...bounds.left) + x0, nativeTop = Math.max(...bounds.top) + y0;
			const nativeRight = Math.min(...bounds.right) + x0 + s.sweep.cx, nativeBottom = Math.min(...bounds.bottom) + y0 + s.sweep.cy;
			if (Number.isFinite(nativeLeft)) expect(nativeLeft).toBe(l);
			if (Number.isFinite(nativeTop)) expect(nativeTop).toBe(t);
			if (Number.isFinite(nativeRight)) expect(nativeRight).toBe(r);
			if (Number.isFinite(nativeBottom)) expect(nativeBottom).toBe(b);
		});
	}
});
