import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { escapementSinCos } from './emf-gdi-text-layout';
import { fixturePath } from './__fixtures__/gdi-parity-harness';

/**
 * `escapement-angles.json.gz` (`EscapementAngleProbe.cs`, `generate-escapement-angles.ps1`, 16 October 2026): native
 * `GetGlyphOutline(GGO_NATIVE)` of the private font `rotation-matrix-plain.ttf` (glyph E000 = (0,0), (30000,0), (0,30000)
 * font units of a 64-unit em, no `head.flags` bit 3) at 64 px, for `lfEscapement = lfOrientation` at every tenth of a degree
 * (3,600 angles) and, for comparison, under a GM_ADVANCED world rotation by the same angle. The two points are 30,000
 * pixels out, so the matrix shows to a relative 5e-7.
 *
 * The world rotation is exact to the 16.16 matrix (1.5e-5). The escapement is not: its length dips by up to 3.2e-4 (the
 * dips repeat every 2.8125 degrees, 128 times a turn) and returns to 1 at the multiples of 2.8125 degrees. That is the
 * chord of the circle between table angles: the matrix is the linear interpolation of the exact sine and cosine at 128
 * equal steps of a turn (`escapementSinCos`), which reproduces all 3,600 angles to 2e-5, where exact trigonometry is off
 * by 3.1e-4. Not documented by Microsoft (`LOGFONT` only says "tenths of a degree"); measured here.
 */
interface Row { tenths: number; mode: 'escapement' | 'world'; points: number[][] }
const rows: Row[] = JSON.parse(gunzipSync(readFileSync(fixturePath('escapement-angles.json.gz'))).toString());
const SCALE = 30000 * 64;
const escapement = rows.filter((r) => r.mode === 'escapement');

describe('the capture', () => {
	it('has 3,600 escapement and 3,600 world rows of three points', () => {
		expect(escapement).toHaveLength(3600);
		expect(rows.filter((r) => r.mode === 'world')).toHaveLength(3600);
		expect(rows.every((r) => r.points.length === 3)).toBe(true);
	});
});

describe('escapementSinCos', () => {
	it('reproduces the escapement matrix at every tenth of a degree to 2e-5', () => {
		let worst = 0;
		for (const r of escapement) {
			const { sin, cos } = escapementSinCos(r.tenths);
			// the image of the x axis; the y axis is the same rotation turned a quarter
			worst = Math.max(worst, Math.abs(r.points[1][0] / SCALE - cos), Math.abs(r.points[1][1] / SCALE - sin));
			worst = Math.max(worst, Math.abs(r.points[2][1] / SCALE - cos), Math.abs(-r.points[2][0] / SCALE - sin));
		}
		expect(worst).toBeLessThan(2.2e-5);
	});
	it('is what exact trigonometry is not: the native length dips by 3e-4 between table angles', () => {
		let exactWorst = 0, dips = 0;
		for (const r of escapement) {
			const t = (r.tenths / 10) * (Math.PI / 180);
			exactWorst = Math.max(exactWorst, Math.abs(r.points[1][0] / SCALE - Math.cos(t)), Math.abs(r.points[1][1] / SCALE - Math.sin(t)));
			if (Math.hypot(r.points[1][0], r.points[1][1]) / SCALE < 1 - 2e-4) dips++;
		}
		expect(exactWorst).toBeGreaterThan(3e-4);
		expect(dips).toBeGreaterThan(1000);
	});
	it('is exact at the table angles and at the quarter turns', () => {
		for (const tenths of [0, 225, 450, 900, 1800, 2700]) {
			const t = (tenths / 10) * (Math.PI / 180);
			const { sin, cos } = escapementSinCos(tenths);
			expect(sin).toBeCloseTo(Math.sin(t), 12);
			expect(cos).toBeCloseTo(Math.cos(t), 12);
		}
	});
	it('wraps negative and large angles', () => {
		expect(escapementSinCos(-300)).toEqual(escapementSinCos(3300));
		expect(escapementSinCos(3900)).toEqual(escapementSinCos(300));
	});
});

describe('a world rotation is not interpolated', () => {
	it('matches exact trigonometry to the 16.16 matrix', () => {
		let worst = 0;
		for (const r of rows.filter((q) => q.mode === 'world')) {
			const t = (r.tenths / 10) * (Math.PI / 180);
			// a GM_ADVANCED rotation turns the text the other way round from an escapement of the same angle
			worst = Math.max(worst, Math.abs(r.points[1][0] / SCALE - Math.cos(t)), Math.abs(-r.points[1][1] / SCALE - Math.sin(t)));
		}
		expect(worst).toBeLessThan(2.5e-5);
	});
});
