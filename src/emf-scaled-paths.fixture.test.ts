/**
 * Native `GetPath` in `GM_ADVANCED` of Arc, Chord, Pie, Ellipse, RoundRect and Rectangle under a `PS_INSIDEFRAME` pen at
 * fractional scales (`emf-scaled-path-probe`, 2,400 shapes: window 16, viewport 11, 17, 22, 23 or 29, pens of 2 to 13
 * logical units, a quarter of them `AD_CLOCKWISE`). An odd device pen width (in 1/16 pixel) puts the vertical edges on half
 * a FIX and shears the curved paths, a RoundRect's edge end points round from the unrounded corner, and an arc's radials
 * are measured on the unrounded device points. Counter-clockwise shapes match Windows point for point; the clockwise
 * Ellipse, Arc, Chord, Pie and RoundRect paths keep the per-kind bounds below (a FIX off at isolated points).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { EMR_ARC, EMR_CHORD, EMR_ELLIPSE, EMR_PIE, EMR_RECTANGLE, EMR_ROUNDRECT } from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { defaultState, type EmfGdiReplayCtx } from './emf-types';

interface NativeShape {
	kind: number;
	scale: number;
	dir: number;
	pw: number;
	box: [number, number, number, number];
	rad: [number, number, number, number];
	corner: [number, number];
	pts: number[];
}

const NAMES = ['chord', 'pie', 'arc', 'ellipse', 'roundrect', 'rect'] as const;
const RECORDS = [EMR_CHORD, EMR_PIE, EMR_ARC, EMR_ELLIPSE, EMR_ROUNDRECT, EMR_RECTANGLE];

/** Our path as `[x, y, type]` triples. */
function oursOf(c: NativeShape): number[] {
	const ints = c.kind === 4 ? [...c.box, ...c.corner] : c.kind >= 3 ? [...c.box] : [...c.box, ...c.rad];
	const view = new DataView(new ArrayBuffer(8 + ints.length * 4));
	ints.forEach((v, i) => view.setInt32(8 + i * 4, v, true));
	const state = defaultState();
	state.penWidth = c.pw;
	state.penStyle = 6;
	state.arcDirection = c.dir;
	const nop = () => undefined;
	const replay: EmfGdiReplayCtx = {
		ctx: new Proxy({}, { get: () => nop }) as unknown as CanvasRenderingContext2D,
		view,
		objectTable: new Map(),
		state,
		stateStack: [],
		inPath: true,
		windowOrg: { x: 0, y: 0 },
		windowExt: { cx: 16, cy: 16 },
		viewportOrg: { x: 0, y: 0 },
		viewportExt: { cx: c.scale, cy: c.scale },
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

/** A pen exactly as wide as the box along an axis leaves a zero-size frame, which Windows builds from rounding noise. */
const zeroFrame = (c: NativeShape): boolean => c.box[2] - c.box[0] === c.pw || c.box[3] - c.box[1] === c.pw;

/** Clockwise shapes that differ from Windows, per kind (of 2,400 / 6 = 400 each, a quarter clockwise). */
const CLOCKWISE_MISMATCH_LIMIT: Record<string, number> = { chord: 59, pie: 46, arc: 47, ellipse: 80, roundrect: 35, rect: 0 };

describe('EMF shapes under an inside-frame pen at fractional scales against native GetPath', () => {
	const shapes = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/emf-scaled-paths.json.gz', import.meta.url))).toString()) as NativeShape[];
	const clockwiseMismatches: Record<string, number> = {};
	let counterClockwise = 0;

	it('matches every counter-clockwise shape', () => {
		for (const c of shapes) {
			if (c.dir !== 1 || zeroFrame(c)) {
				continue;
			}
			counterClockwise++;
			const got = oursOf(c);
			expect(got, JSON.stringify({ ...c, pts: undefined })).toEqual(c.pts);
		}
		expect(counterClockwise).toBeGreaterThan(1000);
	});

	it('keeps the clockwise mismatches within their bounds', () => {
		for (const c of shapes) {
			if (c.dir !== 2 || zeroFrame(c)) {
				continue;
			}
			const got = oursOf(c);
			if (JSON.stringify(got) !== JSON.stringify(c.pts)) {
				clockwiseMismatches[NAMES[c.kind]] = (clockwiseMismatches[NAMES[c.kind]] ?? 0) + 1;
			}
		}
		for (const name of NAMES) {
			expect(clockwiseMismatches[name] ?? 0, name).toBeLessThanOrEqual(CLOCKWISE_MISMATCH_LIMIT[name]);
		}
	});
});
