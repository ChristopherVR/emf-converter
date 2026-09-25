/**
 * EMF+ HatchFill brushes, painted the way GDI+ paints them.
 *
 * A GDI+ hatch brush is an 8 x 8 pixel pattern of its foreground and
 * background colours, laid on the DEVICE pixel grid (whatever the world
 * transform) and anchored at the Graphics rendering origin
 * (`EmfPlusSetRenderingOrigin`, (0, 0) by default): device pixel (x, y)
 * takes pattern cell ((x - originX) mod 8, (y - originY) mod 8). The 53
 * patterns below were read back from GDI+ itself (each HatchStyle filled
 * black on white, every pixel checked for 8-periodicity). All but three
 * are plain bit patterns; ForwardDiagonal, BackwardDiagonal and
 * DiagonalCross are antialiased: their line pixel takes 234/256 of the
 * foreground and its two neighbours across the line 64/256 (DiagonalCross
 * takes the larger weight where its two lines meet), mixed as
 * `(fore * w + back * (256 - w)) >> 8` in premultiplied colour (measured
 * with opaque and translucent colours).
 *
 * Every raster fill samples {@link hatchSampler} per device pixel; SVG and
 * `gdiAntialias: true` output paint the same 8 x 8 tile as a repeating
 * `CanvasPattern` held on the device grid ({@link createHatchPattern}).
 *
 * @module emf-plus-brush-hatch
 */

import { canvasCreatePattern, canvasPutImageData, createImageDataCompat, createTempCanvas } from './emf-canvas-helpers';
import type { CanvasContext, TransformMatrix } from './emf-types';

/** A parsed EMF+ hatch brush (MS-EMFPLUS 2.2.2.20). */
export interface EmfPlusHatch {
	/** GDI+ `HatchStyle`, 0 (Horizontal) to 52 (SolidDiamond). */
	style: number;
	/** Foreground and background colours, packed ARGB. */
	fore: number;
	back: number;
}

/**
 * The bit patterns of HatchStyle 0 to 52, eight rows of eight pixels each
 * (bit 7 is the leftmost pixel; a set bit is foreground), read back from
 * GDI+. Styles 2, 3 and 5 are antialiased (see {@link hatchWeight}); their
 * rows here are the line pixels only.
 */
