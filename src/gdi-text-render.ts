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
 * with GDI's grayscale blend (see {@link blendGrayChannel}) against the
 * pixels already on the canvas.
 *
 * @module gdi-text-render
 */

import { canvasDrawImage, canvasGetImageData, canvasPutImageData, createImageDataCompat, createTempCanvas } from './emf-canvas-helpers';
import { mapFontFamily } from './emf-canvas-helpers';
import { applyTextJustification } from './emf-gdi-text-layout';
import { blendGrayChannel } from './gdi-gray-blend';
import type { GdiFontCollection, GdiRealizedFont, LogFontSpec } from './gdi-font-engine';
import { isSvgContext, type SvgContext } from './svg-context';
import type { CanvasContext, DrawState, TransformMatrix } from './emf-types';

/** ExtTextOut option flags. */
export const ETO_OPAQUE = 0x0002;
export const ETO_CLIPPED = 0x0004;
export const ETO_GLYPH_INDEX = 0x0010;
export const ETO_IGNORELANGUAGE = 0x1000;
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
	/** Unicode code points (or legacy GDI UTF-16 units); with `glyphIndices`, glyph indices. */
	codes: number[];
	glyphIndices: boolean;
	/** Device reference point (before alignment). */
	x: number;
	y: number;
	/** Per-glyph device advances along the baseline (null = the font's own widths). */
	dx: number[] | null;
	/** Per-glyph device advances across the baseline, y down (ETO_PDY), or null. */
	dy: number[] | null;
	/** DC text justification in device units; ignored when the run supplies Dx. */
	textJustification?: { extra: number; count: number };
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
	/**
	 * GDI+ DrawString bars: `fractional` (AntiAlias) draws them at fractional positions, see {@link fractionalBars};
	 * `snapped` (the other hints) draws the same horizontal extent with its ends rounded to whole pixels.
	 */
	plusBars?: 'fractional' | 'snapped';
}

/** What the run advanced the current position by (device), for TA_UPDATECP. */
export interface GdiTextAdvance {
	dx: number;
	dy: number;
}

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

/**
 * Writes into `out` (at `o`) a colour and alpha for a text pixel over a
 * transparent destination (a metafile drawn onto a transparent canvas),
 * where GDI's gamma blend has no backdrop to work on yet. The pair is
 * exact once composited over white (what GDI draws on and what most
 * viewers show), and keeps roughly the coverage as alpha otherwise.
 * `blend(s, d, c)` is the per-channel blend of text `s` over `d`.
 */
