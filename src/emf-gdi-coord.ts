/**
 * GDI coordinate mapping functions for the EMF record replay.
 *
 * The full GDI pipeline is: world transform (EMR_SETWORLDTRANSFORM /
 * EMR_MODIFYWORLDTRANSFORM) → page space → window/viewport (or bounds-based)
 * device mapping. `gmx`/`gmy`/`gmw`/`gmh` apply only the scale and
 * translation components of the world transform (`a`, `d`, `e`, `f`); they
 * are the fast, common-case path used throughout the GDI blit/text handlers,
 * and are left exactly as-is (see below for why blits/text keep this
 * limitation).
 *
 * `gmapPoint` and `gdiEllipseParams` below apply the FULL affine, including
 * the skew/rotation components (`b`, `c`) that `gmx`/`gmy` ignore. Vector
 * shape/path handlers (`emf-gdi-draw-shapes.ts`, `emf-gdi-poly-path-handlers.ts`,
 * `emf-gdi-polypolygon-helpers.ts`) call these instead of `gmx`/`gmy` when
 * {@link hasWorldRotation} is true, so a rotated/skewed `EMR_SETWORLDTRANSFORM`
 * renders paths, polygons, rectangles, rounded rectangles, ellipses, and
 * arcs correctly. Bitmap blits (`executeRotatedBlit`,
 * `emf-gdi-draw-bitmap.ts`) and raster text (`emf-gdi-draw-text.ts`) use
 * {@link gdiDeviceMatrix} too when the transform rotates or skews; without
 * one they keep the scale-only mapping and its exact axis-aligned
 * per-pixel evaluators.
 *
 * Applying the world transform matters in practice even without rotation:
 * GDI+ writes EMF files whose polygon coordinates are pre-multiplied by 16
 * with a compensating 0.0625 world-transform scale (sub-pixel precision), so
 * ignoring the transform renders those files 16× too large.
 */

import type { EmfGdiReplayCtx, TransformMatrix } from './emf-types';

/** Map a logical X coordinate to canvas X. */
export function gmx(r: EmfGdiReplayCtx, x: number): number {
	const wt = r.state.worldTransform;
	const px = wt[0] * x + wt[4];
	if (r.useMappingMode) {
		return (
			((px - r.windowOrg.x) / (r.windowExt.cx || 1)) * (r.viewportExt.cx || 1) + r.viewportOrg.x
		);
	}
	return (px - r.bounds.left) * r.sx;
}

/** Map a logical Y coordinate to canvas Y. */
export function gmy(r: EmfGdiReplayCtx, y: number): number {
	const wt = r.state.worldTransform;
	const py = wt[3] * y + wt[5];
	if (r.useMappingMode) {
		return (
			((py - r.windowOrg.y) / (r.windowExt.cy || 1)) * (r.viewportExt.cy || 1) + r.viewportOrg.y
		);
	}
	return (py - r.bounds.top) * r.sy;
}

/** Map a logical width to canvas width. */
export function gmw(r: EmfGdiReplayCtx, w: number): number {
	const pw = r.state.worldTransform[0] * w;
	if (r.useMappingMode) {
		return (pw / (r.windowExt.cx || 1)) * (r.viewportExt.cx || 1);
	}
	return pw * r.sx;
}

/** Map a logical height to canvas height. */
export function gmh(r: EmfGdiReplayCtx, h: number): number {
	const ph = r.state.worldTransform[3] * h;
	if (r.useMappingMode) {
		return (ph / (r.windowExt.cy || 1)) * (r.viewportExt.cy || 1);
	}
	return ph * r.sy;
}

/** Switch to window/viewport mapping mode. */
export function activateGdiMappingMode(r: EmfGdiReplayCtx): void {
	r.useMappingMode = true;
}

// ---------------------------------------------------------------------------
// Full affine (rotation/skew) mapping
// ---------------------------------------------------------------------------

