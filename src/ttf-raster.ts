/**
 * Black-and-white TrueType scan converter with TrueType dropout control.
 *
 * GDI's non-antialiased glyph bitmaps follow the TrueType scan-conversion
 * rules rather than area coverage: a pixel is on when its centre lies inside
 * the grid-fitted outline (rule 1), and, when the font's `SCANCTRL`/
 * `SCANTYPE` enable dropout control, a scanline segment that falls between
 * two pixel centres without covering either still turns one of them on
 * (rule 2, "simple": the left/lower pixel; rule 5, "smart": the pixel
 * nearest the segment's midpoint), optionally ignoring "stubs" (rules 3/4
 * and 6: the tip of a contour that ends exactly between two centres). Both
 * directions are swept: scanlines along x first, then along y for the
 * dropouts a horizontal feature thinner than a pixel causes.
 *
 * The sweep follows the profile-based design of FreeType's "black"
 * rasterizer (`ftraster.c`), which was written to reproduce the Microsoft
 * rasterizer: outlines become y-monotonic profiles, conic arcs are halved
 * until they span under 1/16 pixel, and span, dropout and stub decisions
 * are integer comparisons. One deliberate difference: crossings are kept
 * on a 1/65536-pixel grid at every size, where FreeType uses 1/4096 below
 * 24 ppem and 1/64 above. Measured against `GetGlyphOutline(GGO_BITMAP)`
 * for five faces at 8..72 px, the finer grid matches GDI more often at
 * every size (GDI evidently computes crossings near exactly), and exact
 * ties (a pixel centre on an edge) count as inside, as GDI does.
 *
 * `rasterizeGray` and `rasterizeSamples` reuse the same sweep at 4x4 and
 * 6x1 samples per pixel for GDI's grayscale and ClearType modes.
 *
 * @module ttf-raster
 */

/** A rendered glyph bitmap. `data` holds one byte per pixel (0/1 for mono, 0..levels for gray). */
export interface GlyphBitmap {
	width: number;
	height: number;
	/** Device x of the bitmap's left column, relative to the pen position. */
	left: number;
	/** Device y (pixels above the baseline, y up) of the bitmap's top row. */
	top: number;
	/** Row-major, top row first. */
	data: Uint8Array;
	/** 3 for a ClearType bitmap (R, G, B alpha per pixel, 0..255); omitted = one value per pixel. */
	channels?: 3;
}

/** An outline in 26.6 device units, y up. */
export interface Outline {
	xs: ArrayLike<number>;
	ys: ArrayLike<number>;
	onCurve: ArrayLike<number>;
	endPts: number[];
}

const FLOW_UP = 0x08;
const OVERSHOOT_TOP = 0x10;
const OVERSHOOT_BOTTOM = 0x20;

interface Profile {
	flags: number;
	start: number;
	height: number;
	xs: number[];
	next: Profile | null;
	X: number;
	offset: number;
	countL: number;
}

function newProfile(): Profile {
	return { flags: 0, start: 0, height: 0, xs: [], next: null, X: 0, offset: 0, countL: 0 };
}

const UNKNOWN = 0;
const ASCENDING = 1;
const DESCENDING = 2;

/** Converts SCANCTRL/SCANTYPE state to the rasterizer's dropout mode (0,1,4,5 or 2 = none). */
export function dropoutMode(scanControl: boolean, scanType: number): number {
	if (!scanControl) {
		return 2;
	}
	switch (scanType) {
		case 0:
			return 0;
		case 1:
			return 1;
		case 4:
			return 4;
		case 5:
			return 5;
		default:
			return 2;
	}
}

class Raster {
	private readonly precBits: number;
	private readonly prec: number;
	private readonly precHalf: number;
	private readonly precStep: number;
	private readonly precJitter: number;
	private readonly precScale: number;
	private minY = 0;
	private maxY = 0;
	private profiles: Profile[] = [];
	private cProfile: Profile = newProfile();
	private gProfile: Profile | null = null;
	private fresh = false;
	private joint = false;
	private state = UNKNOWN;
	private lastX = 0;
	private lastY = 0;
	private arcX: number[] = [];
	private arcY: number[] = [];
	private arc = 0;

