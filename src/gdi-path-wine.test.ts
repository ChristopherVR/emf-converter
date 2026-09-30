/**
 * GDI path geometry checked against Windows' own `GetPath` output.
 *
 * The expected point and type arrays are ported from Wine's conformance
 * tests, `dlls/gdi32/tests/path.c` (LGPL; only the numeric data is used):
 * `arcto_path` (`test_arcto`), `anglearc_path` (`test_anglearc`),
 * `rectangle_path` (`test_rectangle`), `roundrect_path` (`test_roundrect`),
 * `ellipse_path` (`test_ellipse`) and `all_funcs_path`
 * (`test_all_functions`). Those tests run on real Windows, so the arrays are
 * Windows' paths. Wine's own check (`ok_path`) allows each coordinate to be
 * off by 2 (the arrays were printed from one Windows machine; the fudge
 * covers other versions), while point counts and types must be exact. The
 * check here is exact throughout, except for the few points listed in
 * `OFF_BY_ONE`, which may be one unit off.
 *
 * Each case replays the same calls with the same DC state: the shapes go
 * through the EMF record handlers inside an `EMR_BEGINPATH` bracket (GDI's
 * `GM_ADVANCED` geometry, which is how Windows plays an EMF back), except
 * those Wine draws in the default `GM_COMPATIBLE` mode, whose box shapes go
 * through the WMF (compatible-mode) geometry instead (`wmfShapePath`): an
 * EMF records no graphics mode. The path's points are then read back the
 * way `GetPath` reports them: Beziers unflattened, device 28.4 points
 * rounded to whole logical units (every case ends in `MM_TEXT`).
 */

import { describe, it, expect } from 'vitest';
import nativeRoundrectPath from './__fixtures__/gdi/roundrect-path.json';

import {
	EMR_ANGLEARC,
	EMR_ARC,
	EMR_ARCTO,
	EMR_BEGINPATH,
	EMR_CHORD,
	EMR_CLOSEFIGURE,
	EMR_ELLIPSE,
	EMR_LINETO,
	EMR_MOVETOEX,
	EMR_PIE,
	EMR_POLYBEZIER,
	EMR_POLYBEZIERTO,
	EMR_POLYDRAW,
	EMR_POLYGON,
	EMR_POLYLINE,
	EMR_POLYLINETO,
	EMR_POLYPOLYGON,
	EMR_POLYPOLYLINE,
	EMR_RECTANGLE,
	EMR_ROUNDRECT,
} from './emf-constants';
import { handleEmfGdiShapeRecord } from './emf-gdi-draw-shapes';
import { handleEmfGdiPolyPathRecord } from './emf-gdi-poly-path-handlers';
import { fixPoint, type ArcKind } from './emf-gdi-raster-shapes';
import { defaultState, type EmfGdiReplayCtx } from './emf-types';
import { GdiRasterPath } from './gdi-raster';
import type { WmfPlayer } from './wmf-player';
import { wmfShapePath } from './wmf-shapes';

// ---------------------------------------------------------------------------
// A path-bracket DC
// ---------------------------------------------------------------------------

type Field = ['i', number] | ['f', number] | ['b', number];

/** A no-op Canvas context (the bracket's Canvas geometry is not checked here). */
function nullContext(): CanvasRenderingContext2D {
	const noop = () => undefined;
	return new Proxy({} as CanvasRenderingContext2D, { get: () => noop });
}

/**
 * A device context in a `BeginPath` bracket on a one-to-one device (device
 * pixel = canvas pixel, `MM_TEXT`), driven by GDI-style calls that are
 * turned into EMF records (or, in compatible mode, the WMF box geometry).
 */
class PathDc {
	readonly rCtx: EmfGdiReplayCtx;
	/** `GM_COMPATIBLE` (Wine's default for `GetDC`) or `GM_ADVANCED`. */
	compatible = true;

	constructor() {
		this.rCtx = {
			ctx: nullContext(),
			view: new DataView(new ArrayBuffer(8)),
			objectTable: new Map(),
			state: defaultState(),
			stateStack: [],
			inPath: false,
			windowOrg: { x: 0, y: 0 },
			windowExt: { cx: 1, cy: 1 },
			viewportOrg: { x: 0, y: 0 },
			viewportExt: { cx: 1, cy: 1 },
			useMappingMode: true,
			clipSaveDepth: 0,
			bounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
			canvasW: 1000,
			canvasH: 1000,
			sx: 1,
			sy: 1,
			pathCmds: [],
		};
		// The stock black pen: a cosmetic one-pixel pen at any scale.
		this.rCtx.state.penWidth = 0;
		this.record(EMR_BEGINPATH, []);
	}

	/** The compatible-mode player the WMF geometry takes. */
	private get player(): WmfPlayer {
		return { rCtx: this.rCtx, kx: 1, ky: 1 } as WmfPlayer;
	}

	private get path(): GdiRasterPath {
		this.rCtx.rasterPath ??= new GdiRasterPath();
		return this.rCtx.rasterPath;
	}

