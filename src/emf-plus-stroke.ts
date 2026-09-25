/**
 * EMF+ pen strokes: GDI+ pen geometry (width, caps, join, miter limit, dash
 * style or custom dash pattern and offset, all in pen widths) mapped onto
 * Canvas stroke state, and strokes whose pen carries a texture, linear- or
 * path-gradient brush painted exactly.
 *
 * Raster strokes follow the recorded SmoothingMode (see `plusRasterMode`):
 * aliased or with GDI+'s antialiasing, a stroke is rasterised as GDI+ does
 * it, a pen up to 1.5 device pixels wide as GDI+'s nominal-width line
 * (`emf-plus-nominal-line.ts`) and
 * a wider one as the outline GDI+'s widener builds (joins, caps, dash
 * pattern and DashCap, compound bands, Inset alignment:
 * `emf-plus-widen.ts`), scan-converted by GDI+'s fill rules
 * (`emf-plus-raster.ts`); under `gdiAntialias: true` Canvas strokes it. In
 * every raster mode the colour of each device pixel comes from the very
 * brush sampler a fill uses, so a texture or gradient pen shows its brush
 * exactly as GDI+ paints it, unfiltered. SVG output keeps a vector stroke
 * painted with the brush's paint server (`<linearGradient>`, `<pattern>`).
 *
 * @module emf-plus-stroke
 */

import {
	brushSampler,
	cssColorToArgb,
	compositeBrushCoverage,
	deviceBounds,
	plusRasterMode,
	paintBrushThroughMask,
	solidSampler,
	type DeviceBrushSampler,
} from './emf-plus-exact-fill';
import { isHalfPixelOffset } from './emf-plus-image-resample';
import {
	figuresBox,
	rasterizePlusFill,
	recordDeviceFigures,
	toPlusFix,
	type DeviceFigure,
	type FixFigure,
} from './emf-plus-raster';
import { applyPlusWorldTransform, brushPaint, plusWorldMatrix } from './emf-plus-state-handlers';
import { customCapGeometry } from './emf-plus-custom-cap';
import { nominalLineCoverage, recordNominalFigures, type NominalFigure } from './emf-plus-nominal-line';
import { widenFigures, type DevicePen } from './emf-plus-widen';
import { isSvgContext } from './svg-context';
import type { CanvasContext, EmfPlusPen, EmfPlusReplayCtx, TransformMatrix } from './emf-types';

/**
 * Device pen width at or below which GDI+ draws a nominal-width line: one
 * pixel across the minor axis whatever the width, instead of the widened
 * outline. Measured on single lines: widths 0.5, 1, 1.2 and 1.5 all put
 * exactly one pixel's coverage in every column of an x-major line (aliased
 * and antialiased), 1.6 already its true 1.6 / cos(angle).
 */
export const NOMINAL_PEN_MAX = 1.5;

/** GDI+ `DashStyle` patterns (Dash, Dot, DashDot, DashDotDot), in pen widths. */
const DASH_PATTERNS: Record<number, number[]> = {
	1: [3, 1],
	2: [1, 1],
	3: [3, 1, 1, 1],
	4: [3, 1, 1, 1, 1, 1],
};

/** Canvas `lineCap` for a GDI+ `LineCap` (anchor caps approximated by their base shape). */
export function canvasLineCap(cap: number | undefined): CanvasLineCap {
	switch (cap) {
		case 1: // Square
		case 0x11: // SquareAnchor
			return 'square';
		case 2: // Round
		case 0x12: // RoundAnchor
		case 3: // Triangle
		case 0x13: // DiamondAnchor
			return 'round';
		default:
			return 'butt';
	}
}

/** Canvas `lineJoin` for a GDI+ `LineJoin` (Miter, Bevel, Round, MiterClipped). */
export function canvasLineJoin(join: number | undefined): CanvasLineJoin {
	if (join === 1) {
		return 'bevel';
	}
	return join === 2 ? 'round' : 'miter';
}

/**
 * The Canvas dash array for a pen, in world units (GDI+ dash lengths are in
 * pen widths), or `[]` for a solid pen.
 */
export function penDashArray(pen: EmfPlusPen): number[] {
	const w = pen.width || 1;
	const pattern = pen.dashStyle === 5 ? pen.dashPattern : DASH_PATTERNS[pen.dashStyle];
	if (!pattern || pattern.length === 0 || pattern.some((v) => !(v >= 0))) {
		return [];
	}
	return pattern.map((v) => v * w);
}

/**
 * Applies a GDI+ pen's stroke geometry (not its paint) to a context.
 * `widthScale` multiplies the width (an inset pen is stroked at twice its
 * width and clipped to the figure, see {@link strokePlusGeometry}). A dashed
 * pen caps every dash with its `DashCap` (flat by default), which is what
 * Canvas's single `lineCap` then carries; a solid pen uses its start cap.
 */