	constructor(private readonly dropOutControl: number) {
		// A 1/65536-pixel grid: GDI computes scanline crossings (near)
		// exactly (measured: every coarser grid, including FreeType's
		// 1/4096 and 1/64, matches fewer GetGlyphOutline bitmaps). Conic
		// arcs are split until they span under 1/16 pixel vertically; the
		// span "jitter" tolerance is 1/137 pixel, as in FreeType's
		// high-precision mode.
		this.precBits = 16;
		this.precStep = 4096;
		this.precJitter = 480;
		this.prec = 2 ** this.precBits;
		this.precHalf = this.prec / 2;
		this.precScale = this.prec / 64;
	}

	private floorP(x: number): number {
		return Math.floor(x / this.prec) * this.prec;
	}
	private ceilP(x: number): number {
		return Math.floor((x + this.prec - 1) / this.prec) * this.prec;
	}
	private trunc(x: number): number {
		return Math.floor(x / this.prec);
	}
	private frac(x: number): number {
		return x - this.floorP(x);
	}
	private scaled(x: number): number {
		return x * this.precScale - this.precHalf;
	}
	private isBottomOvershoot(y: number): boolean {
		return this.ceilP(y) - y >= this.precHalf;
	}
	private isTopOvershoot(y: number): boolean {
		return y - this.floorP(y) >= this.precHalf;
	}

	// -------------------------------------------------------------------
	// Profile construction
	// -------------------------------------------------------------------

	private newProfileState(state: number, overshoot: boolean): void {
		const p = this.cProfile;
		p.start = 0;
		p.height = 0;
		p.xs = [];
		p.next = null;
		p.flags = this.dropOutControl;
		if (state === ASCENDING) {
			p.flags |= FLOW_UP;
			if (overshoot) p.flags |= OVERSHOOT_BOTTOM;
		} else if (overshoot) {
			p.flags |= OVERSHOOT_TOP;
		}
		if (!this.gProfile) {
			this.gProfile = p;
		}
		this.state = state;
		this.fresh = true;
		this.joint = false;
	}

	private endProfile(overshoot: boolean): void {
		const p = this.cProfile;
		const h = p.xs.length;
		if (h > 0) {
			if (overshoot) {
				p.flags |= p.flags & FLOW_UP ? OVERSHOOT_TOP : OVERSHOOT_BOTTOM;
			}
			p.height = h;
			this.profiles.push(p);
			const slot = newProfile();
			p.next = slot;
			this.cProfile = slot;
		}
		this.joint = false;
	}

	private lineUp(x1: number, y1: number, x2: number, y2: number, miny: number, maxy: number): void {
		let dx = x2 - x1;
		const dy = y2 - y1;
		if (dy <= 0 || y2 < miny || y1 > maxy) {
			return;
		}
		let e1: number;
		let f1: number;
		let e2: number;
		let f2: number;
		if (y1 < miny) {
			x1 += mulDivRound(dx, miny - y1, dy);
			e1 = this.trunc(miny);
			f1 = 0;
		} else {
			e1 = this.trunc(y1);
			f1 = this.frac(y1);
		}
		if (y2 > maxy) {
			e2 = this.trunc(maxy);
			f2 = 0;
		} else {
			e2 = this.trunc(y2);
			f2 = this.frac(y2);
		}
		const xs = this.cProfile.xs;
		if (f1 > 0) {
			if (e1 === e2) {
				return;
			}
			x1 += mulDivRound(dx, this.prec - f1, dy);
			e1 += 1;
		} else if (this.joint) {
			xs.pop();
			this.joint = false;
		}
		this.joint = f2 === 0;
		if (this.fresh) {
			this.cProfile.start = e1;
			this.fresh = false;
		}
		let size = e2 - e1 + 1;
		let ix: number;
		let rx: number;
		if (dx > 0) {
			ix = Math.floor((this.prec * dx) / dy);
			rx = (this.prec * dx) % dy;
			dx = 1;
		} else {
			ix = -Math.floor((this.prec * -dx) / dy);
			rx = (this.prec * -dx) % dy;
			dx = -1;
		}
		let ax = -dy;
		while (size > 0) {
			xs.push(x1);
			x1 += ix;
			ax += rx;
			if (ax >= 0) {
				ax -= dy;
				x1 += dx;
			}
			size--;
		}
	}

