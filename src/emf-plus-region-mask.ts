/**
 * EMF+ Region objects scan-converted to device pixels the way GDI+ holds a
 * region: every leaf (rectangle or path) rasterised on its own like an
 * aliased fill, its vertices rounded to the nearest 1/16 pixel (the
 * rounding GDI+ applies to region and clip geometry, see `clipPixelRects`
 * in `emf-plus-raster.ts`), and the node tree's boolean operations then
 * evaluated exactly, pixel by pixel. That is what `EmfPlusFillRegion`
 * paints: measured against GDI+ on a region of an ellipse path united with
 * a rectangle and XORed with another, and on a rotated rectangle with a
 * hole, a region fill is aliased under every SmoothingMode (the
 * antialiased and aliased references are byte-identical).
 *
 * @module emf-plus-region-mask
 */

import { recordDeviceFigures, rasterizePlusFill, type FixFigure } from './emf-plus-raster';
import { replayEmfPlusPath } from './emf-plus-path';
import type { CanvasContext, EmfPlusRegionNode, TransformMatrix } from './emf-types';

/** A device-pixel rectangle. */
export interface PixelBox {
	x: number;
	y: number;
	w: number;
	h: number;
}


/** Deepest region tree evaluated (a guard against hostile input). */
const MAX_DEPTH = 64;

/** A coordinate in 28.4 rounded to the nearest sixteenth, halves up (GDI+'s region rounding). */
function nearestFix(v: number): number {
	return Math.floor(v * 16 + 0.5 - 1e-4);
}

/** The pixels of `box` inside one leaf's geometry (`build` issues world coordinates mapped by `m`). */
function leafMask(
	build: (c: CanvasContext) => void,
	m: TransformMatrix,
	evenOdd: boolean,
	box: PixelBox,
	half: boolean,
): Uint8Array | null {
	let figures: FixFigure[];
	try {
		figures = recordDeviceFigures(build, m).map((f) => f.pts.map(nearestFix));
	} catch {
		return null;
	}
	const coverage = rasterizePlusFill(
		figures.filter((f) => f.length >= 6),
		evenOdd,
		false,
		half,
		box,
	);
	const out = new Uint8Array(box.w * box.h);
	for (let i = 0; i < out.length; i++) {
		out[i] = coverage[i] ? 1 : 0;
	}
	return out;
}

/**
 * The device pixels of `box` that belong to the region `node` describes in
 * world coordinates, under the world-to-device matrix `m` (1 = inside), or
 * `null` when the tree is too deep or a leaf uses geometry the recorder
 * cannot model. `half` samples pixel centres (PixelOffsetMode Half and
 * HighQuality). Boolean nodes follow `RegionNodeDataType`: 1 And, 2 Or,
 * 3 Xor, 4 Exclude (left minus right), 5 Complement (right minus left);
 * 0, which the spec leaves unassigned, is treated as And. Pure.
 */
export function regionPixelMask(
	node: EmfPlusRegionNode,
	m: TransformMatrix,
	box: PixelBox,
	half: boolean,
	depth: number = 0,
): Uint8Array | null {
	if (depth > MAX_DEPTH) {
		return null;
	}
	switch (node.type) {
		case 'infinite':
			return new Uint8Array(box.w * box.h).fill(1);
		case 'empty':
			return new Uint8Array(box.w * box.h);
		case 'rect': {
			const { x, y, width, height } = node;
			return leafMask((c) => c.rect(x, y, width, height), m, false, box, half);
		}
		case 'path': {
			const path = node.path;
			return leafMask((c) => replayEmfPlusPath(c, path), m, path.fillRule === 'evenodd', box, half);
		}
		case 'combine': {
			const a = regionPixelMask(node.left, m, box, half, depth + 1);
			const b = a ? regionPixelMask(node.right, m, box, half, depth + 1) : null;
			if (!a || !b) {
				return null;
			}
			const op = node.combineMode;
			for (let i = 0; i < a.length; i++) {
				const l = a[i];
				const r = b[i];
				a[i] = op === 2 ? l | r : op === 3 ? l ^ r : op === 4 ? l & (r ^ 1) : op === 5 ? r & (l ^ 1) : l & r;
			}
			return a;
		}
	}
}

/**
 * The tight device box of a mask's set pixels (in `box` coordinates made
 * absolute), or `null` when none is set. Pure.
 */
export function maskBounds(mask: Uint8Array, box: PixelBox): PixelBox | null {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < box.h; y++) {
		for (let x = 0; x < box.w; x++) {
			if (mask[y * box.w + x]) {
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x);
				y0 = Math.min(y0, y);
				y1 = Math.max(y1, y);
			}
		}
	}
	return x1 < 0 ? null : { x: box.x + x0, y: box.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

