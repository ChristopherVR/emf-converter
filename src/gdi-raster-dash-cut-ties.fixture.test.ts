/**
 * Native `WidenPath` of 2,027 flat-capped dashed Beziers whose dash cut points sit within 6e-4 FIX of a rounding tie
 * (`dash-cut-tie-probe`, `find-dash-cut-ties.ts` picks the Beziers; `dash-cut-ties.json.gz` holds each curve and the outline).
 *
 * The cuts decide the dash ends, and GDI places one at `x0 + d * t / len` (the segment's vector component over the distance walked
 * and its whole-pixel length) in single precision: the sum is a float32, and a sum that lands on x.5 rounds half away from the
 * segment's start (up when the component runs forward, down when it runs back). Of 349 forced rounding decisions read from the captures
 * (the ones a fill-identical outline needs), 321 fit; 28 follow the exact double value instead.
 *
 * The same single-precision arithmetic sets the extension of a square cap at a dash end GDI scales by its real over whole-pixel
 * length (`Outliner.scaledExtension`): a float32 product of the vector component and a float32 half-width over whole-pixel length,
 * rounded half away from zero. That is the family of `curve-dash.json` sample 117 (110.5 native 110, 3.5 native 4, 57.5 native 58,
 * -62.5 native -63): 24 of 1,300 neighbouring square-capped Beziers and sample 117 differed, now 0 and 1 (flat) of 2,484.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, geometricStyle, type SpanList } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

const cases: any[] = JSON.parse(gunzipSync(readFileSync(fixturePath('dash-cut-ties.json.gz'))).toString());

function pixels(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	return set;
}
function nativePolygons(points: number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) out.push([]);
		out[out.length - 1].push(points[i], points[i + 1]);
	}
	return out;
}
function differing(ours: number[][], native: number[][]): number {
	const a = pixels(fillPolygonSpans(ours, true));
	const b = pixels(fillPolygonSpans(native, true));
	let d = 0;
	for (const v of a) if (!b.has(v)) d++;
	for (const v of b) if (!a.has(v)) d++;
	return d;
}

it('cuts 2,027 dashed Beziers at the rounding ties as native does: all but 36 fill identically (108 differed with double-precision cuts)', () => {
	expect(cases).toHaveLength(2027);
	let bad = 0;
	let largest = 0;
	for (const c of cases) {
		const path = new GdiRasterPath();
		path.addBeziers((c.points as number[]).map((v) => v * 16), true);
		const style = geometricStyle(0x10000 | c.style, c.width, c.dashes as number[]);
		const ours = widenPath(path, {
			width: c.width * 16,
			cap: (['round', 'square', 'flat'] as const)[c.cap],
			join: 'round',
			miterLimit: 10,
			dashes: style ? style.map((v) => v * 16) : null,
			shortenDashes: c.style !== 7,
			wholePixelDashVectors: true,
		});
		const d = differing(ours, nativePolygons(c.expected));
		if (d > 0) bad++;
		largest = Math.max(largest, d);
	}
	expect(bad).toBe(36);
	expect(largest).toBeLessThanOrEqual(6);
});