	private lineDown(x1: number, y1: number, x2: number, y2: number, miny: number, maxy: number): void {
		const fresh = this.fresh;
		this.lineUp(x1, -y1, x2, -y2, -maxy, -miny);
		if (fresh && !this.fresh) {
			this.cProfile.start = -this.cProfile.start;
		}
	}

	private splitConic(base: number): void {
		const X = this.arcX;
		const Y = this.arcY;
		X[base + 4] = X[base + 2];
		let a = X[base] + X[base + 1];
		let b = X[base + 1] + X[base + 2];
		X[base + 3] = Math.floor(b / 2);
		X[base + 2] = Math.floor((a + b) / 4);
		X[base + 1] = Math.floor(a / 2);
		Y[base + 4] = Y[base + 2];
		a = Y[base] + Y[base + 1];
		b = Y[base + 1] + Y[base + 2];
		Y[base + 3] = Math.floor(b / 2);
		Y[base + 2] = Math.floor((a + b) / 4);
		Y[base + 1] = Math.floor(a / 2);
	}

	private bezierUp(miny: number, maxy: number): void {
		const X = this.arcX;
		const Y = this.arcY;
		let arc = this.arc;
		const xs = this.cProfile.xs;
		let y1 = Y[arc + 2];
		let y2 = Y[arc];
		const fin = (): void => {
			this.arc -= 2;
		};
		if (y2 < miny || y1 > maxy) {
			fin();
			return;
		}
		let e2 = this.floorP(y2);
		if (e2 > maxy) e2 = maxy;
		let e0 = miny;
		let e: number;
		if (y1 < miny) {
			e = miny;
		} else {
			e = this.ceilP(y1);
			const f1 = this.frac(y1);
			e0 = e;
			if (f1 === 0) {
				if (this.joint) {
					xs.pop();
					this.joint = false;
				}
				xs.push(X[arc + 2]);
				e += this.prec;
			}
		}
		if (this.fresh) {
			this.cProfile.start = this.trunc(e0);
			this.fresh = false;
		}
		if (e2 < e) {
			fin();
			return;
		}
		const startArc = arc;
		do {
			this.joint = false;
			y2 = Y[arc];
			if (y2 > e) {
				y1 = Y[arc + 2];
				if (y2 - y1 >= this.precStep) {
					this.splitConic(arc);
					arc += 2;
				} else {
					xs.push(X[arc + 2] + mulDivRound(X[arc] - X[arc + 2], e - y1, y2 - y1));
					arc -= 2;
					e += this.prec;
				}
			} else {
				if (y2 === e) {
					this.joint = true;
					xs.push(X[arc]);
					e += this.prec;
				}
				arc -= 2;
			}
		} while (arc >= startArc && e <= e2);
		fin();
	}

	private bezierDown(miny: number, maxy: number): void {
		const Y = this.arcY;
		const a = this.arc;
		Y[a] = -Y[a];
		Y[a + 1] = -Y[a + 1];
		Y[a + 2] = -Y[a + 2];
		const fresh = this.fresh;
		this.bezierUp(-maxy, -miny);
		if (fresh && !this.fresh) {
			this.cProfile.start = -this.cProfile.start;
		}
		Y[a] = -Y[a];
	}

