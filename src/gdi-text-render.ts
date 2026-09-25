/**
 * Paints one GDI text run (`ExtTextOut`/`TextOut`) the way GDI does, from
 * glyph bitmaps realised by `gdi-font-engine.ts`.
 *
 * Every step follows GDI's device-pixel rules rather than a canvas text
 * layout: the reference point is moved by the `TA_*` alignment (along the
 * baseline by the run's total advance, across it by the cell ascent or
 * descent), each glyph origin lands on an integer device pixel (the Dx
 * array's cumulative advances, or the font's integer advance widths), the
 * glyph bitmap is blitted at that origin, and the `OPAQUE` cell background,
 * `ETO_OPAQUE` rectangle, `ETO_CLIPPED` clip and underline/strike-out bars
 * are axis-aligned device rectangles. Antialiased glyphs are composited
 * with GDI's gamma-correct blend (see {@link GRAY_INV_GAMMA}) against the
 * pixels already on the canvas.
 *
 * @module gdi-text-render
 */

import { canvasDrawImage, canvasGetImageData, canvasPutImageData, createImageDataCompat, createTempCanvas } from './emf-canvas-helpers';
import { mapFontFamily } from './emf-canvas-helpers';
import type { GdiFontCollection, GdiRealizedFont, LogFontSpec } from './gdi-font-engine';
import { isSvgContext, type SvgContext } from './svg-context';
import type { CanvasContext, DrawState, TransformMatrix } from './emf-types';

/** ExtTextOut option flags. */
export const ETO_OPAQUE = 0x0002;
export const ETO_CLIPPED = 0x0004;
export const ETO_GLYPH_INDEX = 0x0010;
export const ETO_PDY = 0x2000;

/** A device-space rectangle, [left, right) x [top, bottom). */
export interface DeviceRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** One ExtTextOut call, already mapped to device pixels. */
export interface GdiTextRun {
	/** Character codes (UTF-16 code units) or, with `glyphIndices`, glyph indices. */
	codes: number[];
	glyphIndices: boolean;
	/** Device reference point (before alignment). */
	x: number;
	y: number;
	/** Per-glyph device advances along the baseline (null = the font's own widths). */
	dx: number[] | null;
	/** Per-glyph device advances across the baseline, y down (ETO_PDY), or null. */
	dy: number[] | null;
	/** TA_* flags. */
	textAlign: number;
	/** CSS hex colours. */
	textColor: string;
	bkColor: string;
	/** 1 = TRANSPARENT, 2 = OPAQUE. */
	bkMode: number;
	/** ETO_* flags. */
	options: number;
	/** The ETO_OPAQUE/ETO_CLIPPED rectangle (device), if any. */
	rect: DeviceRect | null;
	/**
	 * Device linear map of the baseline frame, [a, b, c, d] (x' = a*x + c*y,
	 * y' = b*x + d*y; unit length), or null for upright text.
	 */
	matrix: [number, number, number, number] | null;
	underline: boolean;
	strikeOut: boolean;
}

/** What the run advanced the current position by (device), for TA_UPDATECP. */
export interface GdiTextAdvance {
	dx: number;
	dy: number;
}

/**
 * The exponent GDI encodes grayscale-antialiased text with: a coverage
 * `a = k/16` mixes text `s` and background `d` in linear light and is
 * re-encoded with a truncating `floor(255 * v^0.43)`, i.e.
 * `v = floor(255 * (a*s^g + (1-a)*d^g)^(1/g))` with `1/g = 0.43`. This
 * reproduces all 16 grey levels of black-on-white ANTIALIASED_QUALITY
 * text (`textx-arial-aa`: 0, 77, 104, 124, ..., 233, 240, 255) exactly.
 */
const GRAY_INV_GAMMA = 0.43;

/** Black-on-white levels for coverage 0..16 (coverage 1 leaves the pixel alone). */
const GRAY_BLACK_ON_WHITE = [255, 255, 240, 233, 225, 217, 208, 199, 189, 178, 167, 154, 140, 124, 104, 77, 0];

