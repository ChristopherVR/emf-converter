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
	/** Crossing of the previous scanline (NaN on a profile's first row). */
	prevX: number;
}

function newProfile(): Profile {
	return { flags: 0, start: 0, height: 0, xs: [], next: null, X: 0, offset: 0, countL: 0, prevX: NaN };
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

	constructor(private readonly dropOutControl: number, fineArcs = false) {
		// A 1/65536-pixel grid: GDI computes scanline crossings (near)
		// exactly (measured: every coarser grid, including FreeType's
		// 1/4096 and 1/64, matches fewer GetGlyphOutline bitmaps). Conic
		// arcs are split until they span under 1/16 pixel vertically; the
		// span "jitter" tolerance is 1/137 pixel, as in FreeType's
		// high-precision mode.
		this.precBits = 16;
		this.precStep = fineArcs ? 512 : 4096;
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

	/**
	 * GDI rounds the on-curve point implied between two off-curve points to the 26.6 grid, halves up, before scan
	 * converting (native `GetGlyphOutline(GGO_BITMAP)` of 4,415 real-font glyphs: 207 to 75 wrong pixel decisions at
	 * curved edges with that rounding; FreeType's black rasterizer keeps the half and truncates at its own precision).
	 */
	roundImpliedPoints = false;
	/**
	 * Decides a pixel centre that lies exactly on an edge the way GDI's rotated glyphs do (native GetGlyphOutline bitmaps
	 * of diagonal edges through pixel centres): the pixel is in when the contour runs downward there and out when it runs
	 * upward, whatever the sweep direction (see {@link Raster.tieExcluded}).
	 */
	directedTies = false;
	private flipped = false;

	private decomposeContour(o: Outline, first: number, last: number, flipped: boolean): void {
		const px = (i: number): number => this.scaled(flipped ? o.ys[i] : o.xs[i]);
		const py = (i: number): number => this.scaled(flipped ? o.xs[i] : o.ys[i]);
		const mid = (a: number, b: number): number => this.scaled(Math.floor((a + b + 1) / 2));
		const rx = (i: number): number => (flipped ? o.ys[i] : o.xs[i]);
		const ry = (i: number): number => (flipped ? o.xs[i] : o.ys[i]);
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
				if (this.roundImpliedPoints) {
					startX = mid(rx(first), rx(last));
					startY = mid(ry(first), ry(last));
				} else {
					startX = Math.trunc((startX + lastX) / 2);
					startY = Math.trunc((startY + lastY) / 2);
				}
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
			let cxRaw = rx(point);
			let cyRaw = ry(point);
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
					if (this.roundImpliedPoints) {
						this.conicTo(cx, cy, mid(cxRaw, rx(point)), mid(cyRaw, ry(point)));
					} else {
						this.conicTo(cx, cy, Math.trunc((cx + x) / 2), Math.trunc((cy + y) / 2));
					}
					cx = x;
					cy = y;
					cxRaw = rx(point);
					cyRaw = ry(point);
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
		this.flipped = flipped;
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
				p.prevX = p.X;
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
				let skip1 = this.tieExcluded(pl);
				let skip2 = this.tieExcluded(pr);
				if (x1 > x2) {
					[x1, x2] = [x2, x1];
					[skip1, skip2] = [skip2, skip1];
				}
				if (skip1) {
					x1 += 1;
				}
				if (skip2) {
					x2 -= 1;
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

	/**
	 * With `directedTies`, whether the pixel centre exactly on this profile's crossing is left out of the span: it is when
	 * the contour runs upward there (y up) and in when it runs downward. In the sweep over columns a profile runs along +x
	 * (FLOW_UP) or -x, and the direction in y follows from the slope of the crossing.
	 */
	private tieExcluded(p: Profile): boolean {
		if (!this.directedTies || p.X % this.prec !== 0) {
			return false;
		}
		if (!this.flipped) {
			return (p.flags & FLOW_UP) !== 0;
		}
		const d = p.height > 0 ? p.xs[p.offset] - p.X : p.X - p.prevX;
		if (d === 0 || Number.isNaN(d)) {
			return false;
		}
		return ((p.flags & FLOW_UP) !== 0) === (d > 0);
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

/**
 * Rule 4's neighbouring squares for a straight contour. A short tip
 * still continues when its contour leaves through a square's side. Follow
 * the two branches from the dropout crossing so an unrelated lobe of a
 * concave contour cannot supply that continuation. Multiple contours are
 * admitted by MonoStubContours only when their sample neighbourhoods are
 * independent; curves retain the profile rule.
 */
class MonoStubContour {
	private readonly points: [number, number][];
	constructor(o: Outline) {
		this.points = Array.from(o.xs, (x, i) => [x / 64 - 0.5, o.ys[i] / 64 - 0.5]);
	}

	isStub(flipped: boolean, scan: number, crossing: number, lo: number, hi: number, precision: number, _opposite?: number): boolean | null {
		const points = this.points;
		const n = points.length;
		const point = (i: number): [number, number] => flipped ? [points[i][1], points[i][0]] : points[i];
		let edge = -1;
		let distance = Infinity;
		for (let i = 0; i < n; i++) {
			const a = point(i), b = point((i + 1) % n);
			if (a[1] === b[1] || scan < Math.min(a[1], b[1]) || scan > Math.max(a[1], b[1])) continue;
			const x = a[0] + (b[0] - a[0]) * (scan - a[1]) / (b[1] - a[1]);
			if (Math.abs(x - crossing) < distance) {
				distance = Math.abs(x - crossing);
				edge = i;
			}
		}
		// Profile interpolation can differ from the exact line by two ticks.
		// If there is no matching edge, preserve the existing profile decision.
		if (edge < 0 || distance > 2 / precision) return null;
		const trace = (step: number): { side: number; continues: boolean } => {
			let i = step === 1 ? (edge + 1) % n : edge;
			let previous: [number, number] = [crossing, scan];
			let side = 0;
			for (let k = 0; k < n; k++, i = (i + step + n) % n) {
				const p = point(i), dy = p[1] - scan;
				if (!side && dy) side = Math.sign(dy);
				if (side && dy * side < 0) {
					const x = previous[0] + (p[0] - previous[0]) * (scan - previous[1]) / (p[1] - previous[1]);
					return { side, continues: x <= lo || x >= hi };
				}
				if (p[0] <= lo || p[0] >= hi || dy * side >= 1) return { side, continues: true };
				previous = p;
			}
			return { side, continues: false };
		};
		const a = trace(1), b = trace(-1);
		return !(a.side * b.side < 0 && a.continues && b.continues);
	}
}

/** Convexity without quadratic work or floating-point angle comparisons.
 * Consistent turns alone also admit stars; one revolution excludes them.
 */
function convexContour(o: Outline): boolean {
	const edges: [number, number][] = [];
	for (let i = 0; i < o.xs.length; i++) {
		const j = (i + 1) % o.xs.length;
		const dx = o.xs[j] - o.xs[i], dy = o.ys[j] - o.ys[i];
		if (dx || dy) edges.push([dx, dy]);
	}
	if (edges.length < 3) return false;
	const half = (p: [number, number]): number => p[1] > 0 || (p[1] === 0 && p[0] >= 0) ? 0 : 1;
	let direction = 0, revolutions = 0;
	for (let i = 0; i < edges.length; i++) {
		const a = edges[i], b = edges[(i + 1) % edges.length];
		const cross = a[0] * b[1] - a[1] * b[0];
		if (!cross) {
			if (a[0] * b[0] + a[1] * b[1] < 0) return false;
			continue;
		}
		const turn = Math.sign(cross);
		if (direction && direction !== turn) return false;
		direction = turn;
		if (half(a) !== half(b) && half(a) === (turn > 0 ? 1 : 0)) revolutions++;
	}
	return direction !== 0 && revolutions === 1;
}

/** Native continuation for separate convex components. Nearby, overlapping,
 * concave and curved components keep the profile rule: fresh native controls
 * show interactions there that cannot be decided from one contour alone.
 */
class MonoStubContours {
	private constructor(private readonly contours: MonoStubContour[]) {}

	static create(o: Outline): MonoStubContour | MonoStubContours | null {
		// Bound the new pairwise eligibility work (at most 2,016 box pairs).
		// Unusually complex glyphs retain their established profile behavior.
		if (o.endPts.length > 64) return null;
		if (Array.from(o.onCurve).some((p) => !p)) return null;
		if (o.endPts.length === 1) return new MonoStubContour(o);
		const contours: MonoStubContour[] = [];
		const boxes: { xMin: number; xMax: number; yMin: number; yMax: number }[] = [];
		let start = 0;
		for (const end of o.endPts) {
			const xs: number[] = [], ys: number[] = [], onCurve: number[] = [];
			for (let i = start; i <= end; i++) { xs.push(o.xs[i]); ys.push(o.ys[i]); onCurve.push(o.onCurve[i]); }
			const part: Outline = { xs, ys, onCurve, endPts: [end - start] };
			start = end + 1;
			if (!convexContour(part)) return null;
			const box = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
			for (let i = 0; i < part.xs.length; i++) {
				box.xMin = Math.min(box.xMin, part.xs[i]); box.xMax = Math.max(box.xMax, part.xs[i]);
				box.yMin = Math.min(box.yMin, part.ys[i]); box.yMax = Math.max(box.yMax, part.ys[i]);
			}
			// One full pixel separates the neighbouring squares used by each
			// component. This is a conservative scope, not a native font exception.
			if (boxes.some((b) => box.xMin <= b.xMax + 64 && b.xMin <= box.xMax + 64 &&
				box.yMin <= b.yMax + 64 && b.yMin <= box.yMax + 64)) return null;
			boxes.push(box);
			contours.push(new MonoStubContour(part));
		}
		return new MonoStubContours(contours);
	}

	isStub(flipped: boolean, scan: number, crossing: number, lo: number, hi: number, precision: number, opposite: number): boolean | null {
		let owner = -1, otherOwner = -1, result: boolean | null = null;
		for (let i = 0; i < this.contours.length; i++) {
			const a = this.contours[i].isStub(flipped, scan, crossing, lo, hi, precision);
			const b = this.contours[i].isStub(flipped, scan, opposite, lo, hi, precision);
			if (a !== null) {
				if (owner >= 0) return null;
				owner = i; result = a;
			}
			if (b !== null) {
				if (otherOwner >= 0) return null;
				otherOwner = i;
			}
		}
		return owner >= 0 && owner === otherOwner ? result : null;
	}
}

/**
 * Flattens the quadratic arcs of an outline for the stub test: every arc becomes 16 equal parameter steps plus its
 * extrema in x and y, which lie on the 26.6 grid (a rasterizer splits arcs there, and a contour that only just touches
 * a pixel-centre line must touch it on the same grid the test reads). The result is a polygon (all points on-curve).
 */
function flattenForStubs(o: Outline): Outline {
	const xs: number[] = [], ys: number[] = [], endPts: number[] = [];
	let start = 0;
	for (const end of o.endPts) {
		const n = end - start + 1;
		// An explicit on/off sequence with the on-curve point implied between two off-curve points, starting on-curve.
		const pts: { x: number; y: number; on: boolean }[] = [];
		for (let i = 0; i < n; i++) {
			const a = { x: o.xs[start + i], y: o.ys[start + i], on: !!o.onCurve[start + i] };
			const b = { x: o.xs[start + ((i + 1) % n)], y: o.ys[start + ((i + 1) % n)], on: !!o.onCurve[start + ((i + 1) % n)] };
			pts.push(a);
			if (!a.on && !b.on) pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
		}
		const first = pts.findIndex((p) => p.on);
		const seq = pts.slice(first).concat(pts.slice(0, first));
		let cx = seq[0].x, cy = seq[0].y;
		xs.push(cx); ys.push(cy);
		for (let k = 1; k <= seq.length; k++) {
			const p = seq[k % seq.length];
			if (p.on) {
				if (k < seq.length) { xs.push(p.x); ys.push(p.y); }
				cx = p.x; cy = p.y;
				continue;
			}
			const e = seq[(k + 1) % seq.length];
			const steps: { t: number; extremum: boolean }[] = [];
			for (let t = 1; t <= 16; t++) steps.push({ t: t / 16, extremum: false });
			for (const [a, b, c] of [[cx, p.x, e.x], [cy, p.y, e.y]]) {
				const den = a - 2 * b + c;
				if (den !== 0) {
					const t = (a - b) / den;
					if (t > 0 && t < 1) steps.push({ t, extremum: true });
				}
			}
			steps.sort((a, b) => a.t - b.t);
			for (let i = 0; i < steps.length; i++) {
				// The arc's last point is the next on-curve point, which the contour's own loop would add again.
				if (k + 1 === seq.length && i === steps.length - 1) break;
				const u = steps[i].t, v = 1 - u;
				let x = v * v * cx + 2 * v * u * p.x + u * u * e.x, y = v * v * cy + 2 * v * u * p.y + u * u * e.y;
				if (steps[i].extremum) { x = Math.round(x); y = Math.round(y); }
				xs.push(x); ys.push(y);
			}
			cx = e.x; cy = e.y; k++;
		}
		endPts.push(xs.length - 1);
		start = end + 1;
	}
	return { xs, ys, onCurve: new Array(xs.length).fill(1), endPts };
}

/**
 * Stub test of TrueType dropout control, read as the specification words it (rule 4 of SCANTYPE 1 and rule 6 of
 * SCANTYPE 5, https://learn.microsoft.com/en-us/typography/opentype/spec/tt_instructions#scantype): a dropout between
 * two pixel centres is kept only if the contours continue to intersect the neighbouring scan lines in both directions,
 * judged on "the scanline segments that form a square with the intersected scan line segment" and "they could be
 * different contours than the ones intersecting the dropout scan line segment". Here the square on each side of the
 * dropout segment (the neighbouring scan segment and the two segments that join it to the dropout's pixel centres) must
 * be crossed by contours at least once. A contour that only touches a segment counts as crossing it twice (a vertex
 * on the segment's line with both neighbours on one side), one that runs through it as once; the neighbouring
 * scan segment is closed at both ends, the two joining segments are open.
 *
 * Measured against native GetGlyphOutline bitmaps (single decisions isolated by flipping one decision at a time in
 * 9,070 glyphs of the private polygon fonts): 9,061 are classified right; this reads the specification, nothing else
 * (FreeType's profile rule, which the earlier code followed, disagreed with it on curves and on several contours).
 */
class StubSquares {
	private readonly contours: [number, number][][] = [];
	constructor(o: Outline) {
		let start = 0;
		for (const end of o.endPts) {
			const pts: [number, number][] = [];
			// Pixel centres are the integers.
			for (let i = start; i <= end; i++) pts.push([o.xs[i] / 64 - 0.5, o.ys[i] / 64 - 0.5]);
			this.contours.push(pts);
			start = end + 1;
		}
	}

	/** Crossings of the line `scan axis = L` (axis 1 in the unflipped frame) within [a, b] of the other axis. */
	private crossings(flipped: boolean, axis: 0 | 1, L: number, a: number, b: number, closed: boolean): number {
		const ax = (flipped ? 1 - axis : axis) as 0 | 1, ot = 1 - ax;
		let n = 0;
		const within = (v: number): boolean => closed ? v >= a && v <= b : v > a && v < b;
		for (const pts of this.contours) {
			const m = pts.length;
			for (let i = 0; i < m; i++) {
				const u = pts[(i + m - 1) % m], v = pts[i], w = pts[(i + 1) % m];
				const sv = Math.sign(v[ax] - L), sw = Math.sign(w[ax] - L);
				if (sv * sw < 0) {
					const t = (L - v[ax]) / (w[ax] - v[ax]);
					if (within(v[ot] + (w[ot] - v[ot]) * t)) n++;
				} else if (sv === 0 && within(v[ot])) {
					const su = Math.sign(u[ax] - L);
					if (sw === 0) n++;
					else if (su === 0) { /* counted with the previous vertex */ }
					else if (su * sw < 0) n++;
					else n += 2;
				}
			}
		}
		return n;
	}

	/** Crossings of the three sides of the unit square on one side (`d` = +1 or -1) of the dropout segment. */
	private side(flipped: boolean, scan: number, lo: number, hi: number, d: number): number {
		const far = scan + d, low = Math.min(scan, far), high = Math.max(scan, far);
		return this.crossings(flipped, 1, far, lo, hi, true) + this.crossings(flipped, 0, lo, low, high, false) + this.crossings(flipped, 0, hi, low, high, false);
	}

	/** Whether the dropout on scan line `scan` between pixel centres `lo` and `hi` is a stub. */
	isStub(flipped: boolean, scan: number, lo: number, hi: number): boolean {
		return this.side(flipped, scan, lo, hi, 1) < 1 || this.side(flipped, scan, lo, hi, -1) < 1;
	}
}

/**
 * Scan lines that lie exactly on a horizontal edge of the outline. A sample centre on the contour is on it (rule 2 of
 * the TrueType scan conversion), so such a line is inked where the closed region is: the union of the spans just above
 * and just below the line. The sweep pairs the crossings of the edges that end and start there and leaves a notch's
 * underside or a counter's upper side out. `local` is in sample units of 1/64 with the centre of row r at 64 r + 32.
 */
function fillTieRows(local: Outline, curved: boolean, data: Uint8Array, width: number, height: number, at: (col: number, row: number) => number): void {
	const rows = new Set<number>();
	let start = 0;
	for (const end of local.endPts) {
		for (let i = start; i <= end; i++) {
			const j = i === end ? start : i + 1;
			if (!local.onCurve[i] || !local.onCurve[j] || local.ys[i] !== local.ys[j] || local.xs[i] === local.xs[j]) continue;
			const row = (local.ys[i] - 32) / 64;
			if (row === Math.round(row) && row >= 0 && row < height) rows.add(row);
		}
		start = end + 1;
	}
	if (!rows.size) return;
	const polygon = curved ? flattenForStubs(local) : local;
	const edges: [number, number, number, number][] = [];
	start = 0;
	for (const end of polygon.endPts) {
		for (let i = start; i <= end; i++) {
			const j = i === end ? start : i + 1;
			if (polygon.ys[i] !== polygon.ys[j]) edges.push([polygon.xs[i], polygon.ys[i], polygon.xs[j], polygon.ys[j]]);
		}
		start = end + 1;
	}
	for (const row of rows) {
		const y = 64 * row + 32;
		const spans: [number, number][] = [];
		for (const side of [-1, 1]) {
			const level = y + side * 1e-3;
			const crossings: [number, number][] = [];
			for (const [x0, y0, x1, y1] of edges) {
				if ((y0 <= level) === (y1 <= level)) continue;
				crossings.push([x0 + (x1 - x0) * (level - y0) / (y1 - y0), y1 > y0 ? 1 : -1]);
			}
			crossings.sort((a, b) => a[0] - b[0]);
			let winding = 0, from = 0;
			for (const [x, d] of crossings) {
				const before = winding;
				winding += d;
				if (before === 0 && winding !== 0) from = x;
				else if (before !== 0 && winding === 0) spans.push([from, x]);
			}
		}
		for (const [a, b] of spans) {
			for (let col = Math.max(0, Math.ceil((a - 32) / 64)); col < width && 64 * col + 32 <= b; col++) data[at(col, row)] = 1;
		}
	}
}

/** The pixel box a mono bitmap covers: every pixel whose centre lies in the control box. */
function monoBox(o: Outline): PixelBox | null {
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
	// When the control box covers no sample centre on an axis, GDI assigns
	// its positive/right-or-upper sample, not the nearest one to the box's
	// midpoint (native mono-collapse: every signed phase and both axes).
	const collapsedX = xMin === xMax;
	const collapsedY = yMin === yMax;
	if (collapsedX) xMax += 1;
	if (collapsedY) yMax += 1;
	return { xMin, xMax, yMin, yMax, collapsedX, collapsedY };
}

/** A pixel box: columns [xMin, xMax), rows [yMin, yMax) (y up). */
interface PixelBox {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
	/** GDI supplies a sole sample because this control-box axis contains no pixel centre. */
	collapsedX?: boolean;
	collapsedY?: boolean;
}

/**
 * Rasterises a grid-fitted outline to a 1-bit bitmap (one byte per pixel),
 * with the given dropout mode (see {@link dropoutMode}). The bitmap covers
 * every pixel whose centre lies in the outline's control box, as GDI's
 * glyph black box does, unless `fixedBox` pins it. `smartCrossings26Dot6`
 * enables the measured smart-crossing precision only for a caller's verified
 * upright uniform realization; the default preserves previous arithmetic.
 *
 * `squareStubs` decides the stubs of SCANTYPE 1 and 5 by the specification's squares ({@link StubSquares}); without it
 * the sweep's profiles do (a tip that ends before the next scan line, with FreeType's overshoot exemption and, for
 * single convex or separated straight contours, a neighbouring-square refinement when `stubOvershoot`). `fineArcs`
 * splits quadratic arcs ten times finer (GDI evaluates curved edges almost exactly: native monochrome bitmaps of 1,024
 * generated ovals, 921 exact at FreeType's 1/16 pixel steps, 933 at 1/128). `closedTies` inks a scan line that lies
 * exactly on a horizontal edge where the closed region is ({@link fillTieRows}).
 */
export function rasterizeMono(o: Outline, dropout: number, fixedBox?: PixelBox, stubOvershoot = true, smartCrossings26Dot6 = false, roundImpliedPoints = false, directedTies = false, fineArcs = false, closedTies = false, squareStubs = false): GlyphBitmap | null {
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
	const r = new Raster(dropout, fineArcs);
	r.roundImpliedPoints = roundImpliedPoints;
	r.directedTies = directedTies;
	const P = r.precision;
	const monoContour = !squareStubs && stubOvershoot && (dropout === 1 || dropout === 4 || dropout === 5) ?
		MonoStubContours.create(local) : null;
	const curved = Array.from(local.onCurve).some((p) => !p);
	const squares = squareStubs && (dropout === 1 || dropout === 5) ? new StubSquares(curved ? flattenForStubs(local) : local) : null;
	const roundSmart = squareStubs ? smartCrossings26Dot6 && !curved && (dropout === 1 || dropout === 4 || dropout === 5) : !!(monoContour && smartCrossings26Dot6);
	const smartPixel = (raster: Raster, x1: number, x2: number): number => {
		if (roundSmart) {
			// Native monochrome smart control compares 26.6 crossings, with an
			// exact midpoint tie taking the lower sample (native mono-stubs).
			const step = P / 64;
			x1 = Math.round(x1 / step) * step;
			x2 = Math.round(x2 / step) * step;
		}
		return raster.floorPub(Math.floor((x1 + x2 + Math.floor((P * 63) / 64)) / 2));
	};
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
							pxl = smartPixel(r, x1, x2);
							break;
						case 1:
						case 5:
							// A collapsed control-box axis has only the forced sample;
							// excluding its end stubs would shorten the sole visible stroke.
							const stub = squares ? (box.collapsedX ? false : squares.isStub(false, y, e2 / P, e1 / P)) : monoContour && box.collapsedX ? false : monoContour?.isStub(false, y, x1 / P, e2 / P, e1 / P, P, x2 / P);							if (stub === true) return;
							if (stub == null && left.next === right && left.height <= 0 && !(stubOvershoot && left.flags & OVERSHOOT_TOP && x2 - x1 >= r.half)) {
								return;
							}
							if (stub == null && right.next === left && left.start === y && !(stubOvershoot && left.flags & OVERSHOOT_BOTTOM && x2 - x1 >= r.half)) {
								return;
							}
							pxl = mode === 1 ? e2 : smartPixel(r, x1, x2);
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
		const h = new Raster(dropout, fineArcs);
		h.directedTies = directedTies;
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
								pxl = smartPixel(h, x1, x2);
								break;
							case 1:
							case 5:
								const stub = squares ? (box.collapsedY ? false : squares.isStub(true, col, e2 / P, e1 / P)) : monoContour && box.collapsedY ? false : monoContour?.isStub(true, col, x1 / P, e2 / P, e1 / P, P, x2 / P);
								if (stub === true) return;
								if (stub == null && left.next === right && left.height <= 0 && !(stubOvershoot && left.flags & OVERSHOOT_TOP && x2 - x1 >= h.half)) {
									return;
								}
								if (stub == null && right.next === left && left.start === col && !(stubOvershoot && left.flags & OVERSHOOT_BOTTOM && x2 - x1 >= h.half)) {
									return;
								}
								pxl = mode === 1 ? e2 : smartPixel(h, x1, x2);
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
	if (closedTies) fillTieRows(local, curved, data, width, height, at);
	return { width, height, left: box.xMin, top: box.yMax, data };
}

/** GDI's grayscale oversampling factor per axis (GGO_GRAY4_BITMAP: 4x4 = 16 samples). */
const GRAY_OVERSAMPLE = 4;

/**
 * Scan-converts `o` at `kx` x `ky` samples per pixel (centre rule, no
 * dropout control) on a grid aligned with the pixel grid. `box` is the
 * pixel box (floor/ceil of the control box) and `hi` the 1-bit sample
 * bitmap covering it, `kx * width` by `ky * height`. `dropout` is the
 * scan converter's dropout mode (2 = none); `stubOvershoot` keeps the
 * FreeType exemption that stops a tall overshoot from counting as a stub. `roundImpliedPoints` rounds the on-curve point
 * implied between two off-curve points to the 26.6 grid of the oversampled outline, halves up, as GDI does (see
 * {@link Raster.roundImpliedPoints}; ClearType's scan converter works on the 6x outline).
 */
export function rasterizeSamples(o: Outline, kx: number, ky: number, padX = 0, dropout = 2, stubOvershoot = true, fineArcs = false, closedTies = false, squareStubs = false, roundImpliedPoints = false): { box: PixelBox; hi: GlyphBitmap } | null {
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
	const hi = rasterizeMono(big, dropout, { xMin: box.xMin * kx, xMax: box.xMax * kx, yMin: box.yMin * ky, yMax: box.yMax * ky }, stubOvershoot, false, roundImpliedPoints, false, fineArcs, closedTies, squareStubs);
	return hi ? { box, hi } : null;
}

/**
 * Rasterises a grid-fitted outline the way GDI's ANTIALIASED_QUALITY does:
 * the outline is scaled 4x about the pixel grid, scan-converted with the
 * centre rule and the font's dropout `mode` (2 = none; GDI's grayscale
 * bitmaps and GDI+ AntiAlias text apply the font's scan control to the
 * oversampled outline, stubs excluded for SCANTYPE 1 and 5 without the
 * overshoot exemption), and every 4x4 block of samples is counted, giving a
 * coverage of 0..16 per pixel (`data`).
 */
export function rasterizeGray(o: Outline, dropout = 2, roundImpliedPoints = false, fineArcs = false, squareStubs = false): GlyphBitmap | null {
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
	const hi = rasterizeMono(big, dropout, { xMin: box.xMin * k, xMax: box.xMax * k, yMin: box.yMin * k, yMax: box.yMax * k }, false, false, roundImpliedPoints, false, fineArcs, true, squareStubs);
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