	private lineTo(x: number, y: number): void {
		switch (this.state) {
			case UNKNOWN:
				if (y > this.lastY) {
					this.newProfileState(ASCENDING, this.isBottomOvershoot(this.lastY));
				} else if (y < this.lastY) {
					this.newProfileState(DESCENDING, this.isTopOvershoot(this.lastY));
				}
				break;
			case ASCENDING:
				if (y < this.lastY) {
					this.endProfile(this.isTopOvershoot(this.lastY));
					this.newProfileState(DESCENDING, this.isTopOvershoot(this.lastY));
				}
				break;
			case DESCENDING:
				if (y > this.lastY) {
					this.endProfile(this.isBottomOvershoot(this.lastY));
					this.newProfileState(ASCENDING, this.isBottomOvershoot(this.lastY));
				}
				break;
		}
		if (this.state === ASCENDING) {
			this.lineUp(this.lastX, this.lastY, x, y, this.minY, this.maxY);
		} else if (this.state === DESCENDING) {
			this.lineDown(this.lastX, this.lastY, x, y, this.minY, this.maxY);
		}
		this.lastX = x;
		this.lastY = y;
	}

	private conicTo(cx: number, cy: number, x: number, y: number): void {
		const X = this.arcX;
		const Y = this.arcY;
		this.arc = 0;
		X[2] = this.lastX;
		Y[2] = this.lastY;
		X[1] = cx;
		Y[1] = cy;
		X[0] = x;
		Y[0] = y;
		let x3 = x;
		let y3 = y;
		do {
			const a = this.arc;
			const y1 = Y[a + 2];
			const y2 = Y[a + 1];
			y3 = Y[a];
			x3 = X[a];
			let ymin: number;
			let ymax: number;
			if (y1 <= y3) {
				ymin = y1;
				ymax = y3;
			} else {
				ymin = y3;
				ymax = y1;
			}
			if (y2 < ymin || y2 > ymax) {
				this.splitConic(a);
				this.arc += 2;
			} else if (y1 === y3) {
				this.arc -= 2;
			} else {
				const stateBez = y1 < y3 ? ASCENDING : DESCENDING;
				if (this.state !== stateBez) {
					const o = stateBez === ASCENDING ? this.isBottomOvershoot(y1) : this.isTopOvershoot(y1);
					if (this.state !== UNKNOWN) {
						this.endProfile(o);
					}
					this.newProfileState(stateBez, o);
				}
				if (stateBez === ASCENDING) {
					this.bezierUp(this.minY, this.maxY);
				} else {
					this.bezierDown(this.minY, this.maxY);
				}
			}
		} while (this.arc >= 0);
		this.lastX = x3;
		this.lastY = y3;
	}

	private decomposeContour(o: Outline, first: number, last: number, flipped: boolean): void {
		const px = (i: number): number => this.scaled(flipped ? o.ys[i] : o.xs[i]);
		const py = (i: number): number => this.scaled(flipped ? o.xs[i] : o.ys[i]);
		let startX = px(first);
		let startY = py(first);
		const lastX = px(last);
		const lastY = py(last);
		let limit = last;
		let point = first;
		if (!o.onCurve[first]) {
			if (o.onCurve[last]) {
				startX = lastX;
				startY = lastY;
				limit--;
			} else {
				startX = Math.trunc((startX + lastX) / 2);
				startY = Math.trunc((startY + lastY) / 2);
			}
			point--;
		}
		this.lastX = startX;
		this.lastY = startY;
		while (point < limit) {
			point++;
			if (o.onCurve[point]) {
				this.lineTo(px(point), py(point));
				continue;
			}
			let cx = px(point);
			let cy = py(point);
			let closed = false;
			while (true) {
				if (point < limit) {
					point++;
					const x = px(point);
					const y = py(point);
					if (o.onCurve[point]) {
						this.conicTo(cx, cy, x, y);
						break;
					}
					this.conicTo(cx, cy, Math.trunc((cx + x) / 2), Math.trunc((cy + y) / 2));
					cx = x;
					cy = y;
					continue;
				}
				this.conicTo(cx, cy, startX, startY);
				closed = true;
				break;
			}
			if (closed) {
				return;
			}
		}
		this.lineTo(startX, startY);
	}

