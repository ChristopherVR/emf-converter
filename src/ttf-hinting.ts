/**
 * TrueType bytecode interpreter: grid-fits (hints) a glyph outline at a
 * given ppem the way Windows GDI's font scaler does before scan conversion.
 *
 * GDI never rasterises a TrueType outline as designed: it scales it to the
 * requested ppem and then runs the font's own instructions (`fpgm` once,
 * `prep` per size, then the glyph program) which move the points onto the
 * pixel grid. At text sizes that is what decides every stem width, x-height
 * and overshoot, so an unhinted outline (what a browser's canvas draws)
 * differs from GDI's glyph bitmap by whole pixels. This module implements
 * the full instruction set with the semantics of the "v35" (pre-ClearType,
 * black-and-white) Microsoft rasterizer as documented by the TrueType
 * specification and as reproduced by FreeType's v35 interpreter, including
 * the undocumented behaviours both agree on (twilight-zone handling in
 * MIAP/MIRP/MSIRP/MDRP/IP, SHZ not moving phantom points, `MPS` returning
 * 12 under GDI, the control-value cut-in only applying within one zone).
 *
 * All coordinates are integers: points in 26.6 fixed point, vectors in
 * 2.14, scales in 16.16, with FreeType's fixed-point rounding
 * (`FT_MulDiv`, `FT_DivFix`, `TT_DotFix14`) except where GDI measurably
 * differs: coordinates scale with a round-half-up `MulFix` (FreeType
 * rounds halves away from zero), and IUP interpolates with one `MulDiv` on
 * font units (FreeType goes through a 16.16 ratio). Measured against
 * `GetGlyphOutline(GGO_NATIVE)` (GDI's own grid-fitted outline) for Arial,
 * Times New Roman, Courier New, Segoe UI and Tahoma at 18 sizes from 8 to
 * 72 px: 81.5% of glyph outlines are identical point for point (99.2% of
 * those whose programs use only axis-aligned vectors); the rest differ by
 * 1/64 pixel at a few points, mostly on diagonal strokes grid-fitted along
 * SDPVTL vectors, where the Microsoft rasterizer's internal arithmetic is
 * not documented.
 *
 * A font program that fails (stack underflow, unknown opcode, runaway loop)
 * stops executing and keeps the points where they are, like GDI and like
 * FreeType's non-pedantic mode.
 *
 * @module ttf-hinting
 */

import {
	ARGS_ARE_XY_VALUES,
	ROUND_XY_TO_GRID,
	USE_MY_METRICS,
	WE_HAVE_A_SCALE,
	WE_HAVE_AN_X_AND_Y_SCALE,
	WE_HAVE_A_TWO_BY_TWO,
	type TtfFont,
} from './ttf-font';

// ---------------------------------------------------------------------------
// Fixed-point helpers (FreeType-compatible rounding)
// ---------------------------------------------------------------------------

/**
 * 16.16 fixed-point multiply, (a * b) / 65536 rounded half up (an
 * arithmetic shift after adding 0x8000). This is the rounding GDI's scaler
 * applies; FreeType's `FT_MulFix` rounds halves away from zero instead,
 * which puts every negative coordinate that scales to an exact half 1/64
 * pixel lower/further left than Windows does (measured against
 * `GetGlyphOutline(GGO_NATIVE)`).
 */
export function mulFix(a: number, b: number): number {
	return Math.floor((a * b + 0x8000) / 65536);
}

/** `FT_MulDiv`: (a * b) / c, rounded half away from zero. */
export function mulDiv(a: number, b: number, c: number): number {
	let s = 1;
	if (a < 0) {
		a = -a;
		s = -s;
	}
	if (b < 0) {
		b = -b;
		s = -s;
	}
	if (c < 0) {
		c = -c;
		s = -s;
	}
	const d = c > 0 ? Math.floor((a * b + Math.floor(c / 2)) / c) : 0x7fffffff;
	return s < 0 ? -d : d;
}

/** `FT_MulDiv_No_Round`: (a * b) / c, truncated toward zero. */
function mulDivNoRound(a: number, b: number, c: number): number {
	let s = 1;
	if (a < 0) {
		a = -a;
		s = -s;
	}
	if (b < 0) {
		b = -b;
		s = -s;
	}
	if (c < 0) {
		c = -c;
		s = -s;
	}
	const d = c > 0 ? Math.floor((a * b) / c) : 0x7fffffff;
	return s < 0 ? -d : d;
}

/** `FT_DivFix`: (a * 65536) / b, rounded half away from zero. */
export function divFix(a: number, b: number): number {
	let s = 1;
	if (a < 0) {
		a = -a;
		s = -s;
	}
	if (b < 0) {
		b = -b;
		s = -s;
	}
	const q = b === 0 ? 0x7fffffff : Math.floor((a * 65536 + Math.floor(b / 2)) / b);
	return s < 0 ? -q : q;
}

/** `TT_DotFix14`: (ax * bx + ay * by) / 2^14, rounded. */
function dotFix14(ax: number, ay: number, bx: number, by: number): number {
	const t = ax * bx + ay * by;
	return Math.floor((t + 0x2000 + (t < 0 ? -1 : 0)) / 16384);
}

/** `TT_MulFix14`: (a * b) / 2^14, rounded. */
function mulFix14(a: number, b: number): number {
	const t = a * b;
	return Math.floor((t + 0x2000 + (t < 0 ? -1 : 0)) / 16384);
}

const floor64 = (x: number): number => Math.floor(x / 64) * 64;
const round64 = (x: number): number => floor64(x + 32);
const ceil64 = (x: number): number => floor64(x + 63);

// ---------------------------------------------------------------------------
// Zones and graphics state
// ---------------------------------------------------------------------------

/** Point flags. */
const ON_CURVE = 1;
const TOUCH_X = 8;
const TOUCH_Y = 16;

/** A glyph or twilight zone. Coordinates are 26.6 (orus: font units). */
export class Zone {
	n: number;
	orusX: Float64Array;
	orusY: Float64Array;
	orgX: Float64Array;
	orgY: Float64Array;
	curX: Float64Array;
	curY: Float64Array;
	tags: Uint8Array;
	endPts: number[];

	constructor(n: number, endPts: number[] = []) {
		this.n = n;
		this.orusX = new Float64Array(n);
		this.orusY = new Float64Array(n);
		this.orgX = new Float64Array(n);
		this.orgY = new Float64Array(n);
		this.curX = new Float64Array(n);
		this.curY = new Float64Array(n);
		this.tags = new Uint8Array(n);
		this.endPts = endPts;
	}

	clone(): Zone {
		const z = new Zone(this.n, this.endPts.slice());
		z.orusX.set(this.orusX);
		z.orusY.set(this.orusY);
		z.orgX.set(this.orgX);
		z.orgY.set(this.orgY);
		z.curX.set(this.curX);
		z.curY.set(this.curY);
		z.tags.set(this.tags);
		return z;
	}
}

interface GraphicsState {
	rp0: number;
	rp1: number;
	rp2: number;
	pvx: number;
	pvy: number;
	fvx: number;
	fvy: number;
	dvx: number;
	dvy: number;
	loop: number;
	minDist: number;
	roundState: number;
	autoFlip: boolean;
	cvtCutIn: number;
	swCutIn: number;
	swValue: number;
	deltaBase: number;
	deltaShift: number;
	instructControl: number;
	scanControl: boolean;
	scanType: number;
	gep0: number;
	gep1: number;
	gep2: number;
	period: number;
	phase: number;
	threshold: number;
}

function defaultGS(): GraphicsState {
	return {
		rp0: 0,
		rp1: 0,
		rp2: 0,
		pvx: 0x4000,
		pvy: 0,
		fvx: 0x4000,
		fvy: 0,
		dvx: 0x4000,
		dvy: 0,
		loop: 1,
		minDist: 64,
		roundState: 1,
		autoFlip: true,
		cvtCutIn: 68,
		swCutIn: 0,
		swValue: 0,
		deltaBase: 9,
		deltaShift: 3,
		instructControl: 0,
		scanControl: false,
		scanType: 0,
		gep0: 1,
		gep1: 1,
		gep2: 1,
		period: 64,
		phase: 0,
		threshold: 32,
	};
}

interface FuncDef {
	code: Uint8Array;
	start: number;
	end: number;
}

class HintError extends Error {}

// ---------------------------------------------------------------------------
// Rasterizer environment
// ---------------------------------------------------------------------------

/** What the glyph programs can observe about the rasterizer (GETINFO). */
export interface HintEnvironment {
	/** Rasterizer version GETINFO reports (selector bit 0). */
	version: number;
	/** Grayscale rendering (GETINFO selector bit 5 → result bit 12). */
	grayscale: boolean;
	/**
	 * The glyph is drawn rotated (GETINFO selector bit 1 → result bit 8,
	 * and SCANCTRL's rotation conditions). Fonts typically switch most of
	 * their grid-fitting off for rotated text.
	 */
	rotated?: boolean;
	/**
	 * ClearType rendering, with the Microsoft rasterizer's ClearType
	 * interpreter behaviour in the x ("ClearType") direction: rounding on a
	 * 1/16-pixel virtual grid, CVT cut-in at 1/16 and minimum distance at
	 * 1/2, and, unless the font opts out with INSTCTRL selector 3, the
	 * backward-compatibility rules (x-direction DELTAP/SHPIX skipped,
	 * CVT cut-in on unrounded MIRP and MSIRP, physical rounding in prep and
	 * for RDTG after SPVTL, legacy TypeMan Talk functions bypassed). GETINFO
	 * reports ClearType (bit 13) and compatible widths (bit 14).
	 */
	clearType?: boolean;
	/** ClearType with compatible (bi-level) advance widths: GETINFO bit 14. Default true under ClearType. */
	compatibleWidths?: boolean;
	/** Symmetric (vertically smoothed) ClearType: GETINFO bit 15. */
	symmetricSmoothing?: boolean;
}

