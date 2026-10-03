import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EMR_ROUNDRECT } from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { defaultState, type EmfGdiReplayCtx } from './emf-types';

interface Capture { direction: number; scale: number; width: number; corner: number[]; box: number[]; expected: number[] }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/roundrect-half-fix.json.gz', import.meta.url))).toString());

// Each native control retains its own coordinate ceiling, including every exact odd-FIX path.
const coordinateLimits: number[] = [4,12,4,4,4,4,4,4,0,0,0,0,4,8,4,4,4,4,4,4,0,0,0,0,4,4,4,12,4,8,4,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4,4,4,8,4,4,4,4,8,0,0,0,4,4,4,8,4,12,4,12,0,8,0,0,4,4,4,12,4,4,4,4,0,0,0,0,4,8,4,8,4,4,4,4,0,0,0,0,4,4,4,4,4,4,4,4,0,0,0,0,4,8,4,4,4,12,4,8,4,8,0,0,4,4,4,4,4,4,4,4,0,0,8,0,4,4,4,4,4,4,4,4,0,0,0,0,8,8,4,4,4,8,4,4,0,4,12,0,4,8,4,8,4,4,4,12,0,0,0,0,4,4,4,4,4,4,4,4,0,0,0,0,4,4,4,4,4,12,4,4,0,0,0,0,4,4,4,4,4,4,4,4,0,0,0,0,4,4,4,4,4,4,4,4,0,0,0,0,4,4,4,4,4,4,4,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4,4,4,4,4,4,4,4,4,0,0,0,4,4,4,4,4,4,4,12,0,8,0,0,4,4,4,4,4,4,4,4,0,0,0,0,4,4,4,4,4,4,4,4,0,0,8,0,4,12,4,4,4,8,4,4,0,0,0,0,4,4,4,12,4,4,4,8,8,8,0,0,4,12,4,4,4,12,4,4,0,0,0,0,4,4,4,4,4,4,4,4,0,0,0,0,8,4,4,4,4,8,4,4,0,4,4,0,4,4,4,4,4,8,4,12,0,0,8,0,4,4,4,4,4,4,4,4,0,0,4,0,4,8,4,4,4,12,4,4,0,0,0,0];

function recordedPath(c: Capture): number[] {
	const view = new DataView(new ArrayBuffer(32));
	[...c.box, ...c.corner].forEach((v, i) => view.setInt32(8 + i * 4, v, true));
	const nop = () => {};
	const ctx = { moveTo: nop, lineTo: nop, bezierCurveTo: nop, closePath: nop };
	const state = defaultState();
	state.penWidth = c.width;
	state.penStyle = 6;
	state.arcDirection = c.direction;
	const replay: EmfGdiReplayCtx = {
		ctx: ctx as unknown as CanvasRenderingContext2D, view, objectTable: new Map(), state, stateStack: [], inPath: true,
		windowOrg: { x: 0, y: 0 }, windowExt: { cx: 16, cy: 16 }, viewportOrg: { x: 0, y: 0 }, viewportExt: { cx: c.scale, cy: c.scale },
		useMappingMode: true, clipSaveDepth: 0, bounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
		canvasW: 1000, canvasH: 1000, sx: 1, sy: 1, pathCmds: [],
	};
	expect(handleEmfGdiShapeRecord(replay, EMR_ROUNDRECT, 8, 32)).toBe(true);
	return replay.rasterPath!.getPath.pts;
}

describe('public native inside-frame RoundRect paths at fractional device scales', () => {
	it.each([1, 2])('retains exact even-FIX controls and bounds each odd-FIX coordinate in arc direction %i', direction => {
		const controls = captures.filter(c => c.direction === direction);
		expect(controls).toHaveLength(216);
		let exact = 0, differingCoordinates = 0, even = 0;
		for (const c of controls) {
			const ours = recordedPath(c);
			const native = c.expected.filter((_, i) => i % 3 !== 2);
			expect(ours).toHaveLength(native.length);
			const differences = ours.map((v, i) => Math.abs(v - native[i]));
			// Remaining one-FIX side-point and corner-end ties are unresolved;
			// no new case may exceed this measured coordinate bound.
			expect(Math.max(...differences), JSON.stringify({ ...c, expected: undefined })).toBeLessThanOrEqual(1);
			const changed = differences.filter(v => v !== 0).length;
			expect(changed, JSON.stringify({ ...c, expected: undefined })).toBeLessThanOrEqual(coordinateLimits[captures.indexOf(c)]);
			differingCoordinates += changed;
			if (!differences.some(v => v !== 0)) exact++;
			if ((c.width * c.scale) % 2 === 0) {
				expect(ours).toEqual(native);
				even++;
			}
		}
		expect(even).toBe(36);
		expect(exact).toBeGreaterThanOrEqual(direction === 1 ? 89 : 87);
		expect(differingCoordinates).toBeLessThanOrEqual(direction === 1 ? 648 : 616);
	});
});
