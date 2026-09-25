/**
 * EMF+ complex object parsers: Pen and Image.
 *
 * Extracted from the EMFPLUS_OBJECT handler to keep files under 300 lines.
 */

import { readUtf16LE } from './emf-canvas-helpers';
import { emfLog, emfWarn } from './emf-logging';
import { decodeEmfPlusBitmapPixels } from './emf-plus-bitmap-decoder';
import { looksLikeGraphicsVersion, parseEmfPlusBrushObject } from './emf-plus-brush-parser';
import type { EmfPlusObject, EmfPlusPen, EmfPlusTextureCache, TransformMatrix } from './emf-types';

// ---------------------------------------------------------------------------
// Pen object parser
// ---------------------------------------------------------------------------

/** PenDataFlags (MS-EMFPLUS 2.1.2.7), in the order their optional data follows PenWidth. */
const PEN_TRANSFORM = 0x0001;
const PEN_START_CAP = 0x0002;
const PEN_END_CAP = 0x0004;
const PEN_JOIN = 0x0008;
const PEN_MITER_LIMIT = 0x0010;
const PEN_LINE_STYLE = 0x0020;
const PEN_DASHED_LINE_CAP = 0x0040;
const PEN_DASHED_LINE_OFFSET = 0x0080;
const PEN_DASHED_LINE = 0x0100;
const PEN_NON_CENTER = 0x0200;
const PEN_COMPOUND_LINE = 0x0400;
const PEN_CUSTOM_START_CAP = 0x0800;
const PEN_CUSTOM_END_CAP = 0x1000;

/** Upper bound on a dash pattern / compound array's element count. */
const MAX_PEN_ARRAY = 1024;

/**
 * Parses an EmfPlusPen object (MS-EMFPLUS 2.2.1.7): width, the optional
 * pen data in `PenDataFlags` order (transform, caps, join, miter limit,
 * dash style, dash cap, dash offset, dash pattern, alignment, compound
 * line, custom caps; the order and the alignment's 4 bytes confirmed
 * against real GDI+ recordings, `src/__fixtures__/gdi/gpx-pen-styles`),
 * then the pen's own brush, kept whole so a texture or gradient pen can
 * paint its stroke (`emf-plus-stroke.ts`). `textureCache`/`cacheKey` let
 * a compressed texture pen brush use its pre-decoded image.
 */
export function parseEmfPlusPenObject(
	view: DataView,
	dataOff: number,
	recDataSize: number,
	textureCache?: EmfPlusTextureCache,
	cacheKey: number = dataOff,
): EmfPlusObject | null {
	if (recDataSize < 20) {
		return null;
	}
	const end = dataOff + recDataSize;
	// Real GDI+ files start with EmfPlusGraphicsVersion + Type; the synthetic
	// legacy layout starts at PenDataFlags directly after a 4-byte type slot.
	// PenWidth sits at +16 and the optional data at +20 in both layouts.
	const hasVersion = looksLikeGraphicsVersion(view.getUint32(dataOff, true));
	const penFlags = view.getUint32(dataOff + (hasVersion ? 8 : 4), true);
	const penWidth = view.getFloat32(dataOff + 16, true);
	let o = dataOff + 20;
	const u32 = (): number | undefined => {
		if (o + 4 > end) {
			return undefined;
		}
		const v = view.getUint32(o, true);
		o += 4;
		return v;
	};
	const f32 = (): number | undefined => {
		if (o + 4 > end) {
			return undefined;
		}
		const v = view.getFloat32(o, true);
		o += 4;
		return v;
	};
	const pen: EmfPlusPen = { kind: 'plus-pen', color: 'rgba(0,0,0,1)', width: penWidth || 1, dashStyle: 0 };
	if (penFlags & PEN_TRANSFORM) {
		if (o + 24 <= end) {
			pen.transform = [0, 4, 8, 12, 16, 20].map((k) => view.getFloat32(o + k, true)) as TransformMatrix;
		}
		o += 24;
	}
	if (penFlags & PEN_START_CAP) {
		pen.startCap = u32();
	}
	if (penFlags & PEN_END_CAP) {
		pen.endCap = u32();
	}
	if (penFlags & PEN_JOIN) {
		pen.lineJoin = u32();
	}
	if (penFlags & PEN_MITER_LIMIT) {
		pen.miterLimit = f32();
	}
	if (penFlags & PEN_LINE_STYLE) {
		pen.dashStyle = u32() ?? 0;
	}
	if (penFlags & PEN_DASHED_LINE_CAP) {
		pen.dashCap = u32();
	}
	if (penFlags & PEN_DASHED_LINE_OFFSET) {
		pen.dashOffset = f32();
	}
	if (penFlags & PEN_DASHED_LINE) {
		const n = u32() ?? 0;
		if (n > 0 && n <= MAX_PEN_ARRAY && o + n * 4 <= end) {
			pen.dashPattern = Array.from({ length: n }, (_, k) => view.getFloat32(o + k * 4, true));
			// A custom pattern implies DashStyleCustom even without a LineStyle.
			if (!(penFlags & PEN_LINE_STYLE)) {
				pen.dashStyle = 5;
			}
		}
		o += Math.min(n, MAX_PEN_ARRAY) * 4;
	}
	if (penFlags & PEN_NON_CENTER) {
		pen.alignment = u32();
	}
	if (penFlags & PEN_COMPOUND_LINE) {
		const n = u32() ?? 0;
		o += Math.min(n, MAX_PEN_ARRAY) * 4;
	}
	for (const flag of [PEN_CUSTOM_START_CAP, PEN_CUSTOM_END_CAP]) {
		if (penFlags & flag) {
			const size = u32() ?? 0;
			o += size;
		}
	}
	// The pen's colour comes from an embedded brush object (with or without
	// its own leading version field: parseEmfPlusBrushObject sniffs both).
	if (o + 8 <= end) {
		const brush = parseEmfPlusBrushObject(view, o, end - o, textureCache, cacheKey);
		if (brush) {
			pen.color = brush.color;
			pen.brush = brush;
		}
	}
	return pen;
}

