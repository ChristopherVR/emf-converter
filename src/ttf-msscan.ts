/**
 * The scan converter of GDI's TrueType rasterizer (`fontdrvhost.exe`: `fsc_FillGlyph` and the routines it calls),
 * reimplemented for monochrome glyph bitmaps and the oversampled grid behind GDI's grayscale ones.
 *
 * What the native code does, as read from the binary and confirmed against `GetGlyphOutline(GGO_BITMAP)`:
 *
 * - The outline is 26.6 integers. Duplicate neighbouring points are dropped first (`removeDuplicates`) and the glyph's
 *   pixel box is cut from the extremes of all control points (`box`): columns whose centre lies within the control
 *   box, so a dropout pixel that would fall outside is moved onto the box edge.
 * - Every edge is walked with integer arithmetic and every crossing of a scanline centre (horizontal, `y = 64k + 32`)
 *   or of a column centre (vertical, `x = 64c + 32`) is recorded as a pixel index in a per-row / per-column list. The
 *   lists are two: crossings of edges going up (rows) or left (columns) are the starts of a span, the others the
 *   ends; the pixel runs of a row are the i-th start to the i-th end (`fillBitmap`). A line (`calcLine`) is
 *   Bresenham's walk over the centre lines it crosses; a quadratic arc is split into pieces that are monotone in x and
 *   y (integer de Casteljau at the extremum, `evaluateSpline`) and each piece is walked with a decision variable that
 *   is the implicit curve function evaluated at the next centre-line corner (`calcSpline`), updated by forward
 *   differences. Pieces larger than 8 units are computed on a coarser grid (a right shift of the inputs), and the
 *   decision variable's partial sums are truncated: that, not the curve, is where native results differ from the exact
 *   geometry by a sample at ties.
 * - A vertex that lies exactly on a centre line is resolved by its neighbours (`checkHorizTopology`,
 *   `checkVertTopology`): a pass-through adds one crossing, a local extremum adds a start and an end at the same pixel.
 * - Dropout control (`lookForDropouts`) looks for rows and columns whose start and end crossing coincide: the simple
 *   modes (SCANTYPE 0, 1) turn on the left / lower pixel, the smart ones (4, 5) the pixel nearest the midpoint of the
 *   two contour crossings, evaluated on the original segments (`evalH`, `evalV`). The stub rule (types 1, 5) counts
 *   the crossings in the squares beside the dropout.
 *
 * Flags are the TrueType dropout-control modes the native code takes: bit 0 stubs rejected, bit 1 dropout control
 * off, bit 2 smart (so 0, 1, 4, 5 and 2 for none).
 *
 * @module ttf-msscan
 */

import type { GlyphBitmap } from './ttf-raster';

/** The sentinel of "no previous point" of the native point history. */
const NONE = 0x7fffffff;

/** The native routines report overflow and range errors as a failed glyph. */
export class MsScanError extends Error {}

/** An outline in 26.6 device units, y up (integers). */
export interface MsOutline {
	xs: ArrayLike<number>;
	ys: ArrayLike<number>;
	onCurve: ArrayLike<number | boolean>;
	endPts: ArrayLike<number>;
}

/** A scan-converted bitmap: pixel columns `[xMin, xMax)` and rows `[yMin, yMax)`, top row first, one byte per pixel. */
export interface MsBitmap {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
	data: Uint8Array;
}

/** Rounded division of the native `CompDiv`: half away from zero (numerator magnitudes stay below 2^53 here). */
function compDiv(n: number, d: number): number {
	if (d === 0) {
		return n < 0 ? 0x80000000 : 0x7fffffff;
	}
	const half = Math.trunc(d / 2);
	const adjusted = (n < 0) === (d < 0) ? n + half : n - half;
	return Math.trunc(adjusted / d);
}

/** Number of significant bits of |v| (the native `PowerOf2`). */
function bitLength(v: number): number {
	let a = Math.abs(v);
	let bits = 0;
	while (a > 0) {
		bits++;
		a = Math.floor(a / 2);
	}
	return bits;
}

/** How many bits the inputs of a spline piece are shifted right by, from the bit lengths of its size and its determinant. */
function precisionShift(sum: number): number {
	return sum < 30 ? 0 : Math.min(3, Math.ceil((sum - 29) / 3));
}

interface SortedList {
	pos: number[];
	tag: number[];
}

function makeLists(n: number): SortedList[] {
	const lists: SortedList[] = [];
	for (let i = 0; i < n; i++) {
		lists.push({ pos: [], tag: [] });
	}
	return lists;
}

/** Inserts keeping the list ascending; an equal position goes after the ones already there. */
function insertSorted(list: SortedList, pos: number, tag: number): void {
	let i = list.pos.length;
	while (i > 0 && list.pos[i - 1] > pos) {
		i--;
	}
	list.pos.splice(i, 0, pos);
	list.tag.splice(i, 0, tag);
}

