/**
 * EMF+ text drawing, image drawing, and path-based fill/stroke handlers.
 *
 * Handles: FillPath, DrawPath, DrawString, DrawDriverString,
 * DrawImage, DrawImagePoints.
 */

import { mapFontFamily, readUtf16LE } from './emf-canvas-helpers';
import {
	EMFPLUS_FILLPATH,
	EMFPLUS_DRAWPATH,
	EMFPLUS_DRAWSTRING,
	EMFPLUS_DRAWDRIVERSTRING,
	EMFPLUS_DRAWIMAGE,
	EMFPLUS_DRAWIMAGEPOINTS,
} from './emf-constants';
import { emfLog, emfWarn } from './emf-logging';
import { mulMatrix } from './emf-plus-brush-gradient';
import { drawEmfPlusImageNow } from './emf-plus-draw-image';
import { DRAWIMAGE_EFFECT_FLAG, type EmfPlusImageEffect } from './emf-plus-image-effects';
import {
	compositeBrushCoverage,
	cssColorToArgb,
	deviceBounds,
	solidSampler,
	deviceBrushSampler,
	paintBrushThroughMask,
	tryFillPlusShapeExact,
	type DeviceBrushSampler,
} from './emf-plus-exact-fill';
import { isHalfPixelOffset, resampleKernelFor } from './emf-plus-image-resample';
import { replayEmfPlusPath } from './emf-plus-path';
import { readPlusPoints } from './emf-plus-read-helpers';
import { strokePlusGeometry } from './emf-plus-stroke';
import {
	resolveBrushPaint,
	applyPlusWorldTransform,
	plusWorldMatrix,
} from './emf-plus-state-handlers';
import { isSvgContext } from './svg-context';
import {
	ANTIALIASED_QUALITY,
	CLEARTYPE_NATURAL_QUALITY,
	NONANTIALIASED_QUALITY,
	type GdiRealizedFont,
	type LogFontSpec,
} from './gdi-font-engine';
import { gdiTextCoverage, paintGdiTextRun } from './gdi-text-render';
import type {
	DeferredImageDraw,
	DeferredImageResample,
	EmfPlusFont,
	EmfPlusImage,
	EmfPlusPath,
	EmfPlusPen,
	EmfPlusReplayCtx,
	EmfPlusStringFormat,
	TransformMatrix,
} from './emf-types';

/**
 * The WrapMode and clamp colour of a draw record's ImageAttributes object
 * (its first field, 0xFFFFFFFF or a missing object meaning none).
 */
function imageAttributesWrap(
	rCtx: EmfPlusReplayCtx,
	attributesId: number,
): Pick<DeferredImageResample, 'wrap' | 'clampArgb'> {
	const obj = attributesId <= 0xff ? rCtx.objectTable.get(attributesId) : undefined;
	if (!obj || obj.kind !== 'plus-imageattributes' || !obj.wrapMode) {
		return {};
	}
	return { wrap: obj.wrapMode, clampArgb: obj.clampArgb };
}

/** GDI+ `UnitPixel` (MS-EMFPLUS 2.1.1.33): the only source-rectangle unit resampled per pixel. */
const UNIT_PIXEL = 2;

/**
 * Builds the GDI+-matching resampling descriptor for a raster
 * `DrawImage`/`DrawImagePoints` (see `emf-plus-image-resample.ts`), from the
 * record's source rectangle (at `dataOff + 4`: SrcUnit, then a RectF) and
 * `toWorld`, the matrix taking source pixels to world coordinates. Returns
 * `undefined` (the draw keeps Canvas `drawImage` scaling) for a metafile
 * image, a non-pixel source unit, a degenerate source rectangle, or an
 * `InterpolationMode` that is not modelled.
 */
/**
 * Maps flat `x, y` page points through the world transform `wt` scaled by
 * `s` (page unit and DPI) to device space: where a deferred image lands,
 * for `SvgContext.reserveSlot`.
 */
function deviceQuad(wt: TransformMatrix, s: number, pts: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < pts.length; i += 2) {
		const x = pts[i];
		const y = pts[i + 1];
		out.push((wt[0] * x + wt[2] * y + wt[4]) * s, (wt[1] * x + wt[3] * y + wt[5]) * s);
	}
	return out;
}

