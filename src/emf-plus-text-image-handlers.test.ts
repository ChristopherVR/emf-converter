import { describe, it, expect, vi, expectTypeOf } from 'vitest';

import {
	EMFPLUS_FILLPATH,
	EMFPLUS_DRAWPATH,
	EMFPLUS_DRAWSTRING,
	EMFPLUS_DRAWDRIVERSTRING,
	EMFPLUS_DRAWIMAGE,
	EMFPLUS_DRAWIMAGEPOINTS,
} from './emf-constants';
import { handleEmfPlusTextImageRecord } from './emf-plus-text-image-handlers';
import type { EmfPlusReplayCtx, TransformMatrix } from './emf-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtxStub(): Record<string, unknown> {
	return {
		save: vi.fn<() => void>(),
		restore: vi.fn<() => void>(),
		beginPath: vi.fn<() => void>(),
		closePath: vi.fn<() => void>(),
		rect: vi.fn<() => void>(),
		clip: vi.fn<() => void>(),
		setTransform: vi.fn<() => void>(),
		fill: vi.fn<() => void>(),
		stroke: vi.fn<() => void>(),
		fillRect: vi.fn<() => void>(),
		strokeRect: vi.fn<() => void>(),
		setLineDash: vi.fn<() => void>(),
		ellipse: vi.fn<() => void>(),
		moveTo: vi.fn<() => void>(),
		lineTo: vi.fn<() => void>(),
		bezierCurveTo: vi.fn<() => void>(),
		fillText: vi.fn<() => void>(),
		strokeStyle: '#000',
		fillStyle: '#fff',
		lineWidth: 1,
		font: '12px sans-serif',
		textBaseline: 'top',
		textAlign: 'left',
	};
}

