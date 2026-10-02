/**
 * Generated classic-GDI records. These exercise SVG coordinates and real
 * @napi-rs/canvas pixels, rather than merely inspecting replay state.
 * Semantics: Microsoft SetMapMode, SetWindowExtEx, SaveDC, RestoreDC and
 * https://learn.microsoft.com/en-us/windows/win32/gdi/default-transformations
 */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import {
	EMR_BEGINPATH, EMR_ENDPATH, EMR_FILLPATH, EMR_EOF, EMR_HEADER, EMR_POLYGON, EMR_RESTOREDC, EMR_SAVEDC,
	EMR_SCALEVIEWPORTEXTEX, EMR_SCALEWINDOWEXTEX, EMR_SELECTOBJECT,
	EMR_SETMAPMODE, EMR_SETVIEWPORTEXTEX, EMR_SETVIEWPORTORGEX,
	EMR_SETWINDOWEXTEX, EMR_SETWINDOWORGEX, EMR_SETWORLDTRANSFORM,
} from './emf-constants';
import { convertMetafileToSvgTree } from './emf-converter';
import { replayEmfRecords } from './emf-record-replay';
import { SvgContext } from './svg-context';
import type { SvgNode } from './svg-tree';
import type { CanvasContext, EmfBounds } from './emf-types';

type Box = [number, number, number, number];
function record(type: number, words: number[] = [], floats = false): Uint8Array {
	const bytes = new Uint8Array(8 + words.length * 4);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, type, true);
	view.setUint32(4, bytes.length, true);
	words.forEach((value, i) => {
		if (floats) view.setFloat32(8 + i * 4, value, true);
		else view.setUint32(8 + i * 4, value, true);
	});
	return bytes;
}
function recordsView(records: Uint8Array[], header = record(EMR_HEADER)): DataView {
	const all = [header, record(EMR_SELECTOBJECT, [0x80000004]), // BLACK_BRUSH
		record(EMR_SELECTOBJECT, [0x80000008]), ...records, record(EMR_EOF)]; // NULL_PEN
	const bytes = new Uint8Array(all.reduce((sum, r) => sum + r.length, 0));
	let offset = 0;
	for (const r of all) { bytes.set(r, offset); offset += r.length; }
	return new DataView(bytes.buffer);
}
const polygon = () => record(EMR_POLYGON, [10, 10, 20, 20, 4, 10, 10, 20, 10, 20, 20, 10, 20]);
const mode = (n: number) => record(EMR_SETMAPMODE, [n]);
const win = (x: number, y = x) => record(EMR_SETWINDOWEXTEX, [x, y]);
const vp = (x: number, y = x) => record(EMR_SETVIEWPORTEXTEX, [x, y]);
const save = () => record(EMR_SAVEDC);
const restore = (n = -1) => record(EMR_RESTOREDC, [n]);

function fillBounds(tree: SvgNode): Box[] {
	const result: Box[] = [];
	function visit(node: SvgNode) {
		if (node.tag === 'path' && node.attrs.fill === '#000000') {
			// Decode the absolute/relative straight-line commands emitted by
			// SVG's path compactor, independently of the mapping implementation.
			const d = String(node.attrs.d);
			expect(d).toMatch(/^[MmLlHhVvZz\d., -]+$/);
			let x = 0, y = 0;
			const xs: number[] = [], ys: number[] = [];
			for (const match of d.matchAll(/([MmLlHhVvZz])([^MmLlHhVvZz]*)/g)) {
				const cmd = match[1], relative = cmd === cmd.toLowerCase();
				const values = (match[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
				for (let i = 0; i < values.length;) {
					if (cmd.toLowerCase() === 'h') x = (relative ? x : 0) + values[i++];
					else if (cmd.toLowerCase() === 'v') y = (relative ? y : 0) + values[i++];
					else {
						x = (relative ? x : 0) + values[i++];
						y = (relative ? y : 0) + values[i++];
					}
					xs.push(x); ys.push(y);
				}
			}
			result.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
		}
		node.children?.forEach(visit);
	}
	visit(tree);
	return result;
}

async function assertReplay(
	records: Uint8Array[], expected: Box[],
	bounds: EmfBounds = { left: 0, top: 0, right: 100, bottom: 100 }, size = 100,
): Promise<void> {
	const view = recordsView(records);
	const svg = new SvgContext(size, size);
	replayEmfRecords(view, svg as unknown as CanvasContext, bounds, size, size, 1, { gdiAntialias: true });
	expect(fillBounds(await svg.toTree())).toEqual(expected);
	const canvas = createCanvas(size, size);
	const ctx = canvas.getContext('2d');
	replayEmfRecords(view, ctx as unknown as CanvasContext, bounds, size, size, 1, { gdiAntialias: true });
	const pixels = ctx.getImageData(0, 0, size, size).data;
	// All expected shapes have integral axis-aligned device bounds: assert
	// the whole alpha mask, including empty pixels outside each mapped box.
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const inside = expected.some(([l, t, r, b]) => x >= l && x < r && y >= t && y < b);
			expect(pixels[(y * size + x) * 4 + 3], `alpha at ${x},${y}`).toBe(inside ? 255 : 0);
		}
	}
}