function imageResampleSpec(
	rCtx: EmfPlusReplayCtx,
	dataOff: number,
	isMetafile: boolean,
	toWorld: (sx: number, sy: number, sw: number, sh: number) => TransformMatrix,
): DeferredImageResample | undefined {
	const { view } = rCtx;
	const kernel = resampleKernelFor(rCtx.interpolationMode ?? 0);
	if (isMetafile || view.getUint32(dataOff + 4, true) !== UNIT_PIXEL) {
		return undefined;
	}
	const srcX = view.getFloat32(dataOff + 8, true);
	const srcY = view.getFloat32(dataOff + 12, true);
	const srcW = view.getFloat32(dataOff + 16, true);
	const srcH = view.getFloat32(dataOff + 20, true);
	if (!(srcW > 0 && srcH > 0) || !Number.isFinite(srcX + srcY + srcW + srcH)) {
		return undefined;
	}
	return {
		srcX,
		srcY,
		srcW,
		srcH,
		toDevice: mulMatrix(plusWorldMatrix(rCtx), toWorld(srcX, srcY, srcW, srcH)),
		kernel,
		halfPixelOffset: isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0),
		...imageAttributesWrap(rCtx, view.getUint32(dataOff, true)),
	};
}

/**
 * Paints an EMF+ image draw now, in record order and under the active clip
 * (`emf-plus-draw-image.ts`), or, when its content could not be prepared
 * ahead of replay, queues it for `processDeferredImages` (reserving its
 * SVG slot here so SVG output keeps its z-order either way). `toWorld`
 * maps the record's source rectangle (image pixels, at `dataOff + 8`) to
 * world coordinates. `effect` is an image effect to apply to the bitmap
 * first; a deferred draw retains the effect and source mapping.
 */
function drawOrDeferImage(
	rCtx: EmfPlusReplayCtx,
	imgObj: EmfPlusImage,
	dataOff: number,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
	toWorld: (sx: number, sy: number, sw: number, sh: number) => TransformMatrix,
	effect: EmfPlusImageEffect | null = null,
): void {
	if (!imgObj.data) {
		return;
	}
	const isMetafile = imgObj.type === 2;
	const draw: DeferredImageDraw = {
		imageData: imgObj.data,
		dx,
		dy,
		dw,
		dh,
		transform: plusWorldMatrix(rCtx),
		isMetafile,
		resample: imageResampleSpec(rCtx, dataOff, isMetafile, toWorld),
	};
	const { view } = rCtx;
	const source = {
		unit: view.getUint32(dataOff + 4, true),
		srcX: view.getFloat32(dataOff + 8, true),
		srcY: view.getFloat32(dataOff + 12, true),
		srcW: view.getFloat32(dataOff + 16, true),
		srcH: view.getFloat32(dataOff + 20, true),
		toWorld,
	};
	if (drawEmfPlusImageNow(rCtx, imgObj, draw, source, effect)) {
		emfLog('DrawImage: painted in record order');
		return;
	}
	draw.effect = effect;
	draw.effectSource = source;
	if (isSvgContext(rCtx.ctx)) {
		// The raster mirror never sees a deferred image, so mark the device
		// quad it will cover as unknown (see `SvgContext.reserveSlot`): the
		// source rectangle's corners mapped to world by `toWorld`, then to device.
		const m = toWorld(source.srcX, source.srcY, source.srcW, source.srcH);
		const corners = [
			source.srcX,
			source.srcY,
			source.srcX + source.srcW,
			source.srcY,
			source.srcX + source.srcW,
			source.srcY + source.srcH,
			source.srcX,
			source.srcY + source.srcH,
		];
		const world: number[] = [];
		for (let i = 0; i < corners.length; i += 2) {
			world.push(m[0] * corners[i] + m[2] * corners[i + 1] + m[4], m[1] * corners[i] + m[3] * corners[i + 1] + m[5]);
		}
		draw.svgSlot = rCtx.ctx.reserveSlot(deviceQuad(plusWorldMatrix(rCtx), 1, world));
	}
	rCtx.deferredImages.push(draw);
	emfLog(`DrawImage: queued deferred image (total=${rCtx.deferredImages.length})`);
}

/**
 * Fills an EMF+ path object with a brush (`flags` bit 0x8000: `brush` is
 * an inline ARGB colour, else an object id), in the path's own FillMode:
 * Alternate (even-odd, GDI+'s default) or Winding (nonzero). Shared by
 * FillPath and StrokeFillPath.
 */
export function fillPlusPath(rCtx: EmfPlusReplayCtx, flags: number, brush: number, pathObj: EmfPlusPath): void {
	const { ctx } = rCtx;
	const rule = pathObj.fillRule ?? 'nonzero';
	// replayEmfPlusPath issues its own beginPath(), harmlessly repeating the
	// one tryFillPlusShapeExact has already issued.
	const exact = tryFillPlusShapeExact(rCtx, flags, brush, (c) => replayEmfPlusPath(c, pathObj), pathObj.points, rule);
	if (!exact) {
		ctx.fillStyle = resolveBrushPaint(rCtx, flags, brush);
		applyPlusWorldTransform(rCtx);
		replayEmfPlusPath(ctx, pathObj);
		ctx.fill(rule);
	}
}