function parseHex(c: string): [number, number, number] {
	const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
	if (!m) {
		return [0, 0, 0];
	}
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blends one channel of text `s` over background `d` at coverage `k` (0..16). */
function blendGray(s: number, d: number, k: number): number {
	if (k <= 1) {
		return d;
	}
	if (k >= 16) {
		return s;
	}
	const a = k / 16;
	const g = 1 / GRAY_INV_GAMMA;
	const v = a * Math.pow(s / 255, g) + (1 - a) * Math.pow(d / 255, g);
	return Math.floor(255 * Math.pow(v, GRAY_INV_GAMMA) + 1e-9);
}

interface PlacedGlyph {
	x: number;
	y: number;
	bitmap: NonNullable<ReturnType<GdiRealizedFont['glyph']>['bitmap']>;
}

/** Fills a device rectangle (clipped to `clip` when given) with `color`. */
function fillDeviceRect(ctx: CanvasContext, r: DeviceRect, color: string, clip: DeviceRect | null): void {
	let { left, top, right, bottom } = r;
	if (clip) {
		left = Math.max(left, clip.left);
		top = Math.max(top, clip.top);
		right = Math.min(right, clip.right);
		bottom = Math.min(bottom, clip.bottom);
	}
	if (right <= left || bottom <= top) {
		return;
	}
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
	ctx.fillStyle = color;
	ctx.fillRect(left, top, right - left, bottom - top);
	ctx.restore();
}

/** Fills a device quadrilateral (rotated text background / decoration). */
function fillDeviceQuad(ctx: CanvasContext, pts: Array<{ x: number; y: number }>, color: string, clip: DeviceRect | null): void {
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
	if (clip) {
		ctx.beginPath();
		ctx.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
		ctx.clip();
	}
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(pts[0].x, pts[0].y);
	for (let i = 1; i < pts.length; i++) {
		ctx.lineTo(pts[i].x, pts[i].y);
	}
	ctx.closePath();
	ctx.fill();
	ctx.restore();
}

/** Where every glyph of a run lands (shared by painting and {@link gdiTextCoverage}). */
interface RunLayout {
	glyphs: number[];
	total: number;
	totalY: number;
	startAlong: number;
	baseDown: number;
	hAlign: number;
	at: (along: number, down: number) => { x: number; y: number };
	placed: PlacedGlyph[];
	origins: Array<{ x: number; y: number; along: number; down: number }>;
}

/**
 * Lays a run out the way GDI does: advances (Dx, or the font's widths),
 * TA_* alignment along and across the baseline, and every glyph bitmap at
 * an integer device origin.
 */
function layoutGdiRun(font: GdiRealizedFont, run: GdiTextRun): RunLayout {
	const n = run.codes.length;
	const glyphs = run.codes.map((c) => (run.glyphIndices ? c : font.glyphIndex(c)));
	// Advances along the baseline (device, may be fractional under scaling).
	const adv: number[] = [];
	for (let i = 0; i < n; i++) {
		adv.push(
			run.dx && i < run.dx.length
				? run.dx[i]
				: run.matrix
					? font.rotatedAdvance(glyphs[i])
					: font.advance(glyphs[i]),
		);
	}
	const advY: number[] = [];
	for (let i = 0; i < n; i++) {
		advY.push(run.dy && i < run.dy.length ? run.dy[i] : 0);
	}
	let total = 0;
	let totalY = 0;
	for (let i = 0; i < n; i++) {
		total += adv[i];
		totalY += advY[i];
	}

	const m = run.matrix;
	// Baseline frame: u = along the baseline, v = down across it (device).
	const ux = m ? m[0] : 1;
	const uy = m ? m[1] : 0;
	const vx = m ? m[2] : 0;
	const vy = m ? m[3] : 1;
	const at = (along: number, down: number): { x: number; y: number } => ({
		x: run.x + ux * along + vx * down,
		y: run.y + uy * along + vy * down,
	});

	// Horizontal alignment moves the start along the baseline.
	const hAlign = run.textAlign & 0x06;
	let startAlong = 0;
	if (hAlign === 0x06) {
		startAlong = -Math.ceil(total / 2);
	} else if (hAlign === 0x02) {
		startAlong = -total;
	}
	// Vertical alignment moves the baseline across it.
	const vAlign = run.textAlign & 0x18;
	const baseDown = vAlign === 0x18 ? 0 : vAlign === 0x08 ? -font.descent : font.ascent;

	// Place every glyph at an integer device origin.
	const placed: PlacedGlyph[] = [];
	const origins: Array<{ x: number; y: number; along: number; down: number }> = [];
	const gm = m ? ([m[0], m[1], m[2], m[3]] as const) : undefined;
	let along = startAlong;
	let down = baseDown;
	for (let i = 0; i < n; i++) {
		const origin = at(along, down);
		// GDI places every glyph at an integer origin; GDI+'s non-grid-fitted
		// hints keep the fractional x (to 1/64 pixel) in the glyph itself.
		const ox = font.gridFit ? Math.round(origin.x) : Math.floor(origin.x);
		const subX = font.gridFit ? 0 : Math.round((origin.x - ox) * 64);
		origins.push({ x: ox + subX / 64, y: Math.round(origin.y), along, down });
		const g = font.glyph(glyphs[i], gm, subX);
		if (g.bitmap) {
			placed.push({ x: ox + g.bitmap.left, y: Math.round(origin.y) - g.bitmap.top, bitmap: g.bitmap });
		}
		along += adv[i];
		down += advY[i];
	}
	return { glyphs, total, totalY, startAlong, baseDown, hAlign, at, placed, origins };
}

/**
 * Paints `run` with `font` and returns the device advance of the whole run
 * (for TA_UPDATECP). Never throws; draws nothing it cannot place.
 */
export function paintGdiTextRun(
	ctx: CanvasContext,
	font: GdiRealizedFont,
	run: GdiTextRun,
	fontFamilyMap?: Record<string, string>,
): GdiTextAdvance {
	const { glyphs, total, totalY, startAlong, baseDown, at, placed, origins, hAlign } = layoutGdiRun(font, run);
	const m = run.matrix;
	const ux = m ? m[0] : 1;
	const uy = m ? m[1] : 0;
	const vx = m ? m[2] : 0;
	const vy = m ? m[3] : 1;

	const clip = run.options & ETO_CLIPPED && run.rect ? run.rect : null;

	// ETO_OPAQUE rectangle.
	if (run.options & ETO_OPAQUE && run.rect) {
		fillDeviceRect(ctx, run.rect, run.bkColor, null);
	}

	// OPAQUE background: the text cell, ascent above to descent below the baseline.
	if (run.bkMode === 2 && total !== 0) {
		if (!m) {
			const x0 = Math.round(run.x + startAlong);
			const base = Math.round(run.y + baseDown);
			const l = Math.min(x0, x0 + Math.round(total));
			const r = Math.max(x0, x0 + Math.round(total));
			fillDeviceRect(ctx, { left: l, top: base - font.ascent, right: r, bottom: base + font.descent }, run.bkColor, clip);
		} else {
			const quad = [
				at(startAlong, baseDown - font.ascent),
				at(startAlong + total, baseDown - font.ascent),
				at(startAlong + total, baseDown + font.descent),
				at(startAlong, baseDown + font.descent),
			];
			fillDeviceQuad(ctx, quad, run.bkColor, clip);
		}
	}

	if (isSvgContext(ctx)) {
		if (clip) {
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.beginPath();
			ctx.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
			ctx.clip();
		}
		emitSvgRun(ctx, font, run, glyphs, origins, fontFamilyMap);
		if (clip) {
			ctx.restore();
		}
		if (ctx.shadow) {
			compositeGlyphs(ctx.shadow, placed, run.textColor, font.mode !== 'mono', clip);
		}
	} else {
		compositeGlyphs(ctx, placed, run.textColor, font.mode !== 'mono', clip);
	}

	// Underline / strike-out bars span the run's advance.
	if ((run.underline || run.strikeOut) && total !== 0) {
		const bars: Array<[number, number]> = [];
		if (run.underline) {
			bars.push([font.underlinePosition, Math.max(1, font.underlineThickness)]);
		}
		if (run.strikeOut) {
			bars.push([font.strikeoutPosition, Math.max(1, font.strikeoutThickness)]);
		}
		for (const [pos, thick] of bars) {
			if (!m) {
				const x0 = Math.round(run.x + startAlong);
				const top = Math.round(run.y + baseDown) - pos;
				const l = Math.min(x0, x0 + Math.round(total));
				const r = Math.max(x0, x0 + Math.round(total));
				fillDeviceRect(ctx, { left: l, top, right: r, bottom: top + thick }, run.textColor, clip);
			} else {
				const quad = [
					at(startAlong, baseDown - pos),
					at(startAlong + total, baseDown - pos),
					at(startAlong + total, baseDown - pos + thick),
					at(startAlong, baseDown - pos + thick),
				];
				fillDeviceQuad(ctx, quad, run.textColor, clip);
			}
		}
	}

	// TA_UPDATECP moves the current position to the run's far end: past it
	// for TA_LEFT, back before it for TA_RIGHT (so successive runs extend
	// leftwards), and not at all for TA_CENTER.
	const cpAlong = hAlign === 0x06 ? 0 : hAlign === 0x02 ? -total : total;
	const cpDown = hAlign === 0x06 ? 0 : totalY;
	return { dx: ux * cpAlong + vx * cpDown, dy: uy * cpAlong + vy * cpDown };
}

/**
 * Emits the run's glyphs as one SVG `<text>` at GDI's per-glyph origins
 * (see {@link SvgContext.fillGlyphRun}); backgrounds and decorations were
 * already emitted as rectangles by the shared painting code.
 */
function emitSvgRun(
	ctx: SvgContext,
	font: GdiRealizedFont,
	run: GdiTextRun,
	glyphs: number[],
	origins: Array<{ x: number; y: number; along: number; down: number }>,
	fontFamilyMap?: Record<string, string>,
): void {
	let text = '';
	for (let i = 0; i < origins.length; i++) {
		const code = run.glyphIndices ? font.charForGlyph(glyphs[i]) : run.codes[i];
		text += String.fromCharCode(code);
	}
	const m = run.matrix;
	const ttf = font.ttf;
	const bold = font.syntheticBold || ttf.weightClass >= 600;
	const italic = font.syntheticItalic || (ttf.fsSelection & 1) !== 0 || (ttf.macStyle & 2) !== 0;
	const first = origins[0];
	ctx.fillGlyphRun({
		text,
		// Upright runs: device positions. Rotated runs: offsets along/across
		// the baseline from the first glyph, under the frame matrix.
		xs: origins.map((o) => (m ? o.along - first.along : o.x)),
		ys: origins.map((o) => (m ? o.down - first.down : o.y)),
		matrix: m ? [m[0], m[1], m[2], m[3], first.x, first.y] : null,
		scaleX: font.ppemX !== font.ppem ? font.ppemX / font.ppem : 1,
		fontFamily: mapFontFamily(ttf.family, fontFamilyMap),
		fontSize: font.ppem,
		fontWeight: bold ? 700 : 400,
		italic,
		aliased: font.mode === 'mono',
		fill: run.textColor,
	});
}

/**
 * Composites placed glyph bitmaps in `color`: 1-bit glyphs as opaque
 * pixels, grayscale glyphs blended against the destination with GDI's
 * gamma (the destination is read back; without read-back the blend falls
 * back to plain alpha).
 */
function compositeGlyphs(
	ctx: CanvasContext,
	placed: PlacedGlyph[],
	color: string,
	gray: boolean,
	clip: DeviceRect | null,
): void {
	if (placed.length === 0) {
		return;
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of placed) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x + p.bitmap.width);
		y1 = Math.max(y1, p.y + p.bitmap.height);
	}
	const canvas = (ctx as { canvas?: { width?: unknown; height?: unknown } }).canvas;
	if (typeof canvas?.width === 'number' && typeof canvas?.height === 'number') {
		x0 = Math.max(x0, 0);
		y0 = Math.max(y0, 0);
		x1 = Math.min(x1, canvas.width);
		y1 = Math.min(y1, canvas.height as number);
	}
	if (clip) {
		x0 = Math.max(x0, clip.left);
		y0 = Math.max(y0, clip.top);
		x1 = Math.min(x1, clip.right);
		y1 = Math.min(y1, clip.bottom);
	}
	const w = x1 - x0;
	const h = y1 - y0;
	if (w <= 0 || h <= 0 || w * h > 64 * 1024 * 1024) {
		return;
	}
	if (placed.some((p) => p.bitmap.channels === 3)) {
		compositeClearType(ctx, placed, color, x0, y0, w, h);
		return;
	}
	// Coverage (max over overlapping glyphs, as GDI's blits OR / overwrite).
	const cov = new Uint8Array(w * h);
	const full = gray ? 16 : 1;
	for (const p of placed) {
		const b = p.bitmap;
		for (let y = 0; y < b.height; y++) {
			const dy = p.y + y - y0;
			if (dy < 0 || dy >= h) continue;
			for (let x = 0; x < b.width; x++) {
				const v = b.data[y * b.width + x];
				if (!v) continue;
				const dx = p.x + x - x0;
				if (dx < 0 || dx >= w) continue;
				const i = dy * w + dx;
				if (v > cov[i]) cov[i] = v;
			}
		}
	}
	const layer = createTempCanvas(w, h);
	if (!layer) {
		return;
	}
	const [r, g, b] = parseHex(color);
	const rgba = new Uint8ClampedArray(w * h * 4);
	let dst: Uint8ClampedArray | null = null;
	if (gray && typeof (ctx as { getImageData?: unknown }).getImageData === 'function') {
		try {
			dst = canvasGetImageData(ctx, x0, y0, w, h).data;
		} catch {
			dst = null;
		}
	}
	for (let i = 0; i < w * h; i++) {
		const k = cov[i];
		if (k <= (gray ? 1 : 0)) continue;
		const o = i * 4;
		if (!gray || k >= full) {
			rgba[o] = r;
			rgba[o + 1] = g;
			rgba[o + 2] = b;
			rgba[o + 3] = 255;
		} else if (dst) {
			rgba[o] = blendGray(r, dst[o], k);
			rgba[o + 1] = blendGray(g, dst[o + 1], k);
			rgba[o + 2] = blendGray(b, dst[o + 2], k);
			rgba[o + 3] = 255;
		} else {
			rgba[o] = r;
			rgba[o + 1] = g;
			rgba[o + 2] = b;
			rgba[o + 3] = 255 - GRAY_BLACK_ON_WHITE[k];
		}
	}
	canvasPutImageData(layer.ctx, createImageDataCompat(rgba, w, h), 0, 0);
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
	canvasDrawImage(ctx, layer.canvas, x0, y0, w, h);
	ctx.restore();
}