describe('classic GDI mapping record replay', () => {
	it.each([{ setup: [] }, { setup: [mode(1)] }])('ignores extent and scale records in default/explicit MM_TEXT (%#)', async ({ setup }) => {
		await assertReplay([...setup, win(1), vp(2),
			record(EMR_SCALEWINDOWEXTEX, [2, 1, 3, 1]),
			record(EMR_SCALEVIEWPORTEXTEX, [4, 1, 5, 1]), polygon()], [[10, 10, 20, 20]]);
	});
	it('resets anisotropic extents when switching back to MM_TEXT', async () => {
		await assertReplay([mode(8), win(1), vp(2), mode(1), polygon()], [[10, 10, 20, 20]]);
	});
	it('does not revive old anisotropic extents after a round trip through MM_TEXT', async () => {
		await assertReplay([mode(8), win(1), vp(2), mode(1), mode(8), polygon()], [[10, 10, 20, 20]]);
	});
	it.each([
		{ setup: [vp(2)], expected: [20, 20, 40, 40] as Box },
		{ setup: [win(2)], expected: [5, 5, 10, 10] as Box },
	])('uses GDI default 1×1 extents for partial anisotropic setup (%#)', async ({ setup, expected }) => {
		await assertReplay([mode(8), ...setup, polygon()], [expected]);
	});
	it('restores saved mapping extents instead of retaining mutations', async () => {
		await assertReplay([mode(8), win(1), vp(1), save(), vp(2), restore(), polygon()], [[10, 10, 20, 20]]);
	});
	it('restores saved extents after in-place rational scaling', async () => {
		await assertReplay([mode(8), win(1), vp(1), save(),
			record(EMR_SCALEWINDOWEXTEX, [2, 1, 2, 1]),
			record(EMR_SCALEVIEWPORTEXTEX, [6, 1, 6, 1]), restore(), polygon()], [[10, 10, 20, 20]]);
	});
	it('retains signed anisotropic axes', async () => {
		await assertReplay([mode(8), win(1), vp(-2, 2), record(EMR_SETVIEWPORTORGEX, [60, 0]), polygon()],
			[[20, 20, 40, 40]]);
	});
	it('restores default MM_TEXT and ignores subsequent extent setters', async () => {
		await assertReplay([save(), mode(8), vp(2), restore(), vp(3), polygon()], [[10, 10, 20, 20]]);
	});
	it('restores mapping origins, mode, extents and world transform together', async () => {
		await assertReplay([mode(8), win(2), vp(4, 6),
			record(EMR_SETWINDOWORGEX, [5, 6]), record(EMR_SETVIEWPORTORGEX, [30, 40]),
			record(EMR_SETWORLDTRANSFORM, [1, 0, 0, 1, 2, 3], true), save(), mode(1),
			record(EMR_SETWINDOWORGEX, [0, 0]), record(EMR_SETVIEWPORTORGEX, [0, 0]),
			record(EMR_SETWORLDTRANSFORM, [1, 0, 0, 1, 0, 0], true), restore(), polygon()], [[44, 61, 64, 91]]);
	});
	it.each([-2, 1])('restores the addressed save and removes younger mapping states (%s)', async (level) => {
		await assertReplay([mode(8), win(1), vp(1), save(), vp(2), save(), vp(3),
			restore(level), polygon()], [[10, 10, 20, 20]]);
	});
	it.each([0, 2, -2])('ignores an invalid RestoreDC level without popping state (%s)', async (level) => {
		await assertReplay([mode(8), win(1), vp(1), save(), vp(2), restore(level), polygon(),
			restore(), polygon()], [[20, 20, 40, 40], [10, 10, 20, 20]]);
	});
	it('composes full affine mapping with nonzero bounds and reduced output size', async () => {
		await assertReplay([mode(8), win(1), vp(2),
			record(EMR_SETWORLDTRANSFORM, [0, 1, -1, 0, 40, 0], true),
			record(EMR_BEGINPATH), polygon(), record(EMR_ENDPATH),
			// A completed path is already in device space; changing the world
			// transform before FillPath must not transform it a second time.
			record(EMR_SETWORLDTRANSFORM, [1, 0, 0, 1, 0, 0], true), record(EMR_FILLPATH, [0, 0, 100, 100])],
			[[10, 5, 20, 15]], { left: 20, top: 10, right: 120, bottom: 110 }, 50);
	});
	it('composes explicit mapping with public maxWidth and inclusive nonzero header bounds', async () => {
		const header = record(EMR_HEADER, new Array<number>(20).fill(0));
		const view = recordsView([mode(8), win(1), vp(2), polygon()], header);
		for (const [offset, value] of [
			[8, 20], [12, 10], [16, 119], [20, 109], [32, 2540], [36, 2540],
			[40, 0x464d4520], [44, 0x10000], [48, view.byteLength], [52, 8],
			[72, 1000], [76, 1000], [80, 254], [84, 254],
		]) view.setUint32(offset, value, true);
		const tree = await convertMetafileToSvgTree(view.buffer as ArrayBuffer, { maxWidth: 50, dpiScale: 1, exactRasterOps: false });
		expect(tree).not.toBeNull();
		expect(tree!.attrs.width).toBe(50);
		expect(tree!.attrs.height).toBe(50);
		expect(fillBounds(tree!)).toEqual([[0, 5, 10, 15]]);
	});
	it('keeps MM_TEXT origins when resetting the scaling', async () => {
		await assertReplay([mode(8), win(1), vp(2), record(EMR_SETWINDOWORGEX, [5, 5]),
			record(EMR_SETVIEWPORTORGEX, [10, 10]), mode(1), polygon()], [[15, 15, 25, 25]]);
	});
});