	/** Plays one EMF record whose body (after the 8-byte header) is `fields`. */
	record(type: number, fields: Field[]): void {
		const size = 8 + fields.length * 4 + 4;
		const view = new DataView(new ArrayBuffer(size));
		let o = 8;
		for (const [k, v] of fields) {
			if (k === 'i') {
				view.setInt32(o, v, true);
				o += 4;
			} else if (k === 'f') {
				view.setFloat32(o, v, true);
				o += 4;
			} else {
				view.setUint8(o, v);
				o += 1;
			}
		}
		this.rCtx.view = view;
		if (!handleEmfGdiShapeRecord(this.rCtx, type, 8, o) && !handleEmfGdiPolyPathRecord(this.rCtx, type, 0, 8, o)) {
			throw new Error(`unhandled record ${type}`);
		}
	}

	setArcDirection(clockwise: boolean): void {
		this.rCtx.state.arcDirection = clockwise ? 2 : 1;
	}

	/** `SetMapMode(MM_TEXT)` (true) or `SetMapMode(MM_ANISOTROPIC)` (false; keeps the extents). */
	setMapModeText(text: boolean): void {
		if (text) {
			this.rCtx.windowExt = { cx: 1, cy: 1 };
			this.rCtx.viewportExt = { cx: 1, cy: 1 };
		}
	}

	setViewportExt(cx: number, cy: number): void {
		this.rCtx.viewportExt = { cx, cy };
	}

	setWindowExt(cx: number, cy: number): void {
		this.rCtx.windowExt = { cx, cy };
	}

	moveTo(x: number, y: number): void {
		this.record(EMR_MOVETOEX, [
			['i', x],
			['i', y],
		]);
	}

	lineTo(x: number, y: number): void {
		this.record(EMR_LINETO, [
			['i', x],
			['i', y],
		]);
	}

	closeFigure(): void {
		this.record(EMR_CLOSEFIGURE, []);
	}

	private box(type: number, l: number, t: number, r: number, b: number, extra: number[] = []): void {
		this.record(type, [l, t, r, b, ...extra].map((v): Field => ['i', v]));
	}

	rectangle(l: number, t: number, r: number, b: number): void {
		if (this.compatible) {
			this.appendCompat(wmfShapePath.rectangle(this.player, l, t, r, b));
		} else {
			this.box(EMR_RECTANGLE, l, t, r, b);
		}
	}

	roundRect(l: number, t: number, r: number, b: number, w: number, h: number): void {
		if (this.compatible) {
			this.appendCompat(wmfShapePath.roundRect(this.player, l, t, r, b, w, h));
		} else {
			this.box(EMR_ROUNDRECT, l, t, r, b, [w, h]);
		}
	}

	ellipse(l: number, t: number, r: number, b: number): void {
		if (this.compatible) {
			this.appendCompat(wmfShapePath.ellipse(this.player, l, t, r, b));
		} else {
			this.box(EMR_ELLIPSE, l, t, r, b);
		}
	}

	private appendCompat(path: GdiRasterPath | null): void {
		if (path) {
			this.path.append(path);
		}
	}

	private arcFamily(kind: ArcKind, type: number, c: [number, number, number, number, number, number, number, number]): void {
		if (!this.compatible) {
			this.box(type, c[0], c[1], c[2], c[3], c.slice(4));
			return;
		}
		const { rCtx } = this;
		const from = kind === 'arcto' ? this.currentFix() : undefined;
		const end = wmfShapePath.arc(this.player, kind, ...c, this.path, from);
		if (kind === 'arcto' && end) {
			// ArcTo moves the current position to the arc's end.
			rCtx.state.curX = Math.floor(end[0] / 16);
			rCtx.state.curY = Math.floor(end[1] / 16);
			rCtx.curFix = { x: end[0], y: end[1], lx: rCtx.state.curX, ly: rCtx.state.curY };
		}
	}

	private currentFix(): [number, number] {
		const { rCtx } = this;
		const c = rCtx.curFix;
		if (c && c.lx === rCtx.state.curX && c.ly === rCtx.state.curY) {
			return [c.x, c.y];
		}
		return fixPoint(rCtx, rCtx.state.curX, rCtx.state.curY);
	}

	arc(...c: [number, number, number, number, number, number, number, number]): void {
		this.arcFamily('arc', EMR_ARC, c);
	}

	arcTo(...c: [number, number, number, number, number, number, number, number]): void {
		this.arcFamily('arcto', EMR_ARCTO, c);
	}

	chord(...c: [number, number, number, number, number, number, number, number]): void {
		this.arcFamily('chord', EMR_CHORD, c);
	}

	pie(...c: [number, number, number, number, number, number, number, number]): void {
		this.arcFamily('pie', EMR_PIE, c);
	}

	angleArc(x: number, y: number, radius: number, start: number, sweep: number): void {
		this.record(EMR_ANGLEARC, [
			['i', x],
			['i', y],
			['i', radius],
			['f', start],
			['f', sweep],
		]);
	}

	/** A Poly* record: bounds, count, points (`EMR_POLYLINE` layout). */
	poly(type: number, pts: number[]): void {
		this.record(type, [...bounds(), ['i', pts.length / 2], ...pts.map((v): Field => ['i', v])]);
	}

