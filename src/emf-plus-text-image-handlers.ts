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
import { tryFillPlusShapeExact } from './emf-plus-exact-fill';
import { isHalfPixelOffset, resampleKernelFor } from './emf-plus-image-resample';
import { replayEmfPlusPath } from './emf-plus-path';
import {
	resolveBrushPaint,
	applyPlusWorldTransform,
	getPageUnitMultiplier,
	plusWorldMatrix,
} from './emf-plus-state-handlers';
import { isSvgContext } from './svg-context';
import type { DeferredImageResample, EmfPlusReplayCtx, TransformMatrix } from './emf-types';

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
function imageResampleSpec(
	rCtx: EmfPlusReplayCtx,
	dataOff: number,
	isMetafile: boolean,
	toWorld: (sx: number, sy: number, sw: number, sh: number) => TransformMatrix,
): DeferredImageResample | undefined {
	const { view } = rCtx;
	const kernel = resampleKernelFor(rCtx.interpolationMode ?? 0);
	if (isMetafile || !kernel || view.getUint32(dataOff + 4, true) !== UNIT_PIXEL) {
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
	};
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
					const exact = tryFillPlusShapeExact(
						rCtx,
						recFlags,
						brushVal,
						(c) => replayEmfPlusPath(c, pathObj),
						pathObj.points,
					);
					if (!exact) {
						ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
						applyPlusWorldTransform(rCtx);
						replayEmfPlusPath(ctx, pathObj);
						ctx.fill();
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
					if (pen && pen.kind === 'plus-pen') {
						ctx.strokeStyle = pen.color;
						ctx.lineWidth = pen.width;
					}
					applyPlusWorldTransform(rCtx);
					replayEmfPlusPath(ctx, pathObj);
					ctx.stroke();
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
						const bold = font.flags & 1 ? 'bold ' : '';
						const italic = font.flags & 2 ? 'italic ' : '';
						const family = mapFontFamily(font.family, rCtx.fontFamilyMap);
						ctx.font = `${italic}${bold}${font.emSize}px ${family}`;
						ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
						ctx.textBaseline = 'top';

						const sf = objectTable.get(formatId);
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

						applyPlusWorldTransform(rCtx);
						ctx.fillText(text, layoutX, layoutY);
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
						ctx.fillStyle = resolveBrushPaint(rCtx, recFlags, brushVal);
						ctx.textBaseline = 'alphabetic';
						ctx.textAlign = 'left';

						applyPlusWorldTransform(rCtx);

						const gx = view.getFloat32(alignedPosOff, true);
						const gy = view.getFloat32(alignedPosOff + 4, true);
						ctx.fillText(text, gx, gy);
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
					// Store the fully-scaled transform (world × pageUnit × dpiScale)
					// so processDeferredImages can restore it directly.
					const wt = rCtx.worldTransform;
					const s = getPageUnitMultiplier(rCtx.pageUnit, rCtx.pageScale) * rCtx.dpiScale;
					rCtx.deferredImages.push({
						imageData: imgObj.data,
						dx,
						dy,
						dw,
						dh,
						transform: [
							wt[0] * s,
							wt[1] * s,
							wt[2] * s,
							wt[3] * s,
							wt[4] * s,
							wt[5] * s,
						] as TransformMatrix,
						isMetafile: imgObj.type === 2,
						svgSlot: isSvgContext(rCtx.ctx) ? rCtx.ctx.reserveSlot() : undefined,
						resample: imageResampleSpec(rCtx, dataOff, imgObj.type === 2, (sx, sy, sw, sh) => [
							dw / sw,
							0,
							0,
							dh / sh,
							dx - (sx * dw) / sw,
							dy - (sy * dh) / sh,
						]),
					});
					emfLog(`DrawImage: queued deferred image (total=${rCtx.deferredImages.length})`);
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
					// Store the fully-scaled transform (world × pageUnit × dpiScale)
					const wt2 = rCtx.worldTransform;
					const s2 = getPageUnitMultiplier(rCtx.pageUnit, rCtx.pageScale) * rCtx.dpiScale;
					rCtx.deferredImages.push({
						imageData: imgObj.data,
						dx,
						dy,
						dw,
						dh,
						transform: [
							wt2[0] * s2,
							wt2[1] * s2,
							wt2[2] * s2,
							wt2[3] * s2,
							wt2[4] * s2,
							wt2[5] * s2,
						] as TransformMatrix,
						isMetafile: imgObj.type === 2,
						svgSlot: isSvgContext(rCtx.ctx) ? rCtx.ctx.reserveSlot() : undefined,
						// The three points are the destinations of the source
						// rectangle's top-left, top-right and bottom-left corners,
						// so any rotation or shear is carried exactly here.
						resample: imageResampleSpec(rCtx, dataOff, imgObj.type === 2, (sx, sy, sw, sh) => {
							const a = (p2x - p1x) / sw;
							const b = (p2y - p1y) / sw;
							const c = (p3x - p1x) / sh;
							const d = (p3y - p1y) / sh;
							return [a, b, c, d, p1x - a * sx - c * sy, p1y - b * sx - d * sy];
						}),
					});
					emfLog(`DrawImagePoints: queued deferred image (total=${rCtx.deferredImages.length})`);
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
