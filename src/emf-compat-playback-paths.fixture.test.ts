/**
 * Native `GetPath` of Arc, Chord and Pie records played back under six map modes (`compat-playback-paths-probe`,
 * `CompatPlaybackProbe.PathPlayback`, `compat-playback-paths.json.gz`): 600 random shapes per map (window and viewport
 * extents 1:1, 4:3, 10:7, 3:4, 2:1 and 3:2 by 1:1), Arc, Chord and Pie in turn, every fourth one under `AD_CLOCKWISE`. The
 * metafile is recorded with one call; the target DC then runs `EnumEnhMetaFile`, and the arc record alone is played with
 * `PlayEnhMetaFileRecord` inside a `BeginPath`/`EndPath` bracket (`PlayEnhMetaFile` itself adds nothing to a path bracket).
 * The path is read back through an identity world transform at sixteen units per device pixel, so the points are FIX.
 *
 * The record stores the call's right and bottom edge less one device pixel, in logical units (one unit under 1:1, two under
 * the 2:1 map, one or two under 3:2 by 1:1). What the capture decides: Windows measures a radial's angle in logical space,
 * as the fraction of the record's box the radial sits at, and carries that fraction onto the device box it draws. The
 * converter used to round each radial to FIX first, which moves it by up to half a FIX against the box: 1,059 of the 3,600
 * paths had a point a FIX off (425, 387 and 247 of the 600 under the 10:7, 3:4 and 3:2 by 1:1 maps; the 1:1, 4:3 and 2:1
 * ratios are multiples of 1/16 and never differed). All 3,600 paths are exact now, in both arc directions, and the arcs of
 * the `compat-playback-*` sheets are exact (259 differing pixels over the sheets before, 24 now, all in RoundRect cells).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { EMR_ARC, EMR_CHORD, EMR_PIE } from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { defaultState, type EmfGdiReplayCtx } from './emf-types';

interface NativeShape {
	map: number;
	kind: number;
	dir: number;
	args: number[];
	rec: number[];
	played: number[];
}

const MAPS = [
	[1, 1, 1, 1],
	[4, 4, 3, 3],
	[10, 10, 7, 7],
	[3, 3, 4, 4],
	[2, 2, 1, 1],
	[3, 1, 2, 1],
];
const RECORDS = [EMR_ARC, EMR_CHORD, EMR_PIE];

/** Our path as `[x, y, type]` triples, in the device frame of the capture (the played shape's own offset removed by the caller). */
function oursOf(c: NativeShape): number[] {
	// The record as Windows wrote it: the call's right and bottom edge less one device pixel, in logical units.
	const ints = c.rec;
	const view = new DataView(new ArrayBuffer(8 + ints.length * 4));
	ints.forEach((v, i) => view.setInt32(8 + i * 4, v, true));
	const state = defaultState();
	state.arcDirection = c.dir;
	const m = MAPS[c.map];
	const nop = () => undefined;
	const replay: EmfGdiReplayCtx = {
		ctx: new Proxy({}, { get: () => nop }) as unknown as CanvasRenderingContext2D,
		view,
		objectTable: new Map(),
		state,
		stateStack: [],
		inPath: true,
		windowOrg: { x: 0, y: 0 },
		windowExt: { cx: m[0], cy: m[1] },
		viewportOrg: { x: 0, y: 0 },
		viewportExt: { cx: m[2], cy: m[3] },
		useMappingMode: true,
		clipSaveDepth: 0,
		bounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
		canvasW: 1000,
		canvasH: 1000,
		sx: 1,
		sy: 1,
		pathCmds: [],
	};
	expect(handleEmfGdiShapeRecord(replay, RECORDS[c.kind], 8, 8 + ints.length * 4)).toBe(true);
	const g = replay.rasterPath?.getPath;
	return g ? g.pts.flatMap((v, i) => (i % 2 === 1 ? [v, g.types[(i - 1) / 2]] : [v])) : [];
}

const shapes = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/compat-playback-paths.json.gz', import.meta.url))).toString()) as NativeShape[];

/** The coordinates of `[x, y, type]` triples, with repeated points (the zero-length pieces) dropped. */
function dedupe(triples: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < triples.length; i += 3) {
		if (!(out.length && out[out.length - 2] === triples[i] && out[out.length - 1] === triples[i + 1])) out.push(triples[i], triples[i + 1]);
	}
	return out;
}

describe('Arc, Chord and Pie records played back under non-unit maps against native GetPath', () => {
	it('captures 3,600 shapes: 600 per map, three kinds, a quarter of them clockwise', () => {
		expect(shapes).toHaveLength(3600);
		expect(shapes.filter((c) => c.dir === 2)).toHaveLength(900);
	});

	it('matches every path point for point', () => {
		const exact = new Array<number>(MAPS.length).fill(0);
		const bad: string[] = [];
		for (const c of shapes) {
			const mine = dedupe(oursOf(c));
			const native = dedupe(c.played);
			if (mine.length === native.length && mine.every((v, i) => v === native[i])) {
				exact[c.map]++;
			} else if (bad.length < 5) {
				bad.push(`${c.map}/${c.kind}/${c.dir}: ${c.args.join(',')} native ${native.join(' ')} ours ${mine.join(' ')}`);
			}
		}
		expect(bad).toEqual([]);
		expect(exact).toEqual([600, 600, 600, 600, 600, 600]);
	});
});