	/** `EMR_POLYPOLYLINE`/`EMR_POLYPOLYGON`: bounds, polygon count, point count, counts, points. */
	polyPoly(type: number, pts: number[], counts: number[]): void {
		const n = counts.reduce((a, b) => a + b, 0);
		this.record(type, [
			...bounds(),
			['i', counts.length],
			['i', n],
			...counts.map((v): Field => ['i', v]),
			...pts.slice(0, n * 2).map((v): Field => ['i', v]),
		]);
	}

	polyDraw(pts: number[], types: number[]): void {
		this.record(EMR_POLYDRAW, [
			...bounds(),
			['i', types.length],
			...pts.slice(0, types.length * 2).map((v): Field => ['i', v]),
			...types.map((v): Field => ['b', v]),
		]);
	}

	/**
	 * The path as `GetPath` returns it under `MM_TEXT` (device = logical):
	 * flat `[x, y, type, ...]` triples.
	 */
	getPath(): number[] {
		const { pts, types } = this.path.getPath;
		const out: number[] = [];
		for (let i = 0; i < types.length; i++) {
			out.push(Math.round(pts[2 * i] / 16), Math.round(pts[2 * i + 1] / 16), types[i]);
		}
		return out;
	}
}

function bounds(): Field[] {
	return [
		['i', 0],
		['i', 0],
		['i', 0],
		['i', 0],
	];
}

/** `PT_*` names for failure messages. */
function typeName(t: number): string {
	const base = ['?', '?', 'L', '?', 'B', '?', 'M'][t & ~1] ?? '?';
	return t & 1 ? `${base}|C` : base;
}

/**
 * Point-by-point comparison: the entries whose type or coordinates differ
 * (by more than one unit at the indices in `offByOne`), or that one path
 * has and the other lacks.
 */
function comparePath(actual: number[], expected: number[], offByOne: Set<number>): string[] {
	const mismatches: string[] = [];
	const show = (p: number[]) => (p.length === 3 ? `${typeName(p[2])}(${p[0]},${p[1]})` : 'nothing');
	const n = Math.max(actual.length, expected.length) / 3;
	for (let i = 0; i < n; i++) {
		const a = actual.slice(3 * i, 3 * i + 3);
		const e = expected.slice(3 * i, 3 * i + 3);
		const d = a.length === 3 && e.length === 3 ? Math.max(Math.abs(a[0] - e[0]), Math.abs(a[1] - e[1])) : Infinity;
		if (a[2] !== e[2] || d > (offByOne.has(i) ? 1 : 0)) {
			mismatches.push(`#${i}: expected ${show(e)}, got ${show(a)}`);
		}
	}
	return mismatches;
}

// ---------------------------------------------------------------------------
// Expected paths: Wine dlls/gdi32/tests/path.c (Windows GetPath output).
// Flat [x, y, type] triples; PT_MOVETO 6, PT_LINETO 2, PT_BEZIERTO 4,
// PT_CLOSEFIGURE 1.
// ---------------------------------------------------------------------------

/** `arcto_path` (21 points). */
const arctoPath = [
	0, 0, 6, 229, 215, 2, 248, 205, 4, 273, 200, 4, 300, 200, 4, 355, 200, 4, 399, 222, 4, 399, 250, 4,
	399, 263, 4, 389, 275, 4, 370, 285, 4, 363, 277, 2, 380, 270, 4, 389, 260, 4, 389, 250, 4, 389, 228, 4,
	349, 210, 4, 300, 210, 4, 276, 210, 4, 253, 214, 4, 236, 222, 5,
];

/** `anglearc_path` (21 points). */
const anglearcPath = [
	0, 0, 6, 371, 229, 2, 352, 211, 4, 327, 200, 4, 300, 200, 4, 245, 200, 4, 200, 245, 4, 200, 300, 4,
	200, 300, 4, 200, 300, 4, 200, 300, 4, 231, 260, 2, 245, 235, 4, 271, 220, 4, 300, 220, 4, 344, 220, 4,
	380, 256, 4, 380, 300, 4, 380, 314, 4, 376, 328, 4, 369, 340, 5,
];