class Scanner {
	// Pixel box (columns xMin..xMax inclusive for crossings, rows yMin..yMax-1).
	readonly xMin: number;
	readonly xMax: number;
	readonly yMin: number;
	readonly yMax: number;
	readonly stubs: boolean;
	readonly noDrop: boolean;
	readonly smart: boolean;
	// Crossing lists: horizontal scanlines per row (index row - yMin), vertical ones per column (index col - xMin).
	readonly hStart: SortedList[];
	readonly hEnd: SortedList[];
	readonly vStart: SortedList[];
	readonly vEnd: SortedList[];
	// Original segments for the smart dropout midpoint: points and, per crossing, `index << 2 | kind` (0 line, 1 arc, 2 vertex).
	readonly ptX: number[] = [];
	readonly ptY: number[] = [];
	// Point history: previous vertex, current vertex, end of the contour's first segment.
	private prevX = NONE;
	private prevY = 0;
	private curX = 0;
	private curY = 0;
	private firstX = 0;
	private firstY = 0;

	constructor(xMin: number, xMax: number, yMin: number, yMax: number, flags: number) {
		this.xMin = xMin;
		this.xMax = xMax;
		this.yMin = yMin;
		this.yMax = yMax;
		this.stubs = (flags & 1) !== 0;
		this.noDrop = (flags & 2) !== 0;
		this.smart = !this.noDrop && (flags & 4) !== 0;
		this.hStart = makeLists(Math.max(0, yMax - yMin));
		this.hEnd = makeLists(Math.max(0, yMax - yMin));
		this.vStart = makeLists(Math.max(0, xMax - xMin));
		this.vEnd = makeLists(Math.max(0, xMax - xMin));
	}

	// ---- crossing lists ------------------------------------------------------------------------

	private tagOf(kind: number): number {
		return this.smart ? (((this.ptX.length - 1) << 2) | kind) & 0xffff : 0;
	}

	private addH(list: SortedList[], x: number, row: number, tag: number): void {
		if (x < this.xMin || x > this.xMax || row < this.yMin || row >= this.yMax) {
			throw new MsScanError('horizontal crossing out of the glyph box');
		}
		insertSorted(list[row - this.yMin], x, tag);
	}

	private addV(list: SortedList[], col: number, y: number, tag: number): void {
		if (col < this.xMin || col >= this.xMax || y < this.yMin || y > this.yMax) {
			throw new MsScanError('vertical crossing out of the glyph box');
		}
		insertSorted(list[col - this.xMin], y, tag);
	}

	/** The vertex on a centre line as a span start / end of its row (kind 2 in the smart tag). */
	private horizOn(): void {
		this.addH(this.hStart, (this.curX + 31) >> 6, this.curY >> 6, this.tagOf(2));
	}
	private horizOff(): void {
		this.addH(this.hEnd, (this.curX + 32) >> 6, this.curY >> 6, this.tagOf(2));
	}
	private vertOn(): void {
		this.addV(this.vStart, this.curX >> 6, (this.curY + 31) >> 6, this.tagOf(2));
	}
	private vertOff(): void {
		this.addV(this.vEnd, this.curX >> 6, (this.curY + 32) >> 6, this.tagOf(2));
	}

	/** A vertex on a scanline centre: the neighbours decide how many crossings it stands for. */
	private checkHorizTopology(x2: number, y2: number): void {
		const y1 = this.curY;
		const yPrev = this.prevY;
		if (y2 > y1) {
			if (y1 > yPrev) {
				this.horizOn();
			} else if (y1 < yPrev) {
				this.horizOn();
				this.horizOff();
			} else if (this.curX < this.prevX) {
				this.horizOn();
			}
		} else if (y2 < y1) {
			if (y1 > yPrev) {
				this.horizOn();
				this.horizOff();
			} else if (y1 < yPrev) {
				this.horizOff();
			} else if (this.curX > this.prevX) {
				this.horizOff();
			}
		} else if (y1 > yPrev) {
			if (x2 > this.curX) {
				this.horizOn();
			}
		} else if (y1 < yPrev) {
			if (x2 < this.curX) {
				this.horizOff();
			}
		} else if (this.curX > this.prevX) {
			if (x2 < this.curX) {
				this.horizOff();
			}
		} else if (this.curX < this.prevX) {
			if (x2 > this.curX) {
				this.horizOn();
			}
		}
	}

	/** The same for a vertex on a column centre (only needed when dropout control is on). */
	private checkVertTopology(x2: number, y2: number): void {
		const x1 = this.curX;
		const xPrev = this.prevX;
		if (x2 < x1) {
			if (x1 < xPrev) {
				this.vertOn();
			} else if (x1 > xPrev) {
				this.vertOn();
				this.vertOff();
			} else if (this.curY < this.prevY) {
				this.vertOn();
			}
		} else if (x2 > x1) {
			if (x1 < xPrev) {
				this.vertOn();
				this.vertOff();
			} else if (x1 > xPrev) {
				this.vertOff();
			} else if (this.curY > this.prevY) {
				this.vertOff();
			}
		} else if (x1 < xPrev) {
			if (y2 > this.curY) {
				this.vertOn();
			}
		} else if (x1 > xPrev) {
			if (y2 < this.curY) {
				this.vertOff();
			}
		} else if (this.curY > this.prevY) {
			if (y2 < this.curY) {
				this.vertOff();
			}
		} else if (this.curY < this.prevY) {
			if (y2 > this.curY) {
				this.vertOn();
			}
		}
	}