// ---------------------------------------------------------------------------
// ExtTextOut call (logical units) -> device run
// ---------------------------------------------------------------------------

/** One ExtTextOut/TextOut record, in the metafile's logical units. */
export interface GdiTextCall {
	codes: number[];
	glyphIndices: boolean;
	/** Reference point (ignored under TA_UPDATECP, which uses the current position). */
	x: number;
	y: number;
	options: number;
	/** The record's rectangle (logical), used with ETO_OPAQUE / ETO_CLIPPED. */
	rect: DeviceRect | null;
	/** Dx array (logical), or null. */
	dx: number[] | null;
	/** ETO_PDY vertical advances (logical), or null. */
	dy: number[] | null;
	/** Logical-to-device affine `[a, b, c, d, e, f]` (x' = a*x + c*y + e). */
	matrix: TransformMatrix;
}

const DEG_TO_RAD = Math.PI / 180;

/** The LOGFONT in `state`, with its sizes mapped to device pixels. */
export function deviceLogFont(state: DrawState, heightScale: number, widthScale: number): LogFontSpec {
	const d = state.fontDetails;
	const h = state.fontHeight * heightScale;
	return {
		face: state.fontFamily,
		height: h < 0 ? -Math.round(-h) : Math.round(h),
		width: d && d.width ? Math.round(Math.abs(d.width * widthScale)) : 0,
		weight: state.fontWeight,
		italic: state.fontItalic,
		charSet: d ? d.charSet : 1,
		pitchAndFamily: d ? d.pitchAndFamily : 0,
		quality: d ? d.quality : 0,
	};
}