/** `rectangle_path` (100 points). */
const rectanglePath = [
	39, 20, 6, 20, 20, 2, 20, 39, 2, 39, 39, 3, 54, 35, 6, 30, 35, 2, 30, 49, 2, 54, 49, 3,
	59, 45, 6, 35, 45, 2, 35, 59, 2, 59, 59, 3, 80, 80, 6, 80, 80, 2, 80, 80, 2, 80, 80, 3,
	39, 39, 6, 20, 39, 2, 20, 20, 2, 39, 20, 3, 54, 49, 6, 30, 49, 2, 30, 35, 2, 54, 35, 3,
	59, 59, 6, 35, 59, 2, 35, 45, 2, 59, 45, 3, 80, 80, 6, 80, 80, 2, 80, 80, 2, 80, 80, 3,
	-41, 40, 6, -80, 40, 2, -80, 79, 2, -41, 79, 3, -61, 70, 6, -110, 70, 2, -110, 99, 2, -61, 99, 3,
	119, -120, 6, 60, -120, 2, 60, -61, 2, 119, -61, 3, 164, -150, 6, 90, -150, 2, 90, -106, 2, 164, -106, 3,
	-4, -6, 6, -6, -6, 2, -6, -4, 2, -4, -4, 3, 40, 20, 6, 20, 20, 2, 20, 40, 2, 40, 40, 3,
	55, 35, 6, 30, 35, 2, 30, 50, 2, 55, 50, 3, 60, 45, 6, 35, 45, 2, 35, 60, 2, 60, 60, 3,
	70, 70, 6, 50, 70, 2, 50, 70, 2, 70, 70, 3, 75, 75, 6, 75, 75, 2, 75, 85, 2, 75, 85, 3,
	81, 80, 6, 80, 80, 2, 80, 81, 2, 81, 81, 3, 40, 40, 6, 20, 40, 2, 20, 20, 2, 40, 20, 3,
	55, 50, 6, 30, 50, 2, 30, 35, 2, 55, 35, 3, 60, 60, 6, 35, 60, 2, 35, 45, 2, 60, 45, 3,
	70, 70, 6, 50, 70, 2, 50, 70, 2, 70, 70, 3, 75, 85, 6, 75, 85, 2, 75, 75, 2, 75, 75, 3,
	81, 81, 6, 80, 81, 2, 80, 80, 2, 81, 80, 3,
];

/** `roundrect_path` (312 points). */
const roundrectPath = [
	39, 25, 6, 39, 22, 4, 37, 20, 4, 34, 20, 4, 25, 20, 2, 22, 20, 4, 20, 22, 4, 20, 25, 4,
	20, 34, 2, 20, 37, 4, 22, 39, 4, 25, 39, 4, 34, 39, 2, 37, 39, 4, 39, 37, 4, 39, 34, 5,
	54, 42, 6, 54, 38, 4, 49, 35, 4, 42, 35, 4, 42, 35, 2, 35, 35, 4, 30, 38, 4, 30, 42, 4,
	30, 42, 2, 30, 46, 4, 35, 49, 4, 42, 49, 4, 42, 49, 2, 49, 49, 4, 54, 46, 4, 54, 42, 5,
	59, 46, 6, 59, 45, 4, 58, 45, 4, 57, 45, 4, 37, 45, 2, 36, 45, 4, 35, 45, 4, 35, 46, 4,
	35, 58, 2, 35, 59, 4, 36, 59, 4, 37, 59, 4, 57, 59, 2, 58, 59, 4, 59, 59, 4, 59, 58, 5,
	80, 80, 6, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 2, 80, 80, 4, 80, 80, 4, 80, 80, 4,
	80, 80, 2, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 2, 80, 80, 4, 80, 80, 4, 80, 80, 5,
	94, 85, 6, 90, 85, 2, 90, 89, 2, 94, 89, 3, 39, 34, 6, 39, 37, 4, 37, 39, 4, 34, 39, 4,
	25, 39, 2, 22, 39, 4, 20, 37, 4, 20, 34, 4, 20, 25, 2, 20, 22, 4, 22, 20, 4, 25, 20, 4,
	34, 20, 2, 37, 20, 4, 39, 22, 4, 39, 25, 5, 54, 42, 6, 54, 46, 4, 49, 49, 4, 42, 49, 4,
	42, 49, 2, 35, 49, 4, 30, 46, 4, 30, 42, 4, 30, 42, 2, 30, 38, 4, 35, 35, 4, 42, 35, 4,
	42, 35, 2, 49, 35, 4, 54, 38, 4, 54, 42, 5, -41, 52, 6, -41, 45, 4, -47, 40, 4, -56, 40, 4,
	-65, 40, 2, -73, 40, 4, -80, 45, 4, -80, 52, 4, -80, 67, 2, -80, 74, 4, -73, 79, 4, -65, 79, 4,
	-56, 79, 2, -47, 79, 4, -41, 74, 4, -41, 67, 5, -61, 79, 6, -61, 74, 4, -64, 70, 4, -68, 70, 4,
	-103, 70, 2, -107, 70, 4, -110, 74, 4, -110, 79, 4, -110, 90, 2, -110, 95, 4, -107, 99, 4, -103, 99, 4,
	-68, 99, 2, -64, 99, 4, -61, 95, 4, -61, 90, 5, 119, -102, 6, 119, -112, 4, 109, -120, 4, 97, -120, 4,
	82, -120, 2, 70, -120, 4, 60, -112, 4, 60, -102, 4, 60, -79, 2, 60, -69, 4, 70, -61, 4, 82, -61, 4,
	97, -61, 2, 109, -61, 4, 119, -69, 4, 119, -79, 5, 164, -144, 6, 164, -147, 4, 162, -150, 4, 160, -150, 4,
	94, -150, 2, 92, -150, 4, 90, -147, 4, 90, -144, 4, 90, -112, 2, 90, -109, 4, 92, -106, 4, 94, -106, 4,
	160, -106, 2, 162, -106, 4, 164, -109, 4, 164, -112, 5, -4, -6, 6, -4, -6, 4, -4, -6, 4, -4, -6, 4,
	-6, -6, 2, -6, -6, 4, -6, -6, 4, -6, -6, 4, -6, -4, 2, -6, -4, 4, -6, -4, 4, -6, -4, 4,
	-4, -4, 2, -4, -4, 4, -4, -4, 4, -4, -4, 5, 40, 25, 6, 40, 22, 4, 38, 20, 4, 35, 20, 4,
	25, 20, 2, 22, 20, 4, 20, 22, 4, 20, 25, 4, 20, 35, 2, 20, 38, 4, 22, 40, 4, 25, 40, 4,
	35, 40, 2, 38, 40, 4, 40, 38, 4, 40, 35, 5, 55, 43, 6, 55, 38, 4, 49, 35, 4, 43, 35, 4,
	43, 35, 2, 36, 35, 4, 30, 38, 4, 30, 43, 4, 30, 43, 2, 30, 47, 4, 36, 50, 4, 43, 50, 4,
	43, 50, 2, 49, 50, 4, 55, 47, 4, 55, 43, 5, 60, 46, 6, 60, 46, 4, 59, 45, 4, 58, 45, 4,
	38, 45, 2, 36, 45, 4, 35, 46, 4, 35, 46, 4, 35, 59, 2, 35, 60, 4, 36, 60, 4, 38, 60, 4,
	58, 60, 2, 59, 60, 4, 60, 60, 4, 60, 59, 5, 70, 70, 6, 70, 70, 4, 70, 70, 4, 70, 70, 4,
	50, 70, 2, 50, 70, 4, 50, 70, 4, 50, 70, 4, 50, 70, 2, 50, 70, 4, 50, 70, 4, 50, 70, 4,
	70, 70, 2, 70, 70, 4, 70, 70, 4, 70, 70, 5, 75, 75, 6, 75, 75, 4, 75, 75, 4, 75, 75, 4,
	75, 75, 2, 75, 75, 4, 75, 75, 4, 75, 75, 4, 75, 85, 2, 75, 85, 4, 75, 85, 4, 75, 85, 4,
	75, 85, 2, 75, 85, 4, 75, 85, 4, 75, 85, 5, 81, 81, 6, 81, 80, 4, 81, 80, 4, 81, 80, 4,
	81, 80, 2, 80, 80, 4, 80, 80, 4, 80, 81, 4, 80, 81, 2, 80, 81, 4, 80, 81, 4, 81, 81, 4,
	81, 81, 2, 81, 81, 4, 81, 81, 4, 81, 81, 5, 95, 85, 6, 90, 85, 2, 90, 90, 2, 95, 90, 3,
	40, 35, 6, 40, 38, 4, 38, 40, 4, 35, 40, 4, 25, 40, 2, 22, 40, 4, 20, 38, 4, 20, 35, 4,
	20, 25, 2, 20, 22, 4, 22, 20, 4, 25, 20, 4, 35, 20, 2, 38, 20, 4, 40, 22, 4, 40, 25, 5,
	55, 43, 6, 55, 47, 4, 49, 50, 4, 43, 50, 4, 43, 50, 2, 36, 50, 4, 30, 47, 4, 30, 43, 4,
	30, 43, 2, 30, 38, 4, 36, 35, 4, 43, 35, 4, 43, 35, 2, 49, 35, 4, 55, 38, 4, 55, 43, 5,
];

