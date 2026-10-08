import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resolvePpem } from './gdi-font-engine';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { parseFontFile, type TtfFont } from './ttf-font';
import { HintedSize } from './ttf-hinting';

/**
 * `text-stretch-hinting` (StretchHintingProbe.cs, 8 October 2026): which cell heights does the horizontal
 * world-transform stretch of a recorded GM_COMPATIBLE text record (eyScale / exScale, 1.000558 on a 3840 x 2160
 * display at 150%) change? For 18 faces and every signed lfHeight from 8 to 72 the probe stretches the DC by
 * 1 + k * 1e-4 (k = -40..40) and the recording's ratio, asks GetGlyphOutline(GGO_NATIVE) for 23 glyphs and records
 * whether any outline differs from the unstretched one. No rasterisation is involved, so the hit list is exactly
 * the set of heights whose grid-fitting reacts.
 *
 * Findings (all pinned below):
 * - A reaction is a switch from the grid-fitted outline to the unhinted one at the same ppem (the interpreter
 *   reproduces it, for Segoe UI, by reporting the glyph as stretched to GETINFO / SCANCTRL, which its `prep`
 *   answers with INSTCTRL: `reportStretched` in `HintEnvironment`). It is decided by the stretched x size
 *   `x = round(32 E (1 + s)) / 32`, where E is the exact em size (`h * unitsPerEm / (winAscent + winDescent)` for
 *   a cell height, `|h|` for an em height), against the unstretched `M0 = round(32 E)`: nothing changes while
 *   M = M0 (so a stretch below 1 / (64 E) is invisible whatever the face), and the faces then split in three:
 *   - "window": Segoe UI, Verdana, Lucida Console, Comic Sans MS react once |M / 32 - P| >= 15 / 16, P being the
 *     ppem GDI realises the height at (`resolvePpem`);
 *   - "integer": Calibri, Consolas, Candara, Corbel, Constantia react whenever M is not a multiple of 32;
 *   - others (Arial, Tahoma, Times New Roman, Courier New, ...) follow neither: their outlines change by the
 *     x scale alone.
 * - The engine keeps drawing the unstretched shapes: the reference PNGs of the old recordings are direct
 *   drawings, so reproducing the playback would make `textx-segoeui-cell-mono` inexact (989 pixels).
 */
interface Capture { glyphs: string; steps: number[]; faces: Array<{ face: string; heights: Record<string, string> }> }
const capture: Capture = JSON.parse(gunzipSync(readFileSync(fixturePath('text-stretch-hinting.json.gz'))).toString());
const face = (name: string) => capture.faces.find((f) => f.face === name)!;
const PLAYBACK = capture.steps.length - 1;
const reacting = (name: string, sign: number): number[] =>
	Object.entries(face(name).heights)
		.filter(([h, bits]) => Math.sign(Number(h)) === sign && bits[PLAYBACK] === '1')
		.map(([h]) => Math.abs(Number(h)))
		.sort((a, b) => a - b);

describe('which heights a playback stretch re-grid-fits (native outlines)', () => {
	it('is 18 faces x (65 cell heights, plus 65 em heights for four of them) x 82 stretches, the last the playback ratio', () => {
		expect(capture.faces).toHaveLength(18);
		expect(capture.steps).toHaveLength(82);
		expect(capture.steps[40]).toBe(1);
		expect(capture.steps[PLAYBACK]).toBeCloseTo(1.00055838, 8);
		expect(capture.faces.map((f) => Object.keys(f.heights).length)).toEqual([130, 130, 130, 130, 65, 65, 65, 65, 130, 65, 65, 65, 65, 65, 65, 65, 65, 65]);
	});
	it('re-grid-fits nine Segoe UI cell heights at the playback ratio, as the playback sheet does, and no em height', () => {
		expect(reacting('Segoe UI', 1)).toEqual([24, 35, 36, 39, 40, 56, 58, 59, 64]);
		expect(reacting('Segoe UI Light', 1)).toEqual([24, 35, 36, 39, 40, 56, 58, 59, 64]);
		expect(reacting('Segoe UI Semibold', 1)).toEqual([24, 35, 36, 39, 40, 56, 58, 59, 64, 65, 69]);
		for (const name of ['Segoe UI', 'Segoe UI Light', 'Segoe UI Semibold', 'Arial']) {
			expect(reacting(name, -1), name).toEqual([]);
			expect(Object.entries(face(name).heights).filter(([h, bits]) => Number(h) < 0 && bits.includes('1')), name).toEqual([]);
		}
	});
	it('re-grid-fits about half the cell heights of Calibri and its siblings, and the em heights from 28 px on', () => {
		expect(reacting('Calibri', 1)).toHaveLength(34);
		expect(reacting('Candara', 1)).toEqual(reacting('Calibri', 1));
		expect(reacting('Corbel', 1)).toEqual(reacting('Calibri', 1));
		expect(reacting('Constantia', 1)).toEqual(reacting('Calibri', 1));
		expect(reacting('Consolas', 1)).toHaveLength(38);
		expect(reacting('Calibri', -1)).toEqual(Array.from({ length: 45 }, (_, i) => 28 + i));
	});
	it('re-grid-fits no cell height of Tahoma or Courier New at the playback ratio, and one of Verdana (68) and of Comic Sans MS (70)', () => {
		expect(reacting('Tahoma', 1)).toEqual([]);
		expect(reacting('Courier New', 1)).toEqual([]);
		expect(reacting('Verdana', 1)).toEqual([68]);
		expect(reacting('Comic Sans MS', 1)).toEqual([70]);
		expect(reacting('Lucida Console', 1)).toEqual([34, 39]);
	});
	it('never changes a Segoe UI or Calibri outline at a stretch that rounds to the same 1/32 pixel size', () => {
		// The unstretched size is E (1 + 0): a first change needs |s| of at least 1 / (64 E) - checked on the capture for Segoe UI.
		for (const [h, bits] of Object.entries(face('Segoe UI').heights)) {
			if (Number(h) < 0) {
				continue;
			}
			expect(bits[40], h).toBe('0');
		}
	});
});

