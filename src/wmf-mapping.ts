/**
 * WMF playback mapping: the DC's map mode, window and viewport as GDI keeps
 * them while it plays a metafile, and the playback "device" the converter
 * reproduces.
 *
 * The device. A WMF carries no device of its own; Windows paints it through
 * whatever DC it is played on. The converter plays it the way a
 * placeable-aware player (OLE, Office, GDI+) does: onto a surface of the
 * picture's own size, in `MM_ANISOTROPIC` with the window on the picture's
 * logical rectangle and the viewport on the surface.
 *   - A placeable (Aldus) file names that rectangle: its header bounds, at
 *     `inch` logical units per inch, so the surface is
 *     `bounds * 96 / inch` pixels (the 96 dpi reference device).
 *   - A non-placeable file is played as a `CF_METAFILEPICT` player plays
 *     it: the viewport is the file's own window extent in pixels (one
 *     logical unit per pixel), or the viewport extent it sets itself in
 *     `MM_ISOTROPIC`/`MM_ANISOTROPIC`.
 * Every record the file then plays (`META_SETMAPMODE`, window and viewport
 * origins and extents, their offsets and scales) changes that state exactly
 * as it changes a real DC's ({@link WmfMapping}), and
 * {@link applyWmfMapping} hands the result to the shared EMF machinery as
 * its window/viewport mapping, scaled from device pixels to canvas pixels.
 *
 * The metric map modes (`MM_LOMETRIC` .. `MM_TWIPS`) are defined by GDI
 * through the device's physical size (`HORZSIZE`/`HORZRES`); the converter's
 * device is the 96 dpi reference device, 25.4 mm to 96 pixels.
 *
 * @module wmf-mapping
 */

import type { EmfGdiReplayCtx, WmfHeader } from './emf-types';

/** `MM_TEXT`: one logical unit is one device pixel, y down. */
export const MM_TEXT = 1;
/** `MM_LOMETRIC`: 0.1 mm, y up. */
export const MM_LOMETRIC = 2;
/** `MM_HIMETRIC`: 0.01 mm, y up. */
export const MM_HIMETRIC = 3;
/** `MM_LOENGLISH`: 0.01 inch, y up. */
export const MM_LOENGLISH = 4;
/** `MM_HIENGLISH`: 0.001 inch, y up. */
export const MM_HIENGLISH = 5;
/** `MM_TWIPS`: 1/1440 inch, y up. */
export const MM_TWIPS = 6;
/** `MM_ISOTROPIC`: window and viewport set by the file, equal units on both axes. */
export const MM_ISOTROPIC = 7;
/** `MM_ANISOTROPIC`: window and viewport set by the file. */
export const MM_ANISOTROPIC = 8;

/** Reference-device pixels per inch. */
const DEVICE_DPI = 96;

/** The mapping state of a DC (device units are playback-device pixels). */
export interface WmfMapping {
	mode: number;
	winOrg: { x: number; y: number };
	winExt: { cx: number; cy: number };
	vpOrg: { x: number; y: number };
	vpExt: { cx: number; cy: number };
}

/** An independent copy of `m` (for `META_SAVEDC`). */
export function cloneMapping(m: WmfMapping): WmfMapping {
	return {
		mode: m.mode,
		winOrg: { ...m.winOrg },
		winExt: { ...m.winExt },
		vpOrg: { ...m.vpOrg },
		vpExt: { ...m.vpExt },
	};
}

/** Logical units per inch of each metric map mode (`MM_LOMETRIC` .. `MM_TWIPS`). */
const METRIC_UNITS_PER_INCH: Record<number, number> = {
	[MM_LOMETRIC]: 254,
	[MM_HIMETRIC]: 2540,
	[MM_LOENGLISH]: 100,
	[MM_HIENGLISH]: 1000,
	[MM_TWIPS]: 1440,
};

/**
 * GDI's `MM_ISOTROPIC` adjustment: after any extent changes, the viewport
 * extent is shrunk on the axis with the larger scale so a logical unit
 * spans the same distance on both axes (square device pixels), rounded to
 * the nearest integer and never zero.
 */
