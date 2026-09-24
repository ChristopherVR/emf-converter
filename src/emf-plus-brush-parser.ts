/**
 * EMF+ Brush object parser.
 *
 * Parses solid, hatch, linear-gradient, and path-gradient brushes
 * (MS-EMFPLUS 2.2.1.1) including gradient colour stops from preset blend
 * colours and blend factors. Gradient brushes carry an
 * {@link EmfPlusGradient} descriptor that the renderer turns into a
 * CanvasGradient; the `color` field always holds the primary colour as a
 * fallback for environments without gradient support.
 *
 * Real GDI+ files prefix the object data with an EmfPlusGraphicsVersion
 * field; the synthetic layout used by earlier versions of this library (and
 * its tests) omits it. Both layouts are accepted by sniffing the metafile
 * signature in the version field.
 */

import { argbToRgba, lerpArgbToRgba } from './emf-color-helpers';
import {
	EMFPLUS_BRUSHTYPE_SOLID,
	EMFPLUS_BRUSHTYPE_HATCHFILL,
	EMFPLUS_BRUSHTYPE_LINEARGRADIENT,
	EMFPLUS_BRUSHTYPE_PATHGRADIENT,
} from './emf-constants';
import { emfLog } from './emf-logging';
import { parseEmfPlusPath } from './emf-plus-path';
import type {
	EmfPlusBrush,
	EmfPlusGradientStop,
	EmfPlusGradientWrapMode,
	EmfPlusPathGradientShape,
	TransformMatrix,
} from './emf-types';

// BrushData flags (MS-EMFPLUS 2.1.2.1)
const BRUSH_DATA_PATH = 0x00000001;
const BRUSH_DATA_TRANSFORM = 0x00000002;
const BRUSH_DATA_PRESET_COLORS = 0x00000004;
const BRUSH_DATA_BLEND_FACTORS_H = 0x00000008;
const BRUSH_DATA_FOCUS_SCALES = 0x00000040;

/** Sanity cap for blend-stop / surrounding-colour / boundary-point counts. */
const MAX_GRADIENT_ELEMENTS = 4096;

/**
 * True when a 32-bit value looks like an EmfPlusGraphicsVersion field
 * (top 20 bits carry the 0xDBC01 metafile signature).
 */
