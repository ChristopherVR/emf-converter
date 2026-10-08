import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection, RealizedFont, roundedRotationMatrix } from './gdi-font-engine';
import { fixturePath, windowsFonts } from './__fixtures__/gdi-parity-harness';
import { HintedSize } from './ttf-hinting';

/**
 * `text-rotated-matrix` (RotatedGlyphMatrixProbe.cs, 8 October 2026): native GetGlyphOutline of "Hoae" under a
 * world rotation, for Arial at 12 to 48 px and 10 to 80 degrees and Times New Roman, Tahoma and Segoe UI at
 * 16, 20 and 28 px at 25 and 60 degrees. The returned outline is the rotated glyph in 1/64 pixel. Fitting the
 * matrix that maps the font-unit outline onto it gives the scaling GDI applies: the larger of ppem * |cos| and
 * ppem * |sin| rounded to whole pixels and the whole rotation scaled by the rounded over the exact value (the earlier
 * model rounded both components, which put the smaller one up to 0.02 off: 0.400 where the native fit is 0.419 for
 * 20 px at 25 degrees). `rotate-text-25deg` falls from 31 pixels against the native playback to 1.
 */
interface Entry { face: string; lfHeight: number; degrees: number; glyph: string; advance: number; words: number[] }
const entries: Entry[] = JSON.parse(gunzipSync(readFileSync(fixturePath('rotated-glyph-matrix.json.gz'))).toString());

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

describe('the capture', () => {
	it('is 4 glyphs x (30 Arial + 18 other) face / size / angle combinations', () => {
		expect(entries).toHaveLength(4 * 48);
		expect(new Set(entries.map((e) => e.face))).toEqual(new Set(['Arial', 'Times New Roman', 'Tahoma', 'Segoe UI']));
	});
});

describe('roundedRotationMatrix', () => {
	it('rounds the larger component of a rotation to whole pixels and scales the rotation by the ratio', () => {
		const rad = (25 * Math.PI) / 180;
		const m = roundedRotationMatrix([Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad)], 20);
		expect(m[0]).toBeCloseTo(0.9, 12);
		expect(m[3]).toBeCloseTo(0.9, 12);
		expect(m[1]).toBeCloseTo(0.9 * Math.tan(rad), 12);
		expect(m[2]).toBeCloseTo(-m[1], 12);
		const r60 = (60 * Math.PI) / 180;
		const n = roundedRotationMatrix([Math.cos(r60), Math.sin(r60), -Math.sin(r60), Math.cos(r60)], 20);
		expect(n[1]).toBeCloseTo(0.85, 12);
		expect(n[0]).toBeCloseTo(0.85 / Math.tan(r60), 12);
	});
	it('keeps the component-wise rounding for other matrices', () => {
		expect(roundedRotationMatrix([1, 0.3, 0, 1], 10)).toEqual([1, 0.3, 0, 1]);
		expect(roundedRotationMatrix([0.96, 0.28, 0.28, 0.96], 10)).toEqual([1, 0.3, 0.3, 1]);
	});
});

