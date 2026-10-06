import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {expect,it} from 'vitest';
import {EMR_ROUNDRECT} from './emf-constants';
import {handleEmfGdiShapeRecord} from './emf-gdi-draw-shapes';
import {defaultState,type EmfGdiReplayCtx} from './emf-types';
interface Capture {direction:number;scale:number;width:number;corner:number[];box:number[];expected:number[]}
const captures:Capture[]=JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/roundrect-half-fix-translation.json.gz',import.meta.url))).toString());
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
	if (!handleEmfGdiShapeRecord(replay, EMR_ROUNDRECT, 8, 32)) throw new Error('handler');
	return replay.rasterPath!.getPath.pts;
}

it('preserves native translation covariance and matches every fractional RoundRect in the radius sweep exactly', () => {
	expect(captures).toHaveLength(576);
	for (const c of captures) {
		const base = captures.find((b) => b.direction === c.direction && b.scale === c.scale && b.corner[1] === c.corner[1] && b.box[0] === 20)!;
		const shift = (c.box[0] - 20) * c.scale;
		expect(c.expected).toEqual(base.expected.map((v, i) => v + (i % 3 === 0 ? shift : 0)));
		const native = c.expected.filter((_, i) => i % 3 !== 2);
		expect(recordedPath(c), JSON.stringify({ ...c, expected: undefined })).toEqual(native);
	}
});
