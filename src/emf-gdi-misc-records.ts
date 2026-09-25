/**
 * EMF records that only set state the replay keeps for later records, or
 * that carry nothing a GDI drawing surface paints:
 *
 *   - EMR_SETTEXTJUSTIFICATION (120): the break extra / break count the next
 *     text records spread over their break characters (applied by
 *     `emf-gdi-draw-text.ts`).
 *   - EMR_SETMAPPERFLAGS (16): `ASPECT_FILTERING` restricts font mapping to
 *     faces designed for the device's aspect ratio. On a square-pixel
 *     device every face qualifies, so it changes nothing: Windows paints
 *     raster (Small Fonts, Terminal, System, MS Sans Serif, Courier) and
 *     TrueType text identically with and without it
 *     (`emfrec-text-mapperflags` vs `emfrec-text-mapperflags-off`).
 *   - EMR_SETCOLORADJUSTMENT (23): kept for the HALFTONE stretch mode
 *     (see `emf-gdi-stretch.ts`).
 *   - Informational and ICM/OpenGL/driver records with no effect on a GDI
 *     raster surface, consumed without a warning: colour spaces
 *     (EMR_CREATECOLORSPACE, EMR_SETCOLORSPACE, EMR_DELETECOLORSPACE,
 *     EMR_CREATECOLORSPACEW), ICM profiles and colour matching
 *     (EMR_SETICMPROFILEA/W, EMR_COLORMATCHTOTARGETW,
 *     EMR_COLORCORRECTPALETTE), OpenGL records (EMR_GLSRECORD,
 *     EMR_GLSBOUNDEDRECORD, EMR_PIXELFORMAT), printer-driver escapes
 *     (EMR_DRAWESCAPE, EMR_EXTESCAPE, EMR_NAMEDESCAPE) and font-driver
 *     hints (EMR_FORCEUFIMAPPING, EMR_SETLINKEDUFIS).
 *
 * @module emf-gdi-misc-records
 */

import {
	EMR_COLORCORRECTPALETTE,
	EMR_COLORMATCHTOTARGETW,
	EMR_CREATECOLORSPACE,
	EMR_CREATECOLORSPACEW,
	EMR_DELETECOLORSPACE,
	EMR_DRAWESCAPE,
	EMR_EXTESCAPE,
	EMR_FORCEUFIMAPPING,
	EMR_GLSBOUNDEDRECORD,
	EMR_GLSRECORD,
	EMR_NAMEDESCAPE,
	EMR_PIXELFORMAT,
	EMR_SETCOLORADJUSTMENT,
	EMR_SETCOLORSPACE,
	EMR_SETICMPROFILEA,
	EMR_SETICMPROFILEW,
	EMR_SETLINKEDUFIS,
	EMR_SETMAPPERFLAGS,
	EMR_SETTEXTJUSTIFICATION,
} from './emf-constants';
import { emfLog } from './emf-logging';
import type { EmfGdiReplayCtx } from './emf-types';

/** Record types consumed without any effect on the drawing (see the module doc). */
export const EMF_NO_EFFECT_RECORDS: ReadonlySet<number> = new Set([
	EMR_SETMAPPERFLAGS,
	EMR_CREATECOLORSPACE,
	EMR_SETCOLORSPACE,
	EMR_DELETECOLORSPACE,
	EMR_GLSRECORD,
	EMR_GLSBOUNDEDRECORD,
	EMR_PIXELFORMAT,
	EMR_DRAWESCAPE,
	EMR_EXTESCAPE,
	EMR_FORCEUFIMAPPING,
	EMR_NAMEDESCAPE,
	EMR_COLORCORRECTPALETTE,
	EMR_SETICMPROFILEA,
	EMR_SETICMPROFILEW,
	EMR_SETLINKEDUFIS,
	EMR_COLORMATCHTOTARGETW,
	EMR_CREATECOLORSPACEW,
]);

/** Handles the records above; returns false for any other record type. */
export function handleEmfGdiMiscRecord(rCtx: EmfGdiReplayCtx, recType: number, dataOff: number, recSize: number): boolean {
	const { view, state } = rCtx;
	switch (recType) {
		case EMR_SETTEXTJUSTIFICATION: {
			if (recSize >= 16) {
				const extra = view.getInt32(dataOff, true);
				const count = view.getInt32(dataOff + 4, true);
				state.textJustification = extra !== 0 && count > 0 ? { extra, count } : undefined;
			}
			return true;
		}
		case EMR_SETCOLORADJUSTMENT: {
			if (recSize >= 32) {
				state.colorAdjustment = {
					flags: view.getUint16(dataOff + 2, true),
					illuminant: view.getUint16(dataOff + 4, true),
					redGamma: view.getUint16(dataOff + 6, true),
					greenGamma: view.getUint16(dataOff + 8, true),
					blueGamma: view.getUint16(dataOff + 10, true),
					referenceBlack: view.getUint16(dataOff + 12, true),
					referenceWhite: view.getUint16(dataOff + 14, true),
					contrast: view.getInt16(dataOff + 16, true),
					brightness: view.getInt16(dataOff + 18, true),
					colorfulness: view.getInt16(dataOff + 20, true),
					redGreenTint: view.getInt16(dataOff + 22, true),
				};
			}
			return true;
		}
		default:
			if (EMF_NO_EFFECT_RECORDS.has(recType)) {
				emfLog(`EMF record ${recType} consumed (no effect on a raster surface)`);
				return true;
			}
			return false;
	}
}