/** One grid-fitted glyph, ready for scan conversion. */
export interface HintedGlyph {
	/** Point coordinates in 26.6 device units, y up, origin at the pen position. */
	xs: Float64Array;
	ys: Float64Array;
	/** On-curve flag per point. */
	onCurve: Uint8Array;
	/** Last point index of each contour. */
	endPts: number[];
	/** Hinted advance width (26.6). */
	advance: number;
	/** Linearly scaled (unhinted) advance width (26.6). */
	linearAdvance: number;
	/** SCANCTRL outcome: whether dropout control is on for this glyph. */
	scanControl: boolean;
	/** SCANTYPE mode. */
	scanType: number;
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

const MAX_INSTRUCTIONS = 1_000_000;

/**
 * A font realised at one ppem: runs `fpgm` and `prep` once, then hints
 * glyphs on demand. `ppemX`/`ppemY` differ only for a horizontally
 * stretched or condensed font (LOGFONT `lfWidth`).
 */
export class HintedSize {
	readonly font: TtfFont;
	readonly ppem: number;
	readonly xScale: number;
	readonly yScale: number;
	private readonly scale: number;
	private readonly xRatio: number;
	private readonly yRatio: number;
	private readonly stretched: boolean;
	private readonly env: HintEnvironment;
	private readonly hinting: boolean;
	// State after fpgm + prep (copied for each glyph).
	private cvt0: Float64Array;
	private storage0: Float64Array;
	private twilight0: Zone;
	private gs0: GraphicsState;
	private fdefs: (FuncDef | undefined)[] = [];
	private idefs = new Map<number, FuncDef>();
	private prepOk = true;

	// Execution state.
	private stack: number[] = [];
	private gs: GraphicsState = defaultGS();
	private cvt!: Float64Array;
	private storage!: Float64Array;
	private twilight!: Zone;
	private pts!: Zone;
	private zp0!: Zone;
	private zp1!: Zone;
	private zp2!: Zone;
	private fDotP = 0x4000;
	private inPrep = false;
	/** The projection vector was set by SPVTL (for the ClearType RDTG exception). */
	private pvFromSpvtl = false;
	/** Active function-call frames (for the ClearType legacy-function signatures). */
	private callFrames: Array<{ def: FuncDef }> = [];
	/** The glyph program being run belongs to a composite glyph. */
	private inComposite = false;
	private count = 0;

	constructor(font: TtfFont, ppemX: number, ppemY: number, env: HintEnvironment, hinting = true) {
		this.font = font;
		this.env = env;
		this.hinting = hinting;
		const upem = font.unitsPerEm;
		this.xScale = divFix(ppemX * 64, upem);
		this.yScale = divFix(ppemY * 64, upem);
		if (ppemX >= ppemY) {
			this.ppem = ppemX;
			this.scale = this.xScale;
			this.xRatio = 0x10000;
			this.yRatio = divFix(ppemY, ppemX);
		} else {
			this.ppem = ppemY;
			this.scale = this.yScale;
			this.xRatio = divFix(ppemX, ppemY);
			this.yRatio = 0x10000;
		}
		this.stretched = ppemX !== ppemY;
		this.cvt0 = new Float64Array(font.cvt.length);
		for (let i = 0; i < font.cvt.length; i++) {
			this.cvt0[i] = mulFix(font.cvt[i], this.scale);
		}
		this.storage0 = new Float64Array(font.maxStorage);
		this.twilight0 = new Zone(font.maxTwilightPoints + 4);
		this.gs0 = defaultGS();
		if (hinting) {
			this.runSetup();
		}
	}

	/** Runs fpgm then prep and records the post-prep state every glyph starts from. */
	private runSetup(): void {
		this.cvt = this.cvt0;
		this.storage = this.storage0;
		this.twilight = this.twilight0;
		this.pts = new Zone(0);
		this.zp0 = this.zp1 = this.zp2 = this.pts;
		this.gs = defaultGS();
		this.computeFuncs();
		try {
			this.execute(this.font.fpgm);
		} catch {
			this.prepOk = false;
		}
		this.gs = defaultGS();
		this.computeFuncs();
		this.inPrep = true;
		this.zp0 = this.zp1 = this.zp2 = this.pts;
		try {
			this.execute(this.font.prep);
		} catch {
			// Keep whatever prep achieved (non-pedantic behaviour).
		}
		this.inPrep = false;
		// The MS rasterizer doesn't let prep change these for the glyph programs.
		const gs = this.gs;
		gs.pvx = gs.fvx = gs.dvx = 0x4000;
		gs.pvy = gs.fvy = gs.dvy = 0;
		gs.rp0 = gs.rp1 = gs.rp2 = 0;
		gs.gep0 = gs.gep1 = gs.gep2 = 1;
		gs.loop = 1;
		this.gs0 = { ...gs };
	}

	/** Whether glyph programs are allowed to run at this size (INSTCTRL bit 0). */
	get glyphHinting(): boolean {
		return this.hinting && this.prepOk && (this.gs0.instructControl & 1) === 0;
	}

	/** The scan-conversion mode prep left, used when a glyph program doesn't set its own. */
	get defaultScan(): { scanControl: boolean; scanType: number } {
		return { scanControl: this.gs0.scanControl, scanType: this.gs0.scanType };
	}

	// -----------------------------------------------------------------------
	// Glyph loading
	// -----------------------------------------------------------------------

	/** Loads and grid-fits glyph `g`. Never throws. */
	hintGlyph(g: number): HintedGlyph {
		const { advance } = this.font.hMetrics(g);
		const res = this.loadRecursive(g, 0);
		const n = res.zone.n - 4;
		const pp1x = res.zone.curX[n];
		const pp2x = res.zone.curX[n + 1];
		const xs = new Float64Array(n);
		const ys = new Float64Array(n);
		const onCurve = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			xs[i] = res.zone.curX[i] - pp1x;
			ys[i] = res.zone.curY[i];
			onCurve[i] = res.zone.tags[i] & ON_CURVE;
		}
		return {
			xs,
			ys,
			onCurve,
			endPts: res.zone.endPts,
			advance: pp2x - pp1x,
			linearAdvance: mulFix(advance, this.xScale),
			scanControl: res.scanControl,
			scanType: res.scanType,
		};
	}

