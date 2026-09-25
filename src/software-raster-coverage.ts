/**
 * Analytic anti-aliased polygon coverage for the pure-JavaScript rasteriser
 * (`software-raster.ts`).
 *
 * Coverage is computed exactly, not by supersampling: every edge adds the
 * signed area it sweeps to an accumulation row (the technique popularised
 * by font-rs and used by modern vector renderers), and a running sum along
 * each row turns those area deltas into each pixel's fractional winding.
 * For the nonzero rule a pixel's coverage is that winding's magnitude
 * clamped to 1; for even-odd the winding is folded with a triangle wave (0
 * at even, 1 at odd windings). Both are the exact covered area for a pixel
 * crossed by one edge (every anti-aliased edge pixel of an ordinary shape),
 * and saturate correctly in the interior of overlapping contours; they only
 * approximate the rare pixel where two edges of opposite direction cross
 * inside the same pixel. Skia (Chromium's and `@napi-rs/canvas`'s
 * rasteriser) also computes area coverage for anti-aliased paths, so edges
 * match it to within a few levels of rounding.
 *
 * The scan is sparse: only the cells an edge touches are visited, and the
 * pixels between two touched cells on a row, whose coverage cannot change,
 * are reported as one run. A large fill therefore costs time in proportion
 * to its edges plus its rows, not its area, and the compositor can fill a
 * fully covered run in one step.
 *
 * Coverage is quantised to 256 levels (`0..255`), like the 8-bit coverage
 * masks Skia composites with: an integer-aligned edge yields exactly 0 or
 * 255, which keeps pixel-aligned fills (GDI rectangles, clip regions, blits)
 * bit-exact.
 *
 * @module software-raster-coverage
 */

/** A half-open integer pixel rectangle `[x0, x1) x [y0, y1)`. */
export interface PixelRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/**
 * Receives a run of pixels `x0 .. x1 - 1` on row `y` that all have
 * coverage `level` (1..255). Runs arrive in increasing `y`, then `x`; zero
 * coverage is never reported.
 */
export type SpanSink = (y: number, x0: number, x1: number, level: number) => void;

/** Largest accumulation band kept alive between calls, in cells. */
const BAND_CELLS = 1 << 20;

let accBuffer = new Float64Array(0);
let markBuffer = new Uint8Array(0);
let touched: number[][] = [];

/** Segment endpoints in band-local x (relative to the left bound), absolute y. */
let segs = new Float64Array(0);

function growSegs(need: number): void {
	if (segs.length < need) {
		const next = new Float64Array(Math.max(need, segs.length * 2, 1024));
		next.set(segs);
		segs = next;
	}
}

/**
 * Adds the signed area of the line (`x0`,`y0`)-(`x1`,`y1`) (band-local
 * coordinates, `0 <= x <= width`) to `acc`, a band of `rows` rows of
 * `stride` cells, recording each touched cell. Downward edges add positive
 * area.
 */
function accumulateLine(
	acc: Float64Array,
	mark: Uint8Array,
	stride: number,
	rows: number,
	width: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): void {
	if (y0 === y1) {
		return;
	}
	let dir = 1;
	if (y0 > y1) {
		dir = -1;
		let t = x0;
		x0 = x1;
		x1 = t;
		t = y0;
		y0 = y1;
		y1 = t;
	}
	const top = Math.max(0, y0);
	const bottom = Math.min(rows, y1);
	if (top >= bottom) {
		return;
	}
	const add = (row: number, cell: number, v: number): void => {
		const i = row * stride + cell;
		acc[i] += v;
		if (!mark[i]) {
			mark[i] = 1;
			touched[row].push(cell);
		}
	};
	const dxdy = (x1 - x0) / (y1 - y0);
	let x = Math.min(width, Math.max(0, x0 + (top - y0) * dxdy));
	const rowEnd = Math.ceil(bottom);
	for (let row = Math.floor(top); row < rowEnd; row++) {
		const dy = Math.min(row + 1, bottom) - Math.max(row, top);
		let xnext = x + dxdy * dy;
		if (xnext < 0) {
			xnext = 0;
		} else if (xnext > width) {
			xnext = width;
		}
		const d = dy * dir;
		const lo = x < xnext ? x : xnext;
		const hi = x < xnext ? xnext : x;
		const loFloor = Math.floor(lo);
		const hiCeil = Math.ceil(hi);
		if (hiCeil <= loFloor + 1) {
			// The edge stays within one pixel column on this row.
			const xmf = 0.5 * (x + xnext) - loFloor;
			add(row, loFloor, d - d * xmf);
			add(row, loFloor + 1, d * xmf);
		} else {
			const s = 1 / (hi - lo);
			const x0f = lo - loFloor;
			const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
			const x1f = hi - hiCeil + 1;
			const am = 0.5 * s * x1f * x1f;
			add(row, loFloor, d * a0);
			if (hiCeil === loFloor + 2) {
				add(row, loFloor + 1, d * (1 - a0 - am));
			} else {
				const a1 = s * (1.5 - x0f);
				add(row, loFloor + 1, d * (a1 - a0));
				for (let xi = loFloor + 2; xi < hiCeil - 1; xi++) {
					add(row, xi, d * s);
				}
				const a2 = a1 + (hiCeil - loFloor - 3) * s;
				add(row, hiCeil - 1, d * (1 - a2 - am));
			}
			add(row, hiCeil, d * am);
		}
		x = xnext;
	}
}

