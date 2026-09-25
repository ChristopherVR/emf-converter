/**
 * EMF+ record stream replay: main loop.
 *
 * Iterates over EMF+ records embedded inside EMR_COMMENT records and
 * dispatches to the appropriate handler modules.
 */

import {
	EMFPLUS_HEADER,
	EMFPLUS_ENDOFFILE,
	EMFPLUS_CLEAR,
	EMFPLUS_GETDC,
	EMFPLUS_OBJECT,
	EMFPLUS_MULTIFORMATSTART,
	EMFPLUS_MULTIFORMATSECTION,
	EMFPLUS_MULTIFORMATEND,
	MAX_RECORDS_EMFPLUS_DEFAULT,
} from './emf-constants';
import { argbToRgba } from './emf-color-helpers';
import { emfLog } from './emf-logging';
import { createContinuationAccumulator, feedEmfPlusObjectRecord } from './emf-plus-continuation';
import { handleEmfPlusCurveRecord } from './emf-plus-curve-handlers';
import { handleEmfPlusDrawRecord } from './emf-plus-draw-handlers';
import { handleEmfPlusObjectRecord } from './emf-plus-object-parser';
import { handleEmfPlusStateRecord } from './emf-plus-state-handlers';
import { handleEmfPlusTextImageRecord } from './emf-plus-text-image-handlers';
import type {
	CanvasContext,
	DeferredImageDraw,
	EmfPlusReplayCtx,
	EmfPlusState,
	EmfPlusTextureCache,
} from './emf-types';
import { createEmfPlusState } from './emf-types';

// ---------------------------------------------------------------------------
// Record-name lookup (debug logging only)
// ---------------------------------------------------------------------------

const EMFPLUS_REC_NAMES: Record<number, string> = {
	0x4001: 'Header',
	0x4005: 'MultiFormatStart',
	0x4006: 'MultiFormatSection',
	0x4007: 'MultiFormatEnd',
	0x4002: 'EndOfFile',
	0x4004: 'GetDC',
	0x4008: 'Object',
	0x4009: 'Clear',
	0x400a: 'FillRects',
	0x400b: 'DrawRects',
	0x400c: 'FillPolygon',
	0x400d: 'DrawLines',
	0x400e: 'FillEllipse',
	0x400f: 'DrawEllipse',
	0x4010: 'FillPie',
	0x4011: 'DrawPie',
	0x4012: 'DrawArc',
	0x4013: 'FillRegion',
	0x4016: 'FillClosedCurve',
	0x4017: 'DrawClosedCurve',
	0x4018: 'DrawCurve',
	0x4019: 'DrawBeziers',
	0x4014: 'FillPath',
	0x4015: 'DrawPath',
	0x401a: 'DrawImage',
	0x401b: 'DrawImagePoints',
	0x401c: 'DrawString',
	0x4036: 'DrawDriverString',
	0x401d: 'SetRenderingOrigin',
	0x401e: 'SetAntiAliasMode',
	0x401f: 'SetTextRenderingHint',
	0x4020: 'SetTextContrast',
	0x4021: 'SetInterpolationMode',
	0x4022: 'SetPixelOffsetMode',
	0x4023: 'SetCompositingMode',
	0x4024: 'SetCompositingQuality',
	0x4027: 'BeginContainer',
	0x402d: 'TranslateWorldTransform',
	0x402e: 'ScaleWorldTransform',
	0x402f: 'RotateWorldTransform',
	0x4037: 'StrokeFillPath',
	0x4038: 'SerializableObject',
	0x4039: 'SetTSGraphics',
	0x403a: 'SetTSClip',
	0x402a: 'SetWorldTransform',
	0x402b: 'ResetWorldTransform',
	0x402c: 'MultiplyWorldTransform',
	0x4030: 'SetPageTransform',
	0x4031: 'ResetClip',
	0x4032: 'SetClipRect',
	0x4033: 'SetClipPath',
	0x4034: 'SetClipRegion',
	0x4035: 'OffsetClip',
	0x4025: 'Save',
	0x4026: 'Restore',
	0x4028: 'BeginContainerNoParams',
	0x4029: 'EndContainer',
};

// ---------------------------------------------------------------------------
// MultiFormat
// ---------------------------------------------------------------------------