	/**
	 * Loads glyph `g` into a fresh zone (points + 4 phantom points), scaled
	 * and, when hinting is on, instructed. Composite glyphs are assembled
	 * from their hinted components and then run their own program.
	 */
	private loadRecursive(
		g: number,
		depth: number,
	): { zone: Zone; scanControl: boolean; scanType: number } {
		const font = this.font;
		const glyph = depth < 8 ? font.loadGlyph(g) : null;
		const { advance, lsb } = font.hMetrics(g);
		const xMin = glyph ? glyph.xMin : 0;
		const yMax = glyph ? glyph.yMax : 0;
		const pp1 = xMin - lsb;
		const typoAsc = font.typoAscender || font.hheaAscender;
		const typoDesc = font.typoDescender || font.hheaDescender;
		const phantomOrus = [
			[pp1, 0],
			[pp1 + advance, 0],
			[0, typoAsc],
			[0, typoDesc],
		];
		const scan = this.defaultScan;

		if (!glyph || (!glyph.components && glyph.endPts.length === 0)) {
			const zone = new Zone(4);
			for (let i = 0; i < 4; i++) {
				zone.orusX[i] = phantomOrus[i][0];
				zone.orusY[i] = phantomOrus[i][1];
				zone.orgX[i] = zone.curX[i] = mulFix(phantomOrus[i][0], this.xScale);
				zone.orgY[i] = zone.curY[i] = mulFix(phantomOrus[i][1], this.yScale);
			}
			if (this.hinting) {
				zone.curX[0] = round64(zone.curX[0]);
				zone.curX[1] = round64(zone.curX[1]);
				zone.curY[2] = round64(zone.curY[2]);
				zone.curY[3] = round64(zone.curY[3]);
			}
			return { zone, ...scan };
		}

		if (!glyph.components) {
			const n = glyph.xs.length;
			const zone = new Zone(n + 4, glyph.endPts.slice());
			for (let i = 0; i < n; i++) {
				zone.orusX[i] = glyph.xs[i];
				zone.orusY[i] = glyph.ys[i];
				zone.tags[i] = glyph.onCurve[i] ? ON_CURVE : 0;
			}
			for (let i = 0; i < 4; i++) {
				zone.orusX[n + i] = phantomOrus[i][0];
				zone.orusY[n + i] = phantomOrus[i][1];
			}
			for (let i = 0; i < n + 4; i++) {
				zone.orgX[i] = zone.curX[i] = mulFix(zone.orusX[i], this.xScale);
				zone.orgY[i] = zone.curY[i] = mulFix(zone.orusY[i], this.yScale);
			}
			return this.hintZone(zone, glyph.instructions);
		}

		// Composite: assemble hinted components.
		const parts: Zone[] = [];
		let total = 0;
		let metricsFrom: Zone | null = null;
		let lastScan = scan;
		for (const comp of glyph.components) {
			const sub = this.loadRecursive(comp.glyphIndex, depth + 1);
			lastScan = { scanControl: sub.scanControl, scanType: sub.scanType };
			const z = sub.zone;
			const m = z.n - 4;
			// Component transform (scale/2x2) applies to the scaled points.
			if (comp.flags & (WE_HAVE_A_SCALE | WE_HAVE_AN_X_AND_Y_SCALE | WE_HAVE_A_TWO_BY_TWO)) {
				for (let i = 0; i < z.n; i++) {
					const tx = (x: number, y: number): number => Math.round(x * comp.a + y * comp.c);
					const ty = (x: number, y: number): number => Math.round(x * comp.b + y * comp.d);
					let x = z.curX[i];
					let y = z.curY[i];
					z.curX[i] = tx(x, y);
					z.curY[i] = ty(x, y);
					x = z.orgX[i];
					y = z.orgY[i];
					z.orgX[i] = tx(x, y);
					z.orgY[i] = ty(x, y);
					x = z.orusX[i];
					y = z.orusY[i];
					z.orusX[i] = x * comp.a + y * comp.c;
					z.orusY[i] = x * comp.b + y * comp.d;
				}
			}
			let dx: number;
			let dy: number;
			let dxOrus = 0;
			let dyOrus = 0;
			if (comp.flags & ARGS_ARE_XY_VALUES) {
				dxOrus = comp.arg1;
				dyOrus = comp.arg2;
				dx = mulFix(comp.arg1, this.xScale);
				dy = mulFix(comp.arg2, this.yScale);
				if (this.hinting && comp.flags & ROUND_XY_TO_GRID) {
					dx = round64(dx);
					dy = round64(dy);
				}
			} else {
				// Point matching: move the component so its point arg2 lands on
				// the already-assembled point arg1.
				const p1 = comp.arg1;
				const p2 = comp.arg2;
				let px = 0;
				let py = 0;
				let seen = 0;
				for (const part of parts) {
					const pm = part.n;
					if (p1 < seen + pm) {
						px = part.curX[p1 - seen];
						py = part.curY[p1 - seen];
						break;
					}
					seen += pm;
				}
				dx = p2 < m ? px - z.curX[p2] : 0;
				dy = p2 < m ? py - z.curY[p2] : 0;
			}
			const part = new Zone(m, z.endPts.slice());
			for (let i = 0; i < m; i++) {
				part.orusX[i] = z.orusX[i] + dxOrus;
				part.orusY[i] = z.orusY[i] + dyOrus;
				part.orgX[i] = z.orgX[i] + dx;
				part.orgY[i] = z.orgY[i] + dy;
				part.curX[i] = z.curX[i] + dx;
				part.curY[i] = z.curY[i] + dy;
				part.tags[i] = z.tags[i] & ON_CURVE;
			}
			if (comp.flags & USE_MY_METRICS) {
				metricsFrom = z;
			}
			parts.push(part);
			total += m;
		}
		const zone = new Zone(total + 4);
		let at = 0;
		for (const part of parts) {
			zone.orusX.set(part.orusX, at);
			zone.orusY.set(part.orusY, at);
			zone.orgX.set(part.orgX, at);
			zone.orgY.set(part.orgY, at);
			zone.curX.set(part.curX, at);
			zone.curY.set(part.curY, at);
			zone.tags.set(part.tags, at);
			for (const e of part.endPts) {
				zone.endPts.push(e + at);
			}
			at += part.n;
		}
		for (let i = 0; i < 4; i++) {
			const k = total + i;
			if (metricsFrom) {
				const mk = metricsFrom.n - 4 + i;
				zone.orusX[k] = metricsFrom.orusX[mk];
				zone.orusY[k] = metricsFrom.orusY[mk];
				zone.orgX[k] = metricsFrom.orgX[mk];
				zone.orgY[k] = metricsFrom.orgY[mk];
				zone.curX[k] = metricsFrom.curX[mk];
				zone.curY[k] = metricsFrom.curY[mk];
			} else {
				zone.orusX[k] = phantomOrus[i][0];
				zone.orusY[k] = phantomOrus[i][1];
				zone.orgX[k] = zone.curX[k] = mulFix(phantomOrus[i][0], this.xScale);
				zone.orgY[k] = zone.curY[k] = mulFix(phantomOrus[i][1], this.yScale);
			}
		}
		if (glyph.instructions.length > 0 && this.glyphHinting) {
			// The composite's program sees the hinted components as its
			// "original" outline (FreeType: TT_Process_Composite_Glyph).
			zone.orgX.set(zone.curX);
			zone.orgY.set(zone.curY);
			this.inComposite = true;
			const hinted = this.hintZone(zone, glyph.instructions, !metricsFrom);
			this.inComposite = false;
			return hinted;
		}
		if (this.hinting && !metricsFrom) {
			zone.curX[total] = round64(zone.curX[total]);
			zone.curX[total + 1] = round64(zone.curX[total + 1]);
			zone.curY[total + 2] = round64(zone.curY[total + 2]);
			zone.curY[total + 3] = round64(zone.curY[total + 3]);
		}
		return { zone, ...lastScan };
	}

	/** Rounds the phantom points and runs a glyph program over `zone`. */
	private hintZone(
		zone: Zone,
		instructions: Uint8Array,
		roundPhantoms = true,
	): { zone: Zone; scanControl: boolean; scanType: number } {
		const n = zone.n;
		if (this.hinting && roundPhantoms) {
			// ClearType rounds the horizontal phantoms on its 1/16-pixel grid.
			const rx = this.env.clearType ? (v: number): number => Math.floor((v + 2) / 4) * 4 : round64;
			zone.curX[n - 4] = rx(zone.curX[n - 4]);
			zone.curX[n - 3] = rx(zone.curX[n - 3]);
			zone.curY[n - 2] = round64(zone.curY[n - 2]);
			zone.curY[n - 1] = round64(zone.curY[n - 1]);
		}
		if (!this.glyphHinting || instructions.length === 0) {
			return { zone, ...this.defaultScan };
		}
		this.gs = this.gs0.instructControl & 2 ? defaultGS() : { ...this.gs0 };
		this.cvt = this.cvt0.slice();
		this.storage = this.storage0.slice();
		this.twilight = this.twilight0.clone();
		this.pts = zone;
		this.zp0 = this.zp1 = this.zp2 = zone;
		this.stack = [];
		this.computeFuncs();
		try {
			this.execute(instructions);
		} catch {
			// Keep the partially hinted outline.
		}
		return { zone, scanControl: this.gs.scanControl, scanType: this.gs.scanType };
	}

	// -----------------------------------------------------------------------
	// Vector / projection machinery
	// -----------------------------------------------------------------------

	private computeFuncs(): void {
		const gs = this.gs;
		if (gs.fvx === 0x4000) {
			this.fDotP = gs.pvx;
		} else if (gs.fvy === 0x4000) {
			this.fDotP = gs.pvy;
		} else {
			this.fDotP = Math.floor((gs.pvx * gs.fvx + gs.pvy * gs.fvy) / 16384);
		}
		if (Math.abs(this.fDotP) < 0x400) {
			this.fDotP = 0x4000;
		}
	}

	private project(dx: number, dy: number): number {
		return dotFix14(dx, dy, this.gs.pvx, this.gs.pvy);
	}

	private dualProject(dx: number, dy: number): number {
		return dotFix14(dx, dy, this.gs.dvx, this.gs.dvy);
	}

	/** Dual projection of an orus (font unit) difference, scaled to 26.6. */
	private dualProjectOrus(dx: number, dy: number): number {
		if (this.xScale === this.yScale) {
			return mulFix(this.dualProject(dx, dy), this.xScale);
		}
		return this.dualProject(mulFix(dx, this.xScale), mulFix(dy, this.yScale));
	}

	private normalize(x: number, y: number): [number, number] {
		if (x === 0 && y === 0) {
			return [0x4000, 0];
		}
		const len = Math.hypot(x, y);
		return [Math.round((x / len) * 16384), Math.round((y / len) * 16384)];
	}

	private currentRatio(): number {
		if (!this.stretched) {
			return 0x10000;
		}
		const gs = this.gs;
		if (gs.pvy === 0) {
			return this.xRatio;
		}
		if (gs.pvx === 0) {
			return this.yRatio;
		}
		const x = mulDiv(gs.pvx, this.xRatio, 0x4000);
		const y = mulDiv(gs.pvy, this.yRatio, 0x4000);
		return Math.round(Math.hypot(x, y));
	}

	private currentPpem(): number {
		return this.stretched ? mulFix(this.ppem, this.currentRatio()) : this.ppem;
	}

	private readCvt(i: number): number {
		if (i < 0 || i >= this.cvt.length) {
			throw new HintError('cvt');
		}
		return this.stretched ? mulFix(this.cvt[i], this.currentRatio()) : this.cvt[i];
	}

	private writeCvt(i: number, v: number): void {
		if (i < 0 || i >= this.cvt.length) {
			return;
		}
		this.cvt[i] = this.stretched ? divFix(v, this.currentRatio()) : v;
	}

	private moveCvt(i: number, v: number): void {
		if (i < 0 || i >= this.cvt.length) {
			return;
		}
		this.cvt[i] += this.stretched ? divFix(v, this.currentRatio()) : v;
	}

	private move(zone: Zone, p: number, distance: number): void {
		const gs = this.gs;
		if (gs.fvx !== 0) {
			zone.curX[p] += this.moveAmt(distance, gs.fvx);
			zone.tags[p] |= TOUCH_X;
		}
		if (gs.fvy !== 0) {
			zone.curY[p] += this.moveAmt(distance, gs.fvy);
			zone.tags[p] |= TOUCH_Y;
		}
	}

	/** A projected distance converted to a move along one freedom-vector component. */
	private moveAmt(distance: number, f: number): number {
		return mulDiv(distance, f, this.fDotP);
	}

	private moveOrig(zone: Zone, p: number, distance: number): void {
		const gs = this.gs;
		if (gs.fvx !== 0) {
			zone.orgX[p] += mulDiv(distance, gs.fvx, this.fDotP);
		}
		if (gs.fvy !== 0) {
			zone.orgY[p] += mulDiv(distance, gs.fvy, this.fDotP);
		}
	}

	/**
	 * Backward-compatible ClearType reads storage 22 (TypeMan Talk
	 * DStroke/IStroke), 24 (spacing functions) and 8 (VacuFormRound) as 0
	 * inside the functions whose signatures Microsoft documents, which
	 * bypasses them.
	 */
	private ctBypassStorage(i: number): boolean {
		if (!this.ctCompat() || (i !== 22 && i !== 24 && i !== 8)) {
			return false;
		}
		const frame = this.callFrames[this.callFrames.length - 1];
		if (!frame) {
			return false;
		}
		const c = frame.def.code;
		const s = frame.def.start;
		const at = (bytes: number[]): boolean => bytes.every((b, k) => c[s + k] === b);
		if (i === 22) {
			return at([0xb0, 22, 0x43, 0x58]);
		}
		if (i === 24) {
			return at([0x01, 0xb0, 24, 0x43, 0x58]) || at([0x01, 0x18, 0xb0, 24, 0x43, 0x58]);
		}
		return at([0x45, 0x23, 0x46, 0x60, 0x20, 0xb0, 38]);
	}