/** Strokes an EMF+ path object with a pen (DrawPath, StrokeFillPath). */
export function strokePlusPath(rCtx: EmfPlusReplayCtx, pen: EmfPlusPen | null, pathObj: EmfPlusPath): void {
	// replayEmfPlusPath issues its own beginPath().
	strokePlusGeometry(rCtx, pen, (c) => replayEmfPlusPath(c, pathObj), pathObj.points, isClosedPath(pathObj.types));
}

/**
 * GDI+'s text gamma for a `TextContrast` (0 to 12, default 4): 1 + contrast
 * / 10, the 1.0 to 2.2 range MS-EMFPLUS 2.3.6.7 describes. Pure.
 */
export function textGamma(contrast: number | undefined): number {
	const k = contrast === undefined || !Number.isFinite(contrast) ? 4 : Math.min(12, Math.max(0, contrast));
	return 1 + k / 10;
}

/**
 * Applies GDI+'s text contrast to grayscale (antialiased) glyph coverage,
 * in place: coverage a becomes `1 - (1 - a)^(1 / gamma)`, whatever the text
 * and background colours, and is then blended linearly. Measured on
 * AntiAlias text at every TextContrast (black on white, white on black and
 * colour on colour): each contrast's pixels follow from contrast 0's by
 * exactly this map (contrast 0 is the plain coverage). Pure but for `data`.
 */
export function applyTextContrast(data: Uint8ClampedArray, gamma: number): void {
	if (gamma === 1) {
		return;
	}
	const e = 1 / gamma;
	for (let i = 0; i < data.length; i++) {
		const a = data[i] / 255;
		data[i] = Math.round((1 - Math.pow(1 - a, e)) * 255);
	}
}

/**
 * True when every figure of an EMF+ path is closed (its last point carries
 * the close flag, 0x80), so an Inset pen paints inside it. Pure.
 */
function isClosedPath(types: Uint8Array): boolean {
	if (types.length === 0) {
		return false;
	}
	for (let i = 1; i <= types.length; i++) {
		// The point before each figure start (and the very last point) ends a figure.
		if ((i === types.length || (types[i] & 0x0f) === 0) && !(types[i - 1] & 0x80)) {
			return false;
		}
	}
	return true;
}

/**
 * Fills text (with the context's font, alignment and baseline already set)
 * at world (`x`, `y`) with a record's brush. A texture, linear- or
 * path-gradient brush on a raster context is painted exactly: the glyphs'
 * coverage comes from one opaque `fillText` on a scratch canvas and the
 * colour of every covered device pixel from the brush sampler a fill uses
 * (`paintBrushThroughMask`), instead of a `CanvasPattern` every backend
 * filters. Any other brush (and SVG output, which keeps real `<text>` with
 * a paint server) fills through `fillStyle`. `emSize` bounds the glyph
 * extent above and below the text line.
 */
function fillPlusText(
	rCtx: EmfPlusReplayCtx,
	recFlags: number,
	brushVal: number,
	text: string,
	x: number,
	y: number,
	emSize: number,
): void {
	const { ctx } = rCtx;
	const sampler = isSvgContext(ctx) ? null : deviceBrushSampler(rCtx, recFlags, brushVal);
	const size = (ctx as { canvas?: { width?: number; height?: number } }).canvas;
	if (sampler && size && typeof size.width === 'number' && typeof size.height === 'number') {
		const width = typeof ctx.measureText === 'function' ? ctx.measureText(text).width : text.length * emSize;
		const em = Math.abs(emSize) || 1;
		// Generous world-space bounds for any alignment/baseline: the whole
		// advance on either side, and two ems above and below the anchor.
		const pts = [
			{ x: x - width - em, y: y - 2 * em },
			{ x: x + width + em, y: y - 2 * em },
			{ x: x - width - em, y: y + 2 * em },
			{ x: x + width + em, y: y + 2 * em },
		];
		const box = deviceBounds(pts, plusWorldMatrix(rCtx), { w: size.width, h: size.height });
		if (!box) {
			return;
		}
		const { font, textAlign, textBaseline } = ctx;
		if (
			paintBrushThroughMask(
				rCtx,
				sampler,
				box,
				(c) => {
					c.font = font;
					c.textAlign = textAlign;
					c.textBaseline = textBaseline;
					c.fillText(text, x, y);
				},
				'canvas',
				undefined,
				false,
			)
		) {
			return;
		}
	}
	ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
	applyPlusWorldTransform(rCtx, false);
	ctx.fillText(text, x, y);
}