function levelOf(sum: number, evenOdd: boolean): number {
	let c: number;
	if (evenOdd) {
		let a = Math.abs(sum);
		a -= 2 * Math.floor(a / 2);
		c = a > 1 ? 2 - a : a;
	} else {
		c = Math.abs(sum);
		if (c > 1) {
			c = 1;
		}
	}
	return Math.round(c * 255);
}

const byNumber = (a: number, b: number): number => a - b;

/**
 * Rasterises `rings` (flat `x, y, x, y, ...` device-space coordinate lists,
 * each implicitly closed) with `rule`, limited to `bounds`, reporting runs
 * of equal coverage to `sink`. Returns the pixel bounds actually scanned
 * (`null` when nothing lies inside `bounds`).
 */
export function rasterizeRings(
	rings: ReadonlyArray<ArrayLike<number>>,
	rule: CanvasFillRule,
	bounds: PixelRect,
	sink: SpanSink,
): PixelRect | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const r of rings) {
		for (let i = 0; i + 1 < r.length; i += 2) {
			const x = r[i];
			const y = r[i + 1];
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (!(minX <= maxX) || !(minY <= maxY) || !Number.isFinite(minX + maxX + minY + maxY)) {
		return null;
	}
	// Winding accumulated left of the bounds carries across, so edges left
	// of the box are kept (projected onto its left side, below).
	const bx0 = Math.max(bounds.x0, Math.floor(minX));
	const by0 = Math.max(bounds.y0, Math.floor(minY));
	const bx1 = Math.min(bounds.x1, Math.ceil(maxX));
	const by1 = Math.min(bounds.y1, Math.ceil(maxY));
	if (bx1 <= bx0 || by1 <= by0) {
		return null;
	}
	const width = bx1 - bx0;

	// Collect segments in local x, splitting at the left and right bounds:
	// the part left of the box keeps its vertical extent at x = 0 (it still
	// contributes winding to every pixel on its right), the part right of
	// the box contributes to nothing inside it and is dropped.
	let count = 0;
	const push = (xa: number, ya: number, xb: number, yb: number): void => {
		if (ya === yb) {
			return;
		}
		growSegs((count + 1) * 4);
		segs[count * 4] = xa;
		segs[count * 4 + 1] = ya;
		segs[count * 4 + 2] = xb;
		segs[count * 4 + 3] = yb;
		count++;
	};
	const clipX = (xa: number, ya: number, xb: number, yb: number): void => {
		if (ya === yb || Math.max(ya, yb) <= by0 || Math.min(ya, yb) >= by1) {
			return;
		}
		if (xa >= width && xb >= width) {
			return;
		}
		if (xa > width || xb > width) {
			const t = (width - xa) / (xb - xa);
			const ym = ya + (yb - ya) * t;
			if (xa > width) {
				xa = width;
				ya = ym;
			} else {
				xb = width;
				yb = ym;
			}
		}
		if (xa <= 0 && xb <= 0) {
			push(0, ya, 0, yb);
			return;
		}
		if (xa < 0 || xb < 0) {
			const t = (0 - xa) / (xb - xa);
			const ym = ya + (yb - ya) * t;
			if (xa < 0) {
				push(0, ya, 0, ym);
				push(0, ym, xb, yb);
			} else {
				push(xa, ya, 0, ym);
				push(0, ym, 0, yb);
			}
			return;
		}
		push(xa, ya, xb, yb);
	};
	for (const r of rings) {
		const n = r.length >> 1;
		if (n < 2) {
			continue;
		}
		for (let i = 0; i < n; i++) {
			const j = i + 1 < n ? i + 1 : 0;
			clipX(r[i * 2] - bx0, r[i * 2 + 1], r[j * 2] - bx0, r[j * 2 + 1]);
		}
	}
	if (count === 0) {
		return null;
	}

	const stride = width + 2;
	const bandRows = Math.max(1, Math.min(by1 - by0, Math.floor(BAND_CELLS / stride)));
	if (accBuffer.length < bandRows * stride) {
		accBuffer = new Float64Array(bandRows * stride);
		markBuffer = new Uint8Array(bandRows * stride);
	}
	while (touched.length < bandRows) {
		touched.push([]);
	}
	const acc = accBuffer;
	const mark = markBuffer;
	const evenOdd = rule === 'evenodd';
	for (let bandTop = by0; bandTop < by1; bandTop += bandRows) {
		const rows = Math.min(bandRows, by1 - bandTop);
		for (let s = 0; s < count; s++) {
			const o = s * 4;
			const ya = segs[o + 1] - bandTop;
			const yb = segs[o + 3] - bandTop;
			if ((ya <= 0 && yb <= 0) || (ya >= rows && yb >= rows)) {
				continue;
			}
			accumulateLine(acc, mark, stride, rows, width, segs[o], ya, segs[o + 2], yb);
		}
		for (let row = 0; row < rows; row++) {
			const cells = touched[row];
			if (cells.length === 0) {
				continue;
			}
			cells.sort(byNumber);
			const base = row * stride;
			const y = bandTop + row;
			let sum = 0;
			for (let k = 0; k < cells.length; k++) {
				const cell = cells[k];
				sum += acc[base + cell];
				acc[base + cell] = 0;
				mark[base + cell] = 0;
				if (cell >= width) {
					continue;
				}
				const next = k + 1 < cells.length ? Math.min(cells[k + 1], width) : width;
				const level = levelOf(sum, evenOdd);
				if (level) {
					sink(y, bx0 + cell, bx0 + next, level);
				}
			}
			cells.length = 0;
		}
	}
	return { x0: bx0, y0: by0, x1: bx1, y1: by1 };
}