	/** Converts the whole outline to profiles; returns false when nothing is drawable. */
	convert(o: Outline, flipped: boolean, minY: number, maxY: number): boolean {
		this.minY = minY;
		this.maxY = maxY;
		this.profiles = [];
		this.cProfile = newProfile();
		let start = 0;
		for (const end of o.endPts) {
			this.state = UNKNOWN;
			this.gProfile = null;
			if (end >= start) {
				this.decomposeContour(o, start, end, flipped);
			}
			start = end + 1;
			if (this.frac(this.lastY) === 0 && this.lastY >= this.minY && this.lastY <= this.maxY) {
				const first = this.gProfile as Profile | null;
				if (first && (first.flags & FLOW_UP) === (this.cProfile.flags & FLOW_UP)) {
					this.cProfile.xs.pop();
				}
			}
			const lastProfile = this.cProfile;
			let ov: boolean;
			if (this.cProfile.xs.length > 0 && this.cProfile.flags & FLOW_UP) {
				ov = this.isTopOvershoot(this.lastY);
			} else {
				ov = this.isBottomOvershoot(this.lastY);
			}
			this.endProfile(ov);
			if (this.gProfile) {
				lastProfile.next = this.gProfile;
			}
		}
		return this.profiles.length > 0;
	}

	// -------------------------------------------------------------------
	// Sweep
	// -------------------------------------------------------------------

	/**
	 * Sweeps the profiles. `span(y, x1, x2, left, right)` and
	 * `drop(...)` receive the scanline index and the two crossings.
	 */
	sweep(
		span: (y: number, x1: number, x2: number) => void,
		drop: (y: number, x1: number, x2: number, left: Profile, right: Profile) => void,
	): void {
		if (this.profiles.length === 0) {
			return;
		}
		let minYs = Infinity;
		let maxYs = -Infinity;
		for (const p of this.profiles) {
			if (p.flags & FLOW_UP) {
				p.offset = 0;
			} else {
				p.start = p.start - p.height + 1;
				p.offset = p.height - 1;
			}
			if (p.start < minYs) minYs = p.start;
			if (p.start + p.height - 1 > maxYs) maxYs = p.start + p.height - 1;
			p.X = 0;
		}
		const waiting = this.profiles.slice();
		let left: Profile[] = [];
		let right: Profile[] = [];
		const insNew = (list: Profile[], p: Profile): void => {
			let i = 0;
			while (i < list.length && !(p.X < list[i].X)) i++;
			list.splice(i, 0, p);
		};
		const sortList = (list: Profile[]): void => {
			for (const p of list) {
				p.X = p.xs[p.offset];
				p.offset += p.flags & FLOW_UP ? 1 : -1;
				p.height--;
			}
			// Stable sort by X (the rasterizer's bubble sort is stable).
			list.sort((a, b) => a.X - b.X);
		};
		for (let y = minYs; y <= maxYs; y++) {
			for (let i = 0; i < waiting.length; ) {
				const p = waiting[i];
				if (p.start === y) {
					waiting.splice(i, 1);
					insNew(p.flags & FLOW_UP ? left : right, p);
				} else {
					i++;
				}
			}
			sortList(left);
			sortList(right);
			let dropouts = 0;
			const n = Math.min(left.length, right.length);
			for (let i = 0; i < n; i++) {
				const pl = left[i];
				const pr = right[i];
				let x1 = pl.X;
				let x2 = pr.X;
				if (x1 > x2) {
					const t = x1;
					x1 = x2;
					x2 = t;
				}
				const e1 = this.floorP(x1);
				const e2 = this.ceilP(x2);
				if (x2 - x1 <= this.prec && e1 !== x1 && e2 !== x2) {
					if (e1 > e2 || e2 === e1 + this.prec) {
						if ((pl.flags & 7) !== 2) {
							pl.X = x1;
							pr.X = x2;
							pl.countL = 1;
							dropouts++;
						}
						continue;
					}
				}
				span(y, x1, x2);
			}
			if (dropouts > 0) {
				for (let i = 0; i < n; i++) {
					const pl = left[i];
					if (pl.countL) {
						pl.countL = 0;
						drop(y, pl.X, right[i].X, pl, right[i]);
					}
				}
			}
			left = left.filter((p) => p.height > 0);
			right = right.filter((p) => p.height > 0);
		}
	}