// ---------------------------------------------------------------------------
// DrawString through the GDI font engine
// ---------------------------------------------------------------------------

/**
 * LOGFONT quality equivalent of each GDI+ `TextRenderingHint`:
 * SystemDefault (measured: GDI+ draws it single-bit grid-fitted into a
 * bitmap), SingleBitPerPixelGridFit, SingleBitPerPixel, AntiAliasGridFit,
 * AntiAlias, ClearTypeGridFit (natural ClearType widths, which match GDI+
 * more closely than GDI's compatible ones).
 */
const HINT_QUALITY = [NONANTIALIASED_QUALITY, NONANTIALIASED_QUALITY, NONANTIALIASED_QUALITY, ANTIALIASED_QUALITY, ANTIALIASED_QUALITY, CLEARTYPE_NATURAL_QUALITY];

/** GDI+'s leading padding before the first glyph of a DrawString (a sixth of the em). */
const PLUS_LEADING_EM = 1 / 6;

/** GDI+'s default StringFormat tracking (advance multiplier). */
const PLUS_DEFAULT_TRACKING = 1.03;

function rgbaToHex(c: string): string | null {
	const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c.trim());
	if (m) {
		if (m[4] !== undefined && Number(m[4]) < 1) {
			return null;
		}
		return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
	}
	return /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}

/** A GDI+ font realized by the GDI font engine for the current world transform. */
interface PlusEngineFont {
	realized: GdiRealizedFont;
	/** The em height in device pixels. */
	emPx: number;
	/** The world-to-device matrix (unrotated, positive scales). */
	m: TransformMatrix;
	/** True for the hints that keep linear (unhinted) advances. */
	unhinted: boolean;
	/** Solid glyph colour (CSS hex), or null when the glyphs take the sampler's. */
	color: string | null;
	/** Brush colour per device pixel, for glyph coverage. */
	sampler: DeviceBrushSampler | null;
	/** Whether a solid colour still goes through glyph coverage (smoothed text). */
	solidViaCoverage: boolean;
	underline: boolean;
	strikeOut: boolean;
}

/**
 * Realizes `font` with the GDI font engine for the current world transform
 * and TextRenderingHint, when fonts were supplied, the transform is
 * unrotated and the font's unit is World or Pixel; null otherwise.
 */
function realizePlusEngineFont(
	rCtx: EmfPlusReplayCtx,
	font: EmfPlusFont,
	paint: string | CanvasGradient | CanvasPattern,
	brushSampler: DeviceBrushSampler | null,
): PlusEngineFont | null {
	const fonts = rCtx.fonts;
	const color = typeof paint === 'string' ? rgbaToHex(paint) : null;
	// A texture/gradient brush takes its glyph coverage from the engine and
	// its colour from the brush sampler (raster output only).
	const hint = rCtx.textRenderingHint ?? 0;
	const graySmooth = hint === 3 || hint === 4 || hint === 5;
	// Antialiased and ClearType text is blended the GDI+ way, with its text
	// contrast (see applyTextContrast), so a solid colour goes through the
	// coverage path too.
	const solidViaCoverage = !!color && graySmooth && !isSvgContext(rCtx.ctx);
	const sampler = isSvgContext(rCtx.ctx) ? null : solidViaCoverage ? solidSampler(cssColorToArgb(paint as string) ?? 0xff000000) : color ? null : brushSampler;
	const unit = font.unit ?? 0;
	if (!fonts || (!color && !sampler) || (unit !== 0 && unit !== 2)) {
		return null;
	}
	const m = plusWorldMatrix(rCtx);
	if (m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] <= 0) {
		return null;
	}
	const emPx = font.emSize * m[3];
	const spec: LogFontSpec = {
		face: font.family,
		height: -Math.round(emPx),
		width: 0,
		weight: font.flags & 1 ? 700 : 400,
		italic: (font.flags & 2) !== 0,
		charSet: 1,
		pitchAndFamily: 0,
		quality: HINT_QUALITY[hint] ?? NONANTIALIASED_QUALITY,
		unhinted: hint === 2 || hint === 4,
		// AntiAlias ignores the font's gasp table (measured: Arial 16 px is
		// grayscale there, but single-bit under AntiAliasGridFit, as in GDI).
		ignoreGasp: hint === 4,
		gdiPlus: true,
	};
	const realized = fonts.realize(spec, rCtx.fontFamilyMap);
	if (!realized) {
		return null;
	}
	return {
		realized,
		emPx,
		m,
		unhinted: spec.unhinted === true,
		color,
		sampler,
		solidViaCoverage,
		underline: (font.flags & 4) !== 0,
		strikeOut: (font.flags & 8) !== 0,
	};
}