/** `ellipse_path` (325 points). */
const ellipsePath = [
	39, 30, 6, 39, 24, 4, 35, 20, 4, 30, 20, 4, 24, 20, 4, 20, 24, 4, 20, 30, 4, 20, 35, 4,
	24, 39, 4, 30, 39, 4, 35, 39, 4, 39, 35, 4, 39, 30, 5, 54, 42, 6, 54, 38, 4, 49, 35, 4,
	42, 35, 4, 35, 35, 4, 30, 38, 4, 30, 42, 4, 30, 46, 4, 35, 49, 4, 42, 49, 4, 49, 49, 4,
	54, 46, 4, 54, 42, 5, 59, 52, 6, 59, 48, 4, 54, 45, 4, 47, 45, 4, 40, 45, 4, 35, 48, 4,
	35, 52, 4, 35, 56, 4, 40, 59, 4, 47, 59, 4, 54, 59, 4, 59, 56, 4, 59, 52, 5, 80, 80, 6,
	80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4,
	80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 5, 39, 30, 6, 39, 35, 4, 35, 39, 4, 30, 39, 4,
	24, 39, 4, 20, 35, 4, 20, 30, 4, 20, 24, 4, 24, 20, 4, 30, 20, 4, 35, 20, 4, 39, 24, 4,
	39, 30, 5, 54, 42, 6, 54, 46, 4, 49, 49, 4, 42, 49, 4, 35, 49, 4, 30, 46, 4, 30, 42, 4,
	30, 38, 4, 35, 35, 4, 42, 35, 4, 49, 35, 4, 54, 38, 4, 54, 42, 5, 59, 52, 6, 59, 56, 4,
	54, 59, 4, 47, 59, 4, 40, 59, 4, 35, 56, 4, 35, 52, 4, 35, 48, 4, 40, 45, 4, 47, 45, 4,
	54, 45, 4, 59, 48, 4, 59, 52, 5, 80, 80, 6, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4,
	80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 4, 80, 80, 5,
	-41, 60, 6, -41, 49, 4, -50, 40, 4, -60, 40, 4, -71, 40, 4, -80, 49, 4, -80, 60, 4, -80, 70, 4,
	-71, 79, 4, -60, 79, 4, -50, 79, 4, -41, 70, 4, -41, 60, 5, -61, 85, 6, -61, 77, 4, -72, 70, 4,
	-85, 70, 4, -99, 70, 4, -110, 77, 4, -110, 85, 4, -110, 93, 4, -99, 99, 4, -85, 99, 4, -72, 99, 4,
	-61, 93, 4, -61, 85, 5, 119, -90, 6, 119, -107, 4, 106, -120, 4, 90, -120, 4, 73, -120, 4, 60, -107, 4,
	60, -90, 4, 60, -74, 4, 73, -61, 4, 90, -61, 4, 106, -61, 4, 119, -74, 4, 119, -90, 5, 164, -128, 6,
	164, -140, 4, 147, -150, 4, 127, -150, 4, 107, -150, 4, 90, -140, 4, 90, -128, 4, 90, -116, 4, 107, -106, 4,
	127, -106, 4, 147, -106, 4, 164, -116, 4, 164, -128, 5, -4, -5, 6, -4, -5, 4, -4, -6, 4, -5, -6, 4,
	-6, -6, 4, -6, -5, 4, -6, -5, 4, -6, -4, 4, -6, -4, 4, -5, -4, 4, -4, -4, 4, -4, -4, 4,
	-4, -5, 5, 40, 30, 6, 40, 25, 4, 36, 20, 4, 30, 20, 4, 24, 20, 4, 20, 25, 4, 20, 30, 4,
	20, 36, 4, 24, 40, 4, 30, 40, 4, 36, 40, 4, 40, 36, 4, 40, 30, 5, 55, 43, 6, 55, 38, 4,
	49, 35, 4, 43, 35, 4, 36, 35, 4, 30, 38, 4, 30, 43, 4, 30, 47, 4, 36, 50, 4, 43, 50, 4,
	49, 50, 4, 55, 47, 4, 55, 43, 5, 60, 53, 6, 60, 48, 4, 54, 45, 4, 48, 45, 4, 41, 45, 4,
	35, 48, 4, 35, 53, 4, 35, 57, 4, 41, 60, 4, 48, 60, 4, 54, 60, 4, 60, 57, 4, 60, 53, 5,
	70, 70, 6, 70, 70, 4, 66, 70, 4, 60, 70, 4, 54, 70, 4, 50, 70, 4, 50, 70, 4, 50, 70, 4,
	54, 70, 4, 60, 70, 4, 66, 70, 4, 70, 70, 4, 70, 70, 5, 75, 80, 6, 75, 77, 4, 75, 75, 4,
	75, 75, 4, 75, 75, 4, 75, 77, 4, 75, 80, 4, 75, 83, 4, 75, 85, 4, 75, 85, 4, 75, 85, 4,
	75, 83, 4, 75, 80, 5, 81, 81, 6, 81, 80, 4, 81, 80, 4, 81, 80, 4, 80, 80, 4, 80, 80, 4,
	80, 81, 4, 80, 81, 4, 80, 81, 4, 81, 81, 4, 81, 81, 4, 81, 81, 4, 81, 81, 5, 40, 30, 6,
	40, 36, 4, 36, 40, 4, 30, 40, 4, 24, 40, 4, 20, 36, 4, 20, 30, 4, 20, 24, 4, 24, 20, 4,
	30, 20, 4, 36, 20, 4, 40, 24, 4, 40, 30, 5, 55, 43, 6, 55, 47, 4, 49, 50, 4, 43, 50, 4,
	36, 50, 4, 30, 47, 4, 30, 43, 4, 30, 38, 4, 36, 35, 4, 43, 35, 4, 49, 35, 4, 55, 38, 4,
	55, 43, 5, 60, 53, 6, 60, 57, 4, 54, 60, 4, 48, 60, 4, 41, 60, 4, 35, 57, 4, 35, 53, 4,
	35, 48, 4, 41, 45, 4, 48, 45, 4, 54, 45, 4, 60, 48, 4, 60, 53, 5, 70, 70, 6, 70, 70, 4,
	66, 70, 4, 60, 70, 4, 54, 70, 4, 50, 70, 4, 50, 70, 4, 50, 70, 4, 54, 70, 4, 60, 70, 4,
	66, 70, 4, 70, 70, 4, 70, 70, 5, 75, 80, 6, 75, 83, 4, 75, 85, 4, 75, 85, 4, 75, 85, 4,
	75, 83, 4, 75, 80, 4, 75, 77, 4, 75, 75, 4, 75, 75, 4, 75, 75, 4, 75, 77, 4, 75, 80, 5,
	81, 81, 6, 81, 81, 4, 81, 81, 4, 81, 81, 4, 80, 81, 4, 80, 81, 4, 80, 81, 4, 80, 80, 4,
	80, 80, 4, 81, 80, 4, 81, 80, 4, 81, 80, 4, 81, 81, 5,
];