	/**
	 * What the walk does before it draws a segment from the current vertex to (x2, y2): resolve the vertex when it sits
	 * on a centre line and shift the point history. Returns false when the segment is a point on a centre line (the
	 * native code then draws it without touching the history).
	 */
	private enterSegment(x2: number, y2: number): boolean {
		if ((this.curY & 63) === 32) {
			if (this.curX === x2 && this.curY === y2) {
				return false;
			}
			if (this.prevX === NONE) {
				this.firstX = x2;
				this.firstY = y2;
			} else {
				this.checkHorizTopology(x2, y2);
			}
		}
		if (!this.noDrop && (this.curX & 63) === 32) {
			if (this.curX === x2 && this.curY === y2) {
				return false;
			}
			if (this.prevX === NONE) {
				this.firstX = x2;
				this.firstY = y2;
			} else {
				this.checkVertTopology(x2, y2);
			}
		}
		this.prevX = this.curX;
		this.prevY = this.curY;
		this.curX = x2;
		this.curY = y2;
		return true;
	}

	/** The closing vertex of a contour (its start point), resolved against the contour's first segment. */
	private endContour(): void {
		if ((this.curY & 63) === 32) {
			this.checkHorizTopology(this.firstX, this.firstY);
		}
		if (!this.noDrop && (this.curX & 63) === 32) {
			this.checkVertTopology(this.firstX, this.firstY);
		}
	}

	// ---- edges ---------------------------------------------------------------------------------

	private pushPoints(...xy: number[]): void {
		for (let i = 0; i < xy.length; i += 2) {
			this.ptX.push(xy[i]);
			this.ptY.push(xy[i + 1]);
		}
	}

	/** A straight edge: Bresenham over the scanline and column centres it crosses. */
	private calcLine(x0: number, y0: number, x1: number, y1: number): void {
		let n: number;
		let row: number;
		let dyFirst: number;
		let dy: number;
		let ystep: number;
		let yadj: number;
		let bias: number;
		if (y1 >= y0) {
			const c = ((y0 + 32) & ~63) + 32;
			dyFirst = c - y0;
			row = c >> 6;
			dy = y1 - y0;
			n = ((y1 - 33) >> 6) - row + 1;
			ystep = 1;
			yadj = 0;
			bias = 0;
		} else {
			const c = ((y0 - 33) & ~63) + 32;
			dyFirst = y0 - c;
			row = c >> 6;
			dy = y0 - y1;
			n = row - ((y1 + 32) >> 6) + 1;
			ystep = -1;
			yadj = 1;
			bias = 1;
		}
		if (y1 === y0) {
			if (this.noDrop) {
				return;
			}
			// A horizontal edge only meets column centres: its row is the one above (rightwards) or on (leftwards) it.
			row = x1 >= x0 ? (y0 + 32) >> 6 : (y0 + 31) >> 6;
			n = 0;
		}
		let col: number;
		let m: number;
		let dxFirst: number;
		let dx: number;
		let xstep: number;
		let xadj: number;
		let err: number;
		if (x1 >= x0) {
			const c = ((x0 + 32) & ~63) + 32;
			dx = x1 - x0;
			dxFirst = c - x0;
			col = c >> 6;
			xstep = 1;
			xadj = 0;
			err = bias;
			m = ((x1 - 33) >> 6) - col + 1;
			if (x1 === x0) {
				col = y1 > y0 ? (x0 + 31) >> 6 : (x0 + 32) >> 6;
				m = 0;
			}
		} else {
			const c = ((x0 - 33) & ~63) + 32;
			dx = x0 - x1;
			dxFirst = x0 - c;
			col = c >> 6;
			xstep = -1;
			xadj = 1;
			err = 1 - bias;
			m = col - ((x1 + 32) >> 6) + 1;
		}
		// Which lists: edges going up start a row span, edges going left a column span.
		const hList = y1 >= y0 ? this.hStart : this.hEnd;
		const vList = x1 >= x0 ? this.vEnd : this.vStart;
		if (this.smart) {
			this.tagKind = 0;
			this.pushPoints(x1, y1);
			this.tagValue = ((this.ptX.length - 2) << 2) & 0xffff;
		}
		const tag = this.smart ? this.tagValue : 0;
		if (this.noDrop) {
			if (x0 === x1) {
				for (let i = 0; i < n; i++) {
					this.addH(hList, col, row, 0);
					row += ystep;
				}
				return;
			}
			col += xadj;
			err += Math.imul(dx, dyFirst) - Math.imul(dy, dxFirst);
			const total = n + m;
			for (let i = 0; i < total; i++) {
				if (err > 0) {
					col += xstep;
					err -= dy * 64;
				} else {
					this.addH(hList, col, row, 0);
					row += ystep;
					err += dx * 64;
				}
			}
			return;
		}
		if (y0 === y1) {
			for (let i = 0; i < m; i++) {
				this.addV(vList, col, row, tag);
				col += xstep;
			}
			return;
		}
		if (x0 === x1) {
			for (let i = 0; i < n; i++) {
				this.addH(hList, col, row, tag);
				row += ystep;
			}
			return;
		}
		err += Math.imul(dx, dyFirst) - Math.imul(dy, dxFirst);
		const total = n + m;
		for (let i = 0; i < total; i++) {
			if (err > 0) {
				this.addV(vList, col, yadj + row, tag);
				col += xstep;
				err -= dy * 64;
			} else {
				this.addH(hList, xadj + col, row, tag);
				row += ystep;
				err += dx * 64;
			}
		}
	}

	private tagKind = 0;
	private tagValue = 0;