export const HATCH_PATTERNS: ReadonlyArray<ReadonlyArray<number>> = [
	[0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
	[0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80],
	[0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
	[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80],
	[0xff, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80],
	[0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81],
	[0x80, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00],
	[0x80, 0x00, 0x08, 0x00, 0x80, 0x00, 0x08, 0x00],
	[0x88, 0x00, 0x22, 0x00, 0x88, 0x00, 0x22, 0x00],
	[0x88, 0x22, 0x88, 0x22, 0x88, 0x22, 0x88, 0x22],
	[0xaa, 0x44, 0xaa, 0x11, 0xaa, 0x44, 0xaa, 0x11],
	[0xaa, 0x55, 0xaa, 0x51, 0xaa, 0x55, 0xaa, 0x15],
	[0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55],
	[0xee, 0x55, 0xbb, 0x55, 0xee, 0x55, 0xbb, 0x55],
	[0x77, 0xdd, 0x77, 0xdd, 0x77, 0xdd, 0x77, 0xdd],
	[0x77, 0xff, 0xdd, 0xff, 0x77, 0xff, 0xdd, 0xff],
	[0xef, 0xff, 0xfe, 0xff, 0xef, 0xff, 0xfe, 0xff],
	[0xff, 0xff, 0xff, 0xf7, 0xff, 0xff, 0xff, 0x7f],
	[0x88, 0x44, 0x22, 0x11, 0x88, 0x44, 0x22, 0x11],
	[0x11, 0x22, 0x44, 0x88, 0x11, 0x22, 0x44, 0x88],
	[0xcc, 0x66, 0x33, 0x99, 0xcc, 0x66, 0x33, 0x99],
	[0x33, 0x66, 0xcc, 0x99, 0x33, 0x66, 0xcc, 0x99],
	[0xc1, 0xe0, 0x70, 0x38, 0x1c, 0x0e, 0x07, 0x83],
	[0x83, 0x07, 0x0e, 0x1c, 0x38, 0x70, 0xe0, 0xc1],
	[0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88],
	[0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00],
	[0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55],
	[0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00],
	[0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc],
	[0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00],
	[0x00, 0x00, 0x88, 0x44, 0x22, 0x11, 0x00, 0x00],
	[0x00, 0x00, 0x11, 0x22, 0x44, 0x88, 0x00, 0x00],
	[0xf0, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x00, 0x00],
	[0x80, 0x80, 0x80, 0x80, 0x08, 0x08, 0x08, 0x08],
	[0x80, 0x08, 0x40, 0x02, 0x10, 0x01, 0x20, 0x04],
	[0xb1, 0x30, 0x03, 0x1b, 0xd8, 0xc0, 0x0c, 0x8d],
	[0x81, 0x42, 0x24, 0x18, 0x81, 0x42, 0x24, 0x18],
	[0x00, 0x18, 0x25, 0xc0, 0x00, 0x18, 0x25, 0xc0],
	[0x01, 0x02, 0x04, 0x08, 0x18, 0x24, 0x42, 0x81],
	[0xff, 0x80, 0x80, 0x80, 0xff, 0x08, 0x08, 0x08],
	[0x88, 0x54, 0x22, 0x45, 0x88, 0x14, 0x22, 0x51],
	[0xaa, 0x55, 0xaa, 0x55, 0xf0, 0xf0, 0xf0, 0xf0],
	[0x00, 0x10, 0x08, 0x10, 0x00, 0x80, 0x01, 0x80],
	[0xaa, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80, 0x00],
	[0x80, 0x00, 0x22, 0x00, 0x08, 0x00, 0x22, 0x00],
	[0x03, 0x84, 0x48, 0x30, 0x0c, 0x02, 0x01, 0x01],
	[0xff, 0x66, 0xff, 0x99, 0xff, 0x66, 0xff, 0x99],
	[0x77, 0x89, 0x8f, 0x8f, 0x77, 0x98, 0xf8, 0xf8],
	[0xff, 0x88, 0x88, 0x88, 0xff, 0x88, 0x88, 0x88],
	[0x99, 0x66, 0x66, 0x99, 0x99, 0x66, 0x66, 0x99],
	[0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f],
	[0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x82, 0x01],
	[0x10, 0x38, 0x7c, 0xfe, 0x7c, 0x38, 0x10, 0x00],
];

/** Foreground weight (of 256) of an antialiased diagonal's line pixel and of its neighbours. */
const LINE_WEIGHT = 234;
const EDGE_WEIGHT = 64;

/**
 * The foreground weight, 0 to 256, of pattern cell (`i`, `j`) (each 0 to
 * 7) of HatchStyle `style`: 256 or 0 for the bit patterns; for the
 * antialiased diagonals see the module doc. An unknown style paints its
 * background. Pure.
 */
export function hatchWeight(style: number, i: number, j: number): number {
	const forward = (): number => {
		const d = (((i - j) % 8) + 8) % 8;
		return d === 0 ? LINE_WEIGHT : d === 1 || d === 7 ? EDGE_WEIGHT : 0;
	};
	const backward = (): number => {
		const d = (((i + j - 7) % 8) + 8) % 8;
		return d === 0 ? LINE_WEIGHT : d === 1 || d === 7 ? EDGE_WEIGHT : 0;
	};
	switch (style) {
		case 2:
			return forward();
		case 3:
			return backward();
		case 5:
			return Math.max(forward(), backward());
		default: {
			const rows = HATCH_PATTERNS[style];
			return rows && rows[j] & (0x80 >> i) ? 256 : 0;
		}
	}
}

/**
 * The colour (packed ARGB) of a cell with foreground weight `w` (of 256):
 * the two colours mixed in premultiplied form, `(f * w + b * (256 - w)) >> 8`
 * per channel, then un-premultiplied. Pure.
 */
export function hatchMix(fore: number, back: number, w: number): number {
	if (w >= 256) {
		return fore >>> 0;
	}
	if (w <= 0) {
		return back >>> 0;
	}
	const fa = (fore >>> 24) & 0xff;
	const ba = (back >>> 24) & 0xff;
	const a = (fa * w + ba * (256 - w)) >> 8;
	if (a === 0) {
		return 0;
	}
	let out = a << 24;
	for (const shift of [16, 8, 0]) {
		const fp = Math.round((((fore >>> shift) & 0xff) * fa) / 255);
		const bp = Math.round((((back >>> shift) & 0xff) * ba) / 255);
		const p = (fp * w + bp * (256 - w)) >> 8;
		out |= Math.min(255, Math.round((p * 255) / a)) << shift;
	}
	return out >>> 0;
}

/**
 * The 8 x 8 tile of a hatch brush as straight RGBA (row-major), cell (0,
 * 0) first. Pure.
 */
export function hatchTile(hatch: EmfPlusHatch): Uint8ClampedArray {
	const out = new Uint8ClampedArray(8 * 8 * 4);
	for (let j = 0; j < 8; j++) {
		for (let i = 0; i < 8; i++) {
			const c = hatchMix(hatch.fore, hatch.back, hatchWeight(hatch.style, i, j));
			const o = (j * 8 + i) * 4;
			out[o] = (c >>> 16) & 0xff;
			out[o + 1] = (c >>> 8) & 0xff;
			out[o + 2] = c & 0xff;
			out[o + 3] = (c >>> 24) & 0xff;
		}
	}
	return out;
}

/**
 * A per-device-pixel sampler (see `DeviceBrushSampler` in
 * `emf-plus-exact-fill.ts`) of a hatch brush: canvas pixel (x, y) is
 * mapped to its GDI+ device pixel by `canvasToDevice` (the inverse of the
 * DPI scale and base transform) and takes pattern cell (device - origin)
 * mod 8.
 */
export function hatchSampler(
	hatch: EmfPlusHatch,
	origin: { x: number; y: number },
	canvasToDevice: TransformMatrix,
): (x0: number, y0: number, w: number, h: number, out: Uint8ClampedArray) => void {
	const tile = hatchTile(hatch);
	const m = canvasToDevice;
	return (x0, y0, w, h, out) => {
		for (let j = 0; j < h; j++) {
			for (let i = 0; i < w; i++) {
				const cx = x0 + i + 0.5;
				const cy = y0 + j + 0.5;
				const dx = Math.floor(m[0] * cx + m[2] * cy + m[4]);
				const dy = Math.floor(m[1] * cx + m[3] * cy + m[5]);
				const ti = ((((dx - origin.x) % 8) + 8) % 8) + ((((dy - origin.y) % 8) + 8) % 8) * 8;
				const o = (j * w + i) * 4;
				out[o] = tile[ti * 4];
				out[o + 1] = tile[ti * 4 + 1];
				out[o + 2] = tile[ti * 4 + 2];
				out[o + 3] = tile[ti * 4 + 3];
			}
		}
	};
}

/**
 * The hatch brush as a repeating `CanvasPattern` for a fill made under the
 * user-to-canvas matrix `user` (the world-to-device matrix the fill is
 * issued with): one tile cell per device pixel, anchored at the rendering
 * origin, whatever `user` is. `deviceToCanvas` maps GDI+ device pixels to
 * canvas pixels. `null` when the context cannot make one.
 */
export function createHatchPattern(
	ctx: CanvasContext,
	hatch: EmfPlusHatch,
	origin: { x: number; y: number },
	user: TransformMatrix,
	deviceToCanvas: TransformMatrix,
): CanvasPattern | null {
	if (typeof ctx.createPattern !== 'function') {
		return null;
	}
	const temp = createTempCanvas(8, 8);
	if (!temp) {
		return null;
	}
	canvasPutImageData(temp.ctx, createImageDataCompat(hatchTile(hatch), 8, 8), 0, 0);
	const pattern = canvasCreatePattern(ctx, temp.canvas, 'repeat');
	if (!pattern || typeof pattern.setTransform !== 'function') {
		return pattern;
	}
	// Pattern space -> device (origin) -> canvas -> user space.
	const det = user[0] * user[3] - user[1] * user[2];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return pattern;
	}
	const inv: TransformMatrix = [
		user[3] / det,
		-user[1] / det,
		-user[2] / det,
		user[0] / det,
		(user[2] * user[5] - user[3] * user[4]) / det,
		(user[1] * user[4] - user[0] * user[5]) / det,
	];
	const d = deviceToCanvas;
	const toCanvas: TransformMatrix = [d[0], d[1], d[2], d[3], d[0] * origin.x + d[2] * origin.y + d[4], d[1] * origin.x + d[3] * origin.y + d[5]];
	const m: TransformMatrix = [
		inv[0] * toCanvas[0] + inv[2] * toCanvas[1],
		inv[1] * toCanvas[0] + inv[3] * toCanvas[1],
		inv[0] * toCanvas[2] + inv[2] * toCanvas[3],
		inv[1] * toCanvas[2] + inv[3] * toCanvas[3],
		inv[0] * toCanvas[4] + inv[2] * toCanvas[5] + inv[4],
		inv[1] * toCanvas[4] + inv[3] * toCanvas[5] + inv[5],
	];
	try {
		pattern.setTransform({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] });
	} catch {
		// Some backends reject a DOMMatrix-like literal; the pattern then stays unanchored.
	}
	return pattern;
}