function blendOverUnknown(
	out: Uint8ClampedArray,
	o: number,
	rgb: readonly number[],
	blend: (s: number, d: number, c: number) => number,
): void {
	const onWhite = [0, 0, 0];
	let a = 0;
	let minWhite = 255;
	for (let c = 0; c < 3; c++) {
		onWhite[c] = blend(rgb[c], 255, c);
		a += 1 - (onWhite[c] - blend(rgb[c], 0, c)) / 255;
		minWhite = Math.min(minWhite, onWhite[c]);
	}
	// The alpha must at least darken white to the darkest channel.
	a = Math.min(1, Math.max(a / 3, 1 - minWhite / 255));
	if (a <= 0) {
		return;
	}
	for (let c = 0; c < 3; c++) {
		out[o + c] = Math.round((onWhite[c] - 255 * (1 - a)) / a);
	}
	out[o + 3] = Math.round(a * 255);
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

/** Undefined C1 controls have no drawable glyph in GDI text output. */
function isC1Control(code: number): boolean {
	return code >= 0x80 && code <= 0x9f;
}

function suppressC1Glyph(run: GdiTextRun, index: number): boolean {
	return !run.glyphIndices && !(run.options & ETO_IGNORELANGUAGE) && isC1Control(run.codes[index]);
}

/**
 * Lays a run out the way GDI does: advances (Dx, or the font's widths),
 * TA_* alignment along and across the baseline, and every glyph bitmap at
 * an integer device origin.
 */
export function layoutGdiRun(font: GdiRealizedFont, run: GdiTextRun): RunLayout {
	const n = run.codes.length;
	const glyphs = run.codes.map((c) => (run.glyphIndices ? c : font.glyphIndex(c)));
	// Along a baseline that is not an axis GDI accumulates the unrounded linear advances.
	const diagonal = !!run.matrix && Math.abs(run.matrix[0]) > 1e-9 && Math.abs(run.matrix[1]) > 1e-9 && !!font.rotatedLinearAdvance;
	// Advances along the baseline (device, may be fractional under scaling).
	let adv: number[] = [];
	for (let i = 0; i < n; i++) {
		adv.push(
			suppressC1Glyph(run, i) && !run.dx
				? 0
				: run.dx && i < run.dx.length
				? run.dx[i]
				: run.matrix
					? diagonal
						? font.rotatedLinearAdvance!(glyphs[i])
						: font.rotatedAdvance(glyphs[i], !!run.matrix && run.matrix[0] < 0)
					: font.advance(glyphs[i]),
		);
	}
	if (!run.dx && run.textJustification && !run.glyphIndices) {
		adv = applyTextJustification(adv, run.codes, run.textJustification.extra, run.textJustification.count);
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
	// A diagonal baseline projects the accumulated advance onto the device axes in 28.4 fixed point.
	const fix = diagonal ? (v: number): number => Math.round(v * 16) / 16 : (v: number): number => v;
	// A diagonal baseline works in 28.4 fixed point: the alignment offset is the run's total advance vector (rounded to
	// 1/16 pixel; for TA_CENTER halved with truncation toward zero), the glyph's accumulated advance and the vertical
	// (ascent or descent) offset are projected separately, and the three are added.
	let startAlong = 0;
	let startX = 0;
	let startY = 0;
	const hAlign = run.textAlign & 0x06;
	if (hAlign === 0x06) {
		startAlong = diagonal ? -total / 2 : -Math.ceil(total / 2);
	} else if (hAlign === 0x02) {
		startAlong = -total;
	}
	if (diagonal && hAlign) {
		const vector = (c: number): number => {
			const n = Math.round(c * total * 16);
			return (hAlign === 0x06 ? -Math.trunc(n / 2) : -n) / 16;
		};
		startX = vector(ux);
		startY = vector(uy);
	}
	const at = (along: number, down: number): { x: number; y: number } =>
		diagonal
			? {
					x: run.x + startX + fix(ux * (along - startAlong)) + fix(vx * down),
					y: run.y + startY + fix(uy * (along - startAlong)) + fix(vy * down),
				}
			: { x: run.x + ux * along + vx * down, y: run.y + uy * along + vy * down };

	// Vertical alignment moves the baseline across it.
	const vAlign = run.textAlign & 0x18;
	// At a non-axis angle GDI realises the font with rotated metrics.
	const skew = !!m && Math.abs(m[0]) > 1e-9 && Math.abs(m[1]) > 1e-9;
	const rotatedMetrics = m ? font.rotatedMetrics?.(m[0], m[1]) : undefined;
	const ascent = rotatedMetrics ? rotatedMetrics.ascent : skew ? (font.rotatedAscent ?? font.ascent) : font.ascent;
	const descent = rotatedMetrics ? rotatedMetrics.descent : skew ? (font.rotatedDescent ?? font.descent) : font.descent;
	const baseDown = vAlign === 0x18 ? 0 : vAlign === 0x08 ? -descent : ascent;

	// Place every glyph at an integer device origin.
	const placed: PlacedGlyph[] = [];
	const origins: Array<{ x: number; y: number; along: number; down: number }> = [];
	const gm = m ? ([m[0], m[1], m[2], m[3]] as const) : undefined;
	let along = startAlong;
	let down = baseDown;
	for (let i = 0; i < n; i++) {
		const origin = at(along, down);
		// GDI+ grayscale origins snap to the nearest quarter pixel before
		// sampling (independent x/y 1/64-pixel native controls). ClearType snaps
		// x to its nearest sixth-pixel sample; monochrome origins snap to pixels.
		const fractionalX = !!font.fractionalOrigins;
		const ox = fractionalX ? Math.floor(origin.x) : Math.round(origin.x);
		const subX = !fractionalX ? 0
			: font.fractionalOrigins === 'xy' ? Math.round((origin.x - ox) * 4) * 16
			: font.fractionalOrigins === 'x' ? Math.round((origin.x - ox) * 6) * (64 / 6)
			: Math.round((origin.x - ox) * 64);
		const oy = font.fractionalOrigins === 'xy' ? Math.floor(origin.y) : Math.round(origin.y);
		const subY = font.fractionalOrigins === 'xy' ? Math.round((origin.y - oy) * 4) * 16 : 0;
		origins.push({ x: ox + subX / 64, y: oy + subY / 64, along, down });
		if (!suppressC1Glyph(run, i)) {
			const g = font.glyph(glyphs[i], gm, subX, subY);
			if (g.bitmap) {
				placed.push({ x: ox + g.bitmap.left, y: oy - g.bitmap.top, bitmap: g.bitmap });
			}
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

	// Text drawn together with its background fill blends differently from transparent text (see `gdi-gray-blend.ts`):
	// OPAQUE mode always, and ETO_OPAQUE only when its rectangle contains the text cell and every glyph bitmap
	// (measured by sweeping each edge of the rectangle across the cell; a smaller rectangle is filled first and the
	// text drawn transparent over it).
	let opaqueText = run.bkMode === 2;
	if (!opaqueText && run.options & ETO_OPAQUE && run.rect && placed.length > 0) {
		let l: number;
		let t: number;
		let r: number;
		let b: number;
		if (!m) {
			const x0 = Math.round(run.x + startAlong);
			const base = Math.round(run.y + baseDown);
			l = Math.min(x0, x0 + Math.round(total));
			r = Math.max(x0, x0 + Math.round(total));
			t = base - font.ascent;
			b = base + font.descent;
		} else {
			const corners = [
				at(startAlong, baseDown - font.ascent),
				at(startAlong + total, baseDown - font.ascent),
				at(startAlong + total, baseDown + font.descent),
				at(startAlong, baseDown + font.descent),
			];
			l = Math.min(...corners.map((c) => c.x));
			r = Math.max(...corners.map((c) => c.x));
			t = Math.min(...corners.map((c) => c.y));
			b = Math.max(...corners.map((c) => c.y));
		}
		for (const g of placed) {
			l = Math.min(l, g.x);
			t = Math.min(t, g.y);
			r = Math.max(r, g.x + g.bitmap.width);
			b = Math.max(b, g.y + g.bitmap.height);
		}
		opaqueText = run.rect.left <= l && run.rect.top <= t && run.rect.right >= r && run.rect.bottom >= b;
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
			compositeGlyphs(ctx.shadow, placed, run.textColor, font.mode !== 'mono', clip, opaqueText);
		}
	} else {
		compositeGlyphs(ctx, placed, run.textColor, font.mode !== 'mono', clip, opaqueText);
	}

	// Underline / strike-out bars span the run's advance.
	if ((run.underline || run.strikeOut) && total !== 0) {
		const bars: Array<[number, number, number]> = [];
		if (run.underline) {
			bars.push([font.underlinePosition, Math.max(1, font.underlineThickness), 0]);
		}
		if (run.strikeOut) {
			bars.push([font.strikeoutPosition, Math.max(1, font.strikeoutThickness), font.strikeoutShift ?? 0]);
		}
		const snapped = !m && run.plusBars === 'snapped' && font.exactDecorations ? fractionalBars(font.exactDecorations, run, run.x + startAlong, run.y + baseDown, total) : null;
		let barIndex = 0;
		for (const [pos, thick, lean] of bars) {
			const snap = snapped?.[barIndex++];
			if (!m) {
				const x0 = Math.round(run.x + startAlong) + lean;
				const top = Math.round(run.y + baseDown) - pos;
				const l = snap ? Math.round(snap.left) : Math.min(x0, x0 + Math.round(total));
				const r = snap ? Math.round(snap.right) : Math.max(x0, x0 + Math.round(total));
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
	const visibleOrigins: typeof origins = [];
	for (let i = 0; i < origins.length; i++) {
		const code = run.glyphIndices ? font.charForGlyph(glyphs[i]) : run.codes[i];
		if (!run.glyphIndices && !(run.options & ETO_IGNORELANGUAGE) && isC1Control(code)) continue;
		text += String.fromCodePoint(code);
		visibleOrigins.push(origins[i]);
	}
	if (text.length === 0) return;
	const m = run.matrix;
	const ttf = font.ttf;
	const bold = font.syntheticBold || ttf.weightClass >= 600;
	const italic = font.syntheticItalic || (ttf.fsSelection & 1) !== 0 || (ttf.macStyle & 2) !== 0;
	const first = visibleOrigins[0];
	ctx.fillGlyphRun({
		text,
		// Upright runs: device positions. Rotated runs: offsets along/across
		// the baseline from the first glyph, under the frame matrix.
		xs: visibleOrigins.map((o) => (m ? o.along - first.along : o.x)),
		ys: visibleOrigins.map((o) => (m ? o.down - first.down : o.y)),
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
	opaque = false,
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
		} else if (dst && dst[o + 3] === 255) {
			rgba[o] = blendGrayChannel(r, dst[o], k, opaque);
			rgba[o + 1] = blendGrayChannel(g, dst[o + 1], k, opaque);
			rgba[o + 2] = blendGrayChannel(b, dst[o + 2], k, opaque);
			rgba[o + 3] = 255;
		} else if (dst) {
			blendOverUnknown(rgba, o, [r, g, b], (s, d) => blendGrayChannel(s, d, k, opaque));
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
	/** DC text justification in logical units; ignored when the call supplies Dx. */
	textJustification?: { extra: number; count: number };
	/** Logical-to-device affine `[a, b, c, d, e, f]` (x' = a*x + c*y + e). */
	matrix: TransformMatrix;
	/** `eyScale / exScale` of the record when it is a GM_COMPATIBLE one (upright text only), see `playbackStretchReacts`. */
	playbackStretch?: number;
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
	const upright = b === 0 && c === 0 && state.fontEscapementTenthDeg % 3600 === 0;
	const spec = deviceLogFont(state, fontScale, advanceScale);
	if (upright && call.playbackStretch && call.playbackStretch !== 1) spec.playbackStretch = call.playbackStretch;
	const font = fonts.realize(spec, state.fontFamilyMap);
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
		textJustification: call.textJustification ? { ...call.textJustification, extra: call.textJustification.extra * advanceScale } : undefined,
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
 * GDI's ClearType blend (`gdi-cleartype-blend.json.gz`: 6.87 million native channel values over 128 text/background
 * colour pairs, Arial 12 to 40 px, ClearType, ClearType natural and default quality, are all reproduced). A
 * channel's coverage is one of seven levels `k / 6`. The text colour and the destination are decoded through a
 * gamma 1.2 table (the system's font-smoothing contrast, 1200, divided by 1000) rounded to 8 bits, mixed as
 * `(decode[text] * k + decode[dst] * (6 - k)) / 6` rounded half up, and encoded through the inverse table.
 * A pixel with no coverage in any channel is untouched; one fully covered in all three takes the text colour;
 * every other pixel runs all three channels through the tables, so an uncovered channel of a partly covered
 * pixel round-trips (a 64 background becomes 65).
 */
const CLEARTYPE_GAMMA = 1.2;
const CT_DECODE = Uint8Array.from({ length: 256 }, (_, x) => Math.floor(255 * Math.pow(x / 255, CLEARTYPE_GAMMA) + 0.5));
const CT_ENCODE = Uint8Array.from({ length: 256 }, (_, x) => Math.floor(255 * Math.pow(x / 255, 1 / CLEARTYPE_GAMMA) + 0.5));

/** Blends one channel of ClearType text `s` over `d` at coverage level `k` (0..6) of a partly covered pixel. */
export function blendCtLevel(s: number, d: number, k: number): number {
	return CT_ENCODE[Math.floor((CT_DECODE[s] * k + CT_DECODE[d] * (6 - k) + 3) / 6)];
}

/** The coverage level (0..6) of a ClearType channel alpha (0..255). */
function ctLevel(alpha: number): number {
	return Math.round((alpha * 6) / 255);
}

/** Blends one channel of ClearType text `s` over `d` at subpixel coverage `a` (0..1) of a partly covered pixel. */
function blendCt(s: number, d: number, a: number): number {
	return blendCtLevel(s, d, ctLevel(a * 255));
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
		if (dst[o + 3] !== 255) {
			const cov = [a0 / 255, a1 / 255, a2 / 255];
			blendOverUnknown(rgba, o, rgb, (s, d, c) => blendCt(s, d, cov[c]));
			continue;
		}
		const k0 = ctLevel(a0);
		const k1 = ctLevel(a1);
		const k2 = ctLevel(a2);
		if (k0 === 6 && k1 === 6 && k2 === 6) {
			rgba[o] = rgb[0];
			rgba[o + 1] = rgb[1];
			rgba[o + 2] = rgb[2];
		} else if (k0 || k1 || k2) {
			rgba[o] = blendCtLevel(rgb[0], dst[o], k0);
			rgba[o + 1] = blendCtLevel(rgb[1], dst[o + 1], k1);
			rgba[o + 2] = blendCtLevel(rgb[2], dst[o + 2], k2);
		} else {
			rgba[o] = dst[o];
			rgba[o + 1] = dst[o + 1];
			rgba[o + 2] = dst[o + 2];
		}
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
	/**
	 * Fractional underline / strike-out bars of GDI+ AntiAlias text, one value per pixel, kept apart because native
	 * does not apply the text contrast to them: callers apply the contrast to `data` and then take the larger value.
	 */
	bars?: Uint8ClampedArray;
}

/** An underline or strike-out bar at fractional device coordinates. */
interface SoftBar {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * The bars of GDI+ AntiAlias (unhinted, gray) text, measured against native DrawString captures of five stock faces
 * in regular, bold and italic (`scripts/gdi-fixtures/UnderlineProbe.cs`). Vertically a bar is an integer number of
 * rows thick, `max(1, round(thickness))`, centred so that its top edge is
 * `baseline + position - (thickness - 1) / 2` for the underline (`position` the `post` underlinePosition below the
 * baseline) and `baseline - position - (thickness - 1) / 2` for the strike-out (`OS/2` yStrikeoutPosition), where
 * `baseline` is the run's rounded-ascent baseline. The edge is then raised to the next quarter pixel (the rasteriser's
 * four sub-scanlines) after the position is truncated to 1/512 pixel: 3,248 underline and 1,160 strike-out columns of
 * the probe agree. Horizontally the bar runs over the run's advance; bars of two or more rows begin and end at
 * `ceil8(edge + 0.5)` (1/8 pixel columns, all measured ends agree); the thin bar's ends are fitted offsets
 * (start + 0.30, end + 0.80, within about a sixteenth), whose exact rule is not known.
 */
function fractionalBars(
	metrics: NonNullable<GdiRealizedFont['exactDecorations']>,
	run: GdiTextRun,
	start: number,
	baseline: number,
	total: number,
): SoftBar[] {
	const raiseToQuarter = (v: number): number => Math.ceil((Math.floor(v * 512 + 1e-7) / 512) * 4 - 1e-9) / 4;
	const raiseToEighth = (v: number): number => Math.ceil(v * 8 - 1e-9) / 8;
	const end = start + total;
	const make = (top: number, thickness: number): SoftBar => {
		const rows = Math.max(1, Math.round(thickness));
		const t = raiseToQuarter(top - (rows - 1) / 2);
		return rows === 1
			? { left: start + 0.3, right: end + 0.8, top: t, bottom: t + 1 }
			: { left: raiseToEighth(start + 0.5), right: raiseToEighth(end + 0.5), top: t, bottom: t + rows };
	};
	const bars: SoftBar[] = [];
	if (run.underline) bars.push(make(baseline - metrics.underlinePosition, metrics.underlineThickness));
	if (run.strikeOut) bars.push(make(baseline - metrics.strikeoutPosition, metrics.strikeoutThickness));
	return bars;
}

/**
 * The glyph coverage GDI would paint for `run` (no background, no
 * underline/strike-out), as an alpha mask in device pixels: 255 for a
 * black-and-white pixel, `k * 255 / 16` for grayscale coverage `k`, and
 * per-channel alphas for ClearType. For callers that fill text with
 * something other than a solid colour (e.g. an EMF+ gradient or texture
 * brush sampled per pixel through the mask). With `decorations`, include
 * upright underline/strike-out bars, including runs containing only spaces.
 * Returns null when there is no painted coverage.
 */
export function gdiTextCoverage(font: GdiRealizedFont, run: GdiTextRun, options: { decorations?: boolean; grayLevels?: 15 | 16 } = {}): GdiTextCoverage | null {
	const { placed, total, startAlong, baseDown } = layoutGdiRun(font, run);
	const bars: DeviceRect[] = [];
	const softBars: SoftBar[] = [];
	if (options.decorations && run.plusBars === 'fractional' && font.exactDecorations && !run.matrix && total !== 0 && font.mode === 'gray') {
		softBars.push(...fractionalBars(font.exactDecorations, run, run.x + startAlong, run.y + baseDown, total));
	} else
	// EMF+ uses upright, device-scaled fonts on this coverage path. Keep
	// decoration masks optional for callers that only need the glyphs.
	if (options.decorations && !run.matrix && total !== 0) {
		const x = Math.round(run.x + startAlong);
		const end = x + Math.round(total);
		const snapped = run.plusBars === 'snapped' && font.exactDecorations ? fractionalBars(font.exactDecorations, run, run.x + startAlong, run.y + baseDown, total) : null;
		let barIndex = 0;
		const add = (position: number, thickness: number): void => {
			const top = Math.round(run.y + baseDown) - position;
			const snap = snapped?.[barIndex++];
			const l = snap ? Math.round(snap.left) : x;
			const r = snap ? Math.round(snap.right) : end;
			bars.push({ left: Math.min(l, r), right: Math.max(l, r), top, bottom: top + Math.max(1, thickness) });
		};
		if (run.underline) add(font.underlinePosition, font.underlineThickness);
		if (run.strikeOut) add(font.strikeoutPosition, font.strikeoutThickness);
	}
	if (placed.length === 0 && bars.length === 0 && softBars.length === 0) {
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
	for (const bar of bars) {
		x0 = Math.min(x0, bar.left); y0 = Math.min(y0, bar.top);
		x1 = Math.max(x1, bar.right); y1 = Math.max(y1, bar.bottom);
	}
	for (const bar of softBars) {
		x0 = Math.min(x0, Math.floor(bar.left)); y0 = Math.min(y0, Math.floor(bar.top));
		x1 = Math.max(x1, Math.ceil(bar.right)); y1 = Math.max(y1, Math.ceil(bar.bottom));
	}
	const w = x1 - x0;
	const h = y1 - y0;
	if (w <= 0 || h <= 0 || w * h > 64 * 1024 * 1024) {
		return null;
	}
	const channels: 1 | 3 = placed.some((p) => p.bitmap.channels === 3) ? 3 : 1;
	const data = new Uint8ClampedArray(w * h * channels);
	const full = font.mode === 'mono' ? 1 : options.grayLevels ?? 16;
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
	for (const bar of bars) {
		for (let y = bar.top; y < bar.bottom; y++) {
			data.fill(255, ((y - y0) * w + bar.left - x0) * channels, ((y - y0) * w + bar.right - x0) * channels);
		}
	}
	const barData = softBars.length > 0 ? new Uint8ClampedArray(w * h) : undefined;
	for (const bar of softBars) {
		for (let y = Math.floor(bar.top); y < Math.ceil(bar.bottom); y++) {
			const rowCover = Math.min(y + 1, bar.bottom) - Math.max(y, bar.top);
			for (let x = Math.floor(bar.left); x < Math.ceil(bar.right); x++) {
				// Four sub-scanlines of eight horizontal samples: 32 coverage levels (native values are round(k * 255 / 32)).
				const samples = Math.round(rowCover * 4) * Math.round((Math.min(x + 1, bar.right) - Math.max(x, bar.left)) * 8);
				const v = Math.round((samples * 255) / 32);
				const i = (y - y0) * w + x - x0;
				if (v > barData![i]) barData![i] = v;
			}
		}
	}
	return { x: x0, y: y0, width: w, height: h, channels, data, bars: barData };
}