	/** True when the projection vector points (mostly) along x, ClearType's direction. */
	private ctDirection(): boolean {
		const gs = this.gs;
		return !!this.env.clearType && Math.abs(gs.pvx) > Math.abs(gs.pvy);
	}

	/** Backward-compatible ClearType: ClearType on and the font has not set INSTCTRL selector 3. */
	private ctCompat(): boolean {
		return !!this.env.clearType && (this.gs0.instructControl & 4) === 0 && (this.gs.instructControl & 4) === 0;
	}

	/** CVT cut-in along the current projection (1/16 of it in the ClearType direction). */
	private cutIn(): number {
		return this.ctDirection() ? this.gs.cvtCutIn / 16 : this.gs.cvtCutIn;
	}

	/** Minimum distance along the current projection (halved in the ClearType direction). */
	private minDistance(): number {
		return this.ctDirection() ? Math.floor(this.gs.minDist / 2) : this.gs.minDist;
	}

	/**
	 * Rounds `d` per the round state. In the ClearType direction the grid
	 * is the 1/16-pixel virtual grid, except in prep and for RDTG after
	 * SPVTL, which round on the physical grid.
	 */
	private round(d: number, mode = this.gs.roundState): number {
		if (mode <= 5 && this.ctDirection() && !this.inPrep && !(mode === 3 && this.pvFromSpvtl)) {
			return this.roundPhysical(d * 16, mode) / 16;
		}
		return this.roundPhysical(d, mode);
	}

	private roundPhysical(d: number, mode = this.gs.roundState): number {
		const gs = this.gs;
		let v: number;
		switch (mode) {
			case 0: // half grid
				if (d >= 0) {
					v = floor64(d) + 32;
					if (v < 0) v = 32;
				} else {
					v = -(floor64(-d) + 32);
					if (v > 0) v = -32;
				}
				return v;
			case 1: // grid
				if (d >= 0) {
					v = round64(d);
					if (v < 0) v = 0;
				} else {
					v = -round64(-d);
					if (v > 0) v = 0;
				}
				return v;
			case 2: // double grid
				if (d >= 0) {
					v = Math.floor((d + 16) / 32) * 32;
					if (v < 0) v = 0;
				} else {
					v = -Math.floor((-d + 16) / 32) * 32;
					if (v > 0) v = 0;
				}
				return v;
			case 3: // down to grid
				if (d >= 0) {
					v = floor64(d);
					if (v < 0) v = 0;
				} else {
					v = -floor64(-d);
					if (v > 0) v = 0;
				}
				return v;
			case 4: // up to grid
				if (d >= 0) {
					v = ceil64(d);
					if (v < 0) v = 0;
				} else {
					v = -ceil64(-d);
					if (v > 0) v = 0;
				}
				return v;
			case 5: // off
				return d;
			case 6: // super
				if (d >= 0) {
					v = Math.floor((d - gs.phase + gs.threshold) / gs.period) * gs.period;
					v += gs.phase;
					if (v < 0) v = gs.phase;
				} else {
					v = -(Math.floor((gs.threshold - gs.phase - d) / gs.period) * gs.period);
					v -= gs.phase;
					if (v > 0) v = -gs.phase;
				}
				return v;
			case 7: // super 45
				if (d >= 0) {
					v = Math.trunc((d - gs.phase + gs.threshold) / gs.period) * gs.period;
					v += gs.phase;
					if (v < 0) v = gs.phase;
				} else {
					v = -(Math.trunc((gs.threshold - gs.phase - d) / gs.period) * gs.period);
					v -= gs.phase;
					if (v > 0) v = -gs.phase;
				}
				return v;
			default:
				return d;
		}
	}

	private setSuperRound(gridPeriod: number, selector: number): void {
		const gs = this.gs;
		let period: number;
		switch (selector & 0xc0) {
			case 0:
				period = Math.trunc(gridPeriod / 2);
				break;
			case 0x80:
				period = gridPeriod * 2;
				break;
			default:
				period = gridPeriod;
		}
		let phase: number;
		switch (selector & 0x30) {
			case 0:
				phase = 0;
				break;
			case 0x10:
				phase = Math.trunc(period / 4);
				break;
			case 0x20:
				phase = Math.trunc(period / 2);
				break;
			default:
				phase = Math.trunc((period * 3) / 4);
		}
		let threshold: number;
		if ((selector & 0x0f) === 0) {
			threshold = period - 1;
		} else {
			threshold = Math.trunc((((selector & 0x0f) - 4) * period) / 8);
		}
		// Convert from 2.14-scaled to 26.6 (arithmetic shift right by 8).
		gs.period = Math.floor(period / 256);
		gs.phase = Math.floor(phase / 256);
		gs.threshold = Math.floor(threshold / 256);
		if (gs.period === 0) {
			gs.period = 1;
		}
	}

	/** The zone a SZP* argument names, or null for an invalid one (ignored, as GDI does). */
	private zone(n: number): Zone | null {
		if (n === 0) {
			return this.twilight;
		}
		if (n === 1) {
			return this.pts;
		}
		return null;
	}

	// -----------------------------------------------------------------------
	// Execution loop
	// -----------------------------------------------------------------------

	private pop(): number {
		if (this.stack.length === 0) {
			throw new HintError('underflow');
		}
		return this.stack.pop()!;
	}

	private push(v: number): void {
		this.stack.push(v | 0);
	}

	/** Returns the length of the instruction at `ip` (for skipping). */
	private static insLength(code: Uint8Array, ip: number): number {
		const op = code[ip];
		if (op === 0x40) {
			return 2 + code[ip + 1];
		}
		if (op === 0x41) {
			return 2 + code[ip + 1] * 2;
		}
		if (op >= 0xb0 && op <= 0xb7) {
			return 2 + (op - 0xb0);
		}
		if (op >= 0xb8 && op <= 0xbf) {
			return 1 + (op - 0xb8 + 1) * 2;
		}
		return 1;
	}

	private execute(code: Uint8Array): void {
		interface Frame {
			code: Uint8Array;
			ip: number;
			def: FuncDef;
			count: number;
		}
		const calls: Frame[] = [];
		this.callFrames = calls;
		let ip = 0;
		let cur = code;
		while (true) {
			if (ip >= cur.length) {
				if (calls.length === 0) {
					return;
				}
				// Running off the end of a function without ENDF: abort.
				throw new HintError('eof');
			}
			if (++this.count > MAX_INSTRUCTIONS) {
				throw new HintError('too long');
			}
			const op = cur[ip];
			let next = ip + HintedSize.insLength(cur, ip);
			switch (op) {
				// ---- control flow handled inline ----
				case 0x58: {
					// IF
					const cond = this.pop();
					if (cond === 0) {
						let nIfs = 1;
						let p = next;
						while (p < cur.length) {
							const o = cur[p];
							if (o === 0x58) {
								nIfs++;
							} else if (o === 0x1b && nIfs === 1) {
								break;
							} else if (o === 0x59) {
								nIfs--;
								if (nIfs === 0) {
									break;
								}
							}
							p += HintedSize.insLength(cur, p);
						}
						next = p + 1;
					}
					break;
				}
				case 0x1b: {
					// ELSE: skip to matching EIF
					let nIfs = 1;
					let p = next;
					while (p < cur.length) {
						const o = cur[p];
						if (o === 0x58) {
							nIfs++;
						} else if (o === 0x59) {
							nIfs--;
							if (nIfs === 0) {
								break;
							}
						}
						p += HintedSize.insLength(cur, p);
					}
					next = p + 1;
					break;
				}
				case 0x59: // EIF
					break;
				case 0x1c: {
					// JMPR
					const off = this.pop();
					next = ip + off;
					if (off === 0 || next < 0) {
						throw new HintError('jmpr');
					}
					break;
				}
				case 0x78: {
					// JROT
					const e = this.pop();
					const off = this.pop();
					if (e !== 0) {
						next = ip + off;
						if (off === 0 || next < 0) {
							throw new HintError('jrot');
						}
					}
					break;
				}
				case 0x79: {
					// JROF
					const e = this.pop();
					const off = this.pop();
					if (e === 0) {
						next = ip + off;
						if (off === 0 || next < 0) {
							throw new HintError('jrof');
						}
					}
					break;
				}
				case 0x2c: {
					// FDEF
					const f = this.pop();
					let p = next;
					while (p < cur.length && cur[p] !== 0x2d) {
						if (cur[p] === 0x2c || cur[p] === 0x89) {
							throw new HintError('nested');
						}
						p += HintedSize.insLength(cur, p);
					}
					if (f < 0 || f > 0xffff) {
						throw new HintError('fdef');
					}
					this.fdefs[f] = { code: cur, start: next, end: p };
					next = p + 1;
					break;
				}
				case 0x89: {
					// IDEF
					const o = this.pop();
					let p = next;
					while (p < cur.length && cur[p] !== 0x2d) {
						p += HintedSize.insLength(cur, p);
					}
					this.idefs.set(o & 0xff, { code: cur, start: next, end: p });
					next = p + 1;
					break;
				}
				case 0x2d: {
					// ENDF
					const frame = calls.pop();
					if (!frame) {
						throw new HintError('endf');
					}
					frame.count--;
					if (frame.count > 0) {
						calls.push(frame);
						cur = frame.def.code;
						ip = frame.def.start;
						continue;
					}
					cur = frame.code;
					ip = frame.ip;
					continue;
				}
				case 0x2b: {
					// CALL
					const f = this.pop();
					const def = this.fdefs[f];
					if (!def) {
						throw new HintError('call');
					}
					if (calls.length > 64) {
						throw new HintError('depth');
					}
					calls.push({ code: cur, ip: next, def, count: 1 });
					cur = def.code;
					ip = def.start;
					continue;
				}
				case 0x2a: {
					// LOOPCALL
					const f = this.pop();
					const cnt = this.pop();
					const def = this.fdefs[f];
					if (!def) {
						throw new HintError('loopcall');
					}
					if (cnt > 0) {
						if (calls.length > 64) {
							throw new HintError('depth');
						}
						calls.push({ code: cur, ip: next, def, count: cnt });
						cur = def.code;
						ip = def.start;
						continue;
					}
					break;
				}
				default: {
					if (!this.step(op, cur, ip)) {
						const def = this.idefs.get(op);
						if (!def) {
							throw new HintError(`opcode ${op}`);
						}
						calls.push({ code: cur, ip: next, def, count: 1 });
						cur = def.code;
						ip = def.start;
						continue;
					}
				}
			}
			ip = next;
		}
	}

