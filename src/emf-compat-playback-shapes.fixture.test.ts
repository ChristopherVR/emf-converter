/**
 * Native `GetPath` of Arc, Chord, Pie, Ellipse, RoundRect and Rectangle records played back under mirrored maps
 * (`compat-playback-shapes-probe`, `CompatPlaybackProbe.PathPlaybackShapes`, `compat-playback-shapes.json.gz`): the six
 * `compat-playback` maps (window and viewport extents 1:1, 4:3, 10:7, 3:4, 2:1 and 3:2 by 1:1) and their x, y and x-and-y
 * mirrored forms (a negative viewport extent with the viewport origin at the far edge), 48 random shapes of each kind per map
 * (6,912 in all) under a null, a cosmetic, a plain 3 unit and an inside-frame 3 unit pen, every second block of four under
 * `AD_CLOCKWISE`. Each is recorded with one call and played back record by record inside a path bracket (see
 * `emf-compat-playback-paths.fixture.test.ts`).
 *
 * What the capture shows about a map that mirrors an axis:
 *
 *  - GDI writes the record's box in device order (`l > r` under a mirrored x, `t > b` under a mirrored y) and the recorder inverts
 *    the arc direction once when the map's determinant is negative: a call under the default `AD_COUNTERCLOCKWISE` stores
 *    `SetArcDirection(AD_CLOCKWISE)`. The record's direction is what the converter reads.
 *  - Windows builds the shape in logical space and maps it point by point, but its roundings do not mirror. A mirrored y runs the
 *    shape the other way on screen, so the vertical roundings follow the direction opposite to the recorded one (floor for a
 *    clockwise RoundRect, ceil for a counter-clockwise one). A mirrored x rounds the horizontal controls of a RoundRect and of the
 *    whole quadrants of an arc down instead of up, and an arc's circle keeps its centre but has the horizontal radius
 *    `floor(w / 2)` instead of `ceil(w / 2)`. With those, Arc, Chord, Pie and Ellipse are exact for the 864 shapes of each kind
 *    under the cosmetic, plain and inside-frame pens (every mirroring and map).
 *  - A Rectangle's path is the logical one mapped, so its start vertex and direction are the mirror image of the unmirrored
 *    path's (864 of 864 exact per pen set). What is drawn (not collected in a path bracket) is built in device space whichever way
 *    the map mirrors: a dotted outline starts at the right-bottom corner heading left under `AD_CLOCKWISE`, at the right-top
 *    corner otherwise (`compat-rects-m*-dot`, all pixel-exact).
 *
 * Counts below are exact paths of the pens that need no growth (cosmetic, plain and inside-frame: 5,184 of the 6,912; the null pen
 * grows a whole-pixel box by a quarter pixel in the path bracket too, which the converter applies to drawn shapes only).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { EMR_ARC, EMR_CHORD, EMR_ELLIPSE, EMR_PIE, EMR_RECTANGLE, EMR_ROUNDRECT } from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { defaultState, type EmfGdiReplayCtx } from './emf-types';

interface NativeShape {
	map: number;
	kind: number;
	pen: number;
	dir: number;
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
const RECORDS = [EMR_ARC, EMR_CHORD, EMR_PIE, EMR_ELLIPSE, EMR_ROUNDRECT, EMR_RECTANGLE];
const KINDS = ['arc', 'chord', 'pie', 'ellipse', 'roundrect', 'rect'];
const MIRRORS = ['none', 'x', 'y', 'xy'];
const W = 420;
const H = 300;

const shapes = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/compat-playback-shapes.json.gz', import.meta.url))).toString()) as NativeShape[];

/** Our path as flat `x, y` pairs. */
function oursOf(c: NativeShape): number[] {
	const ints = c.rec;
	const view = new DataView(new ArrayBuffer(8 + ints.length * 4));
	ints.forEach((v, i) => view.setInt32(8 + i * 4, v, true));
	const mirror = Math.floor(c.map / 6);
	const sx = mirror & 1 ? -1 : 1;
	const sy = mirror & 2 ? -1 : 1;
	const state = defaultState();
	// The direction in the record: the call's, inverted once when the map's determinant is negative.
	state.arcDirection = sx !== sy ? 3 - c.dir : c.dir;
	if (c.pen === 0) {
		state.penStyle = 5;
	} else if (c.pen === 3) {
		state.penStyle = 6;
		state.penWidth = 3;
	} else {
		state.penWidth = c.pen === 2 ? 3 : 0;
	}
	const m = MAPS[c.map % 6];
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
		viewportOrg: { x: sx < 0 ? W : 0, y: sy < 0 ? H : 0 },
		viewportExt: { cx: sx * m[2], cy: sy * m[3] },
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
	return replay.rasterPath?.getPath.pts ?? [];
}

/** The coordinates of `[x, y, type]` triples, with repeated points (the zero-length pieces) dropped. */
function dedupe(flat: number[], stride: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < flat.length; i += stride) {
		if (!(out.length && out[out.length - 2] === flat[i] && out[out.length - 1] === flat[i + 1])) out.push(flat[i], flat[i + 1]);
	}
	return out;
}

describe('shapes played back under mirrored maps against native GetPath', () => {
	it('captures 6,912 shapes: 48 of each kind under each of 24 maps', () => {
		expect(shapes).toHaveLength(6912);
	});

	it('matches the native paths of the cosmetic, plain and inside-frame pens: exact counts per kind and mirroring', () => {
		const exact: Record<string, number> = {};
		for (const c of shapes) {
			if (c.pen === 0) continue;
			const mine = dedupe(oursOf(c), 2);
			const native = dedupe(c.played, 3);
			const key = `${KINDS[c.kind]} ${MIRRORS[Math.floor(c.map / 6)]}`;
			exact[key] ??= 0;
			if (mine.length === native.length && mine.every((v, i) => v === native[i])) exact[key]++;
		}
		// 216 shapes per kind and mirroring (72 for each of the three pens). Arc, Chord, Pie, Ellipse and Rectangle are exact everywhere;
		// a RoundRect has the corner-size rounding of the unmirrored case unexplained under the non-dyadic maps (the 24 pixels of
		// `compat-playback-*`), and an inside-frame pen under a mirrored x is not mirrored yet.
		const perfect = Object.fromEntries(['arc', 'chord', 'pie', 'ellipse', 'rect'].flatMap((k) => MIRRORS.map((m) => [`${k} ${m}`, 216])));
		expect(exact).toEqual({ ...perfect, 'roundrect none': 196, 'roundrect x': 109, 'roundrect y': 187, 'roundrect xy': 103 });
	});
});
