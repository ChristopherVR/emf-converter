import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pickRasterFace, type RasterMapperFace } from './raster-mapper';
import { fixturePath } from './__fixtures__/gdi-parity-harness';

/**
 * `text-raster-synthetic` (RasterSyntheticMapperProbe.cs, 16 October 2026): the Windows raster font mapper measured with
 * private bitmap families (bare version 2.0 .fnt files registered with FR_PRIVATE) whose pixel height, internal leading,
 * average width and weight are chosen one at a time, through GetTextMetrics. The six installed families rebuilt as
 * private families ("replicas") answer exactly as the installed fonts do (all 7,000 lfWidth/lfHeight rows of
 * `raster-mapper-widths.json.gz` and `raster-mapper-wide.json.gz` that the replicas cover), so the mapper looks at nothing
 * but the attributes in the face tables.
 */
interface Capture {
	families: Record<string, string[]>;
	replicaHeights: number[];
	replicaWidths: number[];
	replicas: Record<string, number[]>;
	single: { face: string; heights: number[]; avg: number[] };
	gating: Array<[number, number, number, number[]]>;
	allow: string[];
	pairs: Array<[number, number, number, number, number, number, number]>;
	random: Array<{ faces: string[]; request: number; heights: number[]; widths: number[]; tm: number[] }>;
}
const capture: Capture = JSON.parse(gunzipSync(readFileSync(fixturePath('raster-mapper-synthetic.json.gz'))).toString());

function parse(spec: string): RasterMapperFace {
	const [pix, il, avg, , weight = '400', vr = '96'] = spec.split(':');
	return { pixHeight: +pix, internalLeading: +il, avgWidth: +avg, weight: +weight, vertRes: +vr };
}
const pick = (faces: RasterMapperFace[], h: number, w: number, weight = 400): { cell: number; avg: number } => {
	const p = pickRasterFace(faces, h, w, weight)!;
	const f = faces[p.index];
	return { cell: f.pixHeight * p.scaleY, avg: f.avgWidth * p.scaleX };
};

describe('raster font mapper model against native GDI on synthetic families', () => {
	it('is the capture of 6 families, 254 heights x 15 widths each', () => {
		expect(Object.keys(capture.families)).toHaveLength(6);
		expect(capture.replicaHeights).toHaveLength(254);
		for (const name of Object.keys(capture.families)) {
			expect(capture.replicas[name]).toHaveLength(254 * 15 * 2);
		}
	});
	it('picks the native cell height and average width in the replicas of the installed families', () => {
		const counts: Record<string, number> = {};
		for (const [name, specs] of Object.entries(capture.families)) {
			const faces = specs.map(parse);
			const tm = capture.replicas[name];
			let good = 0;
			let k = 0;
			for (const h of capture.replicaHeights) {
				for (const w of capture.replicaWidths) {
					const p = pick(faces, h, w);
					good += p.cell === tm[k] && p.avg === tm[k + 1] ? 1 : 0;
					k += 2;
				}
			}
			counts[name] = good;
		}
		// 3,810 rows per family; the misses are near-ties between faces of the high stretch factors.
		expect(counts).toEqual({ 'MS Sans Serif': 3783, 'MS Serif': 3789, Courier: 3794, 'Small Fonts': 3784, System: 3781, Fixedsys: 3797 });
	});
	it('rounds the horizontal factor of a single face half up and stops at 5', () => {
		const faces = [parse(capture.single.face)];
		let k = 0;
		for (const h of capture.single.heights) {
			for (let w = 1; w <= 60; w++) {
				expect(pick(faces, h, w).avg, `h${h} w${w}`).toBe(capture.single.avg[k]);
				k++;
			}
		}
	});
	it('takes the next vertical factor when the face overshoots by at most a quarter of its height', () => {
		let rows = 0;
		for (const [positive, pix, leading, thresholds] of capture.gating) {
			// A face of 4 pixels or less cannot be stretched; GDI then maps a request this large to another installed font.
			if ((positive ? pix : pix - leading) < 5) continue;
			const face = [parse(`${pix}:${leading}:8:8`)];
			// The first request that gives each vertical factor.
			const seen: number[] = [];
			let prev = 0;
			for (let t = 1; t <= (positive ? pix : pix - leading) * 6 + 5; t++) {
				const ky = pick(face, positive ? t : -t, 0).cell / pix;
				if (ky !== prev) {
					if (prev > 0) seen.push(t);
					prev = ky;
				}
			}
			expect(seen, `${positive ? 'cell' : 'character'} ${pix}/${leading}`).toEqual(thresholds);
			rows++;
		}
		expect(rows).toBe(105);
	});
	it('never stretches a face by more than its height minus 3', () => {
		capture.allow.forEach((line, i) => {
			const u = i + 1;
			const allowed = [...line].map((c) => (c === 'Y' ? 1 : 0));
			// A factor is usable iff u * ky fits: u - 3 >= ky (and always the factor 1).
			allowed.forEach((a, j) => expect(a, `u${u} ky${j + 1}`).toBe(j === 0 || j + 1 <= u - 3 ? 1 : 0));
		});
	});
	it('chooses between two faces of one height by the same winner as native GDI', () => {
		let good = 0;
		for (const [ky, I, J, w, a, b, win] of capture.pairs) {
			const faces = [parse(`13:0:${a}:${a}`), parse(`13:0:${b}:${b}`)];
			const p = pickRasterFace(faces, -13 * ky, w, 400)!;
			good += p.index === win ? 1 : 0;
			expect(I < J).toBe(true);
		}
		expect({ good, of: capture.pairs.length }).toEqual({ good: 3195, of: 3200 });
	});
	it('picks native cell height and width in random families of four faces', () => {
		let good = 0;
		let heightGood = 0;
		let total = 0;
		for (const fam of capture.random) {
			const faces = fam.faces.map(parse);
			const bold = fam.request !== 400 || faces.some((f) => f.weight !== 400);
			let k = 0;
			for (const h of fam.heights) {
				for (const w of fam.widths) {
					const p = pick(faces, h, w, fam.request);
					heightGood += p.cell === fam.tm[k] ? 1 : 0;
					good += p.cell === fam.tm[k] && (bold || p.avg === fam.tm[k + 1]) ? 1 : 0;
					total++;
					k += 2;
				}
			}
		}
		expect({ good, heightGood, total }).toEqual({ good: 7467, heightGood: 7467, total: 7500 });
	});
});