const fontDir = process.env.GDI_FIXTURE_FONTS ?? join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
const FILES: Record<string, string> = {
	'Segoe UI': 'segoeui.ttf', 'Segoe UI Semibold': 'seguisb.ttf', 'Segoe UI Light': 'segoeuil.ttf', Calibri: 'calibri.ttf', Consolas: 'consola.ttf',
	Candara: 'candara.ttf', Corbel: 'corbel.ttf', Constantia: 'constan.ttf', Verdana: 'verdana.ttf', 'Comic Sans MS': 'comic.ttf', 'Lucida Console': 'lucon.ttf',
};
const haveFonts = Object.values(FILES).every((f) => existsSync(join(fontDir, f)));
const loadFont = (name: string): TtfFont => parseFontFile(readFileSync(join(fontDir, FILES[name])))[0];

type Rule = 'window' | 'integer';
/** Whether the stretch `s` of an lfHeight `h` re-grid-fits it under a rule (see the file comment). */
function predictsReaction(rule: Rule, font: TtfFont, h: number, s: number): boolean {
	const cell = font.winAscent + font.winDescent;
	const E = h < 0 ? -h : (h * font.unitsPerEm) / cell;
	const P = h < 0 ? -h : resolvePpem(font, h);
	const M0 = Math.floor(E * 32 + 0.5);
	const M = Math.floor(E * 32 * s + 0.5);
	if (M === M0) {
		return false;
	}
	return rule === 'window' ? Math.abs(M / 32 - P) >= 15 / 16 : M % 32 !== 0;
}
function score(name: string, rule: Rule, only: 'enlarging' | 'em' | 'cell'): [number, number] {
	const font = loadFont(name);
	let ok = 0;
	let total = 0;
	for (const [hs, bits] of Object.entries(face(name).heights)) {
		const h = Number(hs);
		if ((only === 'em' && h > 0) || (only !== 'em' && h < 0)) {
			continue;
		}
		for (let k = 0; k < capture.steps.length; k++) {
			if (only === 'enlarging' && capture.steps[k] < 1) {
				continue;
			}
			total++;
			if (predictsReaction(rule, font, h, capture.steps[k]) === (bits[k] === '1')) {
				ok++;
			}
		}
	}
	return [ok, total];
}