export function applyPlusPenStyle(ctx: CanvasContext, pen: EmfPlusPen, widthScale: number = 1): void {
	ctx.lineWidth = pen.width * widthScale;
	const dashes = penDashArray(pen);
	ctx.lineCap = canvasLineCap(dashes.length > 0 ? (pen.dashCap ?? 0) : (pen.startCap ?? pen.endCap));
	ctx.lineJoin = canvasLineJoin(pen.lineJoin);
	ctx.miterLimit = pen.miterLimit && pen.miterLimit >= 1 ? pen.miterLimit : 10;
	if (typeof ctx.setLineDash === 'function') {
		ctx.setLineDash(dashes);
	}
	ctx.lineDashOffset = dashes.length > 0 ? (pen.dashOffset ?? 0) * (pen.width || 1) : 0;
}

/**
 * Strokes geometry with an EMF+ pen: `buildPath` issues the geometry (world
 * coordinates, `beginPath()` already done) on whichever context it is
 * given, and `points` bound it (world space; control points suffice), for
 * sizing the exact brush path. `closedFigure` is true when every figure is
 * closed (a rectangle, ellipse, pie, polygon or closed path): an Inset pen
 * (`PenAlignment` 1) then paints its whole width inside the figure, as
 * GDI+ does, which is the figure's own stroke at twice the width clipped to
 * its interior. Without a pen object the current stroke style is used, as
 * before.
 */
export function strokePlusGeometry(
	rCtx: EmfPlusReplayCtx,
	pen: EmfPlusPen | null,
	buildPath: (c: CanvasContext) => void,
	points: ReadonlyArray<{ x: number; y: number }> | null,
	closedFigure: boolean = false,
): void {
	const { ctx } = rCtx;
	const inset = !!pen && pen.alignment === 1 && closedFigure;
	const widthScale = inset ? 2 : 1;
	/** Strokes on `c` (transform already set), clipped to the figure for an inset pen. */
	const stroke = (c: CanvasContext): void => {
		if (inset) {
			c.save();
			c.beginPath();
			buildPath(c);
			c.clip();
		}
		c.beginPath();
		buildPath(c);
		c.stroke();
		if (inset) {
			c.restore();
		}
	};
	if (pen) {
		applyPlusPenStyle(ctx, pen, widthScale);
		const mode = plusRasterMode(rCtx);
		let sampler = pen.brush && !isSvgContext(ctx) ? brushSampler(rCtx, pen.brush) : null;
		if (!sampler && mode !== 'canvas') {
			const argb = cssColorToArgb(pen.color);
			sampler = argb === null ? null : solidSampler(argb);
		}
		if (sampler) {
			const size = surfaceSize(ctx);
			const device = plusWorldMatrix(rCtx);
			const scale = Math.max(Math.hypot(device[0], device[1]), Math.hypot(device[2], device[3]));
			if (mode !== 'canvas' && size && strokeGdiplus(rCtx, pen, sampler, buildPath, device, size, mode, closedFigure)) {
				return;
			}
			const miter = Math.max(1, ctx.miterLimit || 10);
			const margin = (pen.width * scale * miter) / 2 + 2;
			const box = size ? deviceBounds(points, device, size, margin) : null;
			if (size && !box) {
				return; // Entirely off the surface.
			}
			if (
				box &&
				paintBrushThroughMask(
					rCtx,
					sampler,
					box,
					(c) => {
						applyPlusPenStyle(c, pen, widthScale);
						stroke(c);
						// Leave the geometry current for the aliased hit test.
						c.beginPath();
						buildPath(c);
					},
					mode,
					(c, x, y) => c.isPointInStroke(x, y) && (!inset || c.isPointInPath(x, y)),
				)
			) {
				return;
			}
		}
		if (hasCustomCap(pen) && !pen.transform && fillCustomCapStroke(rCtx, pen, buildPath, closedFigure)) {
			return;
		}
		ctx.strokeStyle = pen.brush ? brushPaint(rCtx, pen.brush) : pen.color;
	}
	applyPlusWorldTransform(rCtx);
	stroke(ctx);
}

/**
 * Strokes the geometry `buildPath` issues the way GDI+ does (aliased or
 * with its antialiasing): recorded and flattened as GDI+ holds it, then a
 * pen at most {@link NOMINAL_PEN_MAX} device pixels wide drawn as GDI+'s
 * nominal-width line and a wider one widened into GDI+'s outline
 * (`widenFigures`, emf-plus-widen.ts), both scan-converted by GDI+'s fill
 * rules and painted through the brush. `closedFigure` marks every figure
 * closed (the caller knows a rectangle, ellipse or polygon is). Returns
 * `false`, having drawn nothing, for geometry it cannot model: a pen
 * transform, a non-uniform or skewed device transform, or a path call the
 * recorder lacks.
 */