	get precision(): number {
		return this.prec;
	}
	get jitter(): number {
		return this.precJitter;
	}
	get half(): number {
		return this.precHalf;
	}
	floorPub(x: number): number {
		return this.floorP(x);
	}
	ceilPub(x: number): number {
		return this.ceilP(x);
	}
	truncPub(x: number): number {
		return this.trunc(x);
	}
}

/** `FT_MulDiv` (rounded) for the rasterizer's crossing interpolation. */
function mulDivRound(a: number, b: number, c: number): number {
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

/** The pixel box a mono bitmap covers: every pixel whose centre lies in the control box. */
function monoBox(o: Outline): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
	const n = o.xs.length;
	if (n === 0) {
		return null;
	}
	let cxMin = Infinity;
	let cxMax = -Infinity;
	let cyMin = Infinity;
	let cyMax = -Infinity;
	for (let i = 0; i < n; i++) {
		const x = o.xs[i];
		const y = o.ys[i];
		if (x < cxMin) cxMin = x;
		if (x > cxMax) cxMax = x;
		if (y < cyMin) cyMin = y;
		if (y > cyMax) cyMax = y;
	}
	let xMin = Math.floor((cxMin + 31) / 64);
	let xMax = Math.floor((cxMax + 32) / 64);
	let yMin = Math.floor((cyMin + 31) / 64);
	let yMax = Math.floor((cyMax + 32) / 64);
	const rem = (v: number, add: number): number => ((v + add) & 63) - add;
	if (xMin === xMax) {
		if (rem(cxMin, 31) + rem(cxMax, 32) < 0) xMin -= 1;
		else xMax += 1;
	}
	if (yMin === yMax) {
		if (rem(cyMin, 31) + rem(cyMax, 32) < 0) yMin -= 1;
		else yMax += 1;
	}
	return { xMin, xMax, yMin, yMax };
}

