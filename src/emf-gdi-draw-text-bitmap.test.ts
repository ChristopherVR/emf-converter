import { describe, it, expect, vi, expectTypeOf } from 'vitest';

import {
	EMR_EXTTEXTOUTW,
	EMR_BITBLT,
	EMR_STRETCHDIBITS,
	EMR_INTERSECTCLIPRECT,
	EMR_EXTSELECTCLIPRGN,
	EMR_EXCLUDECLIPRECT,
	EMR_OFFSETCLIPRGN,
} from './emf-constants';
import { handleEmfGdiTextBitmapRecord } from './emf-gdi-draw-text-bitmap';
import { defaultState } from './emf-types';
import type { EmfGdiReplayCtx } from './emf-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtxStub(): Record<string, unknown> {
	return {
		save: vi.fn<() => void>(),
		restore: vi.fn<() => void>(),
		beginPath: vi.fn<() => void>(),
		closePath: vi.fn<() => void>(),
		moveTo: vi.fn<() => void>(),
		lineTo: vi.fn<() => void>(),
		bezierCurveTo: vi.fn<() => void>(),
		arc: vi.fn<() => void>(),
		ellipse: vi.fn<() => void>(),
		rect: vi.fn<() => void>(),
		fill: vi.fn<() => void>(),
		stroke: vi.fn<() => void>(),
		fillRect: vi.fn<() => void>(),
		strokeRect: vi.fn<() => void>(),
		clip: vi.fn<() => void>(),
		setTransform: vi.fn<() => void>(),
		setLineDash: vi.fn<() => void>(),
		fillText: vi.fn<() => void>(),
		drawImage: vi.fn<() => void>(),
		putImageData: vi.fn<() => void>(),
		getImageData: vi.fn<() => void>(),
		translate: vi.fn<() => void>(),
		rotate: vi.fn<() => void>(),
		measureText: vi.fn(() => ({ width: 50 })),
		strokeStyle: '#000000',
		fillStyle: '#ffffff',
		lineWidth: 1,
		font: '12px sans-serif',
		textBaseline: 'top' as string,
		textAlign: 'left' as string,
		globalCompositeOperation: 'source-over' as string,
	};
}