function strokeGdiplus(
	rCtx: EmfPlusReplayCtx,
	pen: EmfPlusPen,
	sampler: DeviceBrushSampler,
	buildPath: (c: CanvasContext) => void,
	device: TransformMatrix,
	size: { w: number; h: number },
	mode: 'aliased' | 'gdiplus-aa',
	closedFigure: boolean,
): boolean {
	if (pen.transform && !isIdentity(pen.transform)) {
		return false;
	}
	// Only a similarity (uniform scale and rotation): a pen stays round.
	const sx = Math.hypot(device[0], device[1]);
	const sy = Math.hypot(device[2], device[3]);
	const dot = device[0] * device[2] + device[1] * device[3];
	if (!(sx > 0) || Math.abs(sx - sy) > 1e-6 * sx || Math.abs(dot) > 1e-6 * sx * sy) {
		return false;
	}
	let figures: DeviceFigure[];
	try {
		figures = recordDeviceFigures(buildPath, device);
	} catch {
		return false;
	}
	if (closedFigure) {
		figures = figures.map((f) => ({ ...f, closed: true }));
	}
	const width = (pen.width || 1) * sx;
	const dash = penDashArray(pen).map((v) => v * sx);
	const devicePen: DevicePen = {
		half: width / 2,
		join: pen.lineJoin ?? 0,
		miterLimit: pen.miterLimit && pen.miterLimit >= 1 ? pen.miterLimit : 10,
		startCap: pen.startCap ?? 0,
		endCap: pen.endCap ?? 0,
		dashCap: pen.dashCap ?? 0,
		dash: dash.length > 0 ? dash : null,
		dashOffset: (pen.dashOffset ?? 0) * (pen.width || 1) * sx,
		compound: pen.compound ?? null,
		inset: pen.alignment === 1,
	};
	const antialias = mode === 'gdiplus-aa';
	let fix: FixFigure[];
	if (hasCustomCap(pen)) {
		fix = customCapOutline(figures, width, devicePen, pen).map((poly) => poly.flatMap((p) => [toPlusFix(p.x), toPlusFix(p.y)]));
	} else if (width <= NOMINAL_PEN_MAX && !devicePen.dash && !(((pen.startCap ?? 0) | (pen.endCap ?? 0) | (pen.dashCap ?? 0)) & 0xf0)) {
		return strokeNominal(rCtx, pen, sampler, buildPath, device, size, antialias, closedFigure);
	} else {
		fix = widenFigures(figures, devicePen).map((poly) => poly.flatMap((p) => [toPlusFix(p.x), toPlusFix(p.y)]));
	}
	const box = figuresBox(fix, size);
	if (!box) {
		return true; // Nothing on the surface.
	}
	if (box.w * box.h > 16_000_000) {
		return false;
	}
	const coverage = rasterizePlusFill(fix, false, antialias, isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0), box);
	return compositeBrushCoverage(rCtx, sampler, box, coverage, 1, true);
}

/**
 * A pen at most {@link NOMINAL_PEN_MAX} device pixels wide (solid, without
 * anchor or custom caps) drawn as GDI+'s nominal-width line
 * (`emf-plus-nominal-line.ts`): the path enumerated in GDI+'s precision,
 * then GDI+'s one-pixel DDA (aliased, opaque solid brush, straight
 * figures) or its half-pixel diamond outline scan-converted.
 */
function strokeNominal(
	rCtx: EmfPlusReplayCtx,
	pen: EmfPlusPen,
	sampler: DeviceBrushSampler,
	buildPath: (c: CanvasContext) => void,
	device: TransformMatrix,
	size: { w: number; h: number },
	antialias: boolean,
	closedFigure: boolean,
): boolean {
	let figures: NominalFigure[];
	try {
		figures = recordNominalFigures(buildPath, device);
	} catch {
		return false;
	}
	if (closedFigure) {
		figures = figures.map((f) => ({ ...f, closed: true }));
	}
	const box = figuresBox(
		figures.map((f) => f.pts),
		size,
	);
	if (!box) {
		return true;
	}
	if (box.w * box.h > 16_000_000) {
		return false;
	}
	const argb = cssColorToArgb(pen.color);
	const plainBrush = !pen.brush || (!pen.brush.gradient && !pen.brush.texture && !pen.brush.hatch);
	const opaqueSolid = plainBrush && argb !== null && argb >>> 24 === 0xff && rCtx.ext?.compositingMode !== 1;
	const coverage = nominalLineCoverage(
		figures,
		{ antialias, half: isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0), opaqueSolid, clip: { x: 0, y: 0, w: size.w, h: size.h } },
		box,
	);
	return compositeBrushCoverage(rCtx, sampler, box, coverage, 1, true);
}