function fixIsotropic(m: WmfMapping): void {
	if (m.mode !== MM_ISOTROPIC || !m.winExt.cx || !m.winExt.cy) {
		return;
	}
	const xdim = Math.abs(m.vpExt.cx / m.winExt.cx);
	const ydim = Math.abs(m.vpExt.cy / m.winExt.cy);
	if (xdim > ydim) {
		const min = m.vpExt.cx >= 0 ? 1 : -1;
		m.vpExt.cx = Math.floor((m.vpExt.cx * ydim) / xdim + 0.5) || min;
	} else if (ydim > xdim) {
		const min = m.vpExt.cy >= 0 ? 1 : -1;
		m.vpExt.cy = Math.floor((m.vpExt.cy * xdim) / ydim + 0.5) || min;
	}
}

/** `META_SETMAPMODE`: the metric modes and `MM_TEXT` reset both extents; the isotropic mode starts from `MM_LOMETRIC`'s. */
export function setMapMode(m: WmfMapping, mode: number): void {
	if (mode < MM_TEXT || mode > MM_ANISOTROPIC) {
		return;
	}
	const units = METRIC_UNITS_PER_INCH[mode === MM_ISOTROPIC ? MM_LOMETRIC : mode];
	if (mode === MM_TEXT) {
		m.winExt = { cx: 1, cy: 1 };
		m.vpExt = { cx: 1, cy: 1 };
	} else if (units !== undefined && (mode !== MM_ISOTROPIC || m.mode !== MM_ISOTROPIC)) {
		m.winExt = { cx: units, cy: units };
		m.vpExt = { cx: DEVICE_DPI, cy: -DEVICE_DPI };
	}
	m.mode = mode;
}

/** True when the window and viewport extents may be set (`MM_ISOTROPIC`/`MM_ANISOTROPIC`). */
function extentsSettable(m: WmfMapping): boolean {
	return m.mode === MM_ISOTROPIC || m.mode === MM_ANISOTROPIC;
}

/** `META_SETWINDOWEXT` (ignored outside the scalable modes, or for a zero extent). */
export function setWindowExt(m: WmfMapping, cx: number, cy: number): void {
	if (!extentsSettable(m) || cx === 0 || cy === 0) {
		return;
	}
	m.winExt = { cx, cy };
	fixIsotropic(m);
}

/** `META_SETVIEWPORTEXT` (ignored outside the scalable modes, or for a zero extent). */
export function setViewportExt(m: WmfMapping, cx: number, cy: number): void {
	if (!extentsSettable(m) || cx === 0 || cy === 0) {
		return;
	}
	m.vpExt = { cx, cy };
	fixIsotropic(m);
}

/** `ScaleWindowExtEx` / `ScaleViewportExtEx`: `ext * num / den`, truncated, on each axis. */
function scaled(v: number, num: number, den: number): number {
	return Math.trunc((v * num) / den);
}

/** `META_SCALEWINDOWEXT`. */
export function scaleWindowExt(m: WmfMapping, xNum: number, xDen: number, yNum: number, yDen: number): void {
	if (!extentsSettable(m) || !xDen || !yDen) {
		return;
	}
	const cx = scaled(m.winExt.cx, xNum, xDen);
	const cy = scaled(m.winExt.cy, yNum, yDen);
	if (cx === 0 || cy === 0) {
		return;
	}
	m.winExt = { cx, cy };
	fixIsotropic(m);
}

/** `META_SCALEVIEWPORTEXT`. */
export function scaleViewportExt(m: WmfMapping, xNum: number, xDen: number, yNum: number, yDen: number): void {
	if (!extentsSettable(m) || !xDen || !yDen) {
		return;
	}
	const cx = scaled(m.vpExt.cx, xNum, xDen);
	const cy = scaled(m.vpExt.cy, yNum, yDen);
	if (cx === 0 || cy === 0) {
		return;
	}
	m.vpExt = { cx, cy };
	fixIsotropic(m);
}

/**
 * Hands mapping `m` to the shared GDI replay context: its window/viewport
 * mapping (always active) with the viewport scaled from playback-device
 * pixels to canvas pixels (`kx`, `ky`: canvas pixels per device pixel).
 */
