import { describe, it, expect } from 'vitest';

import {
	gmx,
	gmy,
	gmw,
	gmh,
	activateGdiMappingMode,
	gmapPoint,
	gdiEllipseParams,
	hasWorldRotation,
} from './emf-gdi-coord';
import { defaultState } from './emf-types';
import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal EmfGdiReplayCtx for coordinate mapping tests. */
function makeCtx(overrides: Partial<EmfGdiReplayCtx> = {}): EmfGdiReplayCtx {
	return {
		// Provide stubs for all required fields; tests only care about
		// the coordinate-related subset.
		ctx: {} as unknown as CanvasContext,
		view: {} as unknown as DataView,
		objectTable: new Map(),
		state: defaultState(),
		stateStack: [],
		inPath: false,
		windowOrg: { x: 0, y: 0 },
		windowExt: { cx: 1, cy: 1 },
		viewportOrg: { x: 0, y: 0 },
		viewportExt: { cx: 1, cy: 1 },
		useMappingMode: false,
		clipSaveDepth: 0,
		bounds: { left: 0, top: 0, right: 100, bottom: 100 },
		canvasW: 200,
		canvasH: 200,
		sx: 2,
		sy: 2,
		...overrides,
	} as EmfGdiReplayCtx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emf-gdi-coord', () => {
	// -----------------------------------------------------------------------
	// Simple bounds-based mapping (useMappingMode = false)
	// -----------------------------------------------------------------------
	describe('bounds-based mapping (useMappingMode = false)', () => {
		it('gmx scales x by sx and subtracts bounds.left', () => {
			const r = makeCtx({ bounds: { left: 10, top: 0, right: 110, bottom: 100 }, sx: 2 });
			// (50 - 10) * 2 = 80
			expect(gmx(r, 50)).toBe(80);
		});

		it('gmy scales y by sy and subtracts bounds.top', () => {
			const r = makeCtx({ bounds: { left: 0, top: 20, right: 100, bottom: 120 }, sy: 3 });
			// (60 - 20) * 3 = 120
			expect(gmy(r, 60)).toBe(120);
		});

		it('gmw scales width by sx', () => {
			const r = makeCtx({ sx: 2.5 });
			expect(gmw(r, 40)).toBe(100);
		});

		it('applies the world transform scale and translation (GDI+ ×16 sub-pixel files)', () => {
			const r = makeCtx({ sx: 1, sy: 1 });
			r.state.worldTransform = [0.0625, 0, 0, 0.0625, 5, 10];
			expect(gmx(r, 4800)).toBe(305); // 4800/16 + 5
			expect(gmy(r, 3200)).toBe(210); // 3200/16 + 10
			expect(gmw(r, 1600)).toBe(100);
			expect(gmh(r, 800)).toBe(50);
		});

		it('gmh scales height by sy', () => {
			const r = makeCtx({ sy: 0.5 });
			expect(gmh(r, 100)).toBe(50);
		});

		it('identity scaling (sx=1, sy=1, bounds at origin)', () => {
			const r = makeCtx({
				bounds: { left: 0, top: 0, right: 100, bottom: 100 },
				sx: 1,
				sy: 1,
			});
			expect(gmx(r, 42)).toBe(42);
			expect(gmy(r, 77)).toBe(77);
			expect(gmw(r, 10)).toBe(10);
			expect(gmh(r, 20)).toBe(20);
		});

		it('handles zero coordinates', () => {
			const r = makeCtx({ sx: 3, sy: 4, bounds: { left: 0, top: 0, right: 100, bottom: 100 } });
			expect(gmx(r, 0)).toBe(0);
			expect(gmy(r, 0)).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Window/viewport mapping (useMappingMode = true)
	// -----------------------------------------------------------------------
	describe('window/viewport mapping (useMappingMode = true)', () => {
		it('maps x through window/viewport transform', () => {
			const r = makeCtx({
				useMappingMode: true,
				windowOrg: { x: 0, y: 0 },
				windowExt: { cx: 100, cy: 100 },
				viewportOrg: { x: 0, y: 0 },
				viewportExt: { cx: 200, cy: 200 },
			});
			// (50 - 0) / 100 * 200 + 0 = 100
			expect(gmx(r, 50)).toBe(100);
		});

		it('maps y through window/viewport transform', () => {
			const r = makeCtx({
				useMappingMode: true,
				windowOrg: { x: 0, y: 0 },
				windowExt: { cx: 100, cy: 50 },
				viewportOrg: { x: 0, y: 0 },
				viewportExt: { cx: 200, cy: 300 },
			});
			// (25 - 0) / 50 * 300 + 0 = 150
			expect(gmy(r, 25)).toBe(150);
		});

		it('applies window origin offset', () => {
			const r = makeCtx({
				useMappingMode: true,
				windowOrg: { x: 10, y: 20 },
				windowExt: { cx: 100, cy: 100 },
				viewportOrg: { x: 0, y: 0 },
				viewportExt: { cx: 100, cy: 100 },
			});
			// (50 - 10) / 100 * 100 + 0 = 40
			expect(gmx(r, 50)).toBe(40);
			// (70 - 20) / 100 * 100 + 0 = 50
			expect(gmy(r, 70)).toBe(50);
		});

		it('applies viewport origin offset', () => {
			const r = makeCtx({
				useMappingMode: true,
				windowOrg: { x: 0, y: 0 },
				windowExt: { cx: 100, cy: 100 },
				viewportOrg: { x: 50, y: 30 },
				viewportExt: { cx: 100, cy: 100 },
			});
			// (60 - 0) / 100 * 100 + 50 = 110
			expect(gmx(r, 60)).toBe(110);
			// (40 - 0) / 100 * 100 + 30 = 70
			expect(gmy(r, 40)).toBe(70);
		});

		it('gmw maps width through window/viewport extent ratio', () => {
			const r = makeCtx({
				useMappingMode: true,
				windowExt: { cx: 200, cy: 100 },
				viewportExt: { cx: 400, cy: 300 },
			});
			// 100 / 200 * 400 = 200
			expect(gmw(r, 100)).toBe(200);
		});

		it('gmh maps height through window/viewport extent ratio', () => {
			const r = makeCtx({
				useMappingMode: true,
				windowExt: { cx: 200, cy: 100 },
				viewportExt: { cx: 400, cy: 300 },
			});
			// 50 / 100 * 300 = 150
			expect(gmh(r, 50)).toBe(150);
		});

		it('handles identity mapping (window == viewport)', () => {
			const r = makeCtx({
				useMappingMode: true,
				windowOrg: { x: 0, y: 0 },
				windowExt: { cx: 100, cy: 100 },
				viewportOrg: { x: 0, y: 0 },
				viewportExt: { cx: 100, cy: 100 },
			});
			expect(gmx(r, 42)).toBe(42);
			expect(gmy(r, 77)).toBe(77);
			expect(gmw(r, 10)).toBe(10);
			expect(gmh(r, 20)).toBe(20);
		});
	});

	// -----------------------------------------------------------------------
	// activateGdiMappingMode
	// -----------------------------------------------------------------------
	describe('activateGdiMappingMode()', () => {
		it('sets useMappingMode to true', () => {
			const r = makeCtx({ useMappingMode: false });
			activateGdiMappingMode(r);
			expect(r.useMappingMode).toBeTruthy();
		});

		it('remains true if already activated', () => {
			const r = makeCtx({ useMappingMode: true });
			activateGdiMappingMode(r);
			expect(r.useMappingMode).toBeTruthy();
		});
	});

	// -----------------------------------------------------------------------
	// hasWorldRotation
	// -----------------------------------------------------------------------
	describe('hasWorldRotation()', () => {
		it('is false for a pure scale/translate world transform', () => {
			const r = makeCtx();
			r.state.worldTransform = [2, 0, 0, 3, 5, 7];
			expect(hasWorldRotation(r)).toBe(false);
		});

		it('is true when the b component is non-zero', () => {
			const r = makeCtx();
			r.state.worldTransform = [1, 0.5, 0, 1, 0, 0];
			expect(hasWorldRotation(r)).toBe(true);
		});

		it('is true when the c component is non-zero', () => {
			const r = makeCtx();
			r.state.worldTransform = [1, 0, 0.5, 1, 0, 0];
			expect(hasWorldRotation(r)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// gmapPoint
	// -----------------------------------------------------------------------
	describe('gmapPoint()', () => {
		it('matches gmx/gmy for a non-rotated transform', () => {
			const r = makeCtx();
			const p = gmapPoint(r, 30, 40);
			expect(p.x).toBeCloseTo(gmx(r, 30));
			expect(p.y).toBeCloseTo(gmy(r, 40));
		});

		it('applies a 90-degree rotation about the origin', () => {
			const r = makeCtx({ bounds: { left: 0, top: 0, right: 100, bottom: 100 }, sx: 1, sy: 1 });
			// worldX = -y, worldY = x (90-degree CCW-in-math rotation).
			r.state.worldTransform = [0, 1, -1, 0, 0, 0];
			const p = gmapPoint(r, 10, 0);
			expect(p.x).toBeCloseTo(0);
			expect(p.y).toBeCloseTo(10);
		});

		it('applies translation from a rotated+translated transform', () => {
			const r = makeCtx({ bounds: { left: 0, top: 0, right: 100, bottom: 100 }, sx: 1, sy: 1 });
			r.state.worldTransform = [0, 1, -1, 0, 5, 5];
			const p = gmapPoint(r, 0, 0);
			expect(p.x).toBeCloseTo(5);
			expect(p.y).toBeCloseTo(5);
		});
	});

	// -----------------------------------------------------------------------
	// gdiEllipseParams
	// -----------------------------------------------------------------------
	describe('gdiEllipseParams()', () => {
		it('returns the plain radii and zero rotation for an identity-ish transform', () => {
			const r = makeCtx({ bounds: { left: 0, top: 0, right: 100, bottom: 100 }, sx: 1, sy: 1 });
			const params = gdiEllipseParams(r, 50, 50, 20, 10);
			expect(params.cx).toBeCloseTo(50);
			expect(params.cy).toBeCloseTo(50);
			expect(params.rx).toBeCloseTo(20);
			expect(params.ry).toBeCloseTo(10);
			expect(params.rotation).toBeCloseTo(0);
		});

		it('keeps a circle a circle under pure rotation', () => {
			const r = makeCtx({ bounds: { left: 0, top: 0, right: 100, bottom: 100 }, sx: 1, sy: 1 });
			const angle = Math.PI / 6;
			r.state.worldTransform = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
			const params = gdiEllipseParams(r, 0, 0, 5, 5);
			expect(params.rx).toBeCloseTo(5);
			expect(params.ry).toBeCloseTo(5);
		});

		it('rotates an ellipse 90 degrees: its major axis swaps from x to y', () => {
			const r = makeCtx({ bounds: { left: 0, top: 0, right: 100, bottom: 100 }, sx: 1, sy: 1 });
			// worldX = -y, worldY = x: a 90-degree rotation.
			r.state.worldTransform = [0, 1, -1, 0, 0, 0];
			const params = gdiEllipseParams(r, 0, 0, 2, 1);
			expect(params.rx).toBeCloseTo(2);
			expect(params.ry).toBeCloseTo(1);
			expect(Math.abs(params.rotation)).toBeCloseTo(Math.PI / 2);
		});
	});
});