/**
 * EmfPlusMultiFormatStart, as GDI+ plays it (MS-EMFPLUS only says the
 * MultiFormat records are reserved; read from gdiplus.dll and confirmed on
 * `gpx-rec-multiformat-*`): the data is a count followed by that many
 * 32-bit format ids, and a record with fewer than 8 bytes, or fewer than
 * 4 + 4 * count, is ignored. A well-formed one makes GDI+ pick the section
 * to play and stop playing until MultiFormatSection reaches it, but the
 * Section and End records are themselves dispatched only while playing,
 * so in practice nothing after the Start is ever played again, in this
 * EMR_COMMENT or any later one.
 */
function handleMultiFormatStart(rCtx: EmfPlusReplayCtx, dataOff: number, dataSize: number): void {
	if (dataSize < 8) {
		return;
	}
	const count = rCtx.view.getUint32(dataOff, true);
	if (dataSize < 4 + 4 * count) {
		return;
	}
	(rCtx.ext ?? (rCtx.ext = {})).multiFormatSkip = true;
	emfLog('MultiFormatStart: GDI+ plays no further EMF+ record');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function replayEmfPlusRecords(
	view: DataView,
	offset: number,
	length: number,
	ctx: CanvasContext,
	canvasW: number,
	canvasH: number,
	state?: EmfPlusState,
	dpiScale: number = 1,
	maxRecords: number = MAX_RECORDS_EMFPLUS_DEFAULT,
	fontFamilyMap?: Record<string, string>,
	textureCache?: EmfPlusTextureCache,
	fonts?: import('./gdi-font-engine').GdiFontCollection,
): DeferredImageDraw[] {
	const s = state ?? createEmfPlusState();
	const rCtx: EmfPlusReplayCtx = {
		ctx,
		view,
		objectTable: s.objectTable,
		worldTransform: s.worldTransform,
		deferredImages: [],
		saveStack: s.saveStack,
		saveIdMap: s.saveIdMap,
		totalImageObjects: 0,
		totalDrawImageCalls: 0,
		clipSaveDepth: s.clipSaveDepth,
		clipRegion: s.clipRegion,
		pageUnit: s.pageUnit ?? 2,
		pageScale: s.pageScale ?? 1,
		...(s.continuation ?? createContinuationAccumulator()),
		dpiScale,
		canvasW,
		canvasH,
		fontFamilyMap,
		textureCache,
		interpolationMode: s.interpolationMode,
		pixelOffsetMode: s.pixelOffsetMode,
		textRenderingHint: s.textRenderingHint,
		fonts,
		baseTransform: s.baseTransform,
		imageCache: s.imageCache,
		nestingDepth: s.nestingDepth,
		gdiAntialias: s.gdiAntialias,
		antiAlias: s.antiAlias,
		ext: s.ext ?? (s.ext = {}),
	};

	const end = offset + length;
	let recordCount = 0;
	const emfPlusRecordTypes = new Map<number, number>();

	emfLog(`replayEmfPlusRecords: offset=0x${offset.toString(16)}, length=${length}`);

	while (offset + 12 <= end && recordCount < maxRecords) {
		const recType = view.getUint16(offset, true);
		const recFlags = view.getUint16(offset + 2, true);
		const recSize = view.getUint32(offset + 4, true);
		const recDataSize = view.getUint32(offset + 8, true);

		if (recSize < 12 || offset + recSize > end) {
			break;
		}
		recordCount++;
		emfPlusRecordTypes.set(recType, (emfPlusRecordTypes.get(recType) ?? 0) + 1);

		const dataOff = offset + 12;

		// After a well-formed MultiFormatStart GDI+ plays no further EMF+
		// record, MultiFormatSection and MultiFormatEnd included (their
		// dispatch sits behind the same switch), so the rest of the file is
		// skipped (see handleMultiFormatStart).
		if (rCtx.ext?.multiFormatSkip && recType !== EMFPLUS_ENDOFFILE) {
			offset += recSize;
			continue;
		}

		switch (recType) {
			case EMFPLUS_HEADER: {
				if (recDataSize >= 16) {
					const dpiX = view.getFloat32(dataOff + 8, true);
					const dpiY = view.getFloat32(dataOff + 12, true);
					emfLog(`replayEmfPlusRecords: HEADER dpiX=${dpiX}, dpiY=${dpiY}`);
				}
				void recDataSize;
				break;
			}

			case EMFPLUS_ENDOFFILE:
				offset = end;
				continue;

			case EMFPLUS_GETDC:
				break;

			case EMFPLUS_MULTIFORMATSTART:
				handleMultiFormatStart(rCtx, dataOff, recDataSize);
				break;

			// Without a preceding MultiFormatStart these do nothing in GDI+.
			case EMFPLUS_MULTIFORMATSECTION:
			case EMFPLUS_MULTIFORMATEND:
				break;

			case EMFPLUS_CLEAR: {
				// Graphics.Clear: every pixel inside the clip becomes the colour,
				// replacing (not blending with) what was there.
				if (recDataSize >= 4) {
					const argb = view.getUint32(dataOff, true);
					ctx.save();
					ctx.setTransform(1, 0, 0, 1, 0, 0);
					ctx.globalAlpha = 1;
					ctx.globalCompositeOperation = 'source-over';
					if (argb >>> 24 !== 0xff) {
						ctx.clearRect(0, 0, canvasW, canvasH);
					}
					ctx.fillStyle = argbToRgba(argb);
					ctx.fillRect(0, 0, canvasW, canvasH);
					ctx.restore();
				}
				break;
			}

			case EMFPLUS_OBJECT: {
				// Continuation runs are reassembled by the same code the texture
				// pre-decode pass uses, so a pre-decoded texture's cache key
				// (cacheKey) matches here.
				const assembled = feedEmfPlusObjectRecord(rCtx, view, recFlags, dataOff, recDataSize);
				if (assembled) {
					handleEmfPlusObjectRecord(
						assembled.view === view ? rCtx : { ...rCtx, view: assembled.view },
						assembled.flags,
						assembled.dataOff,
						assembled.dataSize,
						assembled.cacheKey,
					);
				}
				break;
			}

			default: {
				const handled =
					handleEmfPlusDrawRecord(rCtx, recType, recFlags, dataOff, recDataSize) ||
					handleEmfPlusCurveRecord(rCtx, recType, recFlags, dataOff, recDataSize) ||
					handleEmfPlusTextImageRecord(rCtx, recType, recFlags, dataOff, recDataSize) ||
					handleEmfPlusStateRecord(rCtx, recType, recFlags, dataOff, recDataSize);
				if (!handled) {
					console.warn(`[emf-converter] Unhandled EMF+ record type: 0x${recType.toString(16)}`);
				}
				break;
			}
		}

		offset += recSize;
	}

	if (recordCount >= maxRecords) {
		console.warn(
			`[emf-converter] EMF+ record limit reached (${maxRecords}). Output may be incomplete.`,
		);
	}

	// Log summary
	const summary: string[] = [];
	for (const [type, cnt] of emfPlusRecordTypes) {
		summary.push(`${EMFPLUS_REC_NAMES[type] ?? `0x${type.toString(16)}`}:${cnt}`);
	}
	emfLog(`replayEmfPlusRecords: ${recordCount} records processed: ${summary.join(', ')}`);
	emfLog(
		`replayEmfPlusRecords: totalImageObjects=${rCtx.totalImageObjects}, totalDrawImageCalls=${rCtx.totalDrawImageCalls}, deferredImages=${rCtx.deferredImages.length}`,
	);
	emfLog(
		`replayEmfPlusRecords: object table has ${rCtx.objectTable.size} entries: [${Array.from(
			rCtx.objectTable.entries(),
		)
			.map(([id, obj]) => `${id}:${obj.kind}`)
			.join(', ')}]`,
	);

	// Persist state for next EMR_COMMENT continuation
	if (state) {
		state.worldTransform = rCtx.worldTransform;
		state.saveIdMap = rCtx.saveIdMap;
		state.clipRegion = rCtx.clipRegion ?? null;
		state.clipSaveDepth = rCtx.clipSaveDepth;
		state.continuation = {
			continuationBuffer: rCtx.continuationBuffer,
			continuationObjectId: rCtx.continuationObjectId,
			continuationObjectType: rCtx.continuationObjectType,
			continuationTotalSize: rCtx.continuationTotalSize,
			continuationOffset: rCtx.continuationOffset,
			continuationKey: rCtx.continuationKey,
		};
		state.interpolationMode = rCtx.interpolationMode;
		state.pixelOffsetMode = rCtx.pixelOffsetMode;
		state.textRenderingHint = rCtx.textRenderingHint;
		state.pageUnit = rCtx.pageUnit;
		state.pageScale = rCtx.pageScale;
		state.antiAlias = rCtx.antiAlias;
	}

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	return rCtx.deferredImages;
}