	/** Executes one non-flow-control instruction. Returns false for an undefined opcode. */
	private step(op: number, code: Uint8Array, ip: number): boolean {
		const gs = this.gs;
		if (op >= 0xc0) {
			if (op >= 0xe0) {
				this.insMIRP(op);
			} else {
				this.insMDRP(op);
			}
			return true;
		}
		if (op >= 0xb0) {
			if (op <= 0xb7) {
				const n = op - 0xb0 + 1;
				for (let i = 0; i < n; i++) {
					this.push(code[ip + 1 + i]);
				}
			} else {
				const n = op - 0xb8 + 1;
				for (let i = 0; i < n; i++) {
					this.push(((code[ip + 1 + i * 2] << 8) | code[ip + 2 + i * 2]) << 16 >> 16);
				}
			}
			return true;
		}
		switch (op) {
			case 0x00:
			case 0x01:
			case 0x02:
			case 0x03:
			case 0x04:
			case 0x05: {
				// SVTCA, SPVTCA, SFVTCA
				const x = (op & 1) !== 0;
				const ax = x ? 0x4000 : 0;
				const ay = x ? 0 : 0x4000;
				if (op < 4) {
					gs.pvx = gs.dvx = ax;
					gs.pvy = gs.dvy = ay;
					this.pvFromSpvtl = false;
				}
				if (op < 2 || op >= 4) {
					gs.fvx = ax;
					gs.fvy = ay;
				}
				this.computeFuncs();
				return true;
			}
			case 0x06:
			case 0x07:
			case 0x08:
			case 0x09: {
				// SPVTL, SFVTL
				const a1 = this.pop();
				const a0 = this.pop();
				if (a1 < 0 || a1 >= this.zp2.n || a0 < 0 || a0 >= this.zp1.n) {
					return true;
				}
				let A = this.zp1.curX[a0] - this.zp2.curX[a1];
				let B = this.zp1.curY[a0] - this.zp2.curY[a1];
				let opc: number = op;
				if (A === 0 && B === 0) {
					A = 0x4000;
					opc = 0;
				}
				if (opc & 1) {
					const C = B;
					B = A;
					A = -C;
				}
				const [vx, vy] = this.normalize(A, B);
				if (op < 8) {
					gs.pvx = gs.dvx = vx;
					gs.pvy = gs.dvy = vy;
					this.pvFromSpvtl = true;
				} else {
					gs.fvx = vx;
					gs.fvy = vy;
				}
				this.computeFuncs();
				return true;
			}
			case 0x0a:
			case 0x0b: {
				// SPVFS, SFVFS
				const y = (this.pop() << 16) >> 16;
				const x = (this.pop() << 16) >> 16;
				const [vx, vy] = this.normalize(x, y);
				if (op === 0x0a) {
					gs.pvx = gs.dvx = vx;
					gs.pvy = gs.dvy = vy;
					this.pvFromSpvtl = false;
				} else {
					gs.fvx = vx;
					gs.fvy = vy;
				}
				this.computeFuncs();
				return true;
			}
			case 0x0c:
				this.push(gs.pvx);
				this.push(gs.pvy);
				return true;
			case 0x0d:
				this.push(gs.fvx);
				this.push(gs.fvy);
				return true;
			case 0x0e:
				gs.fvx = gs.pvx;
				gs.fvy = gs.pvy;
				this.computeFuncs();
				return true;
			case 0x0f:
				this.insISECT();
				return true;
			case 0x10:
				gs.rp0 = this.pop();
				return true;
			case 0x11:
				gs.rp1 = this.pop();
				return true;
			case 0x12:
				gs.rp2 = this.pop();
				return true;
			case 0x13:
			case 0x14:
			case 0x15:
			case 0x16: {
				const z = this.pop();
				const zone = this.zone(z);
				if (!zone) {
					return true;
				}
				if (op === 0x13 || op === 0x16) {
					this.zp0 = zone;
					gs.gep0 = z;
				}
				if (op === 0x14 || op === 0x16) {
					this.zp1 = zone;
					gs.gep1 = z;
				}
				if (op === 0x15 || op === 0x16) {
					this.zp2 = zone;
					gs.gep2 = z;
				}
				return true;
			}
			case 0x17: {
				const n = this.pop();
				if (n < 0) {
					throw new HintError('sloop');
				}
				gs.loop = Math.min(n, 0xffff);
				return true;
			}
			case 0x18:
				gs.roundState = 1;
				return true;
			case 0x19:
				gs.roundState = 0;
				return true;
			case 0x1a:
				gs.minDist = this.pop();
				return true;
			case 0x1d:
				gs.cvtCutIn = this.pop();
				return true;
			case 0x1e:
				gs.swCutIn = this.pop();
				return true;
			case 0x1f:
				gs.swValue = mulFix(this.pop(), this.scale);
				return true;
			case 0x20: {
				const v = this.pop();
				this.push(v);
				this.push(v);
				return true;
			}
			case 0x21:
				this.pop();
				return true;
			case 0x22:
				this.stack.length = 0;
				return true;
			case 0x23: {
				const b = this.pop();
				const a = this.pop();
				this.push(b);
				this.push(a);
				return true;
			}
			case 0x24:
				this.push(this.stack.length);
				return true;
			case 0x25: {
				// CINDEX
				const k = this.pop();
				this.push(k <= 0 || k > this.stack.length ? 0 : this.stack[this.stack.length - k]);
				return true;
			}
			case 0x26: {
				// MINDEX
				const k = this.pop();
				if (k <= 0 || k > this.stack.length) {
					return true;
				}
				const v = this.stack.splice(this.stack.length - k, 1)[0];
				this.push(v);
				return true;
			}
			case 0x27: {
				// ALIGNPTS
				const p2 = this.pop();
				const p1 = this.pop();
				if (p1 < 0 || p1 >= this.zp1.n || p2 < 0 || p2 >= this.zp0.n) {
					return true;
				}
				const d = Math.trunc(
					this.project(this.zp0.curX[p2] - this.zp1.curX[p1], this.zp0.curY[p2] - this.zp1.curY[p1]) / 2,
				);
				this.move(this.zp1, p1, d);
				this.move(this.zp0, p2, -d);
				return true;
			}
			case 0x29: {
				// UTP
				const p = this.pop();
				if (p < 0 || p >= this.zp0.n) {
					return true;
				}
				let mask = 0xff;
				if (gs.fvx !== 0) mask &= ~TOUCH_X;
				if (gs.fvy !== 0) mask &= ~TOUCH_Y;
				this.zp0.tags[p] &= mask;
				return true;
			}
			case 0x2e:
			case 0x2f: {
				// MDAP
				const p = this.pop();
				if (p < 0 || p >= this.zp0.n) {
					return true;
				}
				let d = 0;
				if (op & 1) {
					const c = this.project(this.zp0.curX[p], this.zp0.curY[p]);
					d = this.round(c) - c;
				}
				this.move(this.zp0, p, d);
				gs.rp0 = gs.rp1 = p;
				return true;
			}
			case 0x30:
			case 0x31:
				this.insIUP(op & 1);
				return true;
			case 0x32:
			case 0x33:
				this.insSHP(op);
				return true;
			case 0x34:
			case 0x35:
				this.insSHC(op);
				return true;
			case 0x36:
			case 0x37:
				this.insSHZ(op);
				return true;
			case 0x38: {
				// SHPIX
				const amt = this.pop();
				const dx = mulFix14(amt, gs.fvx);
				const dy = mulFix14(amt, gs.fvy);
				while (gs.loop > 0) {
					const p = this.pop();
					if (p >= 0 && p < this.zp2.n) {
						// Backward-compatible ClearType keeps SHPIX only on touched
						// points in the non-ClearType direction (and in composites).
						const keep =
							!this.ctCompat() ||
							this.inComposite ||
							(gs.fvx === 0 && (this.zp2.tags[p] & TOUCH_Y) !== 0);
						if (keep) {
							this.moveZp2(p, dx, dy, true);
						}
					}
					gs.loop--;
				}
				gs.loop = 1;
				return true;
			}
			case 0x39:
				this.insIP();
				return true;
			case 0x3a:
			case 0x3b: {
				// MSIRP
				const d = this.pop();
				const p = this.pop();
				if (p < 0 || p >= this.zp1.n || gs.rp0 < 0 || gs.rp0 >= this.zp0.n) {
					return true;
				}
				if (gs.gep1 === 0) {
					this.zp1.orgX[p] = this.zp0.orgX[gs.rp0];
					this.zp1.orgY[p] = this.zp0.orgY[gs.rp0];
					this.moveOrig(this.zp1, p, d);
					this.zp1.curX[p] = this.zp1.orgX[p];
					this.zp1.curY[p] = this.zp1.orgY[p];
				}
				const dist = this.project(
					this.zp1.curX[p] - this.zp0.curX[gs.rp0],
					this.zp1.curY[p] - this.zp0.curY[gs.rp0],
				);
				let target = d;
				if (this.ctCompat() && gs.gep0 !== 0 && gs.gep1 !== 0) {
					// ClearType: a stroke-weight MSIRP (non-trivial outline
					// distance) honours the CVT cut-in.
					const org = this.dualProjectOrus(
						this.zp1.orusX[p] - this.zp0.orusX[gs.rp0],
						this.zp1.orusY[p] - this.zp0.orusY[gs.rp0],
					);
					if (org !== 0 && Math.abs(d - org) > this.cutIn()) {
						target = org;
					}
				}
				this.move(this.zp1, p, target - dist);
				gs.rp1 = gs.rp0;
				gs.rp2 = p;
				if (op & 1) {
					gs.rp0 = p;
				}
				return true;
			}
			case 0x3c: {
				// ALIGNRP
				while (gs.loop > 0) {
					const p = this.pop();
					if (p >= 0 && p < this.zp1.n && gs.rp0 >= 0 && gs.rp0 < this.zp0.n) {
						const d = this.project(
							this.zp1.curX[p] - this.zp0.curX[gs.rp0],
							this.zp1.curY[p] - this.zp0.curY[gs.rp0],
						);
						this.move(this.zp1, p, -d);
					}
					gs.loop--;
				}
				gs.loop = 1;
				return true;
			}
			case 0x3d:
				gs.roundState = 2;
				return true;
			case 0x3e:
			case 0x3f:
				this.insMIAP(op);
				return true;
			case 0x40: {
				const n = code[ip + 1];
				for (let i = 0; i < n; i++) {
					this.push(code[ip + 2 + i]);
				}
				return true;
			}
			case 0x41: {
				const n = code[ip + 1];
				for (let i = 0; i < n; i++) {
					this.push(((code[ip + 2 + i * 2] << 8) | code[ip + 3 + i * 2]) << 16 >> 16);
				}
				return true;
			}
			case 0x42: {
				// WS
				const v = this.pop();
				const i = this.pop();
				if (i >= 0 && i < this.storage.length) {
					this.storage[i] = v;
				}
				return true;
			}
			case 0x43: {
				// RS
				const i = this.pop();
				this.push(i >= 0 && i < this.storage.length && !this.ctBypassStorage(i) ? this.storage[i] : 0);
				return true;
			}
			case 0x44: {
				// WCVTP
				const v = this.pop();
				const i = this.pop();
				this.writeCvt(i, v);
				return true;
			}
			case 0x45: {
				// RCVT
				const i = this.pop();
				this.push(i >= 0 && i < this.cvt.length ? this.readCvt(i) : 0);
				return true;
			}
			case 0x46:
			case 0x47: {
				// GC
				const p = this.pop();
				if (p < 0 || p >= this.zp2.n) {
					this.push(0);
					return true;
				}
				this.push(
					op & 1
						? this.dualProject(this.zp2.orgX[p], this.zp2.orgY[p])
						: this.project(this.zp2.curX[p], this.zp2.curY[p]),
				);
				return true;
			}
			case 0x48: {
				// SCFS
				const v = this.pop();
				const p = this.pop();
				if (p < 0 || p >= this.zp2.n) {
					return true;
				}
				const k = this.project(this.zp2.curX[p], this.zp2.curY[p]);
				this.move(this.zp2, p, v - k);
				if (gs.gep2 === 0) {
					this.zp2.orgX[p] = this.zp2.curX[p];
					this.zp2.orgY[p] = this.zp2.curY[p];
				}
				return true;
			}
			case 0x49:
			case 0x4a: {
				// MD
				const k = this.pop();
				const l = this.pop();
				if (l < 0 || l >= this.zp0.n || k < 0 || k >= this.zp1.n) {
					this.push(0);
					return true;
				}
				let d: number;
				if (op & 1) {
					d = this.project(this.zp0.curX[l] - this.zp1.curX[k], this.zp0.curY[l] - this.zp1.curY[k]);
				} else if (gs.gep0 === 0 || gs.gep1 === 0) {
					d = this.dualProject(this.zp0.orgX[l] - this.zp1.orgX[k], this.zp0.orgY[l] - this.zp1.orgY[k]);
				} else {
					d = this.dualProjectOrus(this.zp0.orusX[l] - this.zp1.orusX[k], this.zp0.orusY[l] - this.zp1.orusY[k]);
				}
				this.push(d);
				return true;
			}
			case 0x4b:
				this.push(this.currentPpem());
				return true;
			case 0x4c:
				// MPS: GDI's interpreter always answers 12.
				this.push(12);
				return true;
			case 0x4d:
				gs.autoFlip = true;
				return true;
			case 0x4e:
				gs.autoFlip = false;
				return true;
			case 0x4f:
				this.pop();
				return true;
			case 0x50:
			case 0x51:
			case 0x52:
			case 0x53:
			case 0x54:
			case 0x55: {
				const b = this.pop();
				const a = this.pop();
				const r =
					op === 0x50 ? a < b : op === 0x51 ? a <= b : op === 0x52 ? a > b : op === 0x53 ? a >= b : op === 0x54 ? a === b : a !== b;
				this.push(r ? 1 : 0);
				return true;
			}
			case 0x56:
			case 0x57: {
				const odd = (this.round(this.pop()) & 127) === 64;
				this.push((op === 0x56 ? odd : !odd) ? 1 : 0);
				return true;
			}
			case 0x5a:
			case 0x5b: {
				const b = this.pop();
				const a = this.pop();
				this.push((op === 0x5a ? a !== 0 && b !== 0 : a !== 0 || b !== 0) ? 1 : 0);
				return true;
			}
			case 0x5c:
				this.push(this.pop() === 0 ? 1 : 0);
				return true;
			case 0x5d:
			case 0x71:
			case 0x72:
				this.insDELTAP(op);
				return true;
			case 0x73:
			case 0x74:
			case 0x75:
				this.insDELTAC(op);
				return true;
			case 0x5e:
				gs.deltaBase = this.pop() & 0xffff;
				return true;
			case 0x5f:
				gs.deltaShift = this.pop() & 0xffff;
				if (gs.deltaShift > 6) {
					throw new HintError('sds');
				}
				return true;
			case 0x60: {
				const b = this.pop();
				const a = this.pop();
				this.push(a + b);
				return true;
			}
			case 0x61: {
				const b = this.pop();
				const a = this.pop();
				this.push(a - b);
				return true;
			}
			case 0x62: {
				const b = this.pop();
				const a = this.pop();
				if (b === 0) {
					throw new HintError('div0');
				}
				this.push(mulDivNoRound(a, 64, b));
				return true;
			}
			case 0x63: {
				const b = this.pop();
				const a = this.pop();
				this.push(mulDiv(a, b, 64));
				return true;
			}
			case 0x64:
				this.push(Math.abs(this.pop()));
				return true;
			case 0x65:
				this.push(-this.pop());
				return true;
			case 0x66:
				this.push(floor64(this.pop()));
				return true;
			case 0x67:
				this.push(ceil64(this.pop()));
				return true;
			case 0x68:
			case 0x69:
			case 0x6a:
			case 0x6b:
				this.push(this.round(this.pop()));
				return true;
			case 0x6c:
			case 0x6d:
			case 0x6e:
			case 0x6f:
				// NROUND: no engine compensation.
				return true;
			case 0x70: {
				// WCVTF
				const v = this.pop();
				const i = this.pop();
				if (i >= 0 && i < this.cvt.length) {
					this.cvt[i] = mulFix(v, this.scale);
				}
				return true;
			}
			case 0x76:
				this.setSuperRound(0x4000, this.pop());
				gs.roundState = 6;
				return true;
			case 0x77:
				this.setSuperRound(0x2d41, this.pop());
				gs.roundState = 7;
				return true;
			case 0x7a:
				gs.roundState = 5;
				return true;
			case 0x7c:
				gs.roundState = 4;
				return true;
			case 0x7d:
				gs.roundState = 3;
				return true;
			case 0x7e:
			case 0x7f:
				this.pop();
				return true;
			case 0x80: {
				// FLIPPT
				while (gs.loop > 0) {
					const p = this.pop();
					if (p >= 0 && p < this.pts.n) {
						this.pts.tags[p] ^= ON_CURVE;
					}
					gs.loop--;
				}
				gs.loop = 1;
				return true;
			}
			case 0x81:
			case 0x82: {
				// FLIPRGON / FLIPRGOFF
				const k = this.pop();
				const l = this.pop();
				if (k < 0 || k >= this.pts.n || l < 0 || l > k) {
					return true;
				}
				for (let i = l; i <= k; i++) {
					if (op === 0x81) {
						this.pts.tags[i] |= ON_CURVE;
					} else {
						this.pts.tags[i] &= ~ON_CURVE;
					}
				}
				return true;
			}
			case 0x85: {
				// SCANCTRL
				const v = this.pop();
				const a = v & 0xff;
				if (a === 0xff) {
					gs.scanControl = true;
					return true;
				}
				if (a === 0) {
					gs.scanControl = false;
					return true;
				}
				if (v & 0x100 && this.ppem <= a) gs.scanControl = true;
				if (v & 0x200 && this.env.rotated) gs.scanControl = true;
				if (v & 0x400 && this.stretched) gs.scanControl = true;
				if (v & 0x800 && this.ppem > a) gs.scanControl = false;
				if (v & 0x1000 && this.env.rotated) gs.scanControl = false;
				if (v & 0x2000 && this.stretched) gs.scanControl = false;
				return true;
			}
			case 0x86:
			case 0x87:
				this.insSDPVTL(op);
				return true;
			case 0x88: {
				// GETINFO
				const sel = this.pop();
				let k = 0;
				if (sel & 1) k = this.env.version;
				if (sel & 2 && this.env.rotated) k |= 1 << 8;
				if (sel & 4 && this.stretched) k |= 1 << 9;
				if (sel & 32 && this.env.grayscale) k |= 1 << 12;
				if (sel & 64 && this.env.clearType) k |= 1 << 13;
				if (sel & 128 && this.env.clearType && this.env.compatibleWidths !== false) k |= 1 << 14;
				if (sel & 256 && this.env.symmetricSmoothing) k |= 1 << 15;
				this.push(k);
				return true;
			}
			case 0x8a: {
				// ROLL
				const a = this.pop();
				const b = this.pop();
				const c = this.pop();
				this.push(b);
				this.push(a);
				this.push(c);
				return true;
			}
			case 0x8b: {
				const b = this.pop();
				const a = this.pop();
				this.push(Math.max(a, b));
				return true;
			}
			case 0x8c: {
				const b = this.pop();
				const a = this.pop();
				this.push(Math.min(a, b));
				return true;
			}
			case 0x8d: {
				// SCANTYPE
				const v = this.pop();
				if (v >= 0) {
					gs.scanType = v & 0xffff;
				}
				return true;
			}
			case 0x8e: {
				// INSTCTRL (prep only)
				const k = this.pop();
				const l = this.pop();
				if (k < 1 || k > 3) {
					throw new HintError('instctrl');
				}
				if (!this.inPrep) {
					return true;
				}
				const bit = 1 << (k - 1);
				gs.instructControl = (gs.instructControl & ~bit) | (l ? bit : 0);
				return true;
			}
			default:
				return false;
		}
	}