/** True when the active GDI world transform has a rotation or skew component. */
export function hasWorldRotation(r: EmfGdiReplayCtx): boolean {
	const wt = r.state.worldTransform;
	return wt[1] !== 0 || wt[2] !== 0;
}

/**
 * The full logical-to-device affine (world transform composed with the
 * bounds-based or window/viewport device mapping), as a standard
 * `[a, b, c, d, e, f]` matrix: `deviceX = a*x + c*y + e`,
 * `deviceY = b*x + d*y + f`. Unlike `gmx`/`gmy`, this includes the world
 * transform's `b`/`c` (rotation/skew) terms.
 */
export function gdiDeviceMatrix(r: EmfGdiReplayCtx): TransformMatrix {
	const wt = r.state.worldTransform;
	if (r.useMappingMode) {
		const kx = (r.viewportExt.cx || 1) / (r.windowExt.cx || 1);
		const ky = (r.viewportExt.cy || 1) / (r.windowExt.cy || 1);
		return [
			wt[0] * kx,
			wt[1] * ky,
			wt[2] * kx,
			wt[3] * ky,
			(wt[4] - r.windowOrg.x) * kx + r.viewportOrg.x,
			(wt[5] - r.windowOrg.y) * ky + r.viewportOrg.y,
		];
	}
	const sx = r.sx || 1;
	const sy = r.sy || 1;
	return [wt[0] * sx, wt[1] * sy, wt[2] * sx, wt[3] * sy, (wt[4] - r.bounds.left) * sx, (wt[5] - r.bounds.top) * sy];
}

/** Maps a logical point through the full affine device matrix (see {@link gdiDeviceMatrix}). */
export function gmapPoint(r: EmfGdiReplayCtx, x: number, y: number): { x: number; y: number } {
	const m = gdiDeviceMatrix(r);
	return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** A device-space ellipse: `ctx.ellipse(cx, cy, rx, ry, rotation, ...)` parameters. */
export interface GdiEllipseParams {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
	rotation: number;
}

/**
 * Maps a logical axis-aligned ellipse (centre `cx0`,`cy0`, radii `rx0`,`ry0`)
 * through the full affine device matrix. An affine map always carries an
 * ellipse to another ellipse, so this is exact for any rotation, skew, or
 * anisotropic scale, unlike scaling `rx0`/`ry0` independently: the semi-axis
 * lengths are the singular values of the mapped linear part (found via the
 * eigendecomposition of `A·Aᵀ`, `A` = the device matrix's linear part times
 * `diag(rx0, ry0)`), and `rotation` is the angle of the corresponding
 * eigenvector. Arc/Chord/Pie's start/end angles are unaffected: they are a
 * LOCAL parameter along this (pre-rotation) ellipse, which `ctx.ellipse`'s
 * own `rotation` parameter then carries into device space.
 */
export function gdiEllipseParams(r: EmfGdiReplayCtx, cx0: number, cy0: number, rx0: number, ry0: number): GdiEllipseParams {
	const m = gdiDeviceMatrix(r);
	const center = gmapPoint(r, cx0, cy0);
	// A = [[a*rx0, c*ry0], [b*rx0, d*ry0]]; decompose via S = A·Aᵀ (symmetric 2x2).
	const a11 = m[0] * rx0;
	const a12 = m[2] * ry0;
	const a21 = m[1] * rx0;
	const a22 = m[3] * ry0;
	const p = a11 * a11 + a12 * a12;
	const q = a11 * a21 + a12 * a22;
	const s = a21 * a21 + a22 * a22;
	const mid = (p + s) / 2;
	const spread = Math.sqrt(Math.max(0, ((p - s) / 2) ** 2 + q * q));
	const lambda1 = Math.max(0, mid + spread);
	const lambda2 = Math.max(0, mid - spread);
	// Standard closed-form rotation of a symmetric 2x2 matrix's major axis.
	const rotation = 0.5 * Math.atan2(2 * q, p - s);
	return {
		cx: center.x,
		cy: center.y,
		rx: Math.sqrt(lambda1),
		ry: Math.sqrt(lambda2),
		rotation,
	};
}