describe.skipIf(!haveFonts)('the two reaction rules against the capture (needs the installed fonts the capture was made with)', () => {
	it('"window" predicts every Segoe UI outcome, cell and em heights, enlarging and shrinking', () => {
		expect(score('Segoe UI', 'window', 'cell')).toEqual([5330, 5330]);
		expect(score('Segoe UI', 'window', 'em')).toEqual([5330, 5330]);
		expect(score('Segoe UI', 'window', 'enlarging')).toEqual([2730, 2730]);
	});
	it('"window" predicts the Segoe UI Semibold, Light, Verdana, Comic Sans MS and Lucida Console outcomes to within 1-5%', () => {
		expect(score('Segoe UI Semibold', 'window', 'cell')).toEqual([5256, 5330]);
		expect(score('Segoe UI Light', 'window', 'cell')).toEqual([5259, 5330]);
		expect(score('Verdana', 'window', 'cell')).toEqual([5234, 5330]);
		expect(score('Comic Sans MS', 'window', 'cell')).toEqual([5171, 5330]);
		expect(score('Lucida Console', 'window', 'cell')).toEqual([4975, 5330]);
	});
	it('"integer" predicts every Calibri em-height outcome and all but 23 of its 5,330 cell-height outcomes (none when enlarging)', () => {
		expect(score('Calibri', 'integer', 'em')).toEqual([5330, 5330]);
		expect(score('Calibri', 'integer', 'cell')).toEqual([5307, 5330]);
		expect(score('Calibri', 'integer', 'enlarging')).toEqual([2730, 2730]);
		expect(score('Consolas', 'integer', 'enlarging')).toEqual([2729, 2730]);
	});
	it('"integer" predicts Consolas, Candara, Corbel and Constantia to within 35 of 5,330 (the misses are shrinking stretches and sizes below 8 ppem)', () => {
		expect(score('Consolas', 'integer', 'cell')).toEqual([5295, 5330]);
		expect(score('Candara', 'integer', 'cell')).toEqual([5311, 5330]);
		expect(score('Corbel', 'integer', 'cell')).toEqual([5304, 5330]);
		expect(score('Constantia', 'integer', 'cell')).toEqual([5322, 5330]);
	});
	it('each rule fails the other face class (the rules are not interchangeable)', () => {
		expect(score('Segoe UI', 'integer', 'cell')[0]).toBeLessThan(2500);
		expect(score('Calibri', 'window', 'cell')[0]).toBeLessThan(1100);
	});
});

interface NativeOutline { face: string; lfHeight: number; stretch: number; glyph: string; advance: number; words: number[] }
const outlines: NativeOutline[] = JSON.parse(readFileSync(fixturePath('text-stretch-outlines.json'), 'utf8'));

/** The points (26.6) of a GGO_NATIVE stream: per contour the start point and every curve point. */
function nativePoints(words: number[]): Array<[number, number]> {
	const points: Array<[number, number]> = [];
	for (let i = 0; i < words.length; ) {
		const end = i + words[i] / 4;
		points.push([words[i + 2] / 1024, words[i + 3] / 1024]);
		i += 4;
		while (i < end) {
			const n = (words[i] >>> 16) & 0xffff;
			i++;
			for (let k = 0; k < n; k++, i += 2) {
				points.push([words[i] / 1024, words[i + 1] / 1024]);
			}
		}
	}
	return points;
}

describe.skipIf(!haveFonts)('the interpreter reproduces the stretched Segoe UI outlines', () => {
	it('draws the unhinted outline exactly where the stretch re-grid-fits the height, and the hinted one where it does not', () => {
		const font = loadFont('Segoe UI');
		let reproduced = 0;
		let reacted = 0;
		for (const o of outlines) {
			const flagged = predictsReaction('window', font, o.lfHeight, o.stretch);
			const ppem = resolvePpem(font, o.lfHeight);
			const sized = new HintedSize(font, ppem, ppem, { version: 35, grayscale: false, reportStretched: flagged }, true);
			const g = sized.hintGlyph(font.glyphIndex(o.glyph.charCodeAt(0)));
			// Every native point is one of ours or the midpoint of two consecutive ones of a contour (implied on-curve points).
			const ours = new Set<string>();
			let start = 0;
			for (const end of g.endPts) {
				for (let i = start; i <= end; i++) {
					const j = i === end ? start : i + 1;
					ours.add(`${g.xs[i]},${g.ys[i]}`);
					ours.add(`${(g.xs[i] + g.xs[j]) / 2},${(g.ys[i] + g.ys[j]) / 2}`);
				}
				start = end + 1;
			}
			if (nativePoints(o.words).every(([x, y]) => ours.has(`${x},${y}`))) {
				reproduced++;
			}
			if (flagged) {
				reacted++;
			}
		}
		expect(outlines).toHaveLength(60);
		expect(reproduced).toBe(60);
		expect(reacted).toBe(24);
	});
	it('a height that reacts differs from its unstretched outline, one that does not equals it', () => {
		const same = (h: number, stretch: number) => {
			const a = outlines.filter((o) => o.lfHeight === h && o.stretch === 1).map((o) => o.words.join());
			const b = outlines.filter((o) => o.lfHeight === h && o.stretch === stretch).map((o) => o.words.join());
			return a.join('|') === b.join('|');
		};
		for (const h of [24, 40, 56]) {
			expect(same(h, 1.0002), String(h)).toBe(false);
		}
		for (const h of [25, 33]) {
			expect(same(h, 1.0002), String(h)).toBe(true);
			expect(same(h, 1.000558), String(h)).toBe(true);
		}
	});
});
