/**
 * Native `WidenPath` of triangles, quadrilaterals and polylines recorded under the `compat-widemirror` map mirrored in x (3:2 by 1:1,
 * the viewport x extent negated), a plain pen of 3 or 4 units (`compat-poly-widen-probe`, `CompatPlaybackProbe.PolyWiden`,
 * `compat-poly-widen.json.gz`): per variant `{raw, wide}`, the record and its native `GetPath` and `WidenPath` as `[x, y, type]` FIX
 * triples. The `par` kinds have a first segment parallel to an edge of the nib (3 unit nib: the diamond (+-16, 0), (0, +-24); 4 unit
 * nib: an octagon with edges (15, 9) and (16, -9)), the tie case that decides which end of that edge a segment's side rests on.
 *
 * What the capture decided: the draw vertex of a segment parallel to an edge is the end "further along the segment's direction
 * normalised to point rightwards (or downwards when steeper)" for an orientation-preserving map, and the other end when the map flips
 * orientation (a mirrored x). Without the flip 1,770 of these 4,800 outlines differ in fill (`line2par` with the 4 unit pen: 400 of
 * 400; the random polygons 1 or 2 of 400, the 5 pixels the `compat-widemirror-poly*` sheets kept); with it none does. Native
 * outlines are compared by their WINDING fill (the loops native adds inside a stroke do not change it), against the converter's own
 * widener fed with native's unwidened `GetPath`.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { fillPolygonSpans, GdiRasterPath } from './gdi-raster';
import { widenPath, type WidenOptions } from './gdi-raster-widen';
import { fixturePath } from './__fixtures__/gdi-parity-harness';

type Entry = { played: number[] };
const capture = JSON.parse(gunzipSync(readFileSync(fixturePath('compat-poly-widen.json.gz'))).toString()) as Record<string, { raw: Entry[]; wide: Entry[] }>;

function fillPixels(polys: number[][]): Set<string> {
	const spans = fillPolygonSpans(polys, true);
	const out = new Set<string>();
	for (let i = 0; i < spans.length; i++) {
		for (let x = spans.data[i * 3 + 1]; x < spans.data[i * 3 + 2]; x++) out.add(`${x},${spans.data[i * 3]}`);
	}
	return out;
}

function nativePolygons(played: number[]): number[][] {
	const polys: number[][] = [];
	let cur: number[] = [];
	for (let i = 0; i + 2 < played.length; i += 3) {
		if (played[i + 2] === 6 && cur.length) {
			polys.push(cur);
			cur = [];
		}
		cur.push(played[i], played[i + 1]);
	}
	if (cur.length) polys.push(cur);
	return polys;
}

describe('wide plain pens widening polygons and polylines under a map that mirrors x (native WidenPath)', () => {
	const variants = Object.keys(capture);
	it('covers 12 variants of 400 records', () => {
		expect(variants).toHaveLength(12);
		for (const v of variants) expect(capture[v].raw).toHaveLength(400);
	});
	for (const v of variants) {
		it(`${v}: every outline fills the pixels native's does`, () => {
			const width = v.includes('-p3-') ? 3 : 4;
			const open = v.startsWith('open') || v.startsWith('line');
			const opts: WidenOptions = {
				width: width * 16,
				matrix: [-2 / 3, 0, 0, 1],
				deviceNib: true,
				cap: 'round',
				join: 'round',
				miterLimit: 10,
				dashes: null,
				shortenDashes: true,
				wholePixelDashVectors: false,
				cutToLogicalUnits: true,
			};
			let differing = 0;
			capture[v].raw.forEach((r, i) => {
				const p = r.played;
				const path = new GdiRasterPath();
				path.moveTo(p[0], p[1]);
				for (let k = 3; k + 1 < p.length; k += 3) path.lineTo(p[k], p[k + 1]);
				if (!open) path.closeFigure();
				const ours = fillPixels(widenPath(path, opts));
				const native = fillPixels(nativePolygons(capture[v].wide[i].played));
				if (ours.size !== native.size || [...ours].some((k) => !native.has(k))) differing++;
			});
			expect(differing).toBe(0);
		});
	}
});