function makeRCtx(bufSize = 1024): EmfGdiReplayCtx {
	const buf = new ArrayBuffer(bufSize);
	const view = new DataView(buf);
	const ctx = makeCtxStub();
	return {
		ctx: ctx as unknown as CanvasRenderingContext2D,
		view,
		objectTable: new Map(),
		state: defaultState(),
		stateStack: [],
		inPath: false,
		windowOrg: { x: 0, y: 0 },
		windowExt: { cx: 1000, cy: 1000 },
		viewportOrg: { x: 0, y: 0 },
		viewportExt: { cx: 1000, cy: 1000 },
		useMappingMode: false,
		clipSaveDepth: 0,
		bounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
		canvasW: 500,
		canvasH: 500,
		sx: 0.5,
		sy: 0.5,
		pathCmds: [],
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emf-gdi-draw-text-bitmap', () => {
	describe('handleEmfGdiTextBitmapRecord()', () => {
		it('is a function with arity 5', () => {
			expectTypeOf(handleEmfGdiTextBitmapRecord).toBeFunction();
			expect(handleEmfGdiTextBitmapRecord).toHaveLength(5);
		});

		it('returns false for unrecognized record type', () => {
			const rCtx = makeRCtx();
			expect(handleEmfGdiTextBitmapRecord(rCtx, 0xffff, 0, 8, 8)).toBeFalsy();
		});

		// -----------------------------------------------------------------------
		// EMR_EXTTEXTOUTW
		// -----------------------------------------------------------------------

		describe('eMR_EXTTEXTOUTW', () => {
			it('returns true even for small recSize', () => {
				const rCtx = makeRCtx();
				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, 0, 8, 8)).toBeTruthy();
			});

			it('draws text when recSize is large enough and string data is valid', () => {
				const rCtx = makeRCtx();
				const offset = 0;
				const dataOff = 8;

				// Set up text out data at dataOff
				// refX at dataOff+28, refY at dataOff+32
				rCtx.view.setInt32(dataOff + 28, 100, true); // refX
				rCtx.view.setInt32(dataOff + 32, 200, true); // refY
				rCtx.view.setUint32(dataOff + 36, 2, true); // nChars = 2
				rCtx.view.setUint32(dataOff + 40, 76, true); // offString (relative to record start=offset)

				// Write "Hi" as UTF-16LE at offset + 76
				rCtx.view.setUint16(offset + 76, 72, true); // 'H'
				rCtx.view.setUint16(offset + 78, 105, true); // 'i'

				const result = handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				expect(result).toBeTruthy();
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillText).toHaveBeenCalledOnce();
				expect(ctx.fillText.mock.calls[0][0]).toBe('Hi');
			});

			it('sets text alignment from state', () => {
				const rCtx = makeRCtx();
				rCtx.state.textAlign = 0x02; // TA_RIGHT
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 50, true);
				rCtx.view.setInt32(dataOff + 32, 50, true);
				rCtx.view.setUint32(dataOff + 36, 1, true); // 1 char
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				expect((rCtx.ctx as unknown as Record<string, string>).textAlign).toBe('right');
			});

			it.each([
				[0x00, 'top'], // TA_TOP
				[0x08, 'bottom'], // TA_BOTTOM
				[0x18, 'alphabetic'], // TA_BASELINE (includes the TA_BOTTOM bit)
			] as const)('maps vertical alignment 0x%s to textBaseline %s', (textAlign, expected) => {
				const rCtx = makeRCtx();
				rCtx.state.textAlign = textAlign;
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 50, true);
				rCtx.view.setInt32(dataOff + 32, 50, true);
				rCtx.view.setUint32(dataOff + 36, 1, true); // 1 char
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				expect((rCtx.ctx as unknown as Record<string, string>).textBaseline).toBe(expected);
			});

			it('draws opaque background when bkMode is 2', () => {
				const rCtx = makeRCtx();
				rCtx.state.bkMode = 2; // OPAQUE
				rCtx.state.bkColor = '#ff0000';
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 0, true);
				rCtx.view.setInt32(dataOff + 32, 0, true);
				rCtx.view.setUint32(dataOff + 36, 1, true);
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				// fillRect should be called for background, then fillText for text
				expect(ctx.fillRect).toHaveBeenCalledOnce();
				expect(ctx.fillText).toHaveBeenCalledOnce();
			});

			it('skips text when nChars is 0', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 0, true);
				rCtx.view.setInt32(dataOff + 32, 0, true);
				rCtx.view.setUint32(dataOff + 36, 0, true); // nChars = 0

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, 0, dataOff, 76);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillText).not.toHaveBeenCalled();
			});

			it('honours an explicit Dx array, drawing one fillText call per glyph at cumulative offsets', () => {
				const rCtx = makeRCtx(); // sx = sy = 0.5
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 100, true); // refX
				rCtx.view.setInt32(dataOff + 32, 200, true); // refY
				rCtx.view.setUint32(dataOff + 36, 2, true); // nChars = 2
				rCtx.view.setUint32(dataOff + 40, 76, true); // offString
				rCtx.view.setUint32(dataOff + 64, 80, true); // offDx (relative to record start)
				rCtx.view.setUint16(offset + 76, 72, true); // 'H'
				rCtx.view.setUint16(offset + 78, 105, true); // 'i'
				rCtx.view.setUint32(offset + 80, 20, true); // Dx[0]: advance after 'H' (logical units)
				rCtx.view.setUint32(offset + 84, 15, true); // Dx[1]: advance after 'i'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				// gmx(100) = 50, gmy(200) = 100; Dx scaled by sx=0.5 -> device advances 10, 7.5;
				// cumulative glyph offsets are [0, 10].
				expect(ctx.fillText.mock.calls).toEqual([
					['H', 50, 100],
					['i', 60, 100],
				]);
			});

			it('anchors a Dx-driven right-aligned run by the Dx array total width, not the browser measurement', () => {
				const rCtx = makeRCtx();
				rCtx.state.textAlign = 0x02; // TA_RIGHT
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 100, true); // refX -> gmx = 50
				rCtx.view.setInt32(dataOff + 32, 200, true); // refY -> gmy = 100
				rCtx.view.setUint32(dataOff + 36, 1, true); // nChars = 1
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint32(dataOff + 64, 80, true); // offDx
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'
				rCtx.view.setUint32(offset + 80, 40, true); // Dx[0] -> device width 20

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				// Right-aligned: the run's right edge sits at gmx(100)=50, so the
				// single glyph (width 20) starts at 50 - 20 = 30.
				expect(ctx.fillText.mock.calls).toEqual([['A', 30, 100]]);
			});

			it('rotates the text draw around the reference point for a nonzero escapement', () => {
				const rCtx = makeRCtx();
				rCtx.state.fontEscapementTenthDeg = 900; // 90.0 degrees
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 100, true); // refX -> gmx = 50
				rCtx.view.setInt32(dataOff + 32, 200, true); // refY -> gmy = 100
				rCtx.view.setUint32(dataOff + 36, 1, true);
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				const ctx = rCtx.ctx as unknown as Record<
					string,
					{ mock: { calls: unknown[][]; invocationCallOrder: number[] } }
				>;
				expect(ctx.translate.mock.calls).toEqual([[50, 100]]);
				expect(ctx.rotate.mock.calls[0][0]).toBeCloseTo(-Math.PI / 2, 10);
				// The glyph is drawn in the translated/rotated frame, at the origin.
				expect(ctx.fillText.mock.calls).toEqual([['A', 0, 0]]);
				// save() -> translate() -> rotate() -> fillText() -> restore(), in order.
				expect(ctx.save.mock.invocationCallOrder[0]).toBeLessThan(
					ctx.translate.mock.invocationCallOrder[0],
				);
				expect(ctx.rotate.mock.invocationCallOrder[0]).toBeLessThan(
					ctx.fillText.mock.invocationCallOrder[0],
				);
				expect(ctx.restore.mock.invocationCallOrder[0]).toBeGreaterThan(
					ctx.fillText.mock.invocationCallOrder[0],
				);
			});

			it('does not rotate when escapement is 0 (the default)', () => {
				const rCtx = makeRCtx();
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 100, true);
				rCtx.view.setInt32(dataOff + 32, 200, true);
				rCtx.view.setUint32(dataOff + 36, 1, true);
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.rotate).not.toHaveBeenCalled();
				expect(ctx.translate).not.toHaveBeenCalled();
				expect(ctx.fillText.mock.calls).toEqual([['A', 50, 100]]);
			});

			it('shears the glyphs under a skewed world transform via its normalised linear part', () => {
				const rCtx = makeRCtx(); // sx = sy = 0.5
				(rCtx.ctx as unknown as Record<string, unknown>).transform = vi.fn<() => void>();
				// x' = x + 0.25*y, y' = 0.35*x + y (the skew-rect fixture's transform).
				rCtx.state.worldTransform = [1, 0.35, 0.25, 1, 0, 0];
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 28, 100, true); // refX
				rCtx.view.setInt32(dataOff + 32, 200, true); // refY
				rCtx.view.setUint32(dataOff + 36, 1, true);
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: number[][] } }>;
				// Device matrix = [0.5, 0.175, 0.125, 0.5]; reference point
				// (100 + 50, 35 + 200) * 0.5 = (75, 117.5).
				expect(ctx.translate.mock.calls).toEqual([[75, 117.5]]);
				const [a, b, c, d, e, f] = ctx.transform.mock.calls[0];
				const ax = Math.hypot(0.5, 0.175);
				const ay = Math.hypot(0.125, 0.5);
				expect(a).toBeCloseTo(0.5 / ax, 10);
				expect(b).toBeCloseTo(0.175 / ax, 10);
				// The skew survives: the mapped y axis is NOT perpendicular to x.
				expect(c).toBeCloseTo(0.125 / ay, 10);
				expect(d).toBeCloseTo(0.5 / ay, 10);
				expect([e, f]).toEqual([0, 0]);
				expect(ctx.rotate).not.toHaveBeenCalled();
				expect(ctx.fillText.mock.calls).toEqual([['A', 0, 0]]);
			});

			it('keeps a pure world rotation a pure rotation of the glyphs', () => {
				const rCtx = makeRCtx();
				(rCtx.ctx as unknown as Record<string, unknown>).transform = vi.fn<() => void>();
				const t = (25 * Math.PI) / 180;
				rCtx.state.worldTransform = [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0];
				const offset = 0;
				const dataOff = 8;
				rCtx.view.setUint32(dataOff + 36, 1, true);
				rCtx.view.setUint32(dataOff + 40, 76, true);
				rCtx.view.setUint16(offset + 76, 65, true); // 'A'

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTTEXTOUTW, offset, dataOff, 80);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: number[][] } }>;
				const [a, b, c, d] = ctx.transform.mock.calls[0];
				expect(a).toBeCloseTo(Math.cos(t), 10);
				expect(b).toBeCloseTo(Math.sin(t), 10);
				expect(c).toBeCloseTo(-Math.sin(t), 10);
				expect(d).toBeCloseTo(Math.cos(t), 10);
			});
		});

		// -----------------------------------------------------------------------
		// EMR_BITBLT
		// -----------------------------------------------------------------------

		describe('eMR_BITBLT', () => {
			it('returns true even for small recSize', () => {
				const rCtx = makeRCtx();
				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, 8, 8)).toBeTruthy();
			});

			it('returns true for valid recSize but no bitmap data', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				// Set offBmiSrc=0 (no bitmap)
				rCtx.view.setUint32(dataOff + 76, 0, true); // offBmiSrc = 0

				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, dataOff, 96)).toBeTruthy();
			});

			it('fills destination with current brush for source-less PATCOPY', () => {
				const rCtx = makeRCtx();
				rCtx.state.brushColor = '#ff00ff';
				rCtx.state.brushStyle = 0; // BS_SOLID
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 16, 10, true); // dstX
				rCtx.view.setInt32(dataOff + 20, 20, true); // dstY
				rCtx.view.setInt32(dataOff + 24, 100, true); // dstW
				rCtx.view.setInt32(dataOff + 28, 50, true); // dstH
				rCtx.view.setUint32(dataOff + 32, 0x00f00021, true); // PATCOPY
				rCtx.view.setUint32(dataOff + 76, 0, true); // offBmiSrc = 0

				handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillRect).toHaveBeenCalledOnce();
				expect(ctx.fillRect.mock.calls[0]).toEqual([5, 10, 50, 25]); // sx = sy = 0.5
				// fillStyle is restored after the fill
				expect((rCtx.ctx as unknown as Record<string, string>).fillStyle).toBe('#ffffff');
			});

			it('does not fill for source-less PATCOPY when the brush is BS_NULL', () => {
				const rCtx = makeRCtx();
				rCtx.state.brushStyle = 1; // BS_NULL
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 24, 100, true); // dstW
				rCtx.view.setInt32(dataOff + 28, 50, true); // dstH
				rCtx.view.setUint32(dataOff + 32, 0x00f00021, true); // PATCOPY
				rCtx.view.setUint32(dataOff + 76, 0, true); // offBmiSrc = 0

				handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillRect).not.toHaveBeenCalled();
			});

			it('fills the destination black for BLACKNESS, ignoring any source bitmap', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 16, 10, true); // dstX
				rCtx.view.setInt32(dataOff + 20, 20, true); // dstY
				rCtx.view.setInt32(dataOff + 24, 100, true); // dstW
				rCtx.view.setInt32(dataOff + 28, 50, true); // dstH
				rCtx.view.setUint32(dataOff + 32, 0x00000042, true); // BLACKNESS

				handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillRect.mock.calls[0]).toEqual([5, 10, 50, 25]);
				expect((rCtx.ctx as unknown as Record<string, string>).fillStyle).toBe('#ffffff');
			});

			it('fills the destination for WHITENESS at the mapped rect, restoring fillStyle after', () => {
				const rCtx = makeRCtx();
				rCtx.state.brushColor = '#123456'; // WHITENESS ignores the brush too
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 24, 20, true); // dstW
				rCtx.view.setInt32(dataOff + 28, 20, true); // dstH
				rCtx.view.setUint32(dataOff + 32, 0x00ff0062, true); // WHITENESS

				handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillRect).toHaveBeenCalledOnce();
				expect(ctx.fillRect.mock.calls[0]).toEqual([0, 0, 10, 10]);
				expect((rCtx.ctx as unknown as Record<string, string>).fillStyle).toBe('#ffffff');
			});

			it('inverts the destination in place for DSTINVERT via a difference blend', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 16, 10, true);
				rCtx.view.setInt32(dataOff + 20, 20, true);
				rCtx.view.setInt32(dataOff + 24, 100, true);
				rCtx.view.setInt32(dataOff + 28, 50, true);
				rCtx.view.setUint32(dataOff + 32, 0x00550009, true); // DSTINVERT

				handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillRect.mock.calls[0]).toEqual([5, 10, 50, 25]);
				// globalCompositeOperation is restored to its previous value afterwards.
				expect((rCtx.ctx as unknown as Record<string, string>).globalCompositeOperation).toBe(
					'source-over',
				);
			});

			it('does not decode a source bitmap for PATCOPY even when one is present', () => {
				const rCtx = makeRCtx();
				rCtx.state.brushColor = '#123456';
				rCtx.state.brushStyle = 0; // BS_SOLID
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 16, 0, true);
				rCtx.view.setInt32(dataOff + 20, 0, true);
				rCtx.view.setInt32(dataOff + 24, 10, true);
				rCtx.view.setInt32(dataOff + 28, 10, true);
				rCtx.view.setUint32(dataOff + 32, 0x00f00021, true); // PATCOPY
				// A (bogus but present) source bitmap descriptor - GDI ignores it for PATCOPY.
				rCtx.view.setUint32(dataOff + 76, 200, true); // offBmiSrc
				rCtx.view.setUint32(dataOff + 80, 40, true); // cbBmiSrc
				rCtx.view.setUint32(dataOff + 84, 240, true); // offBitsSrc
				rCtx.view.setUint32(dataOff + 88, 4, true); // cbBitsSrc

				handleEmfGdiTextBitmapRecord(rCtx, EMR_BITBLT, 0, dataOff, 96);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillRect).toHaveBeenCalledOnce();
				expect(ctx.drawImage).not.toHaveBeenCalled();
			});
		});

		// -----------------------------------------------------------------------
		// EMR_STRETCHDIBITS
		// -----------------------------------------------------------------------

		describe('eMR_STRETCHDIBITS', () => {
			it('returns true even for small recSize', () => {
				const rCtx = makeRCtx();
				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_STRETCHDIBITS, 0, 8, 8)).toBeTruthy();
			});

			it('returns true for valid recSize but no bitmap data', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setUint32(dataOff + 40, 0, true); // offBmiSrc = 0

				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_STRETCHDIBITS, 0, dataOff, 80)).toBeTruthy();
			});

			it('honours the record ROP field for BLACKNESS, ignoring any source bitmap', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff + 16, 10, true); // dstX
				rCtx.view.setInt32(dataOff + 20, 20, true); // dstY
				rCtx.view.setUint32(dataOff + 60, 0x00000042, true); // dwRop: BLACKNESS
				rCtx.view.setInt32(dataOff + 64, 100, true); // cxDest
				rCtx.view.setInt32(dataOff + 68, 50, true); // cyDest

				handleEmfGdiTextBitmapRecord(rCtx, EMR_STRETCHDIBITS, 0, dataOff, 80);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.fillRect.mock.calls[0]).toEqual([5, 10, 50, 25]);
			});
		});

		// -----------------------------------------------------------------------
		// EMR_INTERSECTCLIPRECT
		// -----------------------------------------------------------------------

		describe('eMR_INTERSECTCLIPRECT', () => {
			it('sets up a clip region', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff, 10, true); // left
				rCtx.view.setInt32(dataOff + 4, 20, true); // top
				rCtx.view.setInt32(dataOff + 8, 200, true); // right
				rCtx.view.setInt32(dataOff + 12, 300, true); // bottom

				const result = handleEmfGdiTextBitmapRecord(rCtx, EMR_INTERSECTCLIPRECT, 0, dataOff, 24);
				expect(result).toBeTruthy();
				expect(rCtx.clipSaveDepth).toBe(1);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.save).toHaveBeenCalledOnce();
				expect(ctx.clip).toHaveBeenCalledOnce();
				expect(ctx.rect).toHaveBeenCalledOnce();
			});

			it('returns true for small recSize (< 24)', () => {
				const rCtx = makeRCtx();
				const result = handleEmfGdiTextBitmapRecord(rCtx, EMR_INTERSECTCLIPRECT, 0, 8, 16);
				expect(result).toBeTruthy();
				expect(rCtx.clipSaveDepth).toBe(0); // no clip applied
			});
		});

		// -----------------------------------------------------------------------
		// EMR_EXTSELECTCLIPRGN
		// -----------------------------------------------------------------------

		describe('eMR_EXTSELECTCLIPRGN', () => {
			it('returns true for small recSize', () => {
				const rCtx = makeRCtx();
				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTSELECTCLIPRGN, 0, 8, 8)).toBeTruthy();
			});

			it('resets clip with RGN_COPY and cbRgnData=0', () => {
				const rCtx = makeRCtx();
				rCtx.clipSaveDepth = 2;
				const dataOff = 8;
				rCtx.view.setUint32(dataOff, 0, true); // cbRgnData = 0
				rCtx.view.setUint32(dataOff + 4, 5, true); // iMode = RGN_COPY

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTSELECTCLIPRGN, 0, dataOff, 16);
				expect(rCtx.clipSaveDepth).toBe(0);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.restore).toHaveBeenCalledTimes(2);
			});

			it('applies RGN_COPY with rectangles', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				const rgnHeaderSize = 32;
				const numRects = 1;
				const rectData = numRects * 16;
				const cbRgnData = rgnHeaderSize + rectData;

				rCtx.view.setUint32(dataOff, cbRgnData, true); // cbRgnData
				rCtx.view.setUint32(dataOff + 4, 5, true); // iMode = RGN_COPY

				// RGNDATAHEADER at dataOff+8
				const rgnStart = dataOff + 8;
				rCtx.view.setUint32(rgnStart, 32, true); // dwSize
				rCtx.view.setUint32(rgnStart + 4, 1, true); // iType = RDH_RECTANGLES
				rCtx.view.setUint32(rgnStart + 8, numRects, true); // nCount

				// Rectangle at rgnStart + 32
				const rOff = rgnStart + 32;
				rCtx.view.setInt32(rOff, 10, true); // left
				rCtx.view.setInt32(rOff + 4, 20, true); // top
				rCtx.view.setInt32(rOff + 8, 100, true); // right
				rCtx.view.setInt32(rOff + 12, 200, true); // bottom

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTSELECTCLIPRGN, 0, dataOff, 8 + cbRgnData);
				expect(rCtx.clipSaveDepth).toBe(1);
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.clip).toHaveBeenCalledOnce();
			});

			it('applies RGN_XOR of two region selections via even-odd clipping', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				const writeRegion = (iMode: number, left: number) => {
					rCtx.view.setUint32(dataOff, 48, true); // cbRgnData (32 header + 1 rect)
					rCtx.view.setUint32(dataOff + 4, iMode, true);
					const rgnStart = dataOff + 8;
					rCtx.view.setUint32(rgnStart + 8, 1, true); // nCount
					const rOff = rgnStart + 32;
					rCtx.view.setInt32(rOff, left, true);
					rCtx.view.setInt32(rOff + 4, 0, true);
					rCtx.view.setInt32(rOff + 8, left + 100, true);
					rCtx.view.setInt32(rOff + 12, 100, true);
				};

				writeRegion(5, 0); // RGN_COPY first rect
				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTSELECTCLIPRGN, 0, dataOff, 56);
				writeRegion(3, 50); // RGN_XOR overlapping rect
				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTSELECTCLIPRGN, 0, dataOff, 56);

				// XOR of two simple shapes collapses to one even-odd clip.
				expect(rCtx.clipRegion).toHaveLength(1);
				expect(rCtx.clipRegion![0].fillRule).toBe('evenodd');
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				const clipCalls = ctx.clip.mock.calls;
				expect(clipCalls[clipCalls.length - 1]).toEqual(['evenodd']);
			});

			it('ignores unknown region modes', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setUint32(dataOff, 32, true); // cbRgnData
				rCtx.view.setUint32(dataOff + 4, 9, true); // invalid mode

				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXTSELECTCLIPRGN, 0, dataOff, 16);
				expect(rCtx.clipSaveDepth).toBe(0); // no clip applied
			});
		});

		// -----------------------------------------------------------------------
		// EMR_EXCLUDECLIPRECT
		// -----------------------------------------------------------------------

		describe('eMR_EXCLUDECLIPRECT', () => {
			it('excludes the rect via an even-odd inverted clip', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff, 0, true);
				rCtx.view.setInt32(dataOff + 4, 0, true);
				rCtx.view.setInt32(dataOff + 8, 100, true);
				rCtx.view.setInt32(dataOff + 12, 100, true);

				expect(
					handleEmfGdiTextBitmapRecord(rCtx, EMR_EXCLUDECLIPRECT, 0, dataOff, 24),
				).toBeTruthy();
				expect(rCtx.clipSaveDepth).toBe(1);
				expect(rCtx.clipRegion).toHaveLength(1);
				expect(rCtx.clipRegion![0].fillRule).toBe('evenodd');
				// Huge covering rect + the excluded rect (scaled by sx=sy=0.5)
				expect(rCtx.clipRegion![0].cmds).toHaveLength(2);
				expect(rCtx.clipRegion![0].cmds[1]).toMatchObject({ op: 'rect', w: 50, h: 50 });
				const ctx = rCtx.ctx as unknown as Record<string, { mock: { calls: unknown[][] } }>;
				expect(ctx.clip).toHaveBeenCalledWith('evenodd');
			});

			it('stacks after an intersect clip (band with a hole)', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff, 0, true);
				rCtx.view.setInt32(dataOff + 4, 0, true);
				rCtx.view.setInt32(dataOff + 8, 400, true);
				rCtx.view.setInt32(dataOff + 12, 400, true);
				handleEmfGdiTextBitmapRecord(rCtx, EMR_INTERSECTCLIPRECT, 0, dataOff, 24);

				rCtx.view.setInt32(dataOff, 100, true);
				rCtx.view.setInt32(dataOff + 4, 100, true);
				rCtx.view.setInt32(dataOff + 8, 200, true);
				rCtx.view.setInt32(dataOff + 12, 200, true);
				handleEmfGdiTextBitmapRecord(rCtx, EMR_EXCLUDECLIPRECT, 0, dataOff, 24);

				expect(rCtx.clipRegion).toHaveLength(2);
				expect(rCtx.clipRegion![0].fillRule).toBe('nonzero');
				expect(rCtx.clipRegion![1].fillRule).toBe('evenodd');
			});
		});

		// -----------------------------------------------------------------------
		// EMR_OFFSETCLIPRGN
		// -----------------------------------------------------------------------

		describe('eMR_OFFSETCLIPRGN', () => {
			it('translates the tracked clip region by the mapped offset', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				// Establish a clip rect (0,0)-(100,100) logical → 50×50 device
				rCtx.view.setInt32(dataOff, 0, true);
				rCtx.view.setInt32(dataOff + 4, 0, true);
				rCtx.view.setInt32(dataOff + 8, 100, true);
				rCtx.view.setInt32(dataOff + 12, 100, true);
				handleEmfGdiTextBitmapRecord(rCtx, EMR_INTERSECTCLIPRECT, 0, dataOff, 24);

				rCtx.view.setInt32(dataOff, 40, true); // dx (logical) → 20 device
				rCtx.view.setInt32(dataOff + 4, 10, true); // dy (logical) → 5 device
				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_OFFSETCLIPRGN, 0, dataOff, 16)).toBeTruthy();

				expect(rCtx.clipRegion![0].cmds[0]).toMatchObject({ op: 'rect', x: 20, y: 5 });
			});

			it('is a no-op without an active clip', () => {
				const rCtx = makeRCtx();
				const dataOff = 8;
				rCtx.view.setInt32(dataOff, 5, true);
				rCtx.view.setInt32(dataOff + 4, 10, true);
				expect(handleEmfGdiTextBitmapRecord(rCtx, EMR_OFFSETCLIPRGN, 0, dataOff, 16)).toBeTruthy();
				expect(rCtx.clipSaveDepth).toBe(0);
			});
		});
	});
});
