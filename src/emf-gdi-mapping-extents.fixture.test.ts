/** Native ScaleWindowExtEx / ScaleViewportExtEx states and DIB polygon masks.
 * Regenerate with scripts/gdi-fixtures/MappingExtentProbe.cs. Every reference
 * covers the entire 96 x 96 surface, including pixels outside the drawing.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import {
	EMR_EOF, EMR_HEADER, EMR_POLYGON, EMR_SCALEVIEWPORTEXTEX, EMR_SCALEWINDOWEXTEX,
	EMR_SELECTOBJECT, EMR_SETMAPMODE, EMR_SETVIEWPORTEXTEX, EMR_SETVIEWPORTORGEX, EMR_SETWINDOWEXTEX,
} from './emf-constants';
import { handleEmfTransformRecord } from './emf-gdi-transform-handlers';
import { parseWmfHeader } from './emf-header-parser';
import { replayEmfRecords } from './emf-record-replay';
import { SoftwareRasterCanvas } from './software-raster';
import { createWmfPlayer, replayWmfRecords } from './wmf-replay';
import { scaleViewportExt, scaleWindowExt, type WmfMapping } from './wmf-mapping';

interface Capture {
	viewport: boolean;
	initial: [number, number, number, number];
	ratio: [number, number, number, number];
	success: boolean;
	extent: [number, number, number, number];
	origin: [number, number];
	spans: [number, number, number][];
}
const captures = JSON.parse(readFileSync(fixturePath('mapping-extents.json'), 'utf8')) as Capture[];
const largeCaptures = JSON.parse(readFileSync(fixturePath('mapping-extents-large.json'), 'utf8')) as Capture[];
const bounds = { left: 0, top: 0, right: 96, bottom: 96 };

function emfRecord(type: number, values: number[] = []): number[] {
	const bytes = new Uint8Array(8 + values.length * 4);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, type, true); view.setUint32(4, bytes.length, true);
	values.forEach((v, i) => view.setInt32(8 + i * 4, v, true));
	return Array.from(bytes);
}
function emf(c: Capture): DataView {
	const [wx, wy, vx, vy] = c.initial;
	return new DataView(new Uint8Array([
		...emfRecord(EMR_HEADER), ...emfRecord(EMR_SELECTOBJECT, [-2147483644]),
		...emfRecord(EMR_SELECTOBJECT, [-2147483640]), ...emfRecord(EMR_SETMAPMODE, [8]),
		...emfRecord(EMR_SETWINDOWEXTEX, [wx, wy]), ...emfRecord(EMR_SETVIEWPORTEXTEX, [vx, vy]),
		...emfRecord(EMR_SETVIEWPORTORGEX, c.origin),
		...emfRecord(c.viewport ? EMR_SCALEVIEWPORTEXTEX : EMR_SCALEWINDOWEXTEX, c.ratio),
		...emfRecord(EMR_POLYGON, [Math.min(0, c.extent[0]), Math.min(0, c.extent[1]), Math.max(0, c.extent[0]), Math.max(0, c.extent[1]), 4,
			0, 0, c.extent[0], 0, c.extent[0], c.extent[1], 0, c.extent[1]]), ...emfRecord(EMR_EOF),
	]).buffer);
}
function wmf(c: Capture): DataView {
	const [wx, wy, vx, vy] = c.initial;
	const [xn, xd, yn, yd] = c.ratio;
	const records: [number, number[]][] = [
		[0x0103, [8]], [0x020c, [wy, wx]], [0x020e, [vy, vx]], [0x020d, [c.origin[1], c.origin[0]]],
		[c.viewport ? 0x0412 : 0x0410, [yd, yn, xd, xn]],
		[0x02fc, [0, 0, 0, 0]], [0x02fa, [5, 0, 0, 0, 0]], [0x012d, [0]], [0x012d, [1]],
		[0x0324, [4, 0, 0, c.extent[0], 0, c.extent[0], c.extent[1], 0, c.extent[1]]], [0, []],
	];
	const bytes: number[] = new Array<number>(18).fill(0);
	bytes[0] = 1; bytes[2] = 9; bytes[5] = 3;
	for (const [type, params] of records) {
		const size = 3 + params.length;
		bytes.push(size & 255, (size >>> 8) & 255, 0, 0, type & 255, (type >>> 8) & 255,
			...params.flatMap((p) => [p & 255, (p >>> 8) & 255]));
	}
	return new DataView(new Uint8Array(bytes).buffer);
}
function spans(canvas: SoftwareRasterCanvas): number[][] {
	const pixels = canvas.ctx.getImageData(0, 0, 96, 96).data;
	const result: number[][] = [];
	for (let y = 0; y < 96; y++) {
		let start = -1;
		for (let x = 0; x <= 96; x++) {
			const painted = x < 96 && pixels[(y * 96 + x) * 4 + 3] !== 0;
			if (painted && start < 0) start = x;
			if (!painted && start >= 0) { result.push([y, start, x]); start = -1; }
		}
	}
	return result;
}

describe('rational extent scaling against native Windows', () => {
	it('matches all 276 native states in shared extent arithmetic and EMF handlers', () => {
		for (const [index, c] of [...captures, ...largeCaptures].entries()) {
			const [wx, wy, vx, vy] = c.initial;
			const m: WmfMapping = { mode: 8, winOrg: { x: 0, y: 0 }, vpOrg: { x: 48, y: 48 }, winExt: { cx: wx, cy: wy }, vpExt: { cx: vx, cy: vy } };
			(c.viewport ? scaleViewportExt : scaleWindowExt)(m, ...c.ratio);
			expect([m.winExt.cx, m.winExt.cy, m.vpExt.cx, m.vpExt.cy], `shared state #${index}`).toEqual(c.extent);
			const view = wmf(captures[0]);
			const ctx = createWmfPlayer(view, new SoftwareRasterCanvas(96, 96).ctx as never, parseWmfHeader(view)!, 96, 96).rCtx;
			ctx.mapMode = 8; ctx.windowExt = { cx: wx, cy: wy }; ctx.viewportExt = { cx: vx, cy: vy };
			ctx.view = new DataView(new Uint8Array(emfRecord(c.viewport ? EMR_SCALEVIEWPORTEXTEX : EMR_SCALEWINDOWEXTEX, c.ratio)).buffer);
			handleEmfTransformRecord(ctx, c.viewport ? EMR_SCALEVIEWPORTEXTEX : EMR_SCALEWINDOWEXTEX, 8, 24);
			expect([ctx.windowExt.cx, ctx.windowExt.cy, ctx.viewportExt.cx, ctx.viewportExt.cy], `EMF state #${index}`).toEqual(c.extent);
		}
	});
	it.each([EMR_SCALEWINDOWEXTEX, EMR_SCALEVIEWPORTEXTEX])('keeps bounds mapping inactive for ignored or rejected record %s', (type) => {
		for (const mode of [1, 8]) {
			for (const ratio of [[1, 0, 2, 1], [0, 1, 2, 1], [1, 2, 2, 1]]) {
				const view = wmf(captures[0]);
				const ctx = createWmfPlayer(view, new SoftwareRasterCanvas(96, 96).ctx as never, parseWmfHeader(view)!, 96, 96).rCtx;
				ctx.mapMode = mode; ctx.useMappingMode = false;
				ctx.windowExt = { cx: 1, cy: 1 }; ctx.viewportExt = { cx: 1, cy: 1 };
				ctx.view = new DataView(new Uint8Array(emfRecord(type, ratio)).buffer);
				handleEmfTransformRecord(ctx, type, 8, 24);
				expect(ctx.useMappingMode).toBe(false);
				expect(ctx.windowExt).toEqual({ cx: 1, cy: 1 });
				expect(ctx.viewportExt).toEqual({ cx: 1, cy: 1 });
			}
		}
	});
	it.each(['EMF', 'WMF'])('matches all 252 complete native polygon masks in %s replay', (format) => {
		const mismatches: number[] = [];
		for (const [index, c] of captures.entries()) {
			const canvas = new SoftwareRasterCanvas(96, 96);
			if (format === 'EMF') replayEmfRecords(emf(c), canvas.ctx as never, bounds, 96, 96, 1, { gdiAntialias: false });
			else {
				const view = wmf(c);
				replayWmfRecords(view, canvas.ctx as never, { ...parseWmfHeader(view)!, placeable: true, ...{ boundsLeft: 0, boundsTop: 0, boundsRight: 96, boundsBottom: 96, unitsPerInch: 96 } }, 96, 96, { gdiAntialias: false });
			}
			if (JSON.stringify(spans(canvas)) !== JSON.stringify(c.spans)) mismatches.push(index);
		}
		expect(mismatches).toEqual([]);
	});
});
