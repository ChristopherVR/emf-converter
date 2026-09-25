/**
 * EMF+ curve and region drawing records: DrawBeziers, DrawCurve,
 * DrawClosedCurve, FillClosedCurve and FillRegion.
 *
 * The curve records carry their points absolute (32-bit floats, or 16-bit
 * integers under flag C) or, except DrawCurve, relative (flag P, see
 * `readPlusPoints`). Cardinal splines become the Bezier curves GDI+
 * converts them to (`emf-plus-spline.ts`), so every curve is drawn as the
 * path GDI+ itself strokes or fills: through `strokePlusGeometry` and
 * `tryFillPlusShapeExact`, which rasterise it the GDI+ way in PNG output
 * and keep it a vector path in SVG output.
 *
 * FillRegion paints the region's device pixels as GDI+ scan-converts a
 * region (`emf-plus-region-mask.ts`), aliased whatever the SmoothingMode;
 * SVG output (and `gdiAntialias: true`) fills the region's vector outline
 * instead, intersecting its shapes through the clip.
 *
 * @module emf-plus-curve-handlers
 */

import { replayClipCmds } from './emf-clip-region';
import {
	EMFPLUS_DRAWBEZIERS,
	EMFPLUS_DRAWCLOSEDCURVE,
	EMFPLUS_DRAWCURVE,
	EMFPLUS_FILLCLOSEDCURVE,
	EMFPLUS_FILLREGION,
	EMFPLUS_STROKEFILLPATH,
} from './emf-constants';
import { emfWarn } from './emf-logging';
import {
	anyBrushSampler,
	invertAffine,
	compositeBrushCoverage,
	plusRasterMode,
	tryFillPlusShapeExact,
} from './emf-plus-exact-fill';
import { isHalfPixelOffset } from './emf-plus-image-resample';
import { readPlusPoints, type PointCoords } from './emf-plus-read-helpers';
import { maskBounds, regionPixelMask } from './emf-plus-region-mask';
import { cardinalSplineBeziers } from './emf-plus-spline';
import {
	applyPlusWorldTransform,
	flattenRegionNode,
	plusWorldMatrix,
	resolveBrushPaint,
} from './emf-plus-state-handlers';
import { strokePlusGeometry } from './emf-plus-stroke';
import { fillPlusPath, strokePlusPath } from './emf-plus-text-image-handlers';
import type { CanvasContext, EmfPlusPen, EmfPlusReplayCtx } from './emf-types';

/** Record flag W (0x2000) of FillClosedCurve: a winding (nonzero) fill; clear is alternate (even-odd). */
const FLAG_WINDING = 0x2000;

/** The pen object a draw record names in its flags, or `null`. */
function penOf(rCtx: EmfPlusReplayCtx, flags: number): EmfPlusPen | null {
	const pen = rCtx.objectTable.get(flags & 0xff);
	return pen && pen.kind === 'plus-pen' ? pen : null;
}

/** Issues Bezier points (a start point, then three per segment) as one figure, closed when asked. */
function bezierPath(pts: ReadonlyArray<PointCoords>, closed: boolean): (c: CanvasContext) => void {
	return (c) => {
		c.moveTo(pts[0].x, pts[0].y);
		for (let i = 1; i + 2 < pts.length; i += 3) {
			c.bezierCurveTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, pts[i + 2].x, pts[i + 2].y);
		}
		if (closed) {
			c.closePath();
		}
	};
}

/**
 * Handles the curve and region drawing records; returns `false` for any
 * other record type.
 */
