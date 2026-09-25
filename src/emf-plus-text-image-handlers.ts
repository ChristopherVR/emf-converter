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
import { deviceBounds, deviceBrushSampler, paintBrushThroughMask, tryFillPlusShapeExact } from './emf-plus-exact-fill';
import { isHalfPixelOffset, resampleKernelFor } from './emf-plus-image-resample';
import { replayEmfPlusPath } from './emf-plus-path';
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
	type LogFontSpec,
} from './gdi-font-engine';
import { paintGdiTextRun } from './gdi-text-render';
import type {
	DeferredImageDraw,
	DeferredImageResample,
	EmfPlusFont,
	EmfPlusImage,
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
 * world coordinates.
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
	if (drawEmfPlusImageNow(rCtx, imgObj, draw, source)) {
		emfLog('DrawImage: painted in record order');
		return;
	}
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
			paintBrushThroughMask(rCtx, sampler, box, (c) => {
				c.font = font;
				c.textAlign = textAlign;
				c.textBaseline = textBaseline;
				c.fillText(text, x, y);
			})
		) {
			return;
		}
	}
	ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
	applyPlusWorldTransform(rCtx);
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

/**
 * Draws an EmfPlusDrawString with the GDI font engine when fonts were
 * supplied, for a solid brush, near (left) alignment and an unrotated
 * world transform. Returns false, having drawn nothing, otherwise.
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
): boolean {
	const fonts = rCtx.fonts;
	const color = typeof paint === 'string' ? rgbaToHex(paint) : null;
	const unit = font.unit ?? 0;
	if (!fonts || !color || alignment !== 0 || (unit !== 0 && unit !== 2)) {
		return false;
	}
	const m = plusWorldMatrix(rCtx);
	if (m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] <= 0) {
		return false;
	}
	const emPx = font.emSize * m[3];
	const hint = rCtx.textRenderingHint ?? 0;
	const quality = HINT_QUALITY[hint] ?? NONANTIALIASED_QUALITY;
	const spec: LogFontSpec = {
		face: font.family,
		height: -Math.round(emPx),
		width: 0,
		weight: font.flags & 1 ? 700 : 400,
		italic: (font.flags & 2) !== 0,
		charSet: 1,
		pitchAndFamily: 0,
		quality,
		unhinted: hint === 2 || hint === 4,
		// AntiAlias ignores the font's gasp table (measured: Arial 16 px is
		// grayscale there, but single-bit under AntiAliasGridFit, as in GDI).
		ignoreGasp: hint === 4,
	};
	const realized = fonts.realize(spec, rCtx.fontFamilyMap);
	if (!realized) {
		return false;
	}
	const ttf = realized.ttf;
	const unhinted = spec.unhinted === true;
	// Grid-fitted hints put the baseline on a whole pixel; the others keep
	// GDI+'s fractional one (rounded when the glyphs are placed).
	const exactAscent = (emPx * ttf.winAscent) / ttf.unitsPerEm;
	const ascent = unhinted ? exactAscent : Math.ceil(exactAscent);
	const x = m[0] * layoutX + m[4] + emPx * (format?.leadingMargin ?? PLUS_LEADING_EM);
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
	paintGdiTextRun(rCtx.ctx, realized, {
		codes,
		glyphIndices: false,
		x,
		y,
		dx,
		dy: null,
		textAlign: 0x18,
		textColor: color,
		bkColor: '#ffffff',
		bkMode: 1,
		options: 0,
		rect: null,
		matrix: null,
		underline: (font.flags & 4) !== 0,
		strikeOut: (font.flags & 8) !== 0,
	}, rCtx.fontFamilyMap);
	return true;
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
				const brushVal = view.getUint32(dataOff, true);
				const pathId = recFlags & 0xff;
				const pathObj = objectTable.get(pathId);
				if (pathObj && pathObj.kind === 'plus-path') {
					// replayEmfPlusPath issues its own beginPath(), harmlessly
					// repeating the one tryFillPlusShapeExact has already issued.
					// The path's own FillMode: Alternate (even-odd, GDI+'s default)
					// or Winding (nonzero).
					const rule = pathObj.fillRule ?? 'nonzero';
					const exact = tryFillPlusShapeExact(
						rCtx,
						recFlags,
						brushVal,
						(c) => replayEmfPlusPath(c, pathObj),
						pathObj.points,
						rule,
					);
					if (!exact) {
						ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
						applyPlusWorldTransform(rCtx);
						replayEmfPlusPath(ctx, pathObj);
						ctx.fill(rule);
					}
				}
			}
			return true;
		}

		case EMFPLUS_DRAWPATH: {
			if (recDataSize >= 4) {
				const penIndex = view.getUint32(dataOff, true);
				const pathId = recFlags & 0xff;
				const pathObj = objectTable.get(pathId);
				const pen = objectTable.get(penIndex & 0xff);
				if (pathObj && pathObj.kind === 'plus-path') {
					// replayEmfPlusPath issues its own beginPath().
					strokePlusGeometry(
						rCtx,
						pen && pen.kind === 'plus-pen' ? pen : null,
						(c) => replayEmfPlusPath(c, pathObj),
						pathObj.points,
						isClosedPath(pathObj.types),
					);
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
						if (drawPlusStringWithEngine(rCtx, font, text, layoutX, layoutY, paint, alignment, format)) {
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
			if (recDataSize >= 16) {
				const brushVal = view.getUint32(dataOff, true);
				const glyphCount = view.getUint32(dataOff + 12, true);
				const fontId = recFlags & 0xff;
				const font = objectTable.get(fontId);

				const glyphsOff = dataOff + 16;
				const posOff = glyphsOff + glyphCount * 2;
				const alignedPosOff = (posOff + 3) & ~3;

				if (
					glyphCount > 0 &&
					glyphCount < 100000 &&
					alignedPosOff + glyphCount * 8 <= dataOff + recDataSize &&
					font &&
					font.kind === 'plus-font'
				) {
					const text = readUtf16LE(view, glyphsOff, glyphCount);
					if (text.length > 0) {
						const bold = font.flags & 1 ? 'bold ' : '';
						const italic = font.flags & 2 ? 'italic ' : '';
						const family = mapFontFamily(font.family, rCtx.fontFamilyMap);
						ctx.font = `${italic}${bold}${font.emSize}px ${family}`;
						ctx.textBaseline = 'alphabetic';
						ctx.textAlign = 'left';

						const gx = view.getFloat32(alignedPosOff, true);
						const gy = view.getFloat32(alignedPosOff + 4, true);
						fillPlusText(rCtx, recFlags, brushVal, text, gx, gy, font.emSize);
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
				const compressed = (recFlags & 0x4000) !== 0;
				const ptOff = dataOff + 28;
				if (count >= 3 && imgObj && imgObj.kind === 'plus-image' && imgObj.data) {
					let p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number;
					if (compressed && ptOff + 12 <= dataOff + recDataSize) {
						p1x = view.getInt16(ptOff, true);
						p1y = view.getInt16(ptOff + 2, true);
						p2x = view.getInt16(ptOff + 4, true);
						p2y = view.getInt16(ptOff + 6, true);
						p3x = view.getInt16(ptOff + 8, true);
						p3y = view.getInt16(ptOff + 10, true);
					} else if (!compressed && ptOff + 24 <= dataOff + recDataSize) {
						p1x = view.getFloat32(ptOff, true);
						p1y = view.getFloat32(ptOff + 4, true);
						p2x = view.getFloat32(ptOff + 8, true);
						p2y = view.getFloat32(ptOff + 12, true);
						p3x = view.getFloat32(ptOff + 16, true);
						p3y = view.getFloat32(ptOff + 20, true);
					} else {
						emfWarn(`DrawImagePoints: imgId=${imgId}, point data out of bounds`);
						return true;
					}
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
					});
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