/** True when a pen carries a custom start or end cap. */
function hasCustomCap(pen: EmfPlusPen): boolean {
	return !!(pen.customStartCap || pen.customEndCap);
}

/**
 * The outline GDI+ fills for a pen with custom line caps
 * (`emf-plus-custom-cap.ts`), as device polygons for ONE nonzero fill: the
 * figures shortened by the caps, widened (never thinner than one device
 * pixel, and never drawn as a nominal-width line: GDI+ widens a custom-capped
 * pen whatever its width) with flat ends where a cap sits, their polygons
 * reversed to GDI+'s orientation, then the caps' own polygons.
 */
function customCapOutline(
	figures: ReadonlyArray<DeviceFigure>,
	width: number,
	devicePen: DevicePen,
	pen: EmfPlusPen,
): Array<Array<{ x: number; y: number }>> {
	const geo = customCapGeometry(figures, width, pen.customStartCap ?? null, pen.customEndCap ?? null);
	const outline: Array<Array<{ x: number; y: number }>> = [];
	geo.figures.forEach((fig, i) => {
		const capped = geo.capped[i];
		const figPen: DevicePen = {
			...devicePen,
			half: Math.max(width, 1) / 2,
			startCap: capped.start ? 0 : devicePen.startCap,
			endCap: capped.end ? 0 : devicePen.endCap,
		};
		for (const poly of widenFigures([fig], figPen)) {
			outline.push(poly.slice().reverse());
		}
	});
	outline.push(...geo.polygons);
	return outline;
}

/**
 * Strokes a custom-capped pen as a vector fill (SVG output and
 * `gdiAntialias: true`): the same outline GDI+ fills ({@link customCapOutline}),
 * mapped back to world space and filled nonzero with the pen's paint, so it
 * stays a single exact shape. Returns `false` when the geometry cannot be
 * recorded or the device matrix is singular.
 */
function fillCustomCapStroke(
	rCtx: EmfPlusReplayCtx,
	pen: EmfPlusPen,
	buildPath: (c: CanvasContext) => void,
	closedFigure: boolean,
): boolean {
	const device = plusWorldMatrix(rCtx);
	const sx = Math.hypot(device[0], device[1]);
	const det = device[0] * device[3] - device[1] * device[2];
	if (!(sx > 0) || !Number.isFinite(det) || Math.abs(det) < 1e-12) {
		return false;
	}
	let figures: DeviceFigure[];
	try {
		figures = recordDeviceFigures(buildPath, device);
	} catch {
		return false;
	}
	if (closedFigure) {
		figures = figures.map((f) => ({ ...f, closed: true }));
	}
	const width = (pen.width || 1) * sx;
	const dash = penDashArray(pen).map((v) => v * sx);
	const devicePen: DevicePen = {
		half: width / 2,
		join: pen.lineJoin ?? 0,
		miterLimit: pen.miterLimit && pen.miterLimit >= 1 ? pen.miterLimit : 10,
		startCap: pen.startCap ?? 0,
		endCap: pen.endCap ?? 0,
		dashCap: pen.dashCap ?? 0,
		dash: dash.length > 0 ? dash : null,
		dashOffset: (pen.dashOffset ?? 0) * (pen.width || 1) * sx,
		compound: pen.compound ?? null,
		inset: pen.alignment === 1,
	};
	const inv: TransformMatrix = [
		device[3] / det,
		-device[1] / det,
		-device[2] / det,
		device[0] / det,
		(device[2] * device[5] - device[3] * device[4]) / det,
		(device[1] * device[4] - device[0] * device[5]) / det,
	];
	const { ctx } = rCtx;
	ctx.save();
	try {
		ctx.fillStyle = pen.brush ? brushPaint(rCtx, pen.brush) : pen.color;
		applyPlusWorldTransform(rCtx);
		ctx.beginPath();
		for (const poly of customCapOutline(figures, width, devicePen, pen)) {
			poly.forEach((p, i) => {
				const x = inv[0] * p.x + inv[2] * p.y + inv[4];
				const y = inv[1] * p.x + inv[3] * p.y + inv[5];
				if (i === 0) {
					ctx.moveTo(x, y);
				} else {
					ctx.lineTo(x, y);
				}
			});
			ctx.closePath();
		}
		ctx.fill('nonzero');
	} finally {
		ctx.restore();
	}
	return true;
}

/** True for the identity matrix. */
function isIdentity(m: TransformMatrix): boolean {
	return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/** The drawing surface size, when the context exposes its canvas. */
function surfaceSize(ctx: CanvasContext): { w: number; h: number } | null {
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	const w = canvas?.width;
	const h = canvas?.height;
	return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? { w, h } : null;
}