export function handleEmfPlusCurveRecord(
	rCtx: EmfPlusReplayCtx,
	recType: number,
	recFlags: number,
	dataOff: number,
	recDataSize: number,
): boolean {
	const { view } = rCtx;
	const end = dataOff + recDataSize;
	switch (recType) {
		case EMFPLUS_DRAWBEZIERS: {
			if (recDataSize < 4) {
				return true;
			}
			const count = view.getUint32(dataOff, true);
			const pts = readPlusPoints(view, dataOff + 4, end, count, recFlags);
			// A start point and three points per curve (GDI+ rejects any other count).
			if (!pts || pts.length < 4 || (pts.length - 1) % 3 !== 0) {
				return true;
			}
			strokePlusGeometry(rCtx, penOf(rCtx, recFlags), bezierPath(pts, false), pts, false);
			return true;
		}

		case EMFPLUS_DRAWCURVE: {
			if (recDataSize < 16) {
				return true;
			}
			const tension = view.getFloat32(dataOff, true);
			const offset = view.getUint32(dataOff + 4, true);
			const segments = view.getUint32(dataOff + 8, true);
			const count = view.getUint32(dataOff + 12, true);
			// DrawCurve has no relative form: only flag C selects the encoding.
			const pts = readPlusPoints(view, dataOff + 16, end, count, recFlags & 0x4000);
			if (!pts) {
				return true;
			}
			const bez = cardinalSplineBeziers(pts, tension, false, offset, segments);
			if (bez.length >= 4) {
				strokePlusGeometry(rCtx, penOf(rCtx, recFlags), bezierPath(bez, false), bez, false);
			}
			return true;
		}

		case EMFPLUS_DRAWCLOSEDCURVE: {
			if (recDataSize < 8) {
				return true;
			}
			const tension = view.getFloat32(dataOff, true);
			const count = view.getUint32(dataOff + 4, true);
			const pts = readPlusPoints(view, dataOff + 8, end, count, recFlags);
			const bez = pts ? cardinalSplineBeziers(pts, tension, true) : [];
			if (bez.length >= 4) {
				strokePlusGeometry(rCtx, penOf(rCtx, recFlags), bezierPath(bez, true), bez, true);
			}
			return true;
		}

		case EMFPLUS_FILLCLOSEDCURVE: {
			if (recDataSize < 12) {
				return true;
			}
			const brush = view.getUint32(dataOff, true);
			const tension = view.getFloat32(dataOff + 4, true);
			const count = view.getUint32(dataOff + 8, true);
			const pts = readPlusPoints(view, dataOff + 12, end, count, recFlags);
			const bez = pts ? cardinalSplineBeziers(pts, tension, true) : [];
			if (bez.length < 4) {
				return true;
			}
			const rule: CanvasFillRule = recFlags & FLAG_WINDING ? 'nonzero' : 'evenodd';
			const build = bezierPath(bez, true);
			if (!tryFillPlusShapeExact(rCtx, recFlags, brush, build, bez, rule)) {
				const { ctx } = rCtx;
				ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brush);
				applyPlusWorldTransform(rCtx);
				ctx.beginPath();
				build(ctx);
				ctx.fill(rule);
			}
			return true;
		}

		case EMFPLUS_STROKEFILLPATH: {
			strokeFillPath(rCtx, recFlags, dataOff, recDataSize);
			return true;
		}

		case EMFPLUS_FILLREGION: {
			if (recDataSize < 4) {
				return true;
			}
			fillRegion(rCtx, recFlags, view.getUint32(dataOff, true));
			return true;
		}

		default:
			return false;
	}
}

/**
 * EmfPlusStrokeFillPath, as GDI+ plays it (MS-EMFPLUS 2.3.4 gives no layout;
 * read from gdiplus.dll and confirmed on `gpx-rec-strokefillpath`): the
 * flags' low byte names the path; the data holds a pen id, a brush id and a
 * third 32-bit field (an effect GDI+ fetches and ignores), 12 bytes at
 * least or the record is ignored. 0xFFFFFFFF skips the pen or the brush;
 * both are object ids (there is no inline-colour flag). GDI+ fills the
 * path, then strokes it, leaving open figures open, and drops any pending
 * image effect.
 */