/**
 * Offset of an EmfPlusPen record's embedded brush (see
 * {@link parseEmfPlusPenObject}), or `null` when out of bounds: used by the
 * texture pre-decode pass to find a pen's compressed texture image.
 */
export function penBrushOffset(view: DataView, dataOff: number, recDataSize: number): number | null {
	if (recDataSize < 20) {
		return null;
	}
	const end = dataOff + recDataSize;
	const hasVersion = looksLikeGraphicsVersion(view.getUint32(dataOff, true));
	const penFlags = view.getUint32(dataOff + (hasVersion ? 8 : 4), true);
	let o = dataOff + 20;
	const skipArray = (): void => {
		const n = o + 4 <= end ? view.getUint32(o, true) : 0;
		o += 4 + Math.min(n, MAX_PEN_ARRAY) * 4;
	};
	if (penFlags & PEN_TRANSFORM) {
		o += 24;
	}
	for (const flag of [PEN_START_CAP, PEN_END_CAP, PEN_JOIN, PEN_MITER_LIMIT, PEN_LINE_STYLE, PEN_DASHED_LINE_CAP, PEN_DASHED_LINE_OFFSET]) {
		if (penFlags & flag) {
			o += 4;
		}
	}
	if (penFlags & PEN_DASHED_LINE) {
		skipArray();
	}
	if (penFlags & PEN_NON_CENTER) {
		o += 4;
	}
	if (penFlags & PEN_COMPOUND_LINE) {
		skipArray();
	}
	for (const flag of [PEN_CUSTOM_START_CAP, PEN_CUSTOM_END_CAP]) {
		if (penFlags & flag) {
			const size = o + 4 <= end ? view.getUint32(o, true) : 0;
			o += 4 + size;
		}
	}
	return o + 8 <= end ? o : null;
}

// ---------------------------------------------------------------------------
// Image object parser
// ---------------------------------------------------------------------------