/** `all_funcs_path` (141 points). */
const allFuncsPath = [
	0, 0, 6, 50, 150, 2, 50, 50, 6, 150, 150, 2, 150, 50, 2, 50, 50, 2, 37, 13, 2, 24, 13, 4,
	14, 23, 4, 14, 36, 4, 14, 49, 4, 24, 59, 4, 37, 59, 4, 37, 59, 4, 37, 59, 4, 37, 59, 4,
	10, 10, 6, 20, 10, 2, 10, 20, 2, 20, 20, 2, 36, 27, 6, 37, 26, 4, 38, 25, 4, 38, 25, 4,
	38, 23, 4, 34, 21, 4, 30, 21, 4, 27, 21, 4, 25, 21, 4, 24, 22, 4, 37, 59, 6, 10, 10, 2,
	20, 10, 2, 10, 20, 2, 20, 20, 2, 34, 26, 2, 35, 25, 4, 36, 25, 4, 36, 25, 4, 36, 24, 4,
	33, 23, 4, 30, 23, 4, 28, 23, 4, 26, 23, 4, 25, 23, 4, 10, 10, 6, 20, 10, 2, 10, 20, 2,
	20, 20, 2, 30, 30, 6, 40, 20, 2, 20, 30, 2, 30, 40, 2, 10, 50, 2, 45, 45, 6, 45, 45, 4,
	44, 46, 4, 43, 47, 5, 10, 10, 6, 20, 10, 2, 10, 20, 4, 20, 20, 4, 30, 30, 4, 40, 20, 2,
	20, 30, 3, 30, 40, 6, 10, 50, 2, 55, 55, 6, 54, 55, 4, 54, 56, 4, 54, 56, 4, 58, 61, 3,
	10, 10, 6, 20, 10, 2, 10, 20, 2, 20, 20, 2, 30, 30, 2, 40, 20, 2, 20, 30, 2, 30, 40, 2,
	10, 50, 3, 43, 49, 6, 43, 40, 4, 38, 33, 4, 33, 33, 4, 27, 33, 4, 22, 40, 4, 22, 49, 4,
	22, 58, 4, 27, 65, 4, 33, 65, 4, 38, 65, 4, 43, 58, 4, 43, 49, 5, 79, 70, 6, 60, 70, 2,
	60, 89, 2, 79, 89, 3, 199, 122, 6, 199, 110, 4, 191, 100, 4, 182, 100, 4, 117, 100, 2, 108, 100, 4,
	100, 110, 4, 100, 122, 4, 100, 177, 2, 100, 189, 4, 108, 199, 4, 117, 199, 4, 182, 199, 2, 191, 199, 4,
	199, 189, 4, 199, 177, 5, 10, 10, 6, 20, 10, 4, 10, 20, 4, 20, 20, 4, 30, 30, 4, 40, 20, 4,
	20, 30, 4, 10, 10, 6, 20, 10, 2, 10, 20, 2, 20, 20, 3, 30, 30, 6, 40, 20, 2, 20, 30, 2,
	30, 40, 2, 10, 50, 3, 10, 50, 6, 10, 10, 4, 20, 10, 4, 10, 20, 4, 20, 20, 4, 30, 30, 4,
	40, 20, 4, 20, 30, 4, 30, 40, 4, 10, 50, 4, 150, 150, 2,
];

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** The calls `test_rectangle`, `test_roundrect` and `test_ellipse` share, for one shape. */
function boxShapeSequence(dc: PathDc, shape: (l: number, t: number, r: number, b: number, i: number) => void, count: number): void {
	const boxes: Array<[number, number, number, number]> = [
		[20, 20, 40, 40],
		[30, 50, 55, 35],
		[60, 60, 35, 45],
		[70, 70, 50, 70],
		[75, 75, 75, 85],
		[80, 80, 81, 81],
		[90, 90, 95, 85],
	].slice(0, count) as Array<[number, number, number, number]>;
	const run = (n: number) => boxes.slice(0, n).forEach((b, i) => shape(...b, i));
	run(count);
	dc.setArcDirection(true);
	run(count === 7 ? 2 : count);
	dc.setArcDirection(false);
}