/**
 * Draws one ExtTextOut call with the GDI font engine. Returns the run's
 * advance in logical units (for TA_UPDATECP), or null when the engine
 * cannot take it (no usable font), in which case nothing was drawn and the
 * caller should fall back to its canvas path.
 */
export function drawGdiTextCall(
	ctx: CanvasContext,
	fonts: GdiFontCollection,
	state: DrawState,
	call: GdiTextCall,
): { dx: number; dy: number } | null {
	const [a, b, c, d, e, f] = call.matrix;
	const advanceScale = Math.hypot(a, b);
	const fontScale = Math.hypot(c, d);
	if (!(advanceScale > 0) || !(fontScale > 0) || call.codes.length === 0) {
		return null;
	}
	const font = fonts.realize(deviceLogFont(state, fontScale, advanceScale), state.fontFamilyMap);
	if (!font) {
		return null;
	}
	// Baseline frame: the world transform's rotation (if any) then the
	// LOGFONT escapement (counterclockwise on screen).
	const rotated = b !== 0 || c !== 0;
	let frame: [number, number, number, number] | null = rotated
		? [a / advanceScale, b / advanceScale, c / fontScale, d / fontScale]
		: null;
	const esc = state.fontEscapementTenthDeg % 3600;
	if (esc !== 0) {
		const t = (esc / 10) * DEG_TO_RAD;
		const r: [number, number, number, number] = [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
		frame = frame
			? [
					frame[0] * r[0] + frame[2] * r[1],
					frame[1] * r[0] + frame[3] * r[1],
					frame[0] * r[2] + frame[2] * r[3],
					frame[1] * r[2] + frame[3] * r[3],
				]
			: r;
	}
	const updateCp = (state.textAlign & 0x01) !== 0;
	const lx = updateCp ? state.curX : call.x;
	const ly = updateCp ? state.curY : call.y;
	const map = (x: number, y: number): { x: number; y: number } => ({ x: a * x + c * y + e, y: b * x + d * y + f });
	const ref = map(lx, ly);
	let rect: DeviceRect | null = null;
	if (call.rect && call.options & (ETO_OPAQUE | ETO_CLIPPED)) {
		const p = map(call.rect.left, call.rect.top);
		const q = map(call.rect.right, call.rect.bottom);
		rect = {
			left: Math.round(Math.min(p.x, q.x)),
			top: Math.round(Math.min(p.y, q.y)),
			right: Math.round(Math.max(p.x, q.x)),
			bottom: Math.round(Math.max(p.y, q.y)),
		};
	}
	const run: GdiTextRun = {
		codes: call.codes,
		glyphIndices: call.glyphIndices,
		x: ref.x,
		y: ref.y,
		dx: call.dx ? call.dx.map((v) => v * advanceScale) : null,
		dy: call.dy ? call.dy.map((v) => -v * fontScale) : null,
		textAlign: state.textAlign,
		textColor: state.textColor,
		bkColor: state.bkColor,
		bkMode: state.bkMode,
		options: call.options,
		rect,
		matrix: frame,
		underline: state.fontUnderline,
		strikeOut: state.fontStrikeOut,
	};
	const adv = paintGdiTextRun(ctx, font, run, state.fontFamilyMap);
	// Device advance back to logical units through the linear part's inverse.
	const det = a * d - b * c;
	if (det === 0) {
		return { dx: 0, dy: 0 };
	}
	return { dx: (d * adv.dx - c * adv.dy) / det, dy: (-b * adv.dx + a * adv.dy) / det };
}

/**
 * The gamma GDI blends ClearType channels with (fitted to black-on-white
 * ClearType stems: `255 * (1 - a)^(1/1.2)` reproduces them to 1 level).
 */
const CLEARTYPE_GAMMA = 1.2;

/** Blends one channel of ClearType text `s` over `d` at subpixel coverage `a` (0..1). */
function blendCt(s: number, d: number, a: number): number {
	if (a <= 0) {
		return d;
	}
	if (a >= 1) {
		return s;
	}
	const g = CLEARTYPE_GAMMA;
	const v = a * Math.pow(s / 255, g) + (1 - a) * Math.pow(d / 255, g);
	return Math.round(255 * Math.pow(v, 1 / g));
}

/** Composites ClearType (per-channel alpha) glyph bitmaps against the destination. */
function compositeClearType(
	ctx: CanvasContext,
	placed: PlacedGlyph[],
	color: string,
	x0: number,
	y0: number,
	w: number,
	h: number,
): void {
	const alpha = new Uint8Array(w * h * 3);
	for (const p of placed) {
		const b = p.bitmap;
		const ch = b.channels === 3 ? 3 : 1;
		for (let y = 0; y < b.height; y++) {
			const dy = p.y + y - y0;
			if (dy < 0 || dy >= h) continue;
			for (let x = 0; x < b.width; x++) {
				const dx = p.x + x - x0;
				if (dx < 0 || dx >= w) continue;
				for (let c = 0; c < 3; c++) {
					const v = ch === 3 ? b.data[(y * b.width + x) * 3 + c] : b.data[y * b.width + x] * 255;
					const i = (dy * w + dx) * 3 + c;
					if (v > alpha[i]) alpha[i] = v;
				}
			}
		}
	}
	const layer = createTempCanvas(w, h);
	if (!layer) {
		return;
	}
	let dst: Uint8ClampedArray;
	try {
		dst = canvasGetImageData(ctx, x0, y0, w, h).data;
	} catch {
		return;
	}
	const rgb = parseHex(color);
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const a0 = alpha[i * 3];
		const a1 = alpha[i * 3 + 1];
		const a2 = alpha[i * 3 + 2];
		if (!a0 && !a1 && !a2) continue;
		const o = i * 4;
		rgba[o] = blendCt(rgb[0], dst[o], a0 / 255);
		rgba[o + 1] = blendCt(rgb[1], dst[o + 1], a1 / 255);
		rgba[o + 2] = blendCt(rgb[2], dst[o + 2], a2 / 255);
		rgba[o + 3] = 255;
	}
	canvasPutImageData(layer.ctx, createImageDataCompat(rgba, w, h), 0, 0);
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
	canvasDrawImage(ctx, layer.canvas, x0, y0, w, h);
	ctx.restore();
}

