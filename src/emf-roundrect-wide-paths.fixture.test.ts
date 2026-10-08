/**
 * Native `GetPath` in `GM_COMPATIBLE` of RoundRect at the identity scale under a null pen, a one-pixel cosmetic pen, a wide plain
 * pen and a wide geometric pen (`emf-roundrect-wide-probe`, 1,800 shapes of 450 per pen, a quarter of them `AD_CLOCKWISE`). The
 * EMF record holds the call's right and bottom edge less one pixel, which is where the path ends. GDI builds the corner ellipse on
 * the call's box (the record's with that pixel back), then scales it onto the drawn box, truncating to whole FIX under a wide pen.
 * This is the geometry of the call drawn straight onto a device, not of the metafile it records: `PlayEnhMetaFile` draws the record
 * unscaled whatever mode it was recorded in (`emf-roundrect-mode.fixture.test.ts`), so the converter no longer applies this
 * scaling and this capture now pins how far playback is from it.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { EMR_ROUNDRECT } from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { defaultState, type EmfGdiReplayCtx } from './emf-types';

interface NativeShape {
	pen: number;
	scale: number;
	dir: number;
	pw: number;
	box: [number, number, number, number];
	corner: [number, number];
	pts: number[];
}

const shapes = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/emf-roundrect-wide-paths.json.gz', import.meta.url))).toString()) as NativeShape[];

/** Our path as `[x, y, type]` triples. */
function oursOf(c: NativeShape): number[] {
	// The recorded box is inclusive: GDI stores the call's right and bottom less one.
	const ints = [c.box[0], c.box[1], c.box[2] - 1, c.box[3] - 1, ...c.corner];
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
	expect(handleEmfGdiShapeRecord(replay, EMR_ROUNDRECT, 8, 8 + ints.length * 4)).toBe(true);
	const g = replay.rasterPath?.getPath;
	return g ? g.pts.flatMap((v, i) => (i % 2 === 1 ? [v, g.types[(i - 1) / 2]] : [v])) : [];
}

describe('EMF RoundRect under cosmetic and wide pens against native GetPath', () => {
	const counts: Record<string, { exact: number; total: number }> = {};
	for (const c of shapes) {
		const entry = (counts[['null', 'cosmetic', 'wide', 'geometric'][c.pen]] ??= { exact: 0, total: 0 });
		entry.total++;
		if (JSON.stringify(oursOf(c)) === JSON.stringify(c.pts)) entry.exact++;
	}

	it('captures 450 shapes of each pen kind', () => {
		for (const v of Object.values(counts)) expect(v.total).toBe(450);
	});

	it('differs from playback under every pen that scales its corner', () => {
		// What a GM_COMPATIBLE application sees drawing straight onto a device is not what PlayEnhMetaFile draws from the record it
		// leaves (emf-roundrect-mode.fixture.test.ts): our playback path equals the direct one in only these few shapes.
		expect(counts).toEqual({ null: { exact: 0, total: 450 }, cosmetic: { exact: 11, total: 450 }, wide: { exact: 13, total: 450 }, geometric: { exact: 19, total: 450 } });
	});

});