function strokeFillPath(rCtx: EmfPlusReplayCtx, flags: number, dataOff: number, dataSize: number): void {
	if (dataSize < 12) {
		return;
	}
	const { view, objectTable } = rCtx;
	const path = objectTable.get(flags & 0xff);
	const penId = view.getUint32(dataOff, true);
	const brushId = view.getUint32(dataOff + 4, true);
	if (rCtx.ext) {
		rCtx.ext.pendingEffect = null;
	}
	if (!path || path.kind !== 'plus-path') {
		return;
	}
	const brush = brushId <= 0xff ? objectTable.get(brushId) : undefined;
	if (brush && brush.kind === 'plus-brush') {
		fillPlusPath(rCtx, 0, brushId, path);
	}
	const pen = penId <= 0xff ? objectTable.get(penId) : undefined;
	if (pen && pen.kind === 'plus-pen') {
		strokePlusPath(rCtx, pen, path);
	}
}

/** The drawing surface size, when the context exposes its canvas. */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}

/**
 * EmfPlusFillRegion: the region object named in the flags, filled with the
 * record's brush (see the module doc).
 */
function fillRegion(rCtx: EmfPlusReplayCtx, flags: number, brush: number): void {
	const region = rCtx.objectTable.get(flags & 0xff);
	if (!region || region.kind !== 'plus-region' || region.nodes.length === 0) {
		return;
	}
	const node = region.nodes[0];
	const device = plusWorldMatrix(rCtx);
	const { ctx } = rCtx;
	const size = surfaceSize(ctx);
	if (plusRasterMode(rCtx) !== 'canvas' && size) {
		const domain = { x: 0, y: 0, w: size.w, h: size.h };
		const mask = regionPixelMask(node, device, domain, isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0));
		const sampler = mask ? anyBrushSampler(rCtx, flags, brush) : null;
		if (mask && sampler) {
			const box = maskBounds(mask, domain);
			if (!box) {
				return;
			}
			const coverage = new Uint8ClampedArray(box.w * box.h);
			for (let y = 0; y < box.h; y++) {
				for (let x = 0; x < box.w; x++) {
					coverage[y * box.w + x] = mask[(box.y + y) * domain.w + box.x + x] ? 255 : 0;
				}
			}
			if (compositeBrushCoverage(rCtx, sampler, box, coverage, 1, true)) {
				return;
			}
		}
	}
	// Vector fill: the region's shapes (device space) intersected through the clip.
	const flat = flattenRegionNode(node, device, 0, size ? { x: 0, y: 0, w: size.w, h: size.h } : undefined);
	if (!flat.exact) {
		emfWarn('FillRegion: region approximated (no canvas domain for an unbounded result)');
	}
	const shapes = flat.region;
	const inv = invertAffine(device);
	if ((shapes && shapes.length === 0) || !inv) {
		return;
	}
	// Device-space extent to paint: the canvas, or the shapes' own bounds.
	const extent = size ?? { w: 1e6, h: 1e6 };
	ctx.save();
	try {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		for (const shape of shapes ?? []) {
			ctx.beginPath();
			replayClipCmds(ctx, shape.cmds);
			ctx.clip(shape.fillRule);
		}
		// The paint is defined in world space (a gradient or texture brush), so
		// the clipped area is covered by a world-space quadrilateral.
		ctx.fillStyle = resolveBrushPaint(rCtx, flags, brush);
		applyPlusWorldTransform(rCtx);
		const corners = [
			[0, 0],
			[extent.w, 0],
			[extent.w, extent.h],
			[0, extent.h],
		].map(([x, y]) => ({ x: inv[0] * x + inv[2] * y + inv[4], y: inv[1] * x + inv[3] * y + inv[5] }));
		ctx.beginPath();
		ctx.moveTo(corners[0].x, corners[0].y);
		for (let i = 1; i < 4; i++) {
			ctx.lineTo(corners[i].x, corners[i].y);
		}
		ctx.closePath();
		ctx.fill();
	} finally {
		ctx.restore();
	}
}