describe.skipIf(!windowsFonts())('against the native outlines', () => {
	const collection = new GdiFontCollection(windowsFonts()!, 'cleartype');
	/** Least-squares matrix (per unit of ppem) mapping the font-unit outline onto the native one, and the exactly matched points. */
	function analyse(face: string, lfHeight: number, degrees: number) {
		const font = collection.realize({ face, height: lfHeight, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 }) as RealizedFont;
		const ppem = font.ppem;
		const rad = (degrees * Math.PI) / 180;
		const exact: [number, number, number, number] = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad)];
		const models: Record<string, [number, number, number, number]> = {
			rotation: roundedRotationMatrix(exact, ppem),
			components: [Math.round(exact[0] * ppem) / ppem, Math.round(exact[1] * ppem) / ppem, Math.round(exact[2] * ppem) / ppem, Math.round(exact[3] * ppem) / ppem],
		};
		const big = new HintedSize(font.ttf, 2048, 2048, { version: 35, grayscale: false }, false);
		const rotated = new HintedSize(font.ttf, ppem, ppem, { version: 35, grayscale: false, rotated: true }, true);
		const scale = ppem / 2048;
		const pairs: Array<[number, number, number, number]> = [];
		const hits: Record<string, number> = { rotation: 0, components: 0 };
		let points = 0;
		for (const e of entries.filter((x) => x.face === face && x.lfHeight === lfHeight && x.degrees === degrees)) {
			const gi = font.glyphIndex(e.glyph.charCodeAt(0));
			const g = big.hintGlyph(gi);
			const native = nativePoints(e.words);
			const predicted = [...Array(g.xs.length).keys()].map((i) => {
				const u = g.xs[i] / 64;
				const v = g.ys[i] / 64;
				return [u, v, (models.rotation[0] * u - models.rotation[2] * v) * scale * 64, -(models.rotation[1] * u - models.rotation[3] * v) * scale * 64];
			});
			for (const [nx, ny] of native) {
				let best = 1e9;
				let bp: number[] = [];
				for (const p of predicted) {
					const d = Math.hypot(p[2] - nx, p[3] - ny);
					if (d < best) {
						best = d;
						bp = p;
					}
				}
				if (best < 3) {
					pairs.push([bp[0], bp[1], nx, ny]);
				}
			}
			// Exact reproduction of the 26.6 points from the rotated, grid-fitted outline.
			const rg = rotated.hintGlyph(gi);
			const native2 = new Set(native.map(([x, y]) => `${x},${y}`));
			points += native2.size;
			for (const [name, m] of Object.entries(models)) {
				const ours = new Set<string>();
				for (let i = 0; i < rg.xs.length; i++) {
					ours.add(`${Math.round(m[0] * rg.xs[i] - m[2] * rg.ys[i])},${Math.round(-(m[1] * rg.xs[i] - m[3] * rg.ys[i]))}`);
				}
				for (const k of native2) {
					if (ours.has(k)) {
						hits[name]++;
					}
				}
			}
		}
		let sxx = 0, sxy = 0, syy = 0, sxnx = 0, synx = 0, sxny = 0, syny = 0;
		for (const [u, v, nx, ny] of pairs) {
			sxx += u * u; sxy += u * v; syy += v * v; sxnx += u * nx; synx += v * nx; sxny += u * ny; syny += v * ny;
		}
		const det = sxx * syy - sxy * sxy;
		const unit = scale * 64;
		const fit = [(sxnx * syy - synx * sxy) / det / unit, (sxny * syy - syny * sxy) / det / unit, (synx * sxx - sxnx * sxy) / det / unit, (syny * sxx - sxny * sxy) / det / unit];
		return { ppem, fit, model: models.rotation, components: models.components, hits, points };
	}
	const configs = [...new Map(entries.map((e) => [`${e.face}|${e.lfHeight}|${e.degrees}`, e])).values()];
	const unhintedConfigs = configs.filter((c) => c.face !== "Tahoma");

	it('fits the native scaling matrix to within 0.003 for all 42 Arial, Times New Roman and Segoe UI combinations', () => {
		let worst = 0;
		for (const c of unhintedConfigs) {
			const { fit, model } = analyse(c.face, c.lfHeight, c.degrees);
			for (let i = 0; i < 4; i++) {
				// fit order: a, b, c, d with b = sin, c = -sin: the native matrix is (a, -b?)
				worst = Math.max(worst, Math.abs(Math.abs(fit[i]) - Math.abs(model[i])));
			}
		}
		expect(worst).toBeLessThan(0.003);
	});
	it('reproduces more native points exactly than the component-wise rounding (and the component-wise model is off by up to 0.02)', () => {
		let rotation = 0;
		let components = 0;
		let points = 0;
		let worstComponents = 0;
		for (const c of unhintedConfigs) {
			const a = analyse(c.face, c.lfHeight, c.degrees);
			rotation += a.hits.rotation;
			components += a.hits.components;
			points += a.points;
			for (let i = 0; i < 4; i++) {
				worstComponents = Math.max(worstComponents, Math.abs(Math.abs(a.fit[i]) - Math.abs(a.components[i])));
			}
		}
		expect({ rotation, components, points }).toEqual({ rotation: 2539, components: 441, points: 5436 });
		expect(worstComponents).toBeGreaterThan(0.02);
		expect(rotation).toBeGreaterThan(components);
	});
	it('does not describe Tahoma, whose rotated outlines are not the unhinted ones: 8 of 810 native points', () => {
		let hits = 0;
		let points = 0;
		for (const c of configs.filter((x) => x.face === 'Tahoma')) {
			const a = analyse(c.face, c.lfHeight, c.degrees);
			hits += a.hits.rotation;
			points += a.points;
		}
		expect({ hits, points }).toEqual({ hits: 8, points: 810 });
	});
});