export function applyWmfMapping(rCtx: EmfGdiReplayCtx, m: WmfMapping, kx: number, ky: number): void {
	rCtx.useMappingMode = true;
	rCtx.windowOrg = { x: m.winOrg.x, y: m.winOrg.y };
	rCtx.windowExt = { cx: m.winExt.cx || 1, cy: m.winExt.cy || 1 };
	rCtx.viewportOrg = { x: m.vpOrg.x * kx, y: m.vpOrg.y * ky };
	rCtx.viewportExt = { cx: (m.vpExt.cx || 1) * kx, cy: (m.vpExt.cy || 1) * ky };
}

/** How a WMF is played: the playback surface's size and the DC's mapping before the first record. */
export interface WmfPlayback {
	/** Playback-device width in pixels (the output's size at `dpiScale` 1). */
	width: number;
	/** Playback-device height in pixels. */
	height: number;
	/** The mapping the player sets up before playing the records. */
	mapping: WmfMapping;
}

/** The first value of each mapping record in a non-placeable file (see {@link wmfPlayback}). */
function scanMappingRecords(view: DataView, start: number): {
	mode: number | null;
	winExt: { cx: number; cy: number } | null;
	vpExt: { cx: number; cy: number } | null;
} {
	const out = {
		mode: null as number | null,
		winExt: null as { cx: number; cy: number } | null,
		vpExt: null as { cx: number; cy: number } | null,
	};
	let off = start;
	let guard = 0;
	while (off + 6 <= view.byteLength && guard++ < 1_000_000) {
		const size = view.getUint32(off, true) * 2;
		const type = view.getUint16(off + 4, true);
		if (size < 6 || off + size > view.byteLength || type === 0) {
			break;
		}
		const d = off + 6;
		if (type === 0x0103 && size >= 8 && out.mode === null) {
			out.mode = view.getUint16(d, true);
		} else if (type === 0x020c && size >= 10 && !out.winExt) {
			out.winExt = { cy: view.getInt16(d, true), cx: view.getInt16(d + 2, true) };
		} else if (type === 0x020e && size >= 10 && !out.vpExt) {
			out.vpExt = { cy: view.getInt16(d, true), cx: view.getInt16(d + 2, true) };
		}
		off += size;
	}
	return out;
}

/**
 * The playback surface and the player's initial mapping for a WMF (see the
 * module doc). A header without the `placeable` flag (a hand-built one)
 * counts as placeable when it names bounds.
 */
export function wmfPlayback(view: DataView, header: WmfHeader): WmfPlayback {
	const bw = header.boundsRight - header.boundsLeft;
	const bh = header.boundsBottom - header.boundsTop;
	if (header.placeable !== false) {
		const inch = header.unitsPerInch > 0 ? header.unitsPerInch : DEVICE_DPI;
		const width = Math.max(1, Math.round((Math.abs(bw) * DEVICE_DPI) / inch));
		const height = Math.max(1, Math.round((Math.abs(bh) * DEVICE_DPI) / inch));
		return {
			width,
			height,
			mapping: {
				mode: MM_ANISOTROPIC,
				winOrg: { x: header.boundsLeft, y: header.boundsTop },
				winExt: { cx: bw || 1, cy: bh || 1 },
				vpOrg: { x: 0, y: 0 },
				vpExt: { cx: width, cy: height },
			},
		};
	}
	const scan = scanMappingRecords(view, header.headerSize);
	const scalable = scan.mode === MM_ISOTROPIC || scan.mode === MM_ANISOTROPIC;
	const ext = scalable && scan.vpExt ? scan.vpExt : scan.winExt;
	const width = ext ? Math.abs(ext.cx) : Math.abs(bw);
	const height = ext ? Math.abs(ext.cy) : Math.abs(bh);
	const w = Math.max(1, width || 1);
	const h = Math.max(1, height || 1);
	return {
		width: w,
		height: h,
		mapping: {
			mode: MM_ANISOTROPIC,
			winOrg: { x: 0, y: 0 },
			winExt: { cx: w, cy: h },
			vpOrg: { x: 0, y: 0 },
			vpExt: { cx: w, cy: h },
		},
	};
}