export function looksLikeGraphicsVersion(v: number): boolean {
	return v >>> 12 === 0xdbc01;
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function readTransform(view: DataView, off: number): TransformMatrix {
	return [
		view.getFloat32(off, true),
		view.getFloat32(off + 4, true),
		view.getFloat32(off + 8, true),
		view.getFloat32(off + 12, true),
		view.getFloat32(off + 16, true),
		view.getFloat32(off + 20, true),
	];
}

function applyMatrix(m: TransformMatrix, x: number, y: number): { x: number; y: number } {
	return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function clamp01(v: number): number {
	return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** GDI+ WrapMode enum (MS-EMFPLUS 2.1.1.42): 0=Tile, 1=TileFlipX, 2=TileFlipY, 3=TileFlipXY, 4=Clamp. */
function readWrapMode(raw: number): EmfPlusGradientWrapMode {
	switch (raw) {
		case 0:
			return 'tile';
		case 1:
			return 'tile-flip-x';
		case 2:
			return 'tile-flip-y';
		case 3:
			return 'tile-flip-xy';
		default:
			return 'clamp';
	}
}

/** Normalise stops: clamp offsets, sort ascending. */
function normaliseStops(stops: EmfPlusGradientStop[]): EmfPlusGradientStop[] {
	return stops
		.map((s) => ({ ...s, offset: clamp01(s.offset) }))
		.sort((a, b) => a.offset - b.offset);
}

/**
 * Read an EmfPlusBlendColors block (preset colour stops): count, positions
 * (float32 × count), colours (ARGB × count). Returns null when out of bounds.
 */
function readPresetColors(
	view: DataView,
	off: number,
	end: number,
): { stops: EmfPlusGradientStop[]; next: number } | null {
	if (off + 4 > end) {
		return null;
	}
	const count = view.getUint32(off, true);
	if (count === 0 || count > MAX_GRADIENT_ELEMENTS) {
		return null;
	}
	const posOff = off + 4;
	const colOff = posOff + count * 4;
	const next = colOff + count * 4;
	if (next > end) {
		return null;
	}
	const stops: EmfPlusGradientStop[] = [];
	for (let i = 0; i < count; i++) {
		const argb = view.getUint32(colOff + i * 4, true);
		stops.push({
			offset: view.getFloat32(posOff + i * 4, true),
			color: argbToRgba(argb),
			argb,
		});
	}
	return { stops, next };
}

/**
 * Read an EmfPlusBlendFactors block: count, positions (float32 × count),
 * factors (float32 × count). Returns null when out of bounds.
 */
function readBlendFactors(
	view: DataView,
	off: number,
	end: number,
): { entries: Array<{ pos: number; factor: number }>; next: number } | null {
	if (off + 4 > end) {
		return null;
	}
	const count = view.getUint32(off, true);
	if (count === 0 || count > MAX_GRADIENT_ELEMENTS) {
		return null;
	}
	const posOff = off + 4;
	const facOff = posOff + count * 4;
	const next = facOff + count * 4;
	if (next > end) {
		return null;
	}
	const entries: Array<{ pos: number; factor: number }> = [];
	for (let i = 0; i < count; i++) {
		entries.push({
			pos: view.getFloat32(posOff + i * 4, true),
			factor: view.getFloat32(facOff + i * 4, true),
		});
	}
	return { entries, next };
}

// ---------------------------------------------------------------------------
// Gradient brush data parsers
// ---------------------------------------------------------------------------

/** Parse EmfPlusLinearGradientBrushData (MS-EMFPLUS 2.2.2.24). */
function parseLinearGradient(view: DataView, b: number, end: number): EmfPlusBrush | null {
	if (b + 40 > end) {
		return null;
	}
	const flags = view.getUint32(b, true);
	const wrapMode = readWrapMode(view.getUint32(b + 4, true));
	const rx = view.getFloat32(b + 8, true);
	const ry = view.getFloat32(b + 12, true);
	const rw = view.getFloat32(b + 16, true);
	const rh = view.getFloat32(b + 20, true);
	const startArgb = view.getUint32(b + 24, true);
	const endArgb = view.getUint32(b + 28, true);
	// Reserved1/Reserved2 occupy b+32..b+39; optional data follows.
	let o = b + 40;

	let transform: TransformMatrix | null = null;
	if (flags & BRUSH_DATA_TRANSFORM && o + 24 <= end) {
		transform = readTransform(view, o);
		o += 24;
	}

	let stops: EmfPlusGradientStop[] = [
		{ offset: 0, color: argbToRgba(startArgb), argb: startArgb },
		{ offset: 1, color: argbToRgba(endArgb), argb: endArgb },
	];
	if (flags & BRUSH_DATA_PRESET_COLORS) {
		const preset = readPresetColors(view, o, end);
		if (preset) {
			stops = preset.stops;
		}
	} else if (flags & BRUSH_DATA_BLEND_FACTORS_H) {
		const blend = readBlendFactors(view, o, end);
		if (blend) {
			stops = blend.entries.map((e) => ({
				offset: e.pos,
				color: lerpArgbToRgba(startArgb, endArgb, e.factor),
				argb: lerpArgb(startArgb, endArgb, e.factor),
			}));
		}
	}

	// The gradient runs across the rect horizontally; direction/rotation is
	// carried by the optional brush transform.
	let p1 = { x: rx, y: ry + rh / 2 };
	let p2 = { x: rx + rw, y: ry + rh / 2 };
	if (transform) {
		p1 = applyMatrix(transform, p1.x, p1.y);
		p2 = applyMatrix(transform, p2.x, p2.y);
	}

	emfLog(
		`parseEmfPlusBrushObject: linear gradient (${p1.x.toFixed(1)},${p1.y.toFixed(1)})→(${p2.x.toFixed(1)},${p2.y.toFixed(1)}), ${stops.length} stop(s)`,
	);
	return {
		kind: 'plus-brush',
		color: argbToRgba(startArgb),
		gradient: {
			type: 'linear',
			x1: p1.x,
			y1: p1.y,
			x2: p2.x,
			y2: p2.y,
			stops: normaliseStops(stops),
			wrapMode,
			rect: { x: rx, y: ry, w: rw, h: rh },
			transform,
		},
	};
}

/** Parse EmfPlusPathGradientBrushData (MS-EMFPLUS 2.2.2.29). */
function parsePathGradient(view: DataView, b: number, end: number): EmfPlusBrush | null {
	if (b + 24 > end) {
		return null;
	}
	const flags = view.getUint32(b, true);
	const wrapMode = readWrapMode(view.getUint32(b + 4, true));
	const centerArgb = view.getUint32(b + 8, true);
	let cx = view.getFloat32(b + 12, true);
	let cy = view.getFloat32(b + 16, true);
	const surroundCount = view.getUint32(b + 20, true);
	if (surroundCount > MAX_GRADIENT_ELEMENTS) {
		return { kind: 'plus-brush', color: argbToRgba(centerArgb) };
	}
	const surround: number[] = [];
	let o = b + 24;
	for (let i = 0; i < surroundCount && o + 4 <= end; i++) {
		surround.push(view.getUint32(o, true));
		o += 4;
	}

	// Boundary: either an embedded path object or an explicit point list.
	let boundaryPts: Array<{ x: number; y: number }> = [];
	let boundaryArgb: number[] = [];
	const surroundAt = (k: number): number =>
		surround.length > 0 ? surround[Math.min(k, surround.length - 1)] : centerArgb;
	if (flags & BRUSH_DATA_PATH) {
		if (o + 4 <= end) {
			const pathSize = view.getInt32(o, true);
			o += 4;
			if (pathSize > 0 && o + pathSize <= end) {
				const path = parseEmfPlusPath(view, o, pathSize);
				if (path) {
					const flat = flattenFirstFigure(path.points, path.types, surroundAt);
					boundaryPts = flat.points;
					boundaryArgb = flat.argb;
				}
				o += pathSize;
			}
		}
	} else if (o + 4 <= end) {
		const ptCount = view.getUint32(o, true);
		o += 4;
		if (ptCount > 0 && ptCount <= MAX_GRADIENT_ELEMENTS && o + ptCount * 8 <= end) {
			for (let i = 0; i < ptCount; i++) {
				boundaryPts.push({
					x: view.getFloat32(o + i * 8, true),
					y: view.getFloat32(o + i * 8 + 4, true),
				});
				boundaryArgb.push(surroundAt(i));
			}
			o += ptCount * 8;
		}
	}

	let transform: TransformMatrix | null = null;
	if (flags & BRUSH_DATA_TRANSFORM && o + 24 <= end) {
		transform = readTransform(view, o);
		o += 24;
	}
	const center = { x: cx, y: cy };
	const m = transform;
	const worldBoundary = m ? boundaryPts.map((p) => applyMatrix(m, p.x, p.y)) : boundaryPts;
	if (m) {
		({ x: cx, y: cy } = applyMatrix(m, cx, cy));
	}

	const surroundArgb = surround.length > 0 ? surround[0] : centerArgb;

	// Colour stops for the radial fallback: canvas radial gradients run centre
	// (0) to edge (1); GDI+ path-gradient positions run boundary (0) to
	// centre (1), so invert.
	let stops: EmfPlusGradientStop[] = [
		{ offset: 0, color: argbToRgba(centerArgb), argb: centerArgb },
		{ offset: 1, color: argbToRgba(surroundArgb), argb: surroundArgb },
	];
	let blend: EmfPlusPathGradientShape['blend'] = null;
	let preset: EmfPlusPathGradientShape['preset'] = null;
	if (flags & BRUSH_DATA_PRESET_COLORS) {
		const presetData = readPresetColors(view, o, end);
		if (presetData) {
			stops = presetData.stops.map((s) => ({ ...s, offset: 1 - s.offset }));
			preset = {
				positions: presetData.stops.map((s) => s.offset),
				argb: presetData.stops.map((s) => s.argb ?? 0),
			};
			o = presetData.next;
		}
	} else if (flags & BRUSH_DATA_BLEND_FACTORS_H) {
		const blendData = readBlendFactors(view, o, end);
		if (blendData) {
			stops = blendData.entries.map((e) => ({
				offset: 1 - e.pos,
				color: lerpArgbToRgba(surroundArgb, centerArgb, e.factor),
				argb: lerpArgb(surroundArgb, centerArgb, e.factor),
			}));
			blend = {
				positions: blendData.entries.map((e) => e.pos),
				factors: blendData.entries.map((e) => e.factor),
			};
			o = blendData.next;
		}
	}
	let focus: EmfPlusPathGradientShape['focus'] = null;
	if (flags & BRUSH_DATA_FOCUS_SCALES && o + 12 <= end && view.getUint32(o, true) === 2) {
		focus = { x: view.getFloat32(o + 4, true), y: view.getFloat32(o + 8, true) };
	}

	// Radius: farthest boundary point from the centre.
	let r = 0;
	for (const p of worldBoundary) {
		const d = Math.hypot(p.x - cx, p.y - cy);
		if (d > r) {
			r = d;
		}
	}
	if (!(r > 0)) {
		// No usable boundary, so fall back to the centre colour.
		return { kind: 'plus-brush', color: argbToRgba(centerArgb) };
	}

	emfLog(
		`parseEmfPlusBrushObject: path gradient centre=(${cx.toFixed(1)},${cy.toFixed(1)}), ${boundaryPts.length} boundary point(s)`,
	);
	return {
		kind: 'plus-brush',
		color: argbToRgba(centerArgb),
		gradient: {
			type: 'radial',
			cx,
			cy,
			r,
			stops: normaliseStops(stops),
			wrapMode,
			shape: {
				center,
				centerArgb,
				boundary: boundaryPts,
				boundaryArgb,
				blend,
				preset,
				focus,
				transform,
			},
		},
	};
}

/** Packed-ARGB linear interpolation (`t` clamped to 0..1). */
function lerpArgb(a: number, b: number, t: number): number {
	const tc = Math.min(1, Math.max(0, t));
	let out = 0;
	for (let shift = 24; shift >= 0; shift -= 8) {
		const ca = (a >>> shift) & 0xff;
		const cb = (b >>> shift) & 0xff;
		out = out * 256 + Math.round(ca + (cb - ca) * tc);
	}
	return out >>> 0;
}

/** Segments per flattened cubic Bezier (far finer than any colour step needs). */
const BEZIER_STEPS = 24;

/**
 * Flattens the first figure of a GDI+ path (Start/Line/Bezier point types)
 * into a polygon, carrying a surround colour per vertex: path point `k`
 * owns colour `colorAt(k)`, and flattened Bezier vertices interpolate
 * between their segment's end-point colours.
 */
function flattenFirstFigure(
	points: Array<{ x: number; y: number }>,
	types: Uint8Array,
	colorAt: (k: number) => number,
): { points: Array<{ x: number; y: number }>; argb: number[] } {
	const outPts: Array<{ x: number; y: number }> = [];
	const outArgb: number[] = [];
	for (let k = 0; k < points.length; k++) {
		const kind = types[k] & 0x07;
		if (k > 0 && kind === 0) {
			break; // a second figure starts: the first is the boundary
		}
		if (kind === 3 && k > 0 && k + 2 < points.length) {
			const p0 = points[k - 1];
			const p1 = points[k];
			const p2 = points[k + 1];
			const p3 = points[k + 2];
			const c0 = colorAt(k - 1);
			const c3 = colorAt(k + 2);
			for (let i = 1; i <= BEZIER_STEPS; i++) {
				const t = i / BEZIER_STEPS;
				const u = 1 - t;
				outPts.push({
					x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
					y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
				});
				outArgb.push(lerpArgb(c0, c3, t));
			}
			k += 2;
			if (types[k] & 0x80) {
				break;
			}
			continue;
		}
		outPts.push(points[k]);
		outArgb.push(colorAt(k));
		if (types[k] & 0x80) {
			break;
		}
	}
	// A closed figure may repeat its start point at the end; drop the duplicate.
	const n = outPts.length;
	if (n > 1 && outPts[0].x === outPts[n - 1].x && outPts[0].y === outPts[n - 1].y) {
		outPts.pop();
		outArgb.pop();
	}
	return { points: outPts, argb: outArgb };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse an EMF+ Brush object. Never returns null for structurally valid
 * input: unknown brush types degrade to a solid black brush, matching GDI+
 * fallback behaviour.
 */
export function parseEmfPlusBrushObject(
	view: DataView,
	dataOff: number,
	recDataSize: number,
): EmfPlusBrush | null {
	if (recDataSize < 8) {
		return null;
	}
	const end = dataOff + recDataSize;
	const hasVersion = looksLikeGraphicsVersion(view.getUint32(dataOff, true));
	const typeOff = dataOff + (hasVersion ? 4 : 0);
	if (typeOff + 8 > end) {
		return null;
	}
	const brushType = view.getUint32(typeOff, true);
	const b = typeOff + 4; // start of the type-specific brush data

	switch (brushType) {
		case EMFPLUS_BRUSHTYPE_SOLID:
			return { kind: 'plus-brush', color: argbToRgba(view.getUint32(b, true)) };

		case EMFPLUS_BRUSHTYPE_HATCHFILL:
			// HatchStyle at b, foreground colour at b+4 (background at b+8 unused).
			if (b + 8 <= end) {
				return { kind: 'plus-brush', color: argbToRgba(view.getUint32(b + 4, true)) };
			}
			return { kind: 'plus-brush', color: 'rgba(0,0,0,1)' };

		case EMFPLUS_BRUSHTYPE_LINEARGRADIENT: {
			const brush = parseLinearGradient(view, b, end);
			return brush ?? { kind: 'plus-brush', color: 'rgba(0,0,0,1)' };
		}

		case EMFPLUS_BRUSHTYPE_PATHGRADIENT: {
			const brush = parsePathGradient(view, b, end);
			return brush ?? { kind: 'plus-brush', color: 'rgba(0,0,0,1)' };
		}

		default:
			return { kind: 'plus-brush', color: 'rgba(0,0,0,1)' };
	}
}