/** A pixel box: columns [xMin, xMax), rows [yMin, yMax) (y up). */
interface PixelBox {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

/**
 * Rasterises a grid-fitted outline to a 1-bit bitmap (one byte per pixel),
 * with the given dropout mode (see {@link dropoutMode}). The bitmap covers
 * every pixel whose centre lies in the outline's control box, as GDI's
 * glyph black box does, unless `fixedBox` pins it.
 */
export function rasterizeMono(o: Outline, dropout: number, fixedBox?: PixelBox): GlyphBitmap | null {
	const box = fixedBox ?? monoBox(o);
	if (!box) {
		return null;
	}
	const width = box.xMax - box.xMin;
	const height = box.yMax - box.yMin;
	if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
		return null;
	}
	const n = o.xs.length;
	const xs = new Float64Array(n);
	const ys = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		xs[i] = o.xs[i] - box.xMin * 64;
		ys[i] = o.ys[i] - box.yMin * 64;
	}
	const local: Outline = { xs, ys, onCurve: o.onCurve, endPts: o.endPts };
	const data = new Uint8Array(width * height);
	// Pixel (col, rowFromBottom) -> data index.
	const at = (col: number, row: number): number => (height - 1 - row) * width + col;

	// ---- vertical sweep: scanlines are rows ----
	const r = new Raster(dropout);
	const P = r.precision;
	if (r.convert(local, false, 0, (height - 1) * P)) {
		r.sweep(
			(y, x1, x2) => {
				let e1 = r.ceilPub(x1);
				let e2 = r.floorPub(x2);
				if (dropout !== 2 && x2 - x1 - P <= r.jitter && e1 !== x1 && e2 !== x2) {
					e2 = e1;
				}
				e1 = r.truncPub(e1);
				e2 = r.truncPub(e2);
				if (e2 >= 0 && e1 < width && y >= 0 && y < height) {
					if (e1 < 0) e1 = 0;
					if (e2 >= width) e2 = width - 1;
					for (let c = e1; c <= e2; c++) data[at(c, y)] = 1;
				}
			},
			(y, x1, x2, left, right) => {
				let e1 = r.ceilPub(x1);
				let e2 = r.floorPub(x2);
				let pxl = e1;
				if (e1 > e2) {
					const mode = left.flags & 7;
					if (e1 !== e2 + P) {
						return;
					}
					switch (mode) {
						case 0:
							pxl = e2;
							break;
						case 4:
							pxl = r.floorPub(Math.floor((x1 + x2 + Math.floor((P * 63) / 64)) / 2));
							break;
						case 1:
						case 5:
							if (left.next === right && left.height <= 0 && !(left.flags & OVERSHOOT_TOP && x2 - x1 >= r.half)) {
								return;
							}
							if (right.next === left && left.start === y && !(left.flags & OVERSHOOT_BOTTOM && x2 - x1 >= r.half)) {
								return;
							}
							pxl = mode === 1 ? e2 : r.floorPub(Math.floor((x1 + x2 + Math.floor((P * 63) / 64)) / 2));
							break;
						default:
							return;
					}
					if (pxl < 0) pxl = e1;
					else if (r.truncPub(pxl) >= width) pxl = e2;
					const other = r.truncPub(pxl === e1 ? e2 : e1);
					if (other >= 0 && other < width && y >= 0 && y < height && data[at(other, y)]) {
						return;
					}
				}
				const c = r.truncPub(pxl);
				if (c >= 0 && c < width && y >= 0 && y < height) {
					data[at(c, y)] = 1;
				}
			},
		);
	}

	// ---- horizontal sweep: scanlines are columns (dropouts only) ----
	if (dropout !== 2) {
		const h = new Raster(dropout);
		if (h.convert(local, true, 0, (width - 1) * P)) {
			h.sweep(
				(col, x1, x2) => {
					if (x2 - x1 < P) {
						const e1 = h.ceilPub(x1);
						const e2 = h.floorPub(x2);
						if (e1 === e2) {
							const row = h.truncPub(e1);
							if (row >= 0 && row < height && col >= 0 && col < width) {
								data[at(col, row)] = 1;
							}
						}
					}
				},
				(col, x1, x2, left, right) => {
					let e1 = h.ceilPub(x1);
					const e2 = h.floorPub(x2);
					let pxl = e1;
					if (e1 > e2) {
						const mode = left.flags & 7;
						if (e1 !== e2 + P) {
							return;
						}
						switch (mode) {
							case 0:
								pxl = e2;
								break;
							case 4:
								pxl = h.floorPub(Math.floor((x1 + x2 + Math.floor((P * 63) / 64)) / 2));
								break;
							case 1:
							case 5:
								if (left.next === right && left.height <= 0 && !(left.flags & OVERSHOOT_TOP && x2 - x1 >= h.half)) {
									return;
								}
								if (right.next === left && left.start === col && !(left.flags & OVERSHOOT_BOTTOM && x2 - x1 >= h.half)) {
									return;
								}
								pxl = mode === 1 ? e2 : h.floorPub(Math.floor((x1 + x2 + Math.floor((P * 63) / 64)) / 2));
								break;
							default:
								return;
						}
						if (pxl < 0) pxl = e1;
						else if (h.truncPub(pxl) >= height) pxl = e2;
						e1 = h.truncPub(pxl === e1 ? e2 : e1);
						if (e1 >= 0 && e1 < height && col >= 0 && col < width && data[at(col, e1)]) {
							return;
						}
					}
					const row = h.truncPub(pxl);
					if (row >= 0 && row < height && col >= 0 && col < width) {
						data[at(col, row)] = 1;
					}
				},
			);
		}
	}
	return { width, height, left: box.xMin, top: box.yMax, data };
}

/** GDI's grayscale oversampling factor per axis (GGO_GRAY4_BITMAP: 4x4 = 16 samples). */
const GRAY_OVERSAMPLE = 4;