	/**
	 * A quadratic arc that is monotone in x and y. The walk keeps `d`, the value of the arc's implicit function
	 * (F = u^2 / 2 + D (b x - a y), u = Ay x - Ax y, with the arc written from its first point as
	 * 2t(a, b) + t^2 (Ax, Ay)) at the next unvisited corner of a column centre line and a row centre line; whichever of
	 * the two centre lines the arc reaches first is recorded and `d` and its differences step along.
	 */
	private calcSpline(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
		let row: number;
		let rowEnd: number;
		let dyFirst: number;
		let b: number;
		let b2: number;
		let yadj: number;
		let ystep: number;
		if (y2 > y0) {
			const c = ((y0 + 32) & ~63) + 32;
			rowEnd = ((y2 - 33) >> 6) + 1;
			dyFirst = c - y0;
			row = c >> 6;
			b = y1 - y0;
			b2 = y2 - y0;
			yadj = 0;
			ystep = 1;
		} else {
			const c = ((y0 - 33) & ~63) + 32;
			rowEnd = ((y2 + 32) >> 6) - 1;
			dyFirst = y0 - c;
			row = c >> 6;
			b = y0 - y1;
			b2 = y0 - y2;
			yadj = 1;
			ystep = -1;
		}
		let col: number;
		let colEnd: number;
		let dxFirst: number;
		let a: number;
		let a2: number;
		let xadj: number;
		let xstep: number;
		let bias: number;
		if (x2 > x0) {
			const c = ((x0 + 32) & ~63) + 32;
			colEnd = ((x2 - 33) >> 6) + 1;
			dxFirst = c - x0;
			col = c >> 6;
			a = x1 - x0;
			a2 = x2 - x0;
			xadj = 0;
			xstep = 1;
			bias = yadj;
		} else {
			const c = ((x0 - 33) & ~63) + 32;
			colEnd = ((x2 + 32) >> 6) - 1;
			dxFirst = x0 - c;
			col = c >> 6;
			a = x0 - x1;
			a2 = x0 - x2;
			xadj = 1;
			xstep = -1;
			bias = 1 - yadj;
		}
		const hList = y2 > y0 ? this.hStart : this.hEnd;
		// Rows ascending: x ascending lists end spans of columns, x descending start them.
		const vList = x2 > x0 ? this.vEnd : this.vStart;
		let tag = 0;
		if (this.smart) {
			this.pushPoints(x1, y1, x2, y2);
			tag = ((this.ptX.length - 3) << 2 | 1) & 0xffff;
		}
		if (this.noDrop) {
			if (row === rowEnd) {
				return;
			}
			if (col === colEnd) {
				col += xadj;
				for (; row !== rowEnd; row += ystep) {
					this.addH(hList, col, row, 0);
				}
				return;
			}
		} else {
			if (col === colEnd) {
				col += xadj;
				for (; row !== rowEnd; row += ystep) {
					this.addH(hList, col, row, tag);
				}
				return;
			}
			if (row === rowEnd) {
				for (; col !== colEnd; col += xstep) {
					this.addV(vList, col, row + yadj, tag);
				}
				return;
			}
		}
		// Scale the inputs down when they are large enough to overflow the 32-bit products.
		let det = 2 * (a * b2 - a2 * b);
		const sizeBits = bitLength(Math.max(a2, b2));
		const detBits = bitLength(det);
		if (sizeBits > 12 || detBits > 25) {
			throw new MsScanError('arc too large');
		}
		const sh = precisionShift(detBits + sizeBits);
		const S = 6 - sh;
		if (sh > 0) {
			const half = 1 << (sh - 1);
			a2 = (a2 + half) >> sh;
			b2 = (b2 + half) >> sh;
			a = (a + half) >> sh;
			b = (b + half) >> sh;
			dxFirst = (dxFirst + half) >> sh;
			dyFirst = (dyFirst + half) >> sh;
			det = (Math.imul(b2, a) - Math.imul(a2, b)) * 2;
		}
		if (Math.abs(Math.imul(det, a2)) >= 0x23000000 || Math.abs(Math.imul(det, b2)) >= 0x23000000) {
			throw new MsScanError('arc too large');
		}
		const Ax = a2 - 2 * a;
		const Ay = b2 - 2 * b;
		const U = 1 << S;
		const Db = Math.imul(det, b);
		const Da = Math.imul(det, a);
		const Ayy = Math.imul(Ay, Ay);
		const m = -Math.imul(Ay, Ax);
		const P = Math.imul(Ax, Ax);
		let d: number;
		let dx: number; // first difference along x
		let dy: number; // first difference along y
		let Kxx: number;
		let Kxy: number;
		let Kyy: number; // half the second difference along y
		let Kd: number; // threshold of the x difference for det <= 0
		if (sizeBits > 7) {
			const h = U >> 1;
			const t1 = Math.imul(m, dyFirst);
			dx = (Math.imul((dxFirst + h) | 0, Ayy) + t1 + Db) | 0;
			Kd = Ayy << (S - 1);
			Kxy = m << S;
			let r15 = Math.imul((dyFirst + h) | 0, P);
			Kyy = P << (S - 1);
			let e = (Math.imul(P >> 1, dyFirst) - Da) >> S;
			e = Math.imul(e, dyFirst);
			dy = (r15 + Math.imul(m, dxFirst) - Da) | 0;
			let r9 = (Math.imul(Ayy >> 1, dxFirst) + t1 + Db) >> S;
			r9 = (Math.imul(r9, dxFirst) + e) | 0;
			d = (bias + r9) | 0;
			Kxx = 2 * Kd;
		} else {
			const twoM = 2 * m;
			const t2 = 2 * Db;
			let r8 = Math.imul(twoM, dyFirst);
			const negTwoDa = -2 * Da;
			dx = Math.imul((U + 2 * dxFirst) | 0, Ayy);
			let p = Math.imul((U + 2 * dyFirst) | 0, P);
			let r15 = Math.imul(twoM, dxFirst);
			dx = ((dx + r8 + t2) << S) | 0;
			p = (p + negTwoDa) | 0;
			r15 = ((r15 + p) << S) | 0;
			dy = r15;
			Kxy = twoM << (2 * S);
			Kd = Ayy << (2 * S);
			Kyy = P << (2 * S);
			let c = (Math.imul(Ayy, dxFirst) + r8 + t2) | 0;
			let r9 = (negTwoDa + Math.imul(P, dyFirst)) | 0;
			c = Math.imul(c, dxFirst);
			r9 = Math.imul(r9, dyFirst);
			r9 = (r9 + c) | 0;
			d = (bias + r9) | 0;
			Kxx = 2 * Kd;
		}
		const vertical = (): void => {
			if (!this.noDrop) {
				this.addV(vList, col, yadj + row, tag);
			}
			col += xstep;
			d = (d + dx) | 0;
			dx = (dx + Kxx) | 0;
			dy = (dy + Kxy) | 0;
		};
		const horizontal = (): void => {
			this.addH(hList, xadj + col, row, tag);
			d = (d + dy) | 0;
			row += ystep;
			dx = (dx + Kxy) | 0;
			dy = (dy + 2 * Kyy) | 0;
		};
		for (;;) {
			if (col === colEnd) {
				for (; row !== rowEnd; row += ystep) {
					this.addH(hList, xadj + col, row, tag);
				}
				return;
			}
			if (row === rowEnd) {
				if (this.noDrop) {
					return;
				}
				for (; col !== colEnd; col += xstep) {
					this.addV(vList, col, yadj + row, tag);
				}
				return;
			}
			if (det > 0) {
				if (d < 0 || dy > Kyy) {
					vertical();
				} else {
					horizontal();
				}
			} else if (d < 0 || dx > Kd) {
				horizontal();
			} else {
				vertical();
			}
		}
	}