/**
 * Paints one baseline-anchored glyph run (device pixels) with a realized
 * engine font: a solid brush paints the glyphs directly; a texture or
 * gradient brush, and smoothed text, take the engine's glyph coverage on a
 * scratch canvas and the colour of every covered pixel from the brush.
 */
function paintPlusEngineRun(
	rCtx: EmfPlusReplayCtx,
	ef: PlusEngineFont,
	run: { codes: number[]; glyphIndices: boolean; x: number; y: number; dx: number[] | null; dy: number[] | null },
): boolean {
	const base = {
		...run,
		textAlign: 0x18,
		bkColor: '#ffffff',
		bkMode: 1,
		options: 0,
		rect: null,
		matrix: null,
	};
	if ((!ef.color || ef.solidViaCoverage) && ef.sampler) {
		const cov = gdiTextCoverage(ef.realized, { ...base, textColor: '#000000', underline: ef.underline, strikeOut: ef.strikeOut }, { decorations: true, grayLevels: 15 });
		if (!cov) {
			return true;
		}
		const gamma = textGamma(rCtx.ext?.textContrast);
		if (cov.channels === 1) {
			applyTextContrast(cov.data, gamma);
		}
		return compositeBrushCoverage(
			rCtx,
			ef.sampler,
			{ x: cov.x, y: cov.y, w: cov.width, h: cov.height },
			cov.data,
			cov.channels,
			false,
			cov.channels === 3 ? gamma : 1,
		);
	}
	paintGdiTextRun(
		rCtx.ctx,
		ef.realized,
		{ ...base, textColor: ef.color as string, underline: ef.underline, strikeOut: ef.strikeOut },
		rCtx.fontFamilyMap,
	);
	return true;
}

/**
 * Draws an EmfPlusDrawString with the GDI font engine when fonts were
 * supplied, for near (left) alignment and an unrotated world transform.
 * Returns false, having drawn nothing, otherwise.
 */
function drawPlusStringWithEngine(
	rCtx: EmfPlusReplayCtx,
	font: EmfPlusFont,
	text: string,
	layoutX: number,
	layoutY: number,
	paint: string | CanvasGradient | CanvasPattern,
	alignment: number,
	format?: EmfPlusStringFormat,
	brushSampler: DeviceBrushSampler | null = null,
): boolean {
	if (alignment !== 0) {
		return false;
	}
	const ef = realizePlusEngineFont(rCtx, font, paint, brushSampler);
	if (!ef) {
		return false;
	}
	const { realized, emPx, m, unhinted } = ef;
	const ttf = realized.ttf;
	// DrawString rounds the font ascent before adding the layout position;
	// DriverString supplies its baseline directly and retains its own phase.
	const exactAscent = (emPx * ttf.winAscent) / ttf.unitsPerEm;
	const ascent = unhinted ? Math.round(exactAscent) : Math.ceil(exactAscent);
	let x = m[0] * layoutX + m[4] + emPx * (format?.leadingMargin ?? PLUS_LEADING_EM);
	if (!unhinted) x = Math.round(x);
	const y = m[3] * layoutY + m[5] + ascent;
	const codes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		codes.push(text.charCodeAt(i));
	}
	// Without grid fitting GDI+ spaces glyphs by their linear advances times
	// the format's tracking (1.03 for the default format, 1 for
	// GenericTypographic; measured with MeasureString).
	const tracking = format?.tracking ?? PLUS_DEFAULT_TRACKING;
	const dx = unhinted ? codes.map((c) => realized.advance(realized.glyphIndex(c)) * tracking) : null;
	return paintPlusEngineRun(rCtx, ef, { codes, glyphIndices: false, x, y, dx, dy: null });
}

/** DriverStringOptionsCmapLookup: the glyph array holds character codes, not glyph indices. */
const DRIVER_STRING_CMAP_LOOKUP = 0x1;
/** DriverStringOptionsVertical: the glyphs run top to bottom. */
const DRIVER_STRING_VERTICAL = 0x2;
/** DriverStringOptionsRealizedAdvance: only the first position counts; the font's advances place the rest. */
const DRIVER_STRING_REALIZED_ADVANCE = 0x4;