	// -----------------------------------------------------------------------
	// Individual instructions
	// -----------------------------------------------------------------------

	private moveZp2(p: number, dx: number, dy: number, touch: boolean): void {
		const gs = this.gs;
		if (gs.fvx !== 0) {
			this.zp2.curX[p] += dx;
			if (touch) this.zp2.tags[p] |= TOUCH_X;
		}
		if (gs.fvy !== 0) {
			this.zp2.curY[p] += dy;
			if (touch) this.zp2.tags[p] |= TOUCH_Y;
		}
	}

	private pointDisplacement(op: number): { dx: number; dy: number; zone: Zone; ref: number } | null {
		const gs = this.gs;
		const zone = op & 1 ? this.zp0 : this.zp1;
		const ref = op & 1 ? gs.rp1 : gs.rp2;
		if (ref < 0 || ref >= zone.n) {
			return null;
		}
		const d = this.project(zone.curX[ref] - zone.orgX[ref], zone.curY[ref] - zone.orgY[ref]);
		return {
			dx: mulDiv(d, gs.fvx, this.fDotP),
			dy: mulDiv(d, gs.fvy, this.fDotP),
			zone,
			ref,
		};
	}

	private insSHP(op: number): void {
		const gs = this.gs;
		const disp = this.pointDisplacement(op);
		while (gs.loop > 0) {
			const p = this.pop();
			if (disp && p >= 0 && p < this.zp2.n) {
				this.moveZp2(p, disp.dx, disp.dy, true);
			}
			gs.loop--;
		}
		gs.loop = 1;
	}