function makeRCtx(bufSize = 1024): EmfPlusReplayCtx {
	const buf = new ArrayBuffer(bufSize);
	const view = new DataView(buf);
	return {
		ctx: makeCtxStub() as unknown as CanvasRenderingContext2D,
		view,
		objectTable: new Map(),
		worldTransform: [1, 0, 0, 1, 0, 0] as TransformMatrix,
		deferredImages: [],
		saveStack: [],
		saveIdMap: new Map(),
		totalImageObjects: 0,
		totalDrawImageCalls: 0,
		clipSaveDepth: 0,
		pageUnit: 2,
		pageScale: 1,
		continuationBuffer: null,
		continuationObjectId: 0,
		continuationObjectType: 0,
		continuationTotalSize: 0,
		continuationOffset: 0,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emf-plus-text-image-handlers', () => {
	describe('handleEmfPlusTextImageRecord()', () => {
		it('is a function with arity 5', () => {
			expectTypeOf(handleEmfPlusTextImageRecord).toBeFunction();
			expect(handleEmfPlusTextImageRecord).toHaveLength(5);
		});

		it('returns false for unrecognized record type', () => {
			const rCtx = makeRCtx();
			expect(handleEmfPlusTextImageRecord(rCtx, 0xffff, 0, 8, 8)).toBeFalsy();
		});

		// -- FILLPATH --
		describe('eMFPLUS_FILLPATH', () => {
			it('fills a path from the object table', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(5, {
					kind: 'plus-path',
					points: [
						{ x: 0, y: 0 },
						{ x: 10, y: 0 },
						{ x: 10, y: 10 },
					],
					types: new Uint8Array([0, 1, 1]),
				});
				const d = 8;
				rCtx.view.setUint32(d, 0xff000000, true); // brush (black)
				const flags = 0x8000 | 5; // inline brush, pathId=5
				const result = handleEmfPlusTextImageRecord(rCtx, EMFPLUS_FILLPATH, flags, d, 4);
				expect(result).toBeTruthy();
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fill).toHaveBeenCalledOnce();
			});

			it('does nothing when path not found', () => {
				const rCtx = makeRCtx();
				const d = 8;
				rCtx.view.setUint32(d, 0xff000000, true);
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_FILLPATH, 0x8000 | 99, d, 4);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fill).not.toHaveBeenCalled();
			});

			it('returns true if recDataSize < 4', () => {
				const rCtx = makeRCtx();
				expect(handleEmfPlusTextImageRecord(rCtx, EMFPLUS_FILLPATH, 0, 8, 2)).toBeTruthy();
			});
		});

		// -- DRAWPATH --
		describe('eMFPLUS_DRAWPATH', () => {
			it('strokes a path using a pen from the object table', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(3, {
					kind: 'plus-path',
					points: [
						{ x: 0, y: 0 },
						{ x: 50, y: 50 },
					],
					types: new Uint8Array([0, 1]),
				});
				rCtx.objectTable.set(7, {
					kind: 'plus-pen',
					color: '#ff0000',
					width: 3,
					dashStyle: 0,
				});
				const d = 8;
				rCtx.view.setUint32(d, 7, true); // penIndex
				const flags = 3; // pathId = 3
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWPATH, flags, d, 4);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.stroke).toHaveBeenCalledOnce();
			});
		});

		// -- DRAWSTRING --
		describe('eMFPLUS_DRAWSTRING', () => {
			it('draws a string when font and text are valid', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(1, {
					kind: 'plus-font',
					emSize: 14,
					flags: 0,
					family: 'Arial',
				});
				const d = 8;
				rCtx.view.setUint32(d, 0xff000000, true); // brush
				rCtx.view.setUint32(d + 4, 0xffff, true); // formatId (no format)
				const text = 'Hi';
				rCtx.view.setUint32(d + 8, text.length, true); // strLen
				rCtx.view.setFloat32(d + 12, 10, true); // layoutX
				rCtx.view.setFloat32(d + 16, 20, true); // layoutY
				rCtx.view.setFloat32(d + 20, 100, true); // layoutW
				rCtx.view.setFloat32(d + 24, 50, true); // layoutH
				// Write UTF-16LE string at d + 28
				for (let i = 0; i < text.length; i++) {
					rCtx.view.setUint16(d + 28 + i * 2, text.charCodeAt(i), true);
				}
				const flags = 0x8000 | 1; // inline brush, fontId=1
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWSTRING, flags, d, 28 + text.length * 2);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillText).toHaveBeenCalledOnce();
				expect(ctx.fillText.mock.calls[0][0]).toBe('Hi');
			});

			it('applies string format alignment (center)', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(1, { kind: 'plus-font', emSize: 12, flags: 0, family: 'Arial' });
				rCtx.objectTable.set(10, {
					kind: 'plus-stringformat',
					flags: 0,
					alignment: 1,
					lineAlignment: 0,
				});
				const d = 8;
				rCtx.view.setUint32(d, 0xff000000, true);
				rCtx.view.setUint32(d + 4, 10, true); // formatId
				rCtx.view.setUint32(d + 8, 1, true); // strLen
				rCtx.view.setFloat32(d + 12, 0, true);
				rCtx.view.setFloat32(d + 16, 0, true);
				rCtx.view.setFloat32(d + 20, 100, true);
				rCtx.view.setFloat32(d + 24, 50, true);
				rCtx.view.setUint16(d + 28, 65, true); // 'A'
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWSTRING, 0x8000 | 1, d, 30);
				expect((rCtx.ctx as unknown as Record<string, string>).textAlign).toBe('center');
			});

			it('ignores if recDataSize < 28', () => {
				const rCtx = makeRCtx();
				expect(handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWSTRING, 0, 8, 20)).toBeTruthy();
			});

			it('applies bold/italic from font flags', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(2, {
					kind: 'plus-font',
					emSize: 16,
					flags: 3, // Bold | Italic
					family: 'Times',
				});
				const d = 8;
				rCtx.view.setUint32(d, 0xff000000, true);
				rCtx.view.setUint32(d + 4, 0xffff, true);
				rCtx.view.setUint32(d + 8, 1, true);
				rCtx.view.setFloat32(d + 12, 0, true);
				rCtx.view.setFloat32(d + 16, 0, true);
				rCtx.view.setFloat32(d + 20, 100, true);
				rCtx.view.setFloat32(d + 24, 50, true);
				rCtx.view.setUint16(d + 28, 88, true); // 'X'
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWSTRING, 0x8000 | 2, d, 30);
				expect((rCtx.ctx as unknown as Record<string, string>).font).toContain('italic');
				expect((rCtx.ctx as unknown as Record<string, string>).font).toContain('bold');
			});
		});

		// -- DRAWDRIVERSTRING --
		describe('eMFPLUS_DRAWDRIVERSTRING', () => {
			/** A DrawDriverString record at `d`; returns its data size. */
			function writeDriverString(
				rCtx: EmfPlusReplayCtx,
				d: number,
				text: string,
				positions: Array<[number, number]>,
				options = 1,
				matrix?: number[],
			): number {
				const v = rCtx.view;
				v.setUint32(d, 0xff000000, true); // brush
				v.setUint32(d + 4, options, true);
				v.setUint32(d + 8, matrix ? 1 : 0, true);
				v.setUint32(d + 12, text.length, true);
				let o = d + 16;
				for (let i = 0; i < text.length; i++, o += 2) {
					v.setUint16(o, text.charCodeAt(i), true);
				}
				// Positions follow the glyphs directly, with no padding.
				for (const [x, y] of positions) {
					v.setFloat32(o, x, true);
					v.setFloat32(o + 4, y, true);
					o += 8;
				}
				for (const n of matrix ?? []) {
					v.setFloat32(o, n, true);
					o += 4;
				}
				return o - d;
			}

			it('draws each glyph at its own position', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(0, { kind: 'plus-font', emSize: 12, flags: 0, family: 'Arial' });
				const size = writeDriverString(rCtx, 8, 'AB', [[5, 15], [20, 15]]);
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWDRIVERSTRING, 0x8000, 8, size);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillText.mock.calls).toEqual([['A', 5, 15], ['B', 20, 15]]);
			});

			it('reads the positions unpadded after an odd number of glyphs', () => {
				const rCtx = makeRCtx(512);
				rCtx.objectTable.set(0, { kind: 'plus-font', emSize: 12, flags: 0, family: 'Arial' });
				const size = writeDriverString(rCtx, 8, 'ABC', [[5, 15], [20, 15], [35, 15]]);
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWDRIVERSTRING, 0x8000, 8, size);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillText.mock.calls).toEqual([['A', 5, 15], ['B', 20, 15], ['C', 35, 15]]);
			});

			it('draws the whole run from the first position under RealizedAdvance', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(0, { kind: 'plus-font', emSize: 12, flags: 0, family: 'Arial' });
				const size = writeDriverString(rCtx, 8, 'AB', [[5, 15], [0, 0]], 0x5);
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWDRIVERSTRING, 0x8000, 8, size);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillText.mock.calls).toEqual([['AB', 5, 15]]);
			});

			it('skips glyph indices without the font engine', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(0, { kind: 'plus-font', emSize: 12, flags: 0, family: 'Arial' });
				const size = writeDriverString(rCtx, 8, 'AB', [[5, 15], [20, 15]], 0);
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWDRIVERSTRING, 0x8000, 8, size);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillText).not.toHaveBeenCalled();
			});

			it('applies the TransformMatrix for the record only', () => {
				const scaleX = (matrix?: number[]): { a: unknown; world: TransformMatrix; before: TransformMatrix } => {
					const rCtx = makeRCtx();
					rCtx.objectTable.set(0, { kind: 'plus-font', emSize: 12, flags: 0, family: 'Arial' });
					const before = [...rCtx.worldTransform] as TransformMatrix;
					const size = writeDriverString(rCtx, 8, 'A', [[5, 15]], 1, matrix);
					handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWDRIVERSTRING, 0x8000, 8, size);
					const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
					return { a: ctx.setTransform.mock.calls.at(-1)?.[0], world: rCtx.worldTransform, before };
				};
				const plain = scaleX();
				const scaled = scaleX([2, 0, 0, 2, 10, 0]);
				expect(scaled.a).toBe(2 * (plain.a as number));
				expect(scaled.world).toEqual(scaled.before);
			});

			it('ignores if recDataSize < 16', () => {
				const rCtx = makeRCtx();
				expect(handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWDRIVERSTRING, 0, 8, 8)).toBeTruthy();
			});
		});

		// -- DRAWIMAGE --
		describe('eMFPLUS_DRAWIMAGE', () => {
			it('queues a deferred image draw with compressed rect', () => {
				const rCtx = makeRCtx();
				const imgData = new ArrayBuffer(10);
				rCtx.objectTable.set(2, { kind: 'plus-image', data: imgData, type: 1 });
				const d = 8;
				// 24 bytes before rect
				for (let i = 0; i < 24; i++) {
					rCtx.view.setUint8(d + i, 0);
				}
				// compressed rect at d + 24
				rCtx.view.setInt16(d + 24, 10, true);
				rCtx.view.setInt16(d + 26, 20, true);
				rCtx.view.setInt16(d + 28, 100, true);
				rCtx.view.setInt16(d + 30, 80, true);
				const flags = 2 | 0x4000; // imgId=2, compressed
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWIMAGE, flags, d, 32);
				expect(rCtx.deferredImages).toHaveLength(1);
				expect(rCtx.deferredImages[0].dx).toBe(10);
				expect(rCtx.deferredImages[0].dw).toBe(100);
				expect(rCtx.totalDrawImageCalls).toBe(1);
			});

			it('skips when image object has no data', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(1, { kind: 'plus-image', data: null, type: 1 });
				const d = 8;
				for (let i = 0; i < 24; i++) {
					rCtx.view.setUint8(d + i, 0);
				}
				rCtx.view.setInt16(d + 24, 0, true);
				rCtx.view.setInt16(d + 26, 0, true);
				rCtx.view.setInt16(d + 28, 50, true);
				rCtx.view.setInt16(d + 30, 50, true);
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWIMAGE, 1 | 0x4000, d, 32);
				expect(rCtx.deferredImages).toHaveLength(0);
				expect(rCtx.totalDrawImageCalls).toBe(1);
			});

			it('marks isMetafile when image type is 2', () => {
				const rCtx = makeRCtx();
				const imgData = new ArrayBuffer(10);
				rCtx.objectTable.set(0, { kind: 'plus-image', data: imgData, type: 2 });
				const d = 8;
				for (let i = 0; i < 24; i++) {
					rCtx.view.setUint8(d + i, 0);
				}
				rCtx.view.setInt16(d + 24, 0, true);
				rCtx.view.setInt16(d + 26, 0, true);
				rCtx.view.setInt16(d + 28, 50, true);
				rCtx.view.setInt16(d + 30, 50, true);
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWIMAGE, 0x4000, d, 32);
				expect(rCtx.deferredImages[0].isMetafile).toBeTruthy();
			});

			it('ignores if recDataSize < 24', () => {
				const rCtx = makeRCtx();
				expect(handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWIMAGE, 0, 8, 16)).toBeTruthy();
			});
		});

		// -- DRAWIMAGEPOINTS --
		describe('eMFPLUS_DRAWIMAGEPOINTS', () => {
			it('queues a deferred image draw from 3 compressed points', () => {
				const rCtx = makeRCtx();
				const imgData = new ArrayBuffer(10);
				rCtx.objectTable.set(1, { kind: 'plus-image', data: imgData, type: 1 });
				const d = 8;
				// 24 bytes header
				for (let i = 0; i < 24; i++) {
					rCtx.view.setUint8(d + i, 0);
				}
				rCtx.view.setUint32(d + 24, 3, true); // count
				// 3 compressed points at d + 28
				rCtx.view.setInt16(d + 28, 0, true); // p1x
				rCtx.view.setInt16(d + 30, 0, true); // p1y
				rCtx.view.setInt16(d + 32, 100, true); // p2x
				rCtx.view.setInt16(d + 34, 0, true); // p2y
				rCtx.view.setInt16(d + 36, 0, true); // p3x
				rCtx.view.setInt16(d + 38, 80, true); // p3y
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWIMAGEPOINTS, 1 | 0x4000, d, 40);
				expect(rCtx.deferredImages).toHaveLength(1);
				expect(rCtx.deferredImages[0].dx).toBe(0);
				expect(rCtx.deferredImages[0].dy).toBe(0);
				expect(rCtx.deferredImages[0].dw).toBe(100);
				expect(rCtx.deferredImages[0].dh).toBe(80);
			});

			it('skips when count < 3', () => {
				const rCtx = makeRCtx();
				rCtx.objectTable.set(0, { kind: 'plus-image', data: new ArrayBuffer(10), type: 1 });
				const d = 8;
				for (let i = 0; i < 24; i++) {
					rCtx.view.setUint8(d + i, 0);
				}
				rCtx.view.setUint32(d + 24, 2, true); // count < 3
				handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWIMAGEPOINTS, 0x4000, d, 40);
				expect(rCtx.deferredImages).toHaveLength(0);
			});

			it('ignores if recDataSize < 28', () => {
				const rCtx = makeRCtx();
				expect(handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWIMAGEPOINTS, 0, 8, 20)).toBeTruthy();
			});
		});
	});
});