/** The Rectangle/RoundRect/Ellipse sequence of Wine's tests; `shape` gets the call index. */
function boxTest(shape: (dc: PathDc, l: number, t: number, r: number, b: number, call: number) => void, perRun: number): number[] {
	const dc = new PathDc();
	let call = 0;
	const draw = (l: number, t: number, r: number, b: number) => shape(dc, l, t, r, b, call++);
	boxShapeSequence(dc, draw, perRun);
	dc.setMapModeText(false);
	dc.setViewportExt(-2, 2);
	draw(20, 20, 40, 40);
	draw(30, 50, 55, 35);
	dc.setViewportExt(3, -3);
	draw(20, 20, 40, 40);
	draw(30, 50, 55, 35);
	dc.setWindowExt(-20, 20);
	draw(20, 20, 40, 40);
	draw(24, 22, 21, 20);
	dc.setMapModeText(true);
	dc.compatible = false;
	boxShapeSequence(dc, draw, perRun);
	return dc.getPath();
}

/** RoundRect corner sizes in call order (`test_roundrect`). */
const ROUNDRECT_CORNERS: Array<[number, number]> = [
	[10, 10], [-30, -30], [5, 2], [3, 5], [6, 4], [8, 9], [0, 7], [10, 10], [-30, -30],
	[15, 12], [7, 9], [15, 12], [3, 4], [2, 1], [4, 4],
	[10, 10], [-30, -30], [5, 2], [3, 5], [6, 4], [8, 9], [0, 7], [10, 10], [-30, -30],
];