	/**
	 * One edge of the outline (a quadratic arc with its control point): split it at its extremes in y and in x with the
	 * integer de Casteljau of the native code, halve what is longer than 50 pixels, and draw each monotone piece.
	 */
	private evaluateSpline(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
		for (;;) {
			const dx01 = x1 - x0;
			const dx12 = x2 - x1;
			const dy01 = y1 - y0;
			const dy12 = y2 - y1;
			if ((dy01 > 0 && dy12 < 0) || (dy01 < 0 && dy12 > 0)) {
				// Split where y stops: the arc up to the extremum ends flat.
				const den = dy01 - dy12;
				const ax = x0 + compDiv(dx01 * dy01, den);
				const bx = x1 + compDiv(dx12 * dy01, den);
				const mx = ax + compDiv((bx - ax) * dy01, den);
				const my = y0 + compDiv(dy01 * dy01, den);
				this.evaluateSpline(x0, y0, ax, my, mx, my);
				x0 = mx;
				y0 = my;
				x1 = bx;
				y1 = my;
				continue;
			}
			if ((dx01 > 0 && dx12 < 0) || (dx01 < 0 && dx12 > 0)) {
				const den = dx01 - dx12;
				const ay = y0 + compDiv(dy01 * dx01, den);
				const by = y1 + compDiv(dy12 * dx01, den);
				const my = ay + compDiv((by - ay) * dx01, den);
				const mx = x0 + compDiv(dx01 * dx01, den);
				this.evaluateSpline(x0, y0, mx, ay, mx, my);
				x0 = mx;
				y0 = my;
				y1 = by;
				x1 = mx;
				continue;
			}
			if (Math.abs(x2 - x0) > 0xc80 || Math.abs(y2 - y0) > 0xc80) {
				const abx = (x0 + x1) >> 1;
				const aby = (y0 + y1) >> 1;
				const bcx = (x1 + x2) >> 1;
				const bcy = (y1 + y2) >> 1;
				const mx = (abx + bcx) >> 1;
				const my = (aby + bcy) >> 1;
				this.evaluateSpline(x0, y0, abx, aby, mx, my);
				x0 = mx;
				y0 = my;
				x1 = bcx;
				y1 = bcy;
				continue;
			}
			if (!this.enterSegment(x2, y2)) {
				// A point on a centre line: drawn without a history shift (nothing to draw).
			}
			if (Math.imul(dy12, dx01) === Math.imul(dy01, dx12)) {
				this.calcLine(x0, y0, x2, y2);
			} else {
				this.calcSpline(x0, y0, x1, y1, x2, y2);
			}
			return;
		}
	}


	// ---- contours ------------------------------------------------------------------------------