export function parseEmfPlusImageObject(
	view: DataView,
	dataOff: number,
	recDataSize: number,
	objectId: number,
): { data: ArrayBuffer | SharedArrayBuffer | null; type: number } {
	let imgData: ArrayBuffer | SharedArrayBuffer | null = null;
	const imgType = view.getUint32(dataOff + 4, true);

	const IMG_TYPE_NAMES: Record<number, string> = { 1: 'Bitmap', 2: 'Metafile' };
	emfLog(
		`replayEmfPlusRecords: OBJECT Image id=${objectId}, imgType=${IMG_TYPE_NAMES[imgType] ?? `Unknown(${imgType})`}, recDataSize=${recDataSize}`,
	);

	if (imgType === 1 && recDataSize >= 28) {
		// EmfPlusBitmap.Type (BitmapDataType, [MS-EMFPLUS] 2.1.1.2):
		// BitmapDataTypePixel = 0x00000000, BitmapDataTypeCompressed = 0x00000001.
		// Measured against a real GDI+-recorded DrawImage of a PNG-backed
		// Bitmap: BitmapDataType is 1 (Compressed) there, and the pixel-shaped
		// fields (Width/Height/Stride/PixelFormat) are meaningless for that
		// layout. An earlier version of this parser had the two values
		// swapped (treating 1 as Pixel and an unspecified 2 as Compressed),
		// which fed compressed PNG/JPEG bytes into the raw-pixel decoder as if
		// they were an uncompressed pixel array, corrupting the image, while a
		// genuine BitmapDataTypePixel (0) image fell through both branches and
		// was silently dropped.
		const bmpType = view.getUint32(dataOff + 24, true);
		if (bmpType === 0) {
			const bmpW = view.getInt32(dataOff + 8, true);
			const bmpH = view.getInt32(dataOff + 12, true);
			const bmpStride = view.getInt32(dataOff + 16, true);
			const pixelFormat = view.getUint32(dataOff + 20, true);
			emfLog(
				`  Bitmap(Pixel): ${bmpW}×${bmpH}, stride=${bmpStride}, pixelFormat=0x${pixelFormat.toString(16).padStart(8, '0')}`,
			);
			const pixelStart = dataOff + 28;
			const absStride = Math.abs(bmpStride);
			if (
				bmpW > 0 &&
				bmpH > 0 &&
				bmpW <= 8192 &&
				bmpH <= 8192 &&
				pixelStart + absStride * bmpH <= view.byteLength
			) {
				const decoded = decodeEmfPlusBitmapPixels(
					view,
					pixelStart,
					bmpW,
					bmpH,
					bmpStride,
					pixelFormat,
				);
				if (decoded) {
					emfLog(`  Bitmap(Pixel): decoded successfully, size=${decoded.byteLength} bytes`);
					imgData = decoded;
				} else {
					emfWarn(`  Bitmap(Pixel): decodeEmfPlusBitmapPixels returned null`);
				}
			}
		} else if (bmpType === 1) {
			const imgStart = dataOff + 28;
			const imgLen = recDataSize - 28;
			emfLog(`  Bitmap(Compressed): imgLen=${imgLen}, imgStart=0x${imgStart.toString(16)}`);
			if (imgLen > 0 && imgStart + imgLen <= view.byteLength) {
				imgData = view.buffer.slice(
					view.byteOffset + imgStart,
					view.byteOffset + imgStart + imgLen,
				);
				if (imgData.byteLength >= 4) {
					const hdr = new Uint8Array(imgData, 0, 4);
					emfLog(
						`  Bitmap(Compressed): first 4 bytes = [${Array.from(hdr)
							.map((b) => b.toString(16).padStart(2, '0'))
							.join(' ')}]`,
					);
				}
			} else {
				emfWarn(`  Bitmap(Compressed): out of bounds or empty`);
			}
		} else {
			emfWarn(`  Bitmap: unrecognised BitmapDataType ${bmpType}`);
		}
	} else if (imgType === 2 && recDataSize >= 12) {
		const mfType = view.getUint32(dataOff + 8, true);
		const mfDataSize = view.getUint32(dataOff + 12, true);
		const MF_TYPE_NAMES: Record<number, string> = {
			1: 'WMF',
			2: 'WMF+Placeable',
			3: 'EMF',
			4: 'EMF+Only',
			5: 'EMF+Dual',
		};
		emfLog(
			`  Metafile: type=${MF_TYPE_NAMES[mfType] ?? `Unknown(${mfType})`}, mfDataSize=${mfDataSize}`,
		);
		const mfStart = dataOff + 16;
		if (mfDataSize > 0 && mfStart + mfDataSize <= view.byteLength) {
			imgData = view.buffer.slice(
				view.byteOffset + mfStart,
				view.byteOffset + mfStart + mfDataSize,
			);
			if (imgData.byteLength >= 4) {
				const hdr = new DataView(imgData);
				const firstRec = hdr.getUint32(0, true);
				emfLog(`  Metafile: first 4 bytes recType=${firstRec} (1=EMR_HEADER)`);
			}
		} else {
			emfWarn(
				`  Metafile: out of bounds or empty (mfStart=0x${mfStart.toString(16)}, mfDataSize=${mfDataSize}, viewLen=${view.byteLength})`,
			);
		}
	}

	return { data: imgData, type: imgType };
}

// ---------------------------------------------------------------------------
// Font object parser
// ---------------------------------------------------------------------------

export function parseEmfPlusFontObject(
	view: DataView,
	dataOff: number,
	recDataSize: number,
): EmfPlusObject | null {
	if (recDataSize < 28) {
		return null;
	}
	const emSize = view.getFloat32(dataOff + 4, true);
	const unit = view.getUint32(dataOff + 8, true);
	const styleFlags = view.getInt32(dataOff + 12, true);
	const nameLen = view.getUint32(dataOff + 20, true);
	let family = 'sans-serif';
	if (nameLen > 0 && dataOff + 24 + nameLen * 2 <= dataOff + recDataSize) {
		family = readUtf16LE(view, dataOff + 24, nameLen) || 'sans-serif';
	}
	return { kind: 'plus-font', emSize: emSize || 12, flags: styleFlags, family, unit };
}
