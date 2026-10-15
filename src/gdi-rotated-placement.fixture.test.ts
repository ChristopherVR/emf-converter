import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection, type RealizedFont } from './gdi-font-engine';
import { layoutGdiRun } from './gdi-text-render';
import { diffImages, fixturePath, hasPlaybackReference, loadReference, windowsFonts } from './__fixtures__/gdi-parity-harness';

/**
 * `text-rotated-placement` (TextRotatedPlacementProbe.cs, 15 October 2026): non-antialiased text drawn natively at 14 angles
 * (esc and world rotation) in Arial and Times New Roman, one TextOutW per prefix of "Escape 120 Hgq" so that every glyph's
 * ink is attributed to its native device origin. `rotated-placement.json.gz` draws with TextOut (GDI lays the glyphs out
 * from the unrounded linear advances); `rotated-placement-dx.json.gz` with ExtTextOut and the character widths as Dx, which is
 * what a played-back metafile does. Every glyph is shape-matched against the converter's bitmap at shifts of up to 3 pixels:
 * "placement" = a different shift reproduces it exactly, "raster" = no shift does (the rotated glyph's own pixels differ).
 */
interface Entry { face: string; lfHeight: number; degrees: number; mode: string; align: number; x: number; y: number; text: string; widths: number[]; pixels: number[] }
const load = (name: string): Entry[] => JSON.parse(gunzipSync(readFileSync(fixturePath(name))).toString());

describe.skipIf(!windowsFonts())('rotated glyph placement against native TextOut / ExtTextOut', () => {
	const collection = new GdiFontCollection(windowsFonts() ?? [], 'cleartype');
	function classify(entries: Entry[], useDx: boolean): { glyphs: number; exact: number; placement: number; raster: number } {
		const key = (x: number, y: number): number => y * 1000 + x;
		const out = { glyphs: 0, exact: 0, placement: 0, raster: 0 };
		for (const e of entries) {
			if (e.degrees === 0) continue;
			const font = collection.realize({ face: e.face, height: e.lfHeight, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 }) as RealizedFont;
			const t = (e.degrees * Math.PI) / 180;
			const frame: [number, number, number, number] = [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
			const codes = [...e.text].map((c) => c.codePointAt(0)!);
			const layout = layoutGdiRun(font, {
				codes, glyphIndices: false, x: e.x, y: e.y, dx: useDx ? e.widths : null, dy: null, textAlign: e.align, textColor: '#000000', bkColor: '#ffffff',
				bkMode: 1, options: 0, rect: null, matrix: frame, underline: false, strikeOut: false,
			});
			const native: Array<Set<number>> = codes.map(() => new Set());
			for (let p = 0; p < e.pixels.length; p += 3) native[e.pixels[p + 2]].add(key(e.pixels[p], e.pixels[p + 1]));
			const claimed = new Set<number>();
			for (let i = 0; i < codes.length; i++) {
				const o = layout.origins[i];
				const g = font.glyph(layout.glyphs[i], frame, 0, 0);
				const mine = new Set<number>();
				if (g.bitmap) {
					for (let y = 0; y < g.bitmap.height; y++) {
						for (let x = 0; x < g.bitmap.width; x++) {
							if (g.bitmap.data[y * g.bitmap.width + x]) mine.add(key(Math.floor(o.x) + g.bitmap.left + x, Math.floor(o.y) + y - g.bitmap.top));
						}
					}
				}
				for (const k of [...mine]) if (claimed.has(k)) mine.delete(k);
				for (const k of mine) claimed.add(k);
				if (!mine.size && !native[i].size) { out.exact++; out.glyphs++; continue; }
				out.glyphs++;
				const distance = (dx: number, dy: number): number => {
					let inter = 0;
					for (const k of mine) if (native[i].has(k + dy * 1000 + dx)) inter++;
					return mine.size + native[i].size - 2 * inter;
				};
				if (distance(0, 0) === 0) { out.exact++; continue; }
				let shifted = false;
				for (let dy = -3; dy <= 3 && !shifted; dy++) for (let dx = -3; dx <= 3; dx++) if (distance(dx, dy) === 0) { shifted = true; break; }
				if (shifted) out.placement++; else out.raster++;
			}
		}
		return out;
	}

	it('places every glyph of a recorded (Dx) rotated run on its native origin', () => {
		const r = classify(load('rotated-placement-dx.json.gz'), true);
		expect(r.placement).toBe(0);
		expect(r.exact).toBeGreaterThanOrEqual(3320);
		expect(r.glyphs).toBe(4200);
	}, 120_000);

	it('places a directly drawn rotated run from unrounded linear advances (50 of 4,340 glyphs off by a pixel, 2,100 before)', () => {
		const r = classify(load('rotated-placement.json.gz'), false);
		expect(r.placement).toBeLessThanOrEqual(50);
		expect(r.exact).toBeGreaterThanOrEqual(3262);
	}, 120_000);
});

describe('native playback references (playback-references.json)', () => {
	// name -> pixels where the directly drawn original differs from the native playback of the same recording
	const originalVsPlayback: Record<string, number> = {
		'textx-escapement-mono': 359, 'textx-escapement-aa': 359, 'textx-world-mono': 285, 'textx-world-aa': 362,
		'textx-rotalign-esc': 1454, 'textx-rotalign-esc-small': 581, 'textx-rotalign-world': 1354, 'textx-eto-mono': 377, 'textx-eto-aa': 377,
		'rotate-text-25deg': 23,
	};
	it('are loaded for exactly the recordings whose playback is not their direct drawing', () => {
		for (const name of Object.keys(originalVsPlayback)) expect(hasPlaybackReference(name), name).toBe(true);
		expect(hasPlaybackReference('textx-arial-aa')).toBe(false);
	});
	it('differ from the original PNG by the pinned pixel counts', async () => {
		for (const [name, expected] of Object.entries(originalVsPlayback)) {
			const d = diffImages(await loadReference(name, true), await loadReference(name), 0, 0);
			expect(d.mismatched, name).toBe(expected);
		}
	}, 60_000);
});