	private insSHC(op: number): void {
		const gs = this.gs;
		const contour = this.pop();
		const bounds = gs.gep2 === 0 ? 1 : this.zp2.endPts.length;
		if (contour < 0 || contour >= bounds) {
			return;
		}
		const disp = this.pointDisplacement(op);
		if (!disp) {
			return;
		}
		const start = contour === 0 ? 0 : this.zp2.endPts[contour - 1] + 1;
		const limit = gs.gep2 === 0 ? this.zp2.n : this.zp2.endPts[contour] + 1;
		for (let i = start; i < limit; i++) {
			if (disp.zone !== this.zp2 || disp.ref !== i) {
				this.moveZp2(i, disp.dx, disp.dy, true);
			}
		}
	}

	private insSHZ(op: number): void {
		const gs = this.gs;
		const z = this.pop();
		if (z < 0 || z > 1) {
			return;
		}
		const disp = this.pointDisplacement(op);
		if (!disp) {
			return;
		}
		let limit: number;
		if (gs.gep2 === 0) {
			limit = this.zp2.n;
		} else if (gs.gep2 === 1 && this.zp2.endPts.length > 0) {
			limit = this.zp2.endPts[this.zp2.endPts.length - 1] + 1;
		} else {
			limit = 0;
		}
		for (let i = 0; i < limit; i++) {
			if (disp.zone !== this.zp2 || disp.ref !== i) {
				this.moveZp2(i, disp.dx, disp.dy, false);
			}
		}
	}

	private insMIAP(op: number): void {
		const gs = this.gs;
		const cvtEntry = this.pop();
		const p = this.pop();
		if (p < 0 || p >= this.zp0.n || cvtEntry < 0 || cvtEntry >= this.cvt.length) {
			gs.rp0 = gs.rp1 = p;
			return;
		}
		let distance = this.readCvt(cvtEntry);
		if (gs.gep0 === 0) {
			this.zp0.orgX[p] = mulFix14(distance, gs.fvx);
			this.zp0.orgY[p] = mulFix14(distance, gs.fvy);
			this.zp0.curX[p] = this.zp0.orgX[p];
			this.zp0.curY[p] = this.zp0.orgY[p];
		}
		const orgDist = this.project(this.zp0.curX[p], this.zp0.curY[p]);
		if (op & 1) {
			if (Math.abs(distance - orgDist) > this.cutIn()) {
				distance = orgDist;
			}
			distance = this.round(distance);
		}
		this.move(this.zp0, p, distance - orgDist);
		gs.rp0 = gs.rp1 = p;
	}

	private insMDRP(op: number): void {
		const gs = this.gs;
		const p = this.pop();
		if (p < 0 || p >= this.zp1.n || gs.rp0 < 0 || gs.rp0 >= this.zp0.n) {
			gs.rp1 = gs.rp0;
			gs.rp2 = p;
			if (op & 16) gs.rp0 = p;
			return;
		}
		let orgDist: number;
		if (gs.gep0 === 0 || gs.gep1 === 0) {
			orgDist = this.dualProject(this.zp1.orgX[p] - this.zp0.orgX[gs.rp0], this.zp1.orgY[p] - this.zp0.orgY[gs.rp0]);
		} else {
			orgDist = this.dualProjectOrus(
				this.zp1.orusX[p] - this.zp0.orusX[gs.rp0],
				this.zp1.orusY[p] - this.zp0.orusY[gs.rp0],
			);
		}
		if (gs.swCutIn > 0 && orgDist < gs.swValue + gs.swCutIn && orgDist > gs.swValue - gs.swCutIn) {
			orgDist = orgDist >= 0 ? gs.swValue : -gs.swValue;
		}
		let distance = op & 4 ? this.round(orgDist) : orgDist;
		if (op & 8) {
			if (orgDist >= 0) {
				if (distance < this.minDistance()) distance = this.minDistance();
			} else if (distance > -this.minDistance()) {
				distance = -this.minDistance();
			}
		}
		const cur = this.project(this.zp1.curX[p] - this.zp0.curX[gs.rp0], this.zp1.curY[p] - this.zp0.curY[gs.rp0]);
		this.move(this.zp1, p, distance - cur);
		gs.rp1 = gs.rp0;
		gs.rp2 = p;
		if (op & 16) gs.rp0 = p;
	}

	private insMIRP(op: number): void {
		const gs = this.gs;
		const cvtIdx = this.pop() + 1;
		const p = this.pop();
		if (p < 0 || p >= this.zp1.n || cvtIdx < 0 || cvtIdx > this.cvt.length || gs.rp0 < 0 || gs.rp0 >= this.zp0.n) {
			gs.rp1 = gs.rp0;
			if (op & 16) gs.rp0 = p;
			gs.rp2 = p;
			return;
		}
		let cvtDist = cvtIdx === 0 ? 0 : this.readCvt(cvtIdx - 1);
		if (Math.abs(cvtDist - gs.swValue) < gs.swCutIn) {
			cvtDist = cvtDist >= 0 ? gs.swValue : -gs.swValue;
		}
		if (gs.gep1 === 0) {
			this.zp1.orgX[p] = this.zp0.orgX[gs.rp0] + mulFix14(cvtDist, gs.fvx);
			this.zp1.orgY[p] = this.zp0.orgY[gs.rp0] + mulFix14(cvtDist, gs.fvy);
			this.zp1.curX[p] = this.zp1.orgX[p];
			this.zp1.curY[p] = this.zp1.orgY[p];
		}
		const orgDist = this.dualProject(this.zp1.orgX[p] - this.zp0.orgX[gs.rp0], this.zp1.orgY[p] - this.zp0.orgY[gs.rp0]);
		const curDist = this.project(this.zp1.curX[p] - this.zp0.curX[gs.rp0], this.zp1.curY[p] - this.zp0.curY[gs.rp0]);
		if (gs.autoFlip && orgDist < 0 !== cvtDist < 0) {
			cvtDist = -cvtDist;
		}
		let distance: number;
		if (op & 4) {
			if (gs.gep0 === gs.gep1) {
				if (Math.abs(cvtDist - orgDist) > this.cutIn()) {
					cvtDist = orgDist;
				}
			}
			distance = this.round(cvtDist);
		} else {
			// ClearType: unrounded MIRP honours the CVT cut-in too.
			if (this.env.clearType && this.ctCompat() && gs.gep0 === gs.gep1 && Math.abs(cvtDist - orgDist) > this.cutIn()) {
				cvtDist = orgDist;
			}
			distance = cvtDist;
		}
		if (op & 8) {
			if (orgDist >= 0) {
				if (distance < this.minDistance()) distance = this.minDistance();
			} else if (distance > -this.minDistance()) {
				distance = -this.minDistance();
			}
		}
		this.move(this.zp1, p, distance - curDist);
		gs.rp1 = gs.rp0;
		if (op & 16) gs.rp0 = p;
		gs.rp2 = p;
	}

