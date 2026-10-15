import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';

/**
 * Single-instruction hinting sweeps against GDI (`GetGlyphOutline` GGO_NATIVE, probe `HintSweepProbe.cs`, generator
 * `generate-hint-sweep.ps1`, fonts `build-hint-sweep-fonts.py`). Each private font glyph runs one instruction of
 * interest (MIRP, MDRP, MDAP, ALIGNRP, then IUP) 48 times on random points, after a projection vector set by
 * SPVTL or SDPVTL on a swept random angle and a freedom vector along x, y, the projection vector or another random
 * direction, at 16 and 24 ppem. 16 kinds x 100 vectors x 2 sizes x 52 points = 166,400 points.
 *
 * What the sweeps established (round 7, T):
 *  - the projection and the dual projection round each product alone (`ShortFracMul` x + y);
 *  - the dot product of the vectors (the divisor of a move) is the same per-product sum, and a sum below 1/16 keeps
 *    its sign (+-1.0);
 *  - a move along x divides in truncating integer arithmetic after adding half the divisor, so negative quotients round
 *    toward zero at every half; a move along y rounds half away from zero; with the freedom vector copied from the
 *    projection vector, or a dot product of exactly 1.0, both round to nearest; with the projection vector along x the
 *    x move is the distance itself;
 *  - IUP interpolates with the same truncating division.
 * The legacy arithmetic misses 4 to 60 percent of the points of these fonts.
 */
const captures: { kind: string; size: number; index: number; native: string }[] = JSON.parse(
	gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-hint-sweep.json.gz', import.meta.url))).toString(),
);

function nativePoints(buf: Buffer): { xs: number[]; ys: number[] } {
	const xs: number[] = [];
	const ys: number[] = [];
	let p = 0;
	while (p < buf.length) {
		const end = p + buf.readUInt32LE(p);
		const sx = Math.round((buf.readInt32LE(p + 8) / 65536) * 64);
		const sy = Math.round((buf.readInt32LE(p + 12) / 65536) * 64);
		const start = xs.length;
		xs.push(sx);
		ys.push(sy);
		let q = p + 16;
		while (q < end) {
			const n = buf.readUInt16LE(q + 2);
			for (let i = 0; i < n; i++) {
				xs.push(Math.round((buf.readInt32LE(q + 4 + i * 8) / 65536) * 64));
				ys.push(Math.round((buf.readInt32LE(q + 8 + i * 8) / 65536) * 64));
			}
			q += 4 + n * 8;
		}
		const last = xs.length - 1;
		if (last > start && xs[last] === sx && ys[last] === sy) {
			xs.pop();
			ys.pop();
		}
		p = end;
	}
	return { xs, ys };
}

function score(gdiArithmetic: boolean): { glyphs: number; exact: number; points: number; bad: number } {
	const fonts = new Map<string, ReturnType<typeof parseFontFile>[number]>();
	const out = { glyphs: 0, exact: 0, points: 0, bad: 0 };
	for (const c of captures) {
		if (!fonts.has(c.kind)) fonts.set(c.kind, parseFontFile(readFileSync(new URL(`./__fixtures__/gdi/hint-sweep-${c.kind}.ttf`, import.meta.url)))[0]);
		const g = new HintedSize(fonts.get(c.kind)!, c.size, c.size, { version: 35, grayscale: true, gdiArithmetic }).hintGlyph(c.index);
		const n = nativePoints(Buffer.from(c.native, 'base64'));
		expect(g.xs.length).toBe(n.xs.length);
		let bad = 0;
		for (let i = 0; i < n.xs.length; i++) if (n.xs[i] !== g.xs[i] || n.ys[i] !== g.ys[i]) bad++;
		out.glyphs++;
		out.points += n.xs.length;
		out.bad += bad;
		if (!bad) out.exact++;
	}
	return out;
}

describe('GDI single-instruction hinting sweeps (private fonts, GGO_NATIVE)', () => {
	it('pins the capture', () => {
		expect(captures.length).toBe(3200);
	});
	it('gdiArithmetic reproduces the native points (5 of 166,400 off)', () => {
		const r = score(true);
		expect(r.points).toBe(166400);
		expect(r.bad).toBeLessThanOrEqual(5);
		expect(r.exact).toBeGreaterThanOrEqual(3195);
	});
	it('the legacy arithmetic does not', () => {
		const r = score(false);
		expect(r.bad).toBeGreaterThan(5000);
	});
});
