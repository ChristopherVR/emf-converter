/**
 * EMF GDI coordinate-system and world-transform record handlers.
 */

import {
	EMR_SETWINDOWEXTEX,
	EMR_SETWINDOWORGEX,
	EMR_SETVIEWPORTEXTEX,
	EMR_SETVIEWPORTORGEX,
	EMR_SETMAPMODE,
	EMR_SCALEVIEWPORTEXTEX,
	EMR_SCALEWINDOWEXTEX,
	EMR_SETWORLDTRANSFORM,
	EMR_MODIFYWORLDTRANSFORM,
} from './emf-constants';
import { activateGdiMappingMode } from './emf-gdi-coord';
import type { EmfGdiReplayCtx, TransformMatrix } from './emf-types';
import { MM_ANISOTROPIC, MM_TEXT, type WmfMapping, extentsSettable, fixIsotropic, setMapMode } from './wmf-mapping';

// ---------------------------------------------------------------------------
// Map mode
// ---------------------------------------------------------------------------

/**
 * The reference device's density, from the EMF header's `szlDevice` and
 * `szlMillimeters` (the metric map modes are defined through it); absent
 * when the replayed buffer does not start with a usable header.
 */
function emfDeviceDpi(view: DataView): { x: number; y: number } | undefined {
	if (view.byteLength < 88 || view.getUint32(0, true) !== 1) {
		return undefined;
	}
	const devW = view.getInt32(72, true);
	const devH = view.getInt32(76, true);
	const mmW = view.getInt32(80, true);
	const mmH = view.getInt32(84, true);
	if (devW <= 0 || devH <= 0 || mmW <= 0 || mmH <= 0) {
		return undefined;
	}
	return { x: (devW * 25.4) / mmW, y: (devH * 25.4) / mmH };
}

/** The DC's mapping as the shared GDI mapping rules (`wmf-mapping.ts`) see it. */
function emfMapping(r: EmfGdiReplayCtx): WmfMapping {
	const dpi = emfDeviceDpi(r.view);
	return {
		...(dpi ? { dpi } : {}),
		mode: r.mapMode ?? MM_TEXT,
		winOrg: r.windowOrg,
		winExt: { ...r.windowExt },
		vpOrg: r.viewportOrg,
		vpExt: { ...r.viewportExt },
	};
}

/** Writes the mode and extents of `m` back to the replay context. */
function storeMapping(r: EmfGdiReplayCtx, m: WmfMapping): void {
	r.mapMode = m.mode;
	r.windowExt = m.winExt;
	r.viewportExt = m.vpExt;
}

/**
 * Sets the window (`viewport` false) or viewport extent. GDI ignores both
 * outside `MM_ISOTROPIC`/`MM_ANISOTROPIC` (in `MM_TEXT`, the mode a DC
 * starts in, a logical unit stays one device pixel) and rejects a zero
 * extent; `MM_ISOTROPIC` then evens out the viewport.
 */
function setExtent(r: EmfGdiReplayCtx, viewport: boolean, cx: number, cy: number): void {
	const m = emfMapping(r);
	if (!extentsSettable(m) || cx === 0 || cy === 0) {
		return;
	}
	if (viewport) {
		m.vpExt = { cx, cy };
	} else {
		m.winExt = { cx, cy };
	}
	fixIsotropic(m);
	storeMapping(r, m);
	activateGdiMappingMode(r);
}

/** `ScaleViewportExtEx` / `ScaleWindowExtEx`: rational scaling, under the same rules as {@link setExtent}. */
function scaleExtent(r: EmfGdiReplayCtx, viewport: boolean, xNum: number, xDenom: number, yNum: number, yDenom: number): void {
	const ext = viewport ? r.viewportExt : r.windowExt;
	const cx = xDenom !== 0 ? Math.round((ext.cx * xNum) / xDenom) : ext.cx;
	const cy = yDenom !== 0 ? Math.round((ext.cy * yNum) / yDenom) : ext.cy;
	setExtent(r, viewport, cx, cy);
}

// ---------------------------------------------------------------------------
// Coordinate-system helpers
// ---------------------------------------------------------------------------

function handleCoordinateRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { view } = rCtx;

	switch (recType) {
		case EMR_SETWINDOWEXTEX: {
			if (recSize >= 16) {
				setExtent(rCtx, false, view.getInt32(dataOff, true), view.getInt32(dataOff + 4, true));
			}
			return true;
		}
		case EMR_SETWINDOWORGEX: {
			if (recSize >= 16) {
				rCtx.windowOrg.x = view.getInt32(dataOff, true);
				rCtx.windowOrg.y = view.getInt32(dataOff + 4, true);
				activateGdiMappingMode(rCtx);
			}
			return true;
		}
		case EMR_SETVIEWPORTEXTEX: {
			if (recSize >= 16) {
				setExtent(rCtx, true, view.getInt32(dataOff, true), view.getInt32(dataOff + 4, true));
			}
			return true;
		}
		case EMR_SETVIEWPORTORGEX: {
			if (recSize >= 16) {
				rCtx.viewportOrg.x = view.getInt32(dataOff, true);
				rCtx.viewportOrg.y = view.getInt32(dataOff + 4, true);
				activateGdiMappingMode(rCtx);
			}
			return true;
		}
		case EMR_SETMAPMODE: {
			if (recSize >= 12) {
				const mode = view.getUint32(dataOff, true);
				if (mode >= MM_TEXT && mode <= MM_ANISOTROPIC) {
					// MM_TEXT resets the extents to 1:1 but keeps the origins and
					// the independent world transform.
					const m = emfMapping(rCtx);
					setMapMode(m, mode);
					storeMapping(rCtx, m);
					activateGdiMappingMode(rCtx);
				}
			}
			return true;
		}
		case EMR_SCALEVIEWPORTEXTEX:
		case EMR_SCALEWINDOWEXTEX: {
			if (recSize >= 24) {
				scaleExtent(
					rCtx,
					recType === EMR_SCALEVIEWPORTEXTEX,
					view.getInt32(dataOff, true),
					view.getInt32(dataOff + 4, true),
					view.getInt32(dataOff + 8, true),
					view.getInt32(dataOff + 12, true),
				);
			}
			return true;
		}
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// World-transform helpers
// ---------------------------------------------------------------------------

function handleWorldTransformRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	dataOff: number,
	recSize: number,
): boolean {
	const { view, state } = rCtx;

	switch (recType) {
		case EMR_SETWORLDTRANSFORM: {
			if (recSize >= 32) {
				state.worldTransform = [
					view.getFloat32(dataOff, true),
					view.getFloat32(dataOff + 4, true),
					view.getFloat32(dataOff + 8, true),
					view.getFloat32(dataOff + 12, true),
					view.getFloat32(dataOff + 16, true),
					view.getFloat32(dataOff + 20, true),
				];
			}
			return true;
		}
		case EMR_MODIFYWORLDTRANSFORM: {
			if (recSize >= 36) {
				const mode = view.getUint32(dataOff + 24, true);
				if (mode === 1) {
					state.worldTransform = [1, 0, 0, 1, 0, 0];
				} else if (mode === 2 || mode === 3) {
					const xf: TransformMatrix = [
						view.getFloat32(dataOff, true),
						view.getFloat32(dataOff + 4, true),
						view.getFloat32(dataOff + 8, true),
						view.getFloat32(dataOff + 12, true),
						view.getFloat32(dataOff + 16, true),
						view.getFloat32(dataOff + 20, true),
					];
					const [a1, b1, c1, d1, e1, f1] = state.worldTransform;
					if (mode === 2) {
						state.worldTransform = [
							xf[0] * a1 + xf[1] * c1,
							xf[0] * b1 + xf[1] * d1,
							xf[2] * a1 + xf[3] * c1,
							xf[2] * b1 + xf[3] * d1,
							xf[4] * a1 + xf[5] * c1 + e1,
							xf[4] * b1 + xf[5] * d1 + f1,
						];
					} else {
						state.worldTransform = [
							a1 * xf[0] + b1 * xf[2],
							a1 * xf[1] + b1 * xf[3],
							c1 * xf[0] + d1 * xf[2],
							c1 * xf[1] + d1 * xf[3],
							e1 * xf[0] + f1 * xf[2] + xf[4],
							e1 * xf[1] + f1 * xf[3] + xf[5],
						];
					}
				}
			}
			return true;
		}
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Public combined handler
// ---------------------------------------------------------------------------

export function handleEmfTransformRecord(
	rCtx: EmfGdiReplayCtx,
	recType: number,
	dataOff: number,
	recSize: number,
): boolean {
	return (
		handleCoordinateRecord(rCtx, recType, dataOff, recSize) ||
		handleWorldTransformRecord(rCtx, recType, dataOff, recSize)
	);
}