	/** Walks every contour: lines directly, quadratic arcs through `evaluateSpline`. */
	fillGlyph(xs: Int32Array, ys: Int32Array, on: Uint8Array, sp: number[], ep: number[]): void {
		for (let c = 0; c < sp.length; c++) {
			const first = sp[c];
			const last = ep[c];
			if (first === last) {
				continue;
			}
			let px: number;
			let py: number;
			let k: number; // read position: the index after the current point
			let cx: number;
			let cy: number;
			let cOn: boolean;
			let limit: number;
			if (on[last] & 1) {
				// The contour starts at its last point and ends there again.
				px = xs[last];
				py = ys[last];
				k = first;
				cx = xs[k];
				cy = ys[k];
				cOn = (on[k] & 1) !== 0;
				limit = last + 1;
			} else {
				// The last point is off the curve: start at the previous point, or at the midpoint of the two.
				if (on[last - 1] & 1) {
					px = xs[last - 1];
					py = ys[last - 1];
				} else {
					px = (xs[last - 1] + 1 + xs[last]) >> 1;
					py = (ys[last - 1] + 1 + ys[last]) >> 1;
				}
				k = first - 1;
				cx = xs[last];
				cy = ys[last];
				cOn = false;
				limit = last;
			}
			this.curX = px;
			this.curY = py;
			this.prevX = NONE;
			if (this.smart) {
				this.pushPoints(px, py);
			}
			while (k < limit) {
				if (cOn) {
					this.enterSegment(cx, cy);
					this.calcLine(px, py, cx, cy);
					px = cx;
					py = cy;
					k++;
				} else {
					k++;
					let ex = xs[k];
					let ey = ys[k];
					if (on[k] & 1) {
						k++;
					} else {
						ex = (ex + 1 + cx) >> 1;
						ey = (ey + 1 + cy) >> 1;
					}
					this.evaluateSpline(px, py, cx, cy, ex, ey);
					px = ex;
					py = ey;
				}
				if (k === limit) {
					break;
				}
				cx = xs[k];
				cy = ys[k];
				cOn = (on[k] & 1) !== 0;
			}
			this.endContour();
		}
	}

	// ---- bitmap and dropout control ------------------------------------------------------------

	bitmap = new Uint8Array(0);
	private width = 0;

	private getBit(x: number, y: number): boolean {
		if (x < this.xMin || x >= this.xMax || y < this.yMin || y >= this.yMax) {
			return false;
		}
		return this.bitmap[(this.yMax - 1 - y) * this.width + (x - this.xMin)] !== 0;
	}

	private setBit(x: number, y: number): void {
		if (x < this.xMin || x >= this.xMax || y < this.yMin || y >= this.yMax) {
			throw new MsScanError('dropout pixel out of the glyph box');
		}
		this.bitmap[(this.yMax - 1 - y) * this.width + (x - this.xMin)] = 1;
	}

	/** Fills the span between the i-th start and the i-th end of every row, then applies dropout control. */
	fillBitmap(): Uint8Array {
		this.width = this.xMax - this.xMin;
		const height = this.yMax - this.yMin;
		this.bitmap = new Uint8Array(this.width * height);
		for (let y = this.yMin; y < this.yMax; y++) {
			const starts = this.hStart[y - this.yMin].pos;
			const ends = this.hEnd[y - this.yMin].pos;
			const rowBase = (this.yMax - 1 - y) * this.width - this.xMin;
			for (let i = 0; i < starts.length && i < ends.length; i++) {
				const a = Math.min(starts[i], ends[i]);
				const b = Math.max(starts[i], ends[i]);
				for (let x = a; x < b; x++) {
					this.bitmap[rowBase + x] = 1;
				}
			}
		}
		if (!this.noDrop) {
			this.lookForDropouts();
		}
		return this.bitmap;
	}

	private horizCrossings(x: number, row: number): number {
		if (row < this.yMin || row >= this.yMax) {
			return 0;
		}
		const a = this.hStart[row - this.yMin].pos;
		const b = this.hEnd[row - this.yMin].pos;
		let n = 0;
		for (let i = 0; i < a.length; i++) {
			if (a[i] === x) n++;
			if (b[i] === x) n++;
		}
		return n;
	}

	private vertCrossings(col: number, y: number): number {
		if (col < this.xMin || col >= this.xMax) {
			return 0;
		}
		const a = this.vStart[col - this.xMin].pos;
		const b = this.vEnd[col - this.xMin].pos;
		let n = 0;
		for (let i = 0; i < a.length; i++) {
			if (a[i] === y) n++;
			if (b[i] === y) n++;
		}
		return n;
	}

	/** x of the original segment behind a crossing, at the row's centre line, in 26.6. */
	private evalH(tag: number, row: number): number {
		const kind = tag & 3;
		const i = tag >> 2;
		const target = row * 64 + 32;
		const X = this.ptX;
		const Y = this.ptY;
		if (kind === 2) {
			return X[i];
		}
		if (kind === 0) {
			return X[i] + compDiv((target - Y[i]) * (X[i + 1] - X[i]), Y[i + 1] - Y[i]);
		}
		if (kind !== 1) {
			throw new MsScanError('bad crossing tag');
		}
		return bisect(Y[i], Y[i + 1], Y[i + 2], X[i], X[i + 1], X[i + 2], target);
	}