/**
 * Draws an EmfPlusDrawDriverString (MS-EMFPLUS 2.3.4.6) whose glyph
 * baseline origins are given in world units (only the first one counts
 * under RealizedAdvance); an optional TransformMatrix is already folded
 * into the world transform. The GDI font engine draws the run when fonts
 * were supplied (character codes or glyph indices); otherwise Canvas text
 * draws the character codes glyph by glyph. Glyph indices cannot be drawn
 * without the engine and are skipped.
 */
function drawPlusDriverString(
	rCtx: EmfPlusReplayCtx,
	recFlags: number,
	brushVal: number,
	font: EmfPlusFont,
	codes: number[],
	positions: Array<{ x: number; y: number }>,
	options: number,
): void {
	const cmap = (options & DRIVER_STRING_CMAP_LOOKUP) !== 0;
	const realizedAdvance = (options & DRIVER_STRING_REALIZED_ADVANCE) !== 0;
	if (!(options & DRIVER_STRING_VERTICAL)) {
		const paint = resolveBrushPaint(rCtx, recFlags, brushVal);
		const ef = realizePlusEngineFont(rCtx, font, paint, rCtx.fonts ? deviceBrushSampler(rCtx, recFlags, brushVal) : null);
		if (ef) {
			const { m } = ef;
			const dev = positions.map((p) => ({ x: m[0] * p.x + m[4], y: m[3] * p.y + m[5] }));
			const step = (axis: 'x' | 'y'): number[] => dev.map((p, i) => (i + 1 < dev.length ? dev[i + 1][axis] - p[axis] : 0));
			paintPlusEngineRun(rCtx, ef, {
				codes,
				glyphIndices: !cmap,
				x: dev[0].x,
				y: dev[0].y,
				dx: realizedAdvance ? null : step('x'),
				dy: realizedAdvance ? null : step('y'),
			});
			return;
		}
	}
	if (!cmap) {
		emfWarn('DrawDriverString: glyph indices need the GDI font engine (no fonts supplied); skipped');
		return;
	}
	const { ctx } = rCtx;
	const bold = font.flags & 1 ? 'bold ' : '';
	const italic = font.flags & 2 ? 'italic ' : '';
	const family = mapFontFamily(font.family, rCtx.fontFamilyMap);
	const setFont = (): void => {
		ctx.font = `${italic}${bold}${font.emSize}px ${family}`;
		ctx.textBaseline = 'alphabetic';
		ctx.textAlign = 'left';
	};
	if (realizedAdvance) {
		setFont();
		fillPlusText(rCtx, recFlags, brushVal, String.fromCharCode(...codes), positions[0].x, positions[0].y, font.emSize);
		return;
	}
	for (let i = 0; i < codes.length; i++) {
		setFont();
		fillPlusText(rCtx, recFlags, brushVal, String.fromCharCode(codes[i]), positions[i].x, positions[i].y, font.emSize);
	}
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleEmfPlusTextImageRecord(
	rCtx: EmfPlusReplayCtx,
	recType: number,
	recFlags: number,
	dataOff: number,
	recDataSize: number,
): boolean {
	const { ctx, view, objectTable } = rCtx;

	switch (recType) {
		// ---- path-based drawing ----
		case EMFPLUS_FILLPATH: {
			if (recDataSize >= 4) {
				const pathObj = objectTable.get(recFlags & 0xff);
				if (pathObj && pathObj.kind === 'plus-path') {
					fillPlusPath(rCtx, recFlags, view.getUint32(dataOff, true), pathObj);
				}
			}
			return true;
		}

		case EMFPLUS_DRAWPATH: {
			if (recDataSize >= 4) {
				const pathObj = objectTable.get(recFlags & 0xff);
				const pen = objectTable.get(view.getUint32(dataOff, true) & 0xff);
				if (pathObj && pathObj.kind === 'plus-path') {
					strokePlusPath(rCtx, pen && pen.kind === 'plus-pen' ? pen : null, pathObj);
				}
			}
			return true;
		}

		// ---- text ----
		case EMFPLUS_DRAWSTRING: {
			if (recDataSize >= 28) {
				const brushVal = view.getUint32(dataOff, true);
				const formatId = view.getUint32(dataOff + 4, true);
				const strLen = view.getUint32(dataOff + 8, true);
				const layoutX = view.getFloat32(dataOff + 12, true);
				const layoutY = view.getFloat32(dataOff + 16, true);
				const layoutW = view.getFloat32(dataOff + 20, true);
				void layoutW;
				const layoutH = view.getFloat32(dataOff + 24, true);
				void layoutH;

				const fontId = recFlags & 0xff;
				const font = objectTable.get(fontId);

				if (strLen > 0 && dataOff + 28 + strLen * 2 <= dataOff + recDataSize) {
					const text = readUtf16LE(view, dataOff + 28, strLen);
					if (text.length > 0 && font && font.kind === 'plus-font') {
						const sf = objectTable.get(formatId);
						const paint = resolveBrushPaint(rCtx, recFlags, brushVal);
						const alignment = sf && sf.kind === 'plus-stringformat' ? sf.alignment : 0;
						const format = sf && sf.kind === 'plus-stringformat' ? sf : undefined;
						if (
							drawPlusStringWithEngine(
								rCtx,
								font,
								text,
								layoutX,
								layoutY,
								paint,
								alignment,
								format,
								rCtx.fonts ? deviceBrushSampler(rCtx, recFlags, brushVal) : null,
							)
						) {
							return true;
						}
						const bold = font.flags & 1 ? 'bold ' : '';
						const italic = font.flags & 2 ? 'italic ' : '';
						const family = mapFontFamily(font.family, rCtx.fontFamilyMap);
						ctx.font = `${italic}${bold}${font.emSize}px ${family}`;
						ctx.textBaseline = 'top';

						if (sf && sf.kind === 'plus-stringformat') {
							switch (sf.alignment) {
								case 1:
									ctx.textAlign = 'center';
									break;
								case 2:
									ctx.textAlign = 'right';
									break;
								default:
									ctx.textAlign = 'left';
							}
						} else {
							ctx.textAlign = 'left';
						}

						fillPlusText(rCtx, recFlags, brushVal, text, layoutX, layoutY, font.emSize);
					}
				}
			}
			return true;
		}

		case EMFPLUS_DRAWDRIVERSTRING: {
			// Brush, DriverStringOptionsFlags, MatrixPresent, GlyphCount, then
			// the glyphs (uint16 each) and their positions (PointF each),
			// packed without padding, then the optional TransformMatrix.
			if (recDataSize >= 16) {
				const brushVal = view.getUint32(dataOff, true);
				const options = view.getUint32(dataOff + 4, true);
				const matrixPresent = view.getUint32(dataOff + 8, true) !== 0;
				const glyphCount = view.getUint32(dataOff + 12, true);
				const font = objectTable.get(recFlags & 0xff);
				const glyphsOff = dataOff + 16;
				const posOff = glyphsOff + glyphCount * 2;
				const matrixOff = posOff + glyphCount * 8;
				if (
					glyphCount > 0 &&
					glyphCount < 100000 &&
					matrixOff + (matrixPresent ? 24 : 0) <= dataOff + recDataSize &&
					font &&
					font.kind === 'plus-font'
				) {
					const codes: number[] = [];
					const positions: Array<{ x: number; y: number }> = [];
					for (let i = 0; i < glyphCount; i++) {
						codes.push(view.getUint16(glyphsOff + i * 2, true));
						positions.push({ x: view.getFloat32(posOff + i * 8, true), y: view.getFloat32(posOff + i * 8 + 4, true) });
					}
					const world = rCtx.worldTransform;
					if (matrixPresent) {
						const xf = [0, 4, 8, 12, 16, 20].map((k) => view.getFloat32(matrixOff + k, true)) as TransformMatrix;
						if (xf.every(Number.isFinite)) {
							rCtx.worldTransform = mulMatrix(world, xf);
						}
					}
					try {
						drawPlusDriverString(rCtx, recFlags, brushVal, font, codes, positions, options);
					} finally {
						rCtx.worldTransform = world;
					}
				}
			}
			return true;
		}

		// ---- images ----
		case EMFPLUS_DRAWIMAGE: {
			if (recDataSize >= 24) {
				const imgId = recFlags & 0xff;
				const imgObj = objectTable.get(imgId);
				const compressed = (recFlags & 0x4000) !== 0;
				const rectOff = dataOff + 24;
				let dx: number, dy: number, dw: number, dh: number;
				if (compressed && rectOff + 8 <= dataOff + recDataSize) {
					dx = view.getInt16(rectOff, true);
					dy = view.getInt16(rectOff + 2, true);
					dw = view.getInt16(rectOff + 4, true);
					dh = view.getInt16(rectOff + 6, true);
				} else if (!compressed && rectOff + 16 <= dataOff + recDataSize) {
					dx = view.getFloat32(rectOff, true);
					dy = view.getFloat32(rectOff + 4, true);
					dw = view.getFloat32(rectOff + 8, true);
					dh = view.getFloat32(rectOff + 12, true);
				} else {
					emfWarn(`DrawImage: imgId=${imgId}, rect data out of bounds`);
					return true;
				}
				rCtx.totalDrawImageCalls++;
				const hasData = imgObj && imgObj.kind === 'plus-image' && imgObj.data;
				emfLog(
					`DrawImage: imgId=${imgId}, dest=(${dx},${dy},${dw},${dh}), compressed=${compressed}, hasObj=${Boolean(imgObj)}, objKind=${imgObj?.kind}, hasData=${Boolean(hasData)}, dataLen=${hasData ? imgObj!.data!.byteLength : 0}, isMetafile=${imgObj?.kind === 'plus-image' ? imgObj.type === 2 : 'N/A'}`,
				);
				emfLog(
					`DrawImage: worldTransform=[${rCtx.worldTransform.map((v) => v.toFixed(3)).join(', ')}]`,
				);
				if (imgObj && imgObj.kind === 'plus-image' && imgObj.data) {
					// Store the fully-scaled transform (world × pageUnit × dpiScale ×
					// base) so processDeferredImages can restore it directly.
					drawOrDeferImage(rCtx, imgObj, dataOff, dx, dy, dw, dh, (sx, sy, sw, sh) => [
						dw / sw,
						0,
						0,
						dh / sh,
						dx - (sx * dw) / sw,
						dy - (sy * dh) / sh,
					]);
				} else {
					emfWarn(`DrawImage: SKIPPED, no valid image data for id=${imgId}`);
				}
			}
			return true;
		}

		case EMFPLUS_DRAWIMAGEPOINTS: {
			if (recDataSize >= 28) {
				const imgId = recFlags & 0xff;
				const imgObj = objectTable.get(imgId);
				const count = view.getUint32(dataOff + 24, true);
				const ptOff = dataOff + 28;
				// Flag E applies the effect of the preceding SerializableObject,
				// which the draw consumes.
				const effect = (recFlags & DRAWIMAGE_EFFECT_FLAG) !== 0 ? (rCtx.ext?.pendingEffect ?? null) : null;
				if (rCtx.ext) {
					rCtx.ext.pendingEffect = null;
				}
				if (count >= 3 && imgObj && imgObj.kind === 'plus-image' && imgObj.data) {
					// Absolute (flag C: 16-bit) or relative (flag P) points.
					const pts = readPlusPoints(view, ptOff, dataOff + recDataSize, 3, recFlags);
					if (!pts) {
						emfWarn(`DrawImagePoints: imgId=${imgId}, point data out of bounds`);
						return true;
					}
					const [{ x: p1x, y: p1y }, { x: p2x, y: p2y }, { x: p3x, y: p3y }] = pts;
					const dx = p1x;
					const dy = p1y;
					const dw = Math.sqrt((p2x - p1x) ** 2 + (p2y - p1y) ** 2);
					const dh = Math.sqrt((p3x - p1x) ** 2 + (p3y - p1y) ** 2);
					rCtx.totalDrawImageCalls++;
					emfLog(
						`DrawImagePoints: imgId=${imgId}, points=[(${p1x},${p1y}),(${p2x},${p2y}),(${p3x},${p3y})], dest=(${dx.toFixed(1)},${dy.toFixed(1)},${dw.toFixed(1)},${dh.toFixed(1)})`,
					);
					emfLog(
						`DrawImagePoints: worldTransform=[${rCtx.worldTransform.map((v) => v.toFixed(3)).join(', ')}]`,
					);
					// Store the fully-scaled transform (world × pageUnit × dpiScale × base).
					// The three points are the destinations of the source
					// rectangle's top-left, top-right and bottom-left corners,
					// so any rotation or shear is carried exactly here.
					drawOrDeferImage(rCtx, imgObj, dataOff, dx, dy, dw, dh, (sx, sy, sw, sh) => {
						const a = (p2x - p1x) / sw;
						const b = (p2y - p1y) / sw;
						const c = (p3x - p1x) / sh;
						const d = (p3y - p1y) / sh;
						return [a, b, c, d, p1x - a * sx - c * sy, p1y - b * sx - d * sy];
					}, effect);
				} else {
					const hasData = imgObj && imgObj.kind === 'plus-image' && imgObj.data;
					emfWarn(
						`DrawImagePoints: SKIPPED, imgId=${imgId}, count=${count}, hasObj=${Boolean(imgObj)}, hasData=${Boolean(hasData)}`,
					);
				}
			}
			return true;
		}

		default:
			return false;
	}
}