	private insIP(): void {
		const gs = this.gs;
		const twilight = gs.gep0 === 0 || gs.gep1 === 0 || gs.gep2 === 0;
		const rp1 = gs.rp1;
		const rp2 = gs.rp2;
		let oldRange = 0;
		let curRange = 0;
		if (rp1 < 0 || rp1 >= this.zp0.n) {
			gs.loop = 1;
			return;
		}
		const valid = rp2 >= 0 && rp2 < this.zp1.n;
		if (valid) {
			if (twilight) {
				oldRange = this.dualProject(this.zp1.orgX[rp2] - this.zp0.orgX[rp1], this.zp1.orgY[rp2] - this.zp0.orgY[rp1]);
			} else {
				oldRange = this.dualProjectOrusRaw(
					this.zp1.orusX[rp2] - this.zp0.orusX[rp1],
					this.zp1.orusY[rp2] - this.zp0.orusY[rp1],
				);
			}
			curRange = this.project(this.zp1.curX[rp2] - this.zp0.curX[rp1], this.zp1.curY[rp2] - this.zp0.curY[rp1]);
		}
		while (gs.loop > 0) {
			const p = this.pop();
			gs.loop--;
			if (p < 0 || p >= this.zp2.n) {
				continue;
			}
			let orgDist: number;
			if (twilight) {
				orgDist = this.dualProject(this.zp2.orgX[p] - this.zp0.orgX[rp1], this.zp2.orgY[p] - this.zp0.orgY[rp1]);
			} else {
				orgDist = this.dualProjectOrusRaw(this.zp2.orusX[p] - this.zp0.orusX[rp1], this.zp2.orusY[p] - this.zp0.orusY[rp1]);
			}
			const curDist = this.project(this.zp2.curX[p] - this.zp0.curX[rp1], this.zp2.curY[p] - this.zp0.curY[rp1]);
			let newDist: number;
			if (orgDist) {
				newDist = oldRange ? mulDiv(orgDist, curRange, oldRange) : orgDist;
			} else {
				newDist = 0;
			}
			this.move(this.zp2, p, newDist - curDist);
		}
		gs.loop = 1;
	}

	/** IP's orus projection: unscaled when both axes share one scale (only the ratio matters). */
	private dualProjectOrusRaw(dx: number, dy: number): number {
		if (this.xScale === this.yScale) {
			return this.dualProject(dx, dy);
		}
		return this.dualProject(mulFix(dx, this.xScale), mulFix(dy, this.yScale));
	}

	private insIUP(xAxis: number): void {
		const z = this.pts;
		const mask = xAxis ? TOUCH_X : TOUCH_Y;
		const orgs = xAxis ? z.orgX : z.orgY;
		const curs = xAxis ? z.curX : z.curY;
		const orus = xAxis ? z.orusX : z.orusY;
		const nContours = z.endPts.length;
		let point = 0;
		for (let contour = 0; contour < nContours; contour++) {
			let endPoint = z.endPts[contour];
			const firstPoint = point;
			if (endPoint >= z.n) {
				endPoint = z.n - 1;
			}
			while (point <= endPoint && (z.tags[point] & mask) === 0) {
				point++;
			}
			if (point <= endPoint) {
				const firstTouched = point;
				let curTouched = point;
				point++;
				while (point <= endPoint) {
					if (z.tags[point] & mask) {
						iupInterpolate(orgs, curs, orus, curTouched + 1, point - 1, curTouched, point);
						curTouched = point;
					}
					point++;
				}
				if (curTouched === firstTouched) {
					const d = curs[curTouched] - orgs[curTouched];
					for (let i = firstPoint; i <= endPoint; i++) {
						if (i !== curTouched) {
							curs[i] += d;
						}
					}
				} else {
					iupInterpolate(orgs, curs, orus, curTouched + 1, endPoint, curTouched, firstTouched);
					if (firstTouched > 0) {
						iupInterpolate(orgs, curs, orus, firstPoint, firstTouched - 1, curTouched, firstTouched);
					}
				}
			}
			point = endPoint + 1;
		}
	}

	private insISECT(): void {
		const b1 = this.pop();
		const b0 = this.pop();
		const a1 = this.pop();
		const a0 = this.pop();
		const p = this.pop();
		const zp0 = this.zp0;
		const zp1 = this.zp1;
		const zp2 = this.zp2;
		if (
			p < 0 || p >= zp2.n || a0 < 0 || a0 >= zp1.n || a1 < 0 || a1 >= zp1.n || b0 < 0 || b0 >= zp0.n || b1 < 0 || b1 >= zp0.n
		) {
			return;
		}
		const dbx = zp0.curX[b1] - zp0.curX[b0];
		const dby = zp0.curY[b1] - zp0.curY[b0];
		const dax = zp1.curX[a1] - zp1.curX[a0];
		const day = zp1.curY[a1] - zp1.curY[a0];
		const dx = zp0.curX[b0] - zp1.curX[a0];
		const dy = zp0.curY[b0] - zp1.curY[a0];
		const disc = mulDiv(dax, -dby, 0x40) + mulDiv(day, dbx, 0x40);
		const dot = mulDiv(dax, dbx, 0x40) + mulDiv(day, dby, 0x40);
		if (19 * Math.abs(disc) > Math.abs(dot)) {
			const val = mulDiv(dx, -dby, 0x40) + mulDiv(dy, dbx, 0x40);
			zp2.curX[p] = zp1.curX[a0] + mulDiv(val, dax, disc);
			zp2.curY[p] = zp1.curY[a0] + mulDiv(val, day, disc);
		} else {
			zp2.curX[p] = Math.trunc((zp1.curX[a0] + zp1.curX[a1] + zp0.curX[b0] + zp0.curX[b1]) / 4);
			zp2.curY[p] = Math.trunc((zp1.curY[a0] + zp1.curY[a1] + zp0.curY[b0] + zp0.curY[b1]) / 4);
		}
		zp2.tags[p] |= TOUCH_X | TOUCH_Y;
	}

	private insSDPVTL(op: number): void {
		const gs = this.gs;
		const p1 = this.pop();
		const p2 = this.pop();
		if (p1 < 0 || p1 >= this.zp2.n || p2 < 0 || p2 >= this.zp1.n) {
			return;
		}
		let opc = op;
		let A = this.zp1.orgX[p2] - this.zp2.orgX[p1];
		let B = this.zp1.orgY[p2] - this.zp2.orgY[p1];
		if (A === 0 && B === 0) {
			A = 0x4000;
			opc = 0;
		}
		if (opc & 1) {
			const C = B;
			B = A;
			A = -C;
		}
		[gs.dvx, gs.dvy] = this.normalize(A, B);
		opc = op;
		A = this.zp1.curX[p2] - this.zp2.curX[p1];
		B = this.zp1.curY[p2] - this.zp2.curY[p1];
		if (A === 0 && B === 0) {
			A = 0x4000;
			opc = 0;
		}
		if (opc & 1) {
			const C = B;
			B = A;
			A = -C;
		}
		[gs.pvx, gs.pvy] = this.normalize(A, B);
		this.pvFromSpvtl = false;
		this.computeFuncs();
	}

	private insDELTAP(op: number): void {
		const n = this.pop();
		const ppem = this.currentPpem();
		for (let k = 1; k <= n; k++) {
			if (this.stack.length < 2) {
				this.stack.length = 0;
				return;
			}
			const a = this.pop();
			const b = this.pop();
			if (a < 0 || a >= this.zp0.n) {
				continue;
			}
			let c = (b & 0xf0) >> 4;
			if (op === 0x71) c += 16;
			if (op === 0x72) c += 32;
			c += this.gs.deltaBase;
			if (ppem === c) {
				let s = (b & 0xf) - 8;
				if (s >= 0) s++;
				s *= 1 << (6 - this.gs.deltaShift);
				// Backward-compatible ClearType skips DELTAPs except on points
				// already touched in the non-ClearType (y) direction.
				if (this.ctCompat() && !(this.gs.fvx === 0 && (this.zp0.tags[a] & TOUCH_Y) !== 0)) {
					continue;
				}
				this.move(this.zp0, a, s);
			}
		}
	}

	private insDELTAC(op: number): void {
		const n = this.pop();
		const ppem = this.currentPpem();
		for (let k = 1; k <= n; k++) {
			if (this.stack.length < 2) {
				this.stack.length = 0;
				return;
			}
			const a = this.pop();
			const b = this.pop();
			let c = (b & 0xf0) >> 4;
			if (op === 0x74) c += 16;
			if (op === 0x75) c += 32;
			c += this.gs.deltaBase;
			if (ppem === c) {
				let s = (b & 0xf) - 8;
				if (s >= 0) s++;
				s *= 1 << (6 - this.gs.deltaShift);
				this.moveCvt(a, s);
			}
		}
	}
}

/** IUP interpolation of the untouched points p1..p2 between touched ref1 and ref2. */
function iupInterpolate(
	orgs: Float64Array,
	curs: Float64Array,
	orus: Float64Array,
	p1: number,
	p2: number,
	ref1: number,
	ref2: number,
): void {
	if (p1 > p2) {
		return;
	}
	let orus1 = orus[ref1];
	let orus2 = orus[ref2];
	if (orus1 > orus2) {
		const t = orus1;
		orus1 = orus2;
		orus2 = t;
		const r = ref1;
		ref1 = ref2;
		ref2 = r;
	}
	const org1 = orgs[ref1];
	const org2 = orgs[ref2];
	const cur1 = curs[ref1];
	const cur2 = curs[ref2];
	const delta1 = cur1 - org1;
	const delta2 = cur2 - org2;
	if (cur1 === cur2 || orus1 === orus2) {
		for (let i = p1; i <= p2; i++) {
			let x = orgs[i];
			if (x <= org1) x += delta1;
			else if (x >= org2) x += delta2;
			else x = cur1;
			curs[i] = x;
		}
		return;
	}
	for (let i = p1; i <= p2; i++) {
		let x = orgs[i];
		if (x <= org1) {
			x += delta1;
		} else if (x >= org2) {
			x += delta2;
		} else {
			// A direct MulDiv on font units: FreeType's 16.16 ratio
			// (DivFix then MulFix) rounds differently from GDI here.
			x = cur1 + mulDiv(orus[i] - orus1, cur2 - cur1, orus2 - orus1);
		}
		curs[i] = x;
	}
}

