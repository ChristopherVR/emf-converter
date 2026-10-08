import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * Native GDI+ glyph images are not a pure function of the font, the size and the hint: on 8 October 2026 the same
 * probe, on one machine with one OS build and one gdiplus.dll (SHA-256 recorded in the manifests), returned
 * different images in different runs, while repeating it within a run or in back-to-back runs gave identical
 * bytes. `text-native-states.json.gz` holds the 2,492 of 31,584 captures of `text-real-glyphs` that differ between
 * a run at 06:21 UTC (A) and the runs from 07:35 UTC on (B); `text-coverage-restate.json.gz` the 606 of 3,328
 * committed `text-coverage` captures (taken on 2 October, OS build 26200) that a fresh capture does not reproduce.
 *
 * The two projection arithmetics of the TrueType interpreter tell the states apart. The production interpreter
 * rounds the sum of the two products of a 26.6 distance and a 2.14 vector component (`combined`); GDI's own
 * outlines round each product on its own (`per-product`). In state B the per-product arithmetic reproduces about
 * twice as many of the differing images as the combined one, and state A reproduces with neither; in the committed
 * `text-coverage` captures the combined arithmetic is ahead. A stateless converter cannot match both, so the
 * per-product candidate (excluded because it loses 30 committed Arial 16 `y` captures) stays excluded.
 */
const json = (name: string): any => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
const perProduct = (x: number, y: number, vx: number, vy: number) => Math.floor((x * vx + 8192) / 16384) + Math.floor((y * vy + 8192) / 16384);
const available = new Set(['Arial', 'Times New Roman', 'Segoe UI', 'Tahoma', 'Courier New']);

describe('call-level first divergences of the projection arithmetic (state B)', () => {
	// For each glyph of text-real-glyphs whose image tells the two arithmetics apart, every call of the projection
	// primitives where per-product and combined rounding differ, with the arithmetic the native image requires when
	// it is determined (all assignments reproducing the image agree). Fonts: Arial, Times New Roman, Segoe UI,
	// Tahoma, Verdana, Georgia, Calibri, Courier New, Comic Sans MS, Consolas, 9 to 24 ppem.
	it('2,149 determined calls: 2,125 need per-product rounding, 24 combined (state A: 1,013 and 78 of 1,091)', () => {
		const dump = json('hinting-divergence.json.gz');
		const determined = dump.rows.filter((r: any) => r.verdict !== 'either');
		expect(dump.rows).toHaveLength(5039);
		expect(determined).toHaveLength(2149);
		expect(determined.filter((r: any) => r.verdict === 'pp')).toHaveLength(2125);
		expect(determined.filter((r: any) => r.verdict === 'comb')).toHaveLength(24);
		for (const r of dump.rows.slice(0, 200)) expect(r.pp).toBe(perProduct(r.dx, r.dy, r.vx, r.vy));
	});
});

describe.skipIf(!windowsFonts())('native glyph output differs between runs on one machine', () => {
	const fonts = { combined: new GdiFontCollection(windowsFonts()!), perProduct: new GdiFontCollection(windowsFonts()!) };
	function render(kind: 'combined' | 'perProduct', c: any, side: number, x: number, y: number, scale: number, contrast: number): Uint8Array {
		const font = fonts[kind].realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400, italic: !!(c.style & 2), charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: c.hint === 4, ignoreGasp: c.hint === 4, gdiPlus: true })!;
		const hinted = (font as any).hinted;
		if (kind === 'perProduct' && !hinted.__perProduct) {
			hinted.__perProduct = true;
			hinted.project = (dx: number, dy: number) => perProduct(dx, dy, hinted.gs.pvx, hinted.gs.pvy);
			hinted.dualProject = (dx: number, dy: number) => perProduct(dx, dy, hinted.gs.dvx, hinted.gs.dvy);
		}
		const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: x + (c.qx ?? 0) / scale, y: y + (c.qy ?? 0) / scale, dx: null, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
		applyTextContrast(mask.data, textGamma(contrast));
		const image = new Uint8Array(side * side).fill(255);
		for (let row = 0; row < mask.height; row++) for (let col = 0; col < mask.width; col++) {
			const yy = row + mask.y, xx = col + mask.x;
			if (yy >= 0 && yy < side && xx >= 0 && xx < side) image[yy * side + xx] = 255 - mask.data[row * mask.width + col];
		}
		return image;
	}

	it('text-real-glyphs: 2,492 of 31,584 captures differ between the 06:21 and 07:35 UTC runs; per-product matches 1,541 of the later images, combined 775, and the earlier run matches combined 57 times and per-product never', () => {
		const states = json('text-native-states.json.gz');
		expect(states.total).toBe(31584);
		expect(states.differing).toHaveLength(2492);
		expect(states.states.map((s: any) => s.label)).toEqual(['A-0621Z', 'B-0735Z']);
		expect(new Set(states.states.map((s: any) => s.gdiplus)).size).toBe(1);
		// The shipped text-real-glyphs.json.gz is the later state.
		const later = json('text-real-glyphs.json.gz');
		for (const d of states.differing.slice(0, 50)) {
			const c = later.find((l: any) => l.face === d.face && l.style === d.style && l.size === d.size && l.hint === d.hint && l.code === d.code);
			expect(c.gray).toBe(d.images[1]);
		}
		const matches: Record<string, number> = {};
		for (const d of states.differing.filter((d: any) => available.has(d.face))) {
			for (const kind of ['combined', 'perProduct'] as const) {
				const mine = Buffer.from(render(kind, d, 40, 6, 28, 4, 0));
				d.images.forEach((image: string, s: number) => {
					if (mine.equals(Buffer.from(image, 'base64'))) matches[`${kind} ${states.states[s].label}`] = (matches[`${kind} ${states.states[s].label}`] ?? 0) + 1;
				});
			}
		}
		expect(matches).toEqual({ 'combined A-0621Z': 57, 'combined B-0735Z': 775, 'perProduct B-0735Z': 1541 });
	});

	it('text-coverage: 606 of 3,328 committed captures differ from a fresh capture; per-product matches 350 of the fresh images, combined 128, and the committed ones 64 and 94', () => {
		const restate = json('text-coverage-restate.json.gz');
		expect(restate.total).toBe(3328);
		expect(restate.differing).toHaveLength(606);
		expect(restate.committed.os).toBe('Microsoft Windows NT 10.0.26200.0');
		expect(restate.fresh.os).toBe('Microsoft Windows NT 10.0.26300.0');
		expect(restate.committed.gdiplus).toBe(restate.fresh.gdiplus);
		const matches: Record<string, number> = {};
		for (const d of restate.differing.filter((d: any) => available.has(d.face))) {
			for (const kind of ['combined', 'perProduct'] as const) {
				const mine = Buffer.from(render(kind, d, 64, 8, 48, 4, d.contrast));
				for (const which of ['committed', 'fresh'] as const) if (mine.equals(Buffer.from(d[which], 'base64'))) matches[`${kind} ${which}`] = (matches[`${kind} ${which}`] ?? 0) + 1;
			}
		}
		expect(matches).toEqual({ 'combined committed': 94, 'perProduct committed': 64, 'combined fresh': 128, 'perProduct fresh': 350 });
	});
});
