import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection, type RealizedFont } from './gdi-font-engine';
import { fixturePath, windowsFonts } from './__fixtures__/gdi-parity-harness';

/**
 * `rotated-text-metrics.json.gz` (RotatedMetricsProbe.cs, `generate-rotated-metrics.ps1`, 16 October 2026): `GetTextMetrics` tmAscent /
 * tmDescent of Arial, Times New Roman, Tahoma, Courier New and Segoe UI at lfHeight -8 to -60 (265 sizes) and lfEscapement 0, 90, 180,
 * 270, 25, 45, 160 and 300 degrees (GM_ADVANCED). TA_TOP and TA_BOTTOM place rotated text by these. A rotated font has metrics of its
 * own, not the upright ones (VDMX): at a non-axis angle the head box padded by 1/64 em, at a quarter turn the win box padded the
 * same way, at a half turn the win box rounded (`RealizedFont.rotatedMetrics`).
 */
interface Entry { face: string; h: number; deg: number; asc: number; desc: number; height: number; il: number }
const entries: Entry[] = JSON.parse(gunzipSync(readFileSync(fixturePath('rotated-text-metrics.json.gz'))).toString());

describe('the capture', () => {
	it('holds 5 faces x 53 sizes x 8 angles', () => {
		expect(entries).toHaveLength(5 * 53 * 8);
	});
	it('shows that the quarter and half turns have metrics of their own', () => {
		const upright = new Map(entries.filter((e) => e.deg === 0).map((e) => [`${e.face}|${e.h}`, e]));
		let same90 = 0;
		let same180 = 0;
		for (const e of entries) {
			const u = upright.get(`${e.face}|${e.h}`)!;
			if (e.deg === 90 && e.asc === u.asc && e.desc === u.desc) same90++;
			if (e.deg === 180 && e.asc === u.asc && e.desc === u.desc) same180++;
		}
		expect(same90).toBeLessThan(120);
		expect(same180).toBeLessThan(120);
	});
});

describe.skipIf(!windowsFonts())('RealizedFont.rotatedMetrics', () => {
	const collection = new GdiFontCollection(windowsFonts() ?? [], 'mono');
	const matches = (deg: number): { ok: number; total: number } => {
		let ok = 0;
		let total = 0;
		for (const e of entries.filter((x) => x.deg === deg)) {
			const font = collection.realize({ face: e.face, height: e.h, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 }) as RealizedFont;
			const rad = (deg * Math.PI) / 180;
			const m = font.rotatedMetrics(Math.cos(rad), -Math.sin(rad));
			const asc = m ? m.ascent : font.ascent;
			const desc = m ? m.descent : font.descent;
			total++;
			if (asc === e.asc && desc === e.desc) ok++;
		}
		return { ok, total };
	};
	it('matches the upright tmAscent / tmDescent at 0 degrees (the hinted values)', () => {
		expect(matches(0)).toEqual({ ok: 265, total: 265 });
	});
	it('matches the quarter turns and the half turn', () => {
		expect(matches(90)).toEqual({ ok: 265, total: 265 });
		expect(matches(270)).toEqual({ ok: 265, total: 265 });
		expect(matches(180)).toEqual({ ok: 265, total: 265 });
	});
	it('matches the non-axis angles', () => {
		// 262 of 265 at 45 and 300 degrees: the pad moves by 0.005 em with the angle (the fitted 0.964 is the 25 and 160 degree value)
		const r = [25, 45, 160, 300].map((d) => matches(d).ok);
		expect(r).toEqual([265, 262, 265, 262]);
	});
});