/**
 * Scan-converts `o` at `kx` x `ky` samples per pixel (centre rule, no
 * dropout control) on a grid aligned with the pixel grid. `box` is the
 * pixel box (floor/ceil of the control box) and `hi` the 1-bit sample
 * bitmap covering it, `kx * width` by `ky * height`.
 */
export function rasterizeSamples(o: Outline, kx: number, ky: number, padX = 0): { box: PixelBox; hi: GlyphBitmap } | null {
	const n = o.xs.length;
	if (n === 0) {
		return null;
	}
	let cxMin = Infinity;
	let cxMax = -Infinity;
	let cyMin = Infinity;
	let cyMax = -Infinity;
	for (let i = 0; i < n; i++) {
		cxMin = Math.min(cxMin, o.xs[i]);
		cxMax = Math.max(cxMax, o.xs[i]);
		cyMin = Math.min(cyMin, o.ys[i]);
		cyMax = Math.max(cyMax, o.ys[i]);
	}
	const box: PixelBox = {
		xMin: Math.floor(cxMin / 64) - padX,
		xMax: Math.ceil(cxMax / 64) + padX,
		yMin: Math.floor(cyMin / 64),
		yMax: Math.ceil(cyMax / 64),
	};
	if (box.xMax <= box.xMin) box.xMax = box.xMin + 1;
	if (box.yMax <= box.yMin) box.yMax = box.yMin + 1;
	const big: Outline = {
		xs: Array.from(o.xs, (v) => v * kx),
		ys: Array.from(o.ys, (v) => v * ky),
		onCurve: o.onCurve,
		endPts: o.endPts,
	};
	const hi = rasterizeMono(big, 2, { xMin: box.xMin * kx, xMax: box.xMax * kx, yMin: box.yMin * ky, yMax: box.yMax * ky });
	return hi ? { box, hi } : null;
}

/**
 * Rasterises a grid-fitted outline the way GDI's ANTIALIASED_QUALITY does:
 * the outline is scaled 4x about the pixel grid, scan-converted with the
 * centre rule and no dropout control, and every 4x4 block of samples is
 * counted, giving a coverage of 0..16 per pixel (`data`).
 */
export function rasterizeGray(o: Outline): GlyphBitmap | null {
	const n = o.xs.length;
	if (n === 0) {
		return null;
	}
	let cxMin = Infinity;
	let cxMax = -Infinity;
	let cyMin = Infinity;
	let cyMax = -Infinity;
	for (let i = 0; i < n; i++) {
		cxMin = Math.min(cxMin, o.xs[i]);
		cxMax = Math.max(cxMax, o.xs[i]);
		cyMin = Math.min(cyMin, o.ys[i]);
		cyMax = Math.max(cyMax, o.ys[i]);
	}
	const box: PixelBox = {
		xMin: Math.floor(cxMin / 64),
		xMax: Math.ceil(cxMax / 64),
		yMin: Math.floor(cyMin / 64),
		yMax: Math.ceil(cyMax / 64),
	};
	if (box.xMax <= box.xMin) box.xMax = box.xMin + 1;
	if (box.yMax <= box.yMin) box.yMax = box.yMin + 1;
	const k = GRAY_OVERSAMPLE;
	const big: Outline = {
		xs: Array.from(o.xs, (v) => v * k),
		ys: Array.from(o.ys, (v) => v * k),
		onCurve: o.onCurve,
		endPts: o.endPts,
	};
	const hi = rasterizeMono(big, 2, { xMin: box.xMin * k, xMax: box.xMax * k, yMin: box.yMin * k, yMax: box.yMax * k });
	if (!hi) {
		return null;
	}
	const width = box.xMax - box.xMin;
	const height = box.yMax - box.yMin;
	const data = new Uint8Array(width * height);
	for (let y = 0; y < hi.height; y++) {
		const row = Math.floor(y / k) * width;
		for (let x = 0; x < hi.width; x++) {
			if (hi.data[y * hi.width + x]) {
				data[row + Math.floor(x / k)]++;
			}
		}
	}
	return { width, height, left: box.xMin, top: box.yMax, data };
}