	private evalV(tag: number, col: number): number {
		const kind = tag & 3;
		const i = tag >> 2;
		const target = col * 64 + 32;
		const X = this.ptX;
		const Y = this.ptY;
		if (kind === 2) {
			return Y[i];
		}
		if (kind === 0) {
			return Y[i] + compDiv((target - X[i]) * (Y[i + 1] - Y[i]), X[i + 1] - X[i]);
		}
		if (kind !== 1) {
			throw new MsScanError('bad crossing tag');
		}
		return bisect(X[i], X[i + 1], X[i + 2], Y[i], Y[i + 1], Y[i + 2], target);
	}

	private lookForDropouts(): void {
		for (let y = this.yMax - 1; y >= this.yMin; y--) {
			const a = this.hStart[y - this.yMin];
			const b = this.hEnd[y - this.yMin];
			for (let i = 0; i < a.pos.length && i < b.pos.length; i++) {
				if (a.pos[i] === b.pos[i]) {
					this.horizDropout(a.pos[i], y, a.tag[i], b.tag[i]);
				}
			}
		}
		for (let col = this.xMin; col < this.xMax; col++) {
			const a = this.vStart[col - this.xMin];
			const b = this.vEnd[col - this.xMin];
			for (let t = 0; t < a.pos.length; t++) {
				const ia = a.pos.length - 1 - t;
				const ib = b.pos.length - 1 - t;
				if (ib < 0) {
					break;
				}
				if (a.pos[ia] === b.pos[ib]) {
					this.vertDropout(a.pos[ia], col, a.tag[ia], b.tag[ib]);
				}
			}
		}
	}

	private horizDropout(x: number, row: number, tagA: number, tagB: number): void {
		if (this.stubs) {
			if (this.horizCrossings(x, row + 1) + this.vertCrossings(x - 1, row + 1) + this.vertCrossings(x, row + 1) < 2) {
				return;
			}
			if (this.horizCrossings(x, row - 1) + this.vertCrossings(x - 1, row) + this.vertCrossings(x, row) < 2) {
				return;
			}
		}
		if (x > this.xMin && this.getBit(x - 1, row)) {
			return;
		}
		if (x < this.xMax && this.getBit(x, row)) {
			return;
		}
		let p = x - 1;
		if (this.smart) {
			const xa = this.evalH(tagA, row);
			const xb = this.evalH(tagB, row);
			p = (xb - 1 + xa) >> 7;
		}
		p = Math.max(this.xMin, p);
		if (p >= this.xMax) {
			p = this.xMax - 1;
		}
		this.setBit(p, row);
	}

	private vertDropout(y: number, col: number, tagA: number, tagB: number): void {
		if (y < this.yMin || y > this.yMax) {
			return;
		}
		if (this.stubs) {
			if (this.vertCrossings(col - 1, y) + this.horizCrossings(col, y) + this.horizCrossings(col, y - 1) < 2) {
				return;
			}
			if (this.vertCrossings(col + 1, y) + this.horizCrossings(col + 1, y) + this.horizCrossings(col + 1, y - 1) < 2) {
				return;
			}
		}
		if (y > this.yMin && this.getBit(col, y - 1)) {
			return;
		}
		if (y < this.yMax && this.getBit(col, y)) {
			return;
		}
		let p = y - 1;
		if (this.smart) {
			const ya = this.evalV(tagA, col);
			const yb = this.evalV(tagB, col);
			p = (ya - 1 + yb) >> 7;
		}
		p = Math.max(this.yMin, p);
		if (p >= this.yMax) {
			p = this.yMax - 1;
		}
		this.setBit(col, p);
	}
}

/**
 * The value `vs` of a quadratic arc where `ts` reaches `target`, by halving the arc at integer midpoints until a
 * midpoint hits the target exactly (the native `CalcHorizSpSubpix` / `CalcVertSpSubpix`).
 */
function bisect(t0: number, t1: number, t2: number, v0: number, v1: number, v2: number, target: number): number {
	let tl: number;
	let th: number;
	let vl: number;
	let vh: number;
	if (t0 < t2) {
		tl = t0;
		vl = v0;
		th = t2;
		vh = v2;
	} else {
		tl = t2;
		vl = v2;
		th = t0;
		vh = v0;
	}
	let mt = t1;
	let mv = v1;
	let midV = vl;
	for (let guard = 0; guard < 64; guard++) {
		const nextV = (2 * mv + 1 + vh + vl) >> 2;
		const nextT = (tl + 1 + th + 2 * mt) >> 2;
		midV = nextV;
		if (nextT > target) {
			mv = (mv + vl) >> 1;
			mt = (mt + tl) >> 1;
			vh = nextV;
			th = nextT;
		} else if (nextT < target) {
			mv = (mv + vh) >> 1;
			mt = (mt + th) >> 1;
			vl = nextV;
			tl = nextT;
		} else {
			return nextV;
		}
	}
	return midV;
}

/**
 * The native cleanup of coincident points: where two neighbouring points are equal the contour's start moves past
 * one of them and the survivor is marked on-curve; a last point equal to the first drops the first.
 */
function removeDuplicates(xs: Int32Array, ys: Int32Array, on: Uint8Array, sp: number[], ep: number[]): void {
	for (let c = 0; c < sp.length; c++) {
		let s = sp[c];
		const e = ep[c];
		if (s < e) {
			for (let j = s; j < e; j++) {
				if (xs[j + 1] === xs[j] && ys[j + 1] === ys[j]) {
					for (let k = j - 1; k >= s; k--) {
						xs[k + 1] = xs[k];
						ys[k + 1] = ys[k];
						on[k + 1] = on[k];
					}
					s++;
					on[j + 1] |= 1;
				}
			}
			if (s !== e && xs[e] === xs[s] && ys[e] === ys[s]) {
				s++;
				on[e] |= 1;
			}
		}
		sp[c] = s;
	}
}

