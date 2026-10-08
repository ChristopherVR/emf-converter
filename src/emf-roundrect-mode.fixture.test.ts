/**
 * RoundRect records against native GDI in both graphics modes (`emf-roundrect-mode-probe`, 800 shapes: 100 per pen kind and mode,
 * a quarter of them `AD_CLOCKWISE`). An EMF holds no graphics-mode record (neither `SetGraphicsMode` call is recorded; the six
 * recorded files differ from each other only in the EMR_ROUNDRECT box, which a GM_COMPATIBLE recording stores one pixel short at
 * the right and bottom) and `PlayEnhMetaFile` draws the record the same way for both: the corner ellipse stays unscaled on the
 * record's box under a cosmetic, wide or geometric pen, and a null pen's quarter-pixel grown box takes the corner scaled onto it.
 * `played` is GetPath read when the recorded EndPath has played (whole pixels); `direct` is GetPath of the call itself in GM_ADVANCED
 * (1/16 pixel). Native playback of the six sheets `emf-roundrect-mode-{compat,adv}-{null,cosmetic,wide}` is pinned in
 * `gdi-parity.fixture.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { EMR_ROUNDRECT } from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { defaultState, type EmfGdiReplayCtx } from './emf-types';

interface NativeShape {
	mode: number;
	pen: number;
	dir: number;
	pw: number;
	box: [number, number, number, number];
	corner: [number, number];
	rec: [number, number, number, number];
	direct: number[];
	played: number[];
}

const shapes = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/emf-roundrect-mode-paths.json.gz', import.meta.url))).toString()) as NativeShape[];

/** Our path as `[x, y, type]` triples in FIX, built from the recorded box. */
function oursOf(c: NativeShape): number[] {
	const ints = [...c.rec, ...c.corner];
	const view = new DataView(new ArrayBuffer(8 + ints.length * 4));
	ints.forEach((v, i) => view.setInt32(8 + i * 4, v, true));
	const state = defaultState();
	state.penWidth = c.pw;
	state.penStyle = c.pen === 0 ? 5 : 0;
	if (c.pen === 3) {
		state.penExtended = true;
		state.penFlags = 0x10000 | 0x200;
	}
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
		viewportExt: { cx: 16, cy: 16 },
		useMappingMode: true,
		clipSaveDepth: 0,
		bounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
		canvasW: 1000,
		canvasH: 1000,
		sx: 1,
		sy: 1,
		pathCmds: [],
	};
	expect(handleEmfGdiShapeRecord(replay, EMR_ROUNDRECT, 8, 8 + ints.length * 4)).toBe(true);
	const g = replay.rasterPath?.getPath;
	return g ? g.pts.flatMap((v, i) => (i % 2 === 1 ? [v, g.types[(i - 1) / 2]] : [v])) : [];
}

const whole = (fix: number[]): number[] => fix.map((v, i) => (i % 3 === 2 ? v : Math.round(v / 16)));

describe('RoundRect records against native playback in both graphics modes', () => {
	const counts: Record<string, { played: number; direct: number; total: number }> = {};
	for (const c of shapes) {
		const entry = (counts[`${c.mode === 1 ? 'compat' : 'adv'}-${['null', 'cosmetic', 'wide', 'geometric'][c.pen]}`] ??= { played: 0, direct: 0, total: 0 });
		entry.total++;
		const ours = oursOf(c);
		if (JSON.stringify(whole(ours)) === JSON.stringify(c.played)) entry.played++;
		if (JSON.stringify(ours) === JSON.stringify(c.direct)) entry.direct++;
	}

	it('captures 100 shapes per pen kind and graphics mode', () => {
		expect(Object.keys(counts)).toHaveLength(8);
		for (const v of Object.values(counts)) expect(v.total).toBe(100);
	});

	it('records the box one pixel short of the call in GM_COMPATIBLE and as called in GM_ADVANCED', () => {
		for (const c of shapes) {
			const extra = c.mode === 1 ? 1 : 0;
			expect(c.rec).toEqual([c.box[0], c.box[1], c.box[2] - extra, c.box[3] - extra]);
		}
	});

	it('matches native playback of every record, whatever mode recorded it', () => {
		for (const [key, v] of Object.entries(counts)) expect(v.played, key).toBe(100);
	});

	it('matches the GM_ADVANCED call point for point at 1/16 pixel', () => {
		for (const pen of ['null', 'cosmetic', 'wide', 'geometric']) expect(counts[`adv-${pen}`].direct, pen).toBe(100);
	});
});