/** A run's glyph coverage in device space (see {@link gdiTextCoverage}). */
export interface GdiTextCoverage {
	/** Device position of the mask's top-left pixel. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** 1 (one alpha per pixel) or 3 (ClearType R, G, B alphas per pixel). */
	channels: 1 | 3;
	/** Row-major coverage, 0..255 per pixel (or per channel). */
	data: Uint8ClampedArray;
}

/**
 * The glyph coverage GDI would paint for `run` (no background, no
 * underline/strike-out), as an alpha mask in device pixels: 255 for a
 * black-and-white pixel, `k * 255 / 16` for grayscale coverage `k`, and
 * per-channel alphas for ClearType. For callers that fill text with
 * something other than a solid colour (e.g. an EMF+ gradient or texture
 * brush sampled per pixel through the mask). Returns null for an empty run.
 */
export function gdiTextCoverage(font: GdiRealizedFont, run: GdiTextRun): GdiTextCoverage | null {
	const { placed } = layoutGdiRun(font, run);
	if (placed.length === 0) {
		return null;
	}
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of placed) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x + p.bitmap.width);
		y1 = Math.max(y1, p.y + p.bitmap.height);
	}
	const w = x1 - x0;
	const h = y1 - y0;
	if (w <= 0 || h <= 0 || w * h > 64 * 1024 * 1024) {
		return null;
	}
	const channels: 1 | 3 = placed.some((p) => p.bitmap.channels === 3) ? 3 : 1;
	const data = new Uint8ClampedArray(w * h * channels);
	const full = font.mode === 'mono' ? 1 : 16;
	for (const p of placed) {
		const b = p.bitmap;
		const bc = b.channels === 3 ? 3 : 1;
		for (let y = 0; y < b.height; y++) {
			for (let x = 0; x < b.width; x++) {
				for (let c = 0; c < channels; c++) {
					const v = bc === 3 ? b.data[(y * b.width + x) * 3 + c] : Math.round((b.data[y * b.width + x] * 255) / full);
					const i = ((p.y + y - y0) * w + (p.x + x - x0)) * channels + c;
					if (v > data[i]) data[i] = v;
				}
			}
		}
	}
	return { x: x0, y: y0, width: w, height: h, channels, data };
}