const PT_MOVETO = 6;
const PT_LINETO = 2;
const PT_BEZIERTO = 4;
const PT_CLOSEFIGURE = 1;

const cases: Array<{ name: string; run: () => number[]; expected: number[] }> = [
	{
		name: 'test_arcto',
		expected: arctoPath,
		run: () => {
			const dc = new PathDc();
			dc.setArcDirection(true);
			dc.arcTo(200, 200, 400, 300, 200, 200, 400, 300);
			dc.setArcDirection(false);
			dc.arcTo(210, 210, 390, 290, 390, 290, 210, 210);
			dc.closeFigure();
			return dc.getPath();
		},
	},
	{
		name: 'test_anglearc',
		expected: anglearcPath,
		run: () => {
			const dc = new PathDc();
			dc.angleArc(300, 300, 100, 45, 135);
			dc.angleArc(300, 300, 80, 150, -180);
			dc.closeFigure();
			return dc.getPath();
		},
	},
	{
		name: 'test_rectangle',
		expected: rectanglePath,
		run: () => boxTest((dc, l, t, r, b) => dc.rectangle(l, t, r, b), 6),
	},
	{
		name: 'test_roundrect',
		expected: roundrectPath,
		run: () => boxTest((dc, l, t, r, b, i) => dc.roundRect(l, t, r, b, ...ROUNDRECT_CORNERS[i]), 7),
	},
	{
		name: 'test_ellipse',
		expected: ellipsePath,
		run: () => boxTest((dc, l, t, r, b) => dc.ellipse(l, t, r, b), 6),
	},
	{
		name: 'test_all_functions',
		expected: allFuncsPath,
		run: () => {
			const pts = [10, 10, 20, 10, 10, 20, 20, 20, 30, 30, 40, 20, 20, 30, 30, 40, 10, 50];
			const counts = [4, 5];
			const types = [
				PT_MOVETO, PT_LINETO, PT_BEZIERTO, PT_BEZIERTO, PT_BEZIERTO, PT_LINETO,
				PT_LINETO | PT_CLOSEFIGURE, PT_MOVETO, PT_LINETO,
			];
			const dc = new PathDc();
			dc.lineTo(50, 150);
			dc.moveTo(50, 50);
			dc.lineTo(150, 150);
			dc.lineTo(150, 50);
			dc.lineTo(50, 50);
			dc.angleArc(37, 36, 23, 90, 180);
			dc.poly(EMR_POLYLINE, pts.slice(0, 8));
			dc.arc(21, 21, 39, 29, 39, 29, 21, 21);
			dc.poly(EMR_POLYLINETO, pts.slice(0, 8));
			dc.arcTo(23, 23, 37, 27, 37, 27, 23, 23);
			dc.polyPoly(EMR_POLYPOLYLINE, pts, counts);
			dc.chord(42, 43, 57, 66, 39, 29, 21, 21);
			dc.polyDraw(pts, types);
			dc.pie(52, 54, 65, 68, 39, 29, 21, 21);
			dc.poly(EMR_POLYGON, pts);
			dc.ellipse(22, 33, 44, 66);
			dc.rectangle(60, 70, 80, 90);
			dc.roundRect(100, 100, 200, 200, 35, 45);
			dc.poly(EMR_POLYBEZIER, pts.slice(0, 14));
			dc.polyPoly(EMR_POLYPOLYGON, pts, counts);
			dc.poly(EMR_POLYBEZIERTO, pts);
			dc.lineTo(150, 150);
			return dc.getPath();
		},
	},
];

/**
 * Points still one unit off Windows (all within Wine's own 2-unit fudge):
 * two vertical and two horizontal Bezier controls of `GM_COMPATIBLE`
 * RoundRect corners (`RoundRect(60, 60, 35, 45, 5, 2)`, and
 * `RoundRect(20, 20, 40, 40, 15, 12)` under a (-2, 2) viewport extent),
 * where no single rounding rule fits every case in the data.
 */
const OFF_BY_ONE: Record<string, number[]> = {
	test_roundrect: [33, 38, 102, 113],
};

describe('GDI path geometry against Windows (Wine gdi32/tests/path.c)', () => {
	it('confirms the historical RoundRect reference on current Windows', () => {
		const c = cases.find(c => c.name === 'test_roundrect')!;
		expect(nativeRoundrectPath).toEqual(c.expected);
		expect(comparePath(c.run(), nativeRoundrectPath, new Set(OFF_BY_ONE[c.name]))).toEqual([]);
	});
	for (const c of cases) {
		it(`${c.name}: the same points and types as GetPath`, () => {
			expect(comparePath(c.run(), c.expected, new Set(OFF_BY_ONE[c.name] ?? []))).toEqual([]);
		});
	}
});