/**
 * Scan-converts a 26.6 outline the way GDI does. `flags` is the dropout mode (0 simple, 1 simple without stubs,
 * 2 none, 4 smart, 5 smart without stubs); `align` rounds the left edge of the pixel box down to a multiple (4 for
 * the oversampled grid behind grayscale bitmaps). Returns null for an empty glyph or one the native code rejects.
 */
export function msScan(o: MsOutline, flags: number, align = 1): MsBitmap | null {
	const n = o.xs.length;
	const xs = new Int32Array(n);
	const ys = new Int32Array(n);
	const on = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		xs[i] = Math.round(o.xs[i]);
		ys[i] = Math.round(o.ys[i]);
		on[i] = o.onCurve[i] ? 1 : 0;
	}
	const sp: number[] = [];
	const ep: number[] = [];
	let start = 0;
	for (let c = 0; c < o.endPts.length; c++) {
		sp.push(start);
		ep.push(o.endPts[c]);
		start = o.endPts[c] + 1;
	}
	removeDuplicates(xs, ys, on, sp, ep);
	let minX = 0;
	let maxX = 0;
	let minY = 0;
	let maxY = 0;
	let any = false;
	for (let c = 0; c < sp.length; c++) {
		if (sp[c] >= ep[c]) {
			continue;
		}
		for (let i = sp[c]; i <= ep[c]; i++) {
			if (!any) {
				minX = maxX = xs[i];
				minY = maxY = ys[i];
				any = true;
			} else {
				minX = Math.min(minX, xs[i]);
				maxX = Math.max(maxX, xs[i]);
				minY = Math.min(minY, ys[i]);
				maxY = Math.max(maxY, ys[i]);
			}
		}
	}
	if (!any) {
		return null;
	}
	let xMin = (minX + 31) >> 6;
	let xMax = (maxX + 32) >> 6;
	const yMin = (minY + 31) >> 6;
	let yMax = (maxY + 32) >> 6;
	let thin = false;
	if (xMin === xMax) {
		xMax++;
		thin = true;
	}
	if (yMin === yMax) {
		yMax++;
		thin = true;
	}
	xMin &= -align;
	if (thin) {
		// A glyph with no pixel centre in its control box in one direction: no stub test.
		flags &= ~1;
	}
	const scanner = new Scanner(xMin, xMax, yMin, yMax, flags);
	try {
		scanner.fillGlyph(xs, ys, on, sp, ep);
		const data = scanner.fillBitmap();
		return { xMin, xMax, yMin, yMax, data };
	} catch (e) {
		if (e instanceof MsScanError) {
			return null;
		}
		throw e;
	}
}

/** A monochrome glyph bitmap in the converter's bitmap form (`left` and `top` relative to the pen, y up). */
export function msMonoBitmap(o: MsOutline, flags: number): GlyphBitmap | null {
	const r = msScan(o, flags);
	if (!r) {
		return null;
	}
	return { width: r.xMax - r.xMin, height: r.yMax - r.yMin, left: r.xMin, top: r.yMax, data: r.data };
}

/** Samples per pixel along each axis of GDI's grayscale glyphs. */
const GRAY_SAMPLES = 4;

/**
 * A grayscale glyph bitmap the way GDI's `GGO_GRAY4_BITMAP` makes it: the outline is multiplied by 4, scan-converted on
 * that grid (pixel box aligned to a multiple of 4 on the left) and every 4 x 4 block of samples is counted, giving
 * 0..16 per pixel.
 */
export function msGrayBitmap(o: MsOutline, flags: number): GlyphBitmap | null {
	const k = GRAY_SAMPLES;
	const n = o.xs.length;
	const xs = new Array<number>(n);
	const ys = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		xs[i] = Math.round(o.xs[i]) * k;
		ys[i] = Math.round(o.ys[i]) * k;
	}
	const hi = msScan({ xs, ys, onCurve: o.onCurve, endPts: o.endPts }, flags, k);
	if (!hi) {
		return null;
	}
	const left = Math.floor(hi.xMin / k);
	const right = Math.ceil(hi.xMax / k);
	const bottom = Math.floor(hi.yMin / k);
	const top = Math.ceil(hi.yMax / k);
	const width = right - left;
	const height = top - bottom;
	const data = new Uint8Array(width * height);
	const hiWidth = hi.xMax - hi.xMin;
	for (let row = 0; row < hi.yMax - hi.yMin; row++) {
		const y = hi.yMax - 1 - row;
		const gy = top - 1 - Math.floor(y / k);
		for (let col = 0; col < hiWidth; col++) {
			if (hi.data[row * hiWidth + col]) {
				data[gy * width + Math.floor((hi.xMin + col) / k) - left]++;
			}
		}
	}
	return { width, height, left, top, data };
}

/**
 * The scan flags GDI hands its scan converter: the SCANTYPE word when SCANCTRL left dropout control on, 2 (none) when
 * it did not. The converter reads bits 0 to 2 only, so a type of 8 or more acts as its low bits do.
 */
export function msScanFlags(controlOn: boolean, scanType: number): number {
	return controlOn ? scanType & 7 : 2;
}
