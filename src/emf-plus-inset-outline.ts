/**
 * GDI+'s outline of an Inset stroke on a closed figure (`PenAlignment` Inset).
 *
 * Measured with `GraphicsPath.Widen` and `DrawPath` on the same Inset pen (`emfplus-pens`, `scripts/gdi-fixtures`): GDI+ does not offset the
 * figure inward. It draws the pen at twice its width, centered, and clips it to the figure with its hard (aliased) clip: the aliased stroke
 * is those pixels exactly (`SetClip(path)` + `DrawPath` at 2w: 0 differing pixels on a triangle, ellipse, rectangle and closed curve; 60
 * random fractional triangles and 90 random curves exact against `Widen`). For the antialiased stroke it fills the outline of the surviving
 * pixels: `Widen` of an Inset pen returns a polygon on whole-pixel coordinates (whole numbers even when the path is scaled up sixteen times),
 * and an antialiased `DrawPath` equals an antialiased fill of that polygon pixel for pixel on polygons. The polygon is the staircase around
 * the pixel squares `[x, x+1) x [y, y+1)` of the surviving pixels (the pixel with its centre on `(x, y)`) with some corners cut, so the
 * outer and inner edges of the stroke are diagonal runs, not staircases, where GDI+ cuts them.
 *
 * The outline is GDI+'s own region-to-path conversion, read from gdiplus.dll in round 11 (`GpPath::GetWidenedPath` ANDs the stroke of each
 * closed figure, widened at twice the pen's width, with the region of the whole path, and converts the region of the surviving pixels back to a
 * path with `DpRegion::GetOutlinePoints` and `RegionToPath::DiagonalizePath`): {@link traceRegionLoops} walks the span boundaries of the region
 * band by band (set pixels that touch only at a corner are linked or kept apart by where the walk meets them, which replaces the earlier
 * pairing rules measured on 3,000 polygons), and {@link diagonalizeLoop} drops a corner in a few one-pixel cases. The hand-fitted rules they
 * replace left 6 of 120 outlines and 51 of 300 contact cases inexact; all 120 and all 300 are exact now.
 *
 * @module emf-plus-inset-outline
 */

import { rasterizePlusFill, type FixFigure } from './emf-plus-raster';

export interface Corner {
	x: number;
	y: number;
}

/**
 * The coverage (0..255 over `box`) of an Inset stroke on closed figures: `strokeGroups`, the stroke at twice the pen's width, centered (28.4
 * device polygons, one group per figure), clipped to the pixels of `figureFix` (the figures themselves) as GDI+'s hard clip does; antialiased,
 * the outline of the surviving pixels is filled instead (see the module comment), the outline of each figure's own pixels (measured on 80 paths
 * of two or three overlapping figures: 3,251 pixels differ against 6,719 for the outline of all the pixels together). `evenOdd` takes the clip as the even-odd interior of the figures
 * (the Alternate fill mode of a GraphicsPath, its default; a polygon or a Winding path clips by the nonzero interior): measured on 80 paths of
 * two or three overlapping closed polygons, a pixel is kept when it lies in an odd number of the figures and in the stroke (49 of 80 exact,
 * from 9 with the nonzero interior). `half` (PixelOffsetMode Half) moves the samples of the aliased mask half a pixel; the antialiased outline is
 * on the device pixels of that mask and is not moved again (exact on 40 of 40 paths, from none when it was).
 */
export function insetStrokeCoverage(
	strokeGroups: ReadonlyArray<ReadonlyArray<FixFigure>>,
	figureFix: ReadonlyArray<FixFigure>,
	antialias: boolean,
	half: boolean,
	box: { x: number; y: number; w: number; h: number },
	evenOdd: boolean = false,
): Uint8ClampedArray {
	const inside = rasterizePlusFill(figureFix, evenOdd, false, half, box);
	const masks = strokeGroups.map((group) => {
		const mask = rasterizePlusFill(group, false, false, half, box);
		for (let i = 0; i < mask.length; i++) {
			if (inside[i] === 0) {
				mask[i] = 0;
			}
		}
		return mask;
	});
	if (!antialias) {
		const out = masks[0] ?? new Uint8ClampedArray(box.w * box.h);
		for (let k = 1; k < masks.length; k++) {
			for (let i = 0; i < out.length; i++) {
				if (masks[k][i] !== 0) {
					out[i] = 255;
				}
			}
		}
		return out;
	}
	return rasterizePlusFill(
		masks.flatMap((mask) => insetMaskOutline(mask, box.w, box.h, box.x, box.y)),
		false,
		true,
		false,
		box,
	);
}

/**
 * The outline GDI+ fills for the set pixels of `mask` (`w` x `h`, row-major, non-zero is set): the loops of {@link regionOutline}, as flat
 * `x, y` pairs in 28.4 units offset by (`ox`, `oy`) pixels.
 */
export function insetMaskOutline(mask: ArrayLike<number>, w: number, h: number, ox: number, oy: number): number[][] {
	return regionOutline(mask, w, h)
		.filter((l) => l.length >= 3)
		.map((loop) => {
			const flat: number[] = [];
			for (const c of loop) {
				flat.push((c.x + ox) * 16, (c.y + oy) * 16);
			}
			return flat;
		});
}

/** A horizontal band of identical rows of a region: rows `y0` to `y1` (exclusive), its span boundaries are `X[s .. s + n)` (start, end, start, end, ...). */
interface Band {
	y0: number;
	y1: number;
	s: number;
	n: number;
}

/** The band representation of GDI+'s region for the set pixels of `mask`: rows with the same spans are one band, empty rows are no band. */
function maskBands(mask: ArrayLike<number>, w: number, h: number): { bands: Band[]; X: number[] } {
	const bands: Band[] = [];
	const X: number[] = [];
	let prev: number[] | null = null;
	for (let j = 0; j < h; j++) {
		const row: number[] = [];
		let inRun = false;
		for (let i = 0; i < w; i++) {
			const on = mask[j * w + i] !== 0;
			if (on !== inRun) {
				row.push(i);
				inRun = on;
			}
		}
		if (inRun) {
			row.push(w);
		}
		const last = bands[bands.length - 1];
		if (row.length === 0) {
			prev = null;
			continue;
		}
		if (prev && last && last.y1 === j && prev.length === row.length && prev.every((v, k) => v === row[k])) {
			last.y1 = j + 1;
		} else {
			bands.push({ y0: j, y1: j + 1, s: X.length, n: row.length });
			X.push(...row);
		}
		prev = row;
	}
	return { bands, X };
}

/**
 * The boundary loops of a region the way `DpRegion::GetOutlinePoints` walks them: from the first unvisited span boundary of a band (a start
 * boundary traces an outer loop down its left side; an end boundary a hole, down its left side too) down through the bands, along the bottom, and
 * back up the other side. The link to the next band picks the boundary of the same parity that the current one meets there (the largest not
 * above it going down, below it going up), and stops where the neighbouring band does not continue it; so set pixels that touch only at a corner
 * are linked or kept apart by where the loop was approached from, not by a rule of its own. Every loop is a list of corners from its first
 * (a top left one) to its closing one.
 */
function traceRegionLoops(bands: Band[], X: number[]): Corner[][] {
	const nb = bands.length;
	const used = new Uint8Array(X.length + 2);
	const loops: Corner[][] = [];
	for (let bi = 0; bi < nb; bi++) {
		const start = bands[bi];
		for (let e = 0; e < start.n; e++) {
			if (used[start.s + e]) {
				continue;
			}
			const pts: Corner[] = [{ x: X[start.s + e], y: start.y0 }];
			used[start.s + e] = 1;
			const p = e & 1;
			let delta = 1;
			let rsi = bi;
			let r15 = e;
			let closed = false;
			for (let guard = 0; guard < 16 * (X.length + 8) && !closed; guard++) {
				// Descend.
				for (;;) {
					const cur = bands[rsi];
					const next = rsi + 1 < nb ? bands[rsi + 1] : null;
					if (!next || next.y0 !== cur.y1) {
						break;
					}
					const curAbs = cur.s + r15;
					const x = X[curAbs];
					const r11 = next.s;
					const hi = next.n - p - 1;
					let u: number;
					let stop = false;
					if (X[r11 + p] > x) {
						u = p;
					} else if (X[r11 + hi] <= x) {
						break;
					} else {
						let lo = p;
						let top = hi;
						let mid = (top + lo) >> 1;
						while (mid !== lo) {
							if (X[r11 + mid] <= x) {
								lo = mid;
							} else {
								top = mid;
							}
							mid = (lo + top) >> 1;
						}
						u = top;
					}
					if ((u & 1) === p) {
						if (X[r11 + u] >= X[curAbs + 1]) {
							stop = true;
						}
					} else if (r15 <= 0) {
						u -= 1;
					} else if (X[r11 + u - 1] < X[curAbs - 1]) {
						delta = -1;
						stop = true;
					} else {
						u -= 1;
					}
					if (stop) {
						break;
					}
					const xn = X[r11 + u];
					if (x !== xn) {
						pts.push({ x, y: cur.y1 }, { x: xn, y: cur.y1 });
					}
					used[r11 + u] = 1;
					rsi += 1;
					r15 = u;
				}
				// The bottom.
				{
					const cur = bands[rsi];
					pts.push({ x: X[cur.s + r15], y: cur.y1 }, { x: X[cur.s + r15 + delta], y: cur.y1 });
					r15 += delta;
					used[cur.s + r15] = 1;
					delta = -1;
				}
				// Ascend.
				for (;;) {
					const cur = bands[rsi];
					const r13 = rsi - 1;
					if (r13 < bi) {
						break;
					}
					const prev = bands[r13];
					if (prev.y1 !== cur.y0) {
						break;
					}
					const curAbs = cur.s + r15;
					const x = X[curAbs];
					const r11 = prev.s;
					const hi = prev.n - p - 1;
					let idx: number;
					if (X[r11 + hi] < x) {
						idx = hi;
					} else if (X[r11 + p] >= x) {
						break;
					} else {
						let lo = p;
						let top = hi;
						let mid = (top + lo) >> 1;
						while (mid !== lo) {
							if (X[r11 + mid] < x) {
								lo = mid;
							} else {
								top = mid;
							}
							mid = (lo + top) >> 1;
						}
						idx = lo;
					}
					if ((idx & 1) === p) {
						if (r15 < cur.n - 1 && X[r11 + idx + 1] > X[curAbs + 1]) {
							delta = 1;
							break;
						}
						idx += 1;
					} else if (X[r11 + idx] <= X[curAbs - 1]) {
						break;
					}
					const xn = X[r11 + idx];
					if (x !== xn) {
						pts.push({ x, y: cur.y0 }, { x: xn, y: cur.y0 });
					}
					used[r11 + idx] = 1;
					rsi = r13;
					r15 = idx;
				}
				// The top: closed where the loop began, else on to the neighbouring boundary and down again.
				const cur = bands[rsi];
				if (rsi === bi && e === r15 - 1) {
					pts.push({ x: X[cur.s + r15], y: cur.y0 });
					closed = true;
				} else {
					pts.push({ x: X[cur.s + r15], y: cur.y0 }, { x: X[cur.s + r15 + delta], y: cur.y0 });
					r15 += delta;
					used[cur.s + r15] = 1;
					delta = 1;
				}
			}
			if (closed) {
				loops.push(pts);
			}
		}
	}
	return loops;
}

/**
 * Which of the traced (rectilinear) loops are holes: those inside an odd number of the others. GDI+ reverses these after converting
 * (`ConvertRegionOutputToWinding`, which tests the loops' bounding boxes against each other; testing the loops themselves is what the captured
 * outlines follow: 300 of 300 contact cases exact, against 299 with the boxes, and the overlapping figures of `gpx-pen-inset-multi-aa`
 * 4 pixels off against 20).
 */
function nestFlags(raw: Corner[][]): boolean[] {
	return raw.map((l, i) => {
		const px = l[0].x + 0.5, py = l[0].y + 0.5;
		let depth = 0;
		raw.forEach((o, j) => {
			if (j === i) return;
			let inside = false;
			for (let a = 0, b = o.length - 1; a < o.length; b = a++) {
				const pa = o[a], pb = o[b];
				if (pa.y > py !== pb.y > py && px < ((pb.x - pa.x) * (py - pa.y)) / (pb.y - pa.y) + pa.x) inside = !inside;
			}
			if (inside) depth++;
		});
		return depth % 2 === 1;
	});
}

/** The outline GDI+ builds for the region of the set pixels of `mask` (see {@link traceRegionLoops}, {@link diagonalizeLoop}). */
export function regionOutline(mask: ArrayLike<number>, w: number, h: number): Corner[][] {
	const { bands, X } = maskBands(mask, w, h);
	if (bands.length === 0) {
		return [];
	}
	if (bands.length === 1 && bands[0].n === 2) {
		// A region of one rectangle is its four corners as they are.
		const b = bands[0];
		return [[{ x: X[b.s], y: b.y0 }, { x: X[b.s + 1], y: b.y0 }, { x: X[b.s + 1], y: b.y1 }, { x: X[b.s], y: b.y1 }]];
	}
	const raw = traceRegionLoops(bands, X);
	const loops = raw.map(diagonalizeLoop);
	const flags = nestFlags(raw);
	return loops.map((l, i) => (flags[i] ? l.slice().reverse() : l));
}

/**
 * The corner dropping of GDI+'s region-to-path conversion (`RegionToPath::DiagonalizePath` in gdiplus.dll), on the corners `P` of one loop
 * walked counterclockwise from its top left corner (alternating vertical and horizontal edges). A window of three consecutive corners
 * (`A`, `B`, `C`; `A` already written) decides whether the middle one, `B`, is written. With `esi` the signed length of the edge `A` to `B`
 * and `d` that of `B` to `C` (along their own axes, y down, so a down edge and a right edge are positive):
 *
 * - `B` ends a horizontal edge (so `B` to `C` is vertical): it is dropped when `C` is above it (`d < 0`) and `esi === 1` (the edge into it is
 *   one pixel to the right) or `d === -1` (the vertical edge is one pixel high);
 * - `B` ends a vertical edge (so `B` to `C` is horizontal): it is dropped when that edge goes down (`esi > 0`) and `esi === 1` or `d === -1`
 *   (the horizontal edge is one pixel to the left);
 * - otherwise `B` is written. When `B` is dropped `C` is written unconditionally and the window moves on by two.
 *
 * Past the last corner the walk returns to the first one. The first corner is never dropped, and neither is the closing edge's start unless
 * the rule above says so. Written corners are merged into the outline: a corner whose step from the one before is the same step as the next
 * (a run of equal diagonal steps) is not a vertex, any other is. Read from the binary; confirmed against 120 captured `Widen` outlines
 * (`inset-outline.json.gz`: all 120 antialiased renderings exact, from 114) and 299 of 300 contact cases (`inset-contacts.json.gz`).
 */
export function diagonalizeLoop(P: Corner[]): Corner[] {
	const n = P.length;
	const slotP: Corner[] = [P[0], P[0], P[0]];
	const slotLast = [false, false, false];
	let w = 0;
	let cursor = 0;
	const fetch = (): void => {
		const s = w;
		w = (w + 1) % 3;
		if (cursor < n) {
			slotP[s] = P[cursor];
			slotLast[s] = cursor === n - 1;
			cursor++;
		} else {
			slotP[s] = P[0];
			slotLast[s] = false;
		}
	};
	const out: Corner[] = [P[0]];
	let st = 0;
	let p88: Corner = P[0], p90: Corner = P[0];
	let dx = 0, dy = 0;
	const write = (pt: Corner): void => {
		if (st === 0) {
			p88 = pt;
			st = 1;
		} else if (st === 1) {
			p90 = pt;
			dx = pt.x - p88.x;
			dy = pt.y - p88.y;
			st = 2;
		} else {
			const ex = pt.x - p90.x, ey = pt.y - p90.y;
			if (ex === dx && ey === dy) {
				p90 = pt;
			} else {
				out.push(p88);
				p88 = p90;
				dx = ex;
				dy = ey;
				p90 = pt;
			}
		}
	};
	const finish = (): Corner[] => {
		out.push(p88, p90);
		return out;
	};
	fetch();
	fetch();
	fetch();
	let A = 0, B = 1, C = 2;
	let esi: number;
	let r12: number;
	if (slotP[C].y === slotP[B].y) {
		esi = slotP[B].y - slotP[A].y;
		r12 = 1;
	} else {
		esi = slotP[B].x - slotP[A].x;
		r12 = 0;
	}
	for (let guard = 0; guard < 8 * n + 16; guard++) {
		if (slotLast[A]) {
			return finish();
		}
		let skip: boolean;
		let d: number;
		if (r12 === 0) {
			d = slotP[C].y - slotP[B].y;
			skip = d < 0 && (esi === 1 || d === -1);
		} else {
			d = slotP[C].x - slotP[B].x;
			skip = esi > 0 && (esi === 1 || d === -1);
		}
		if (!skip) {
			fetch();
			r12 ^= 1;
			esi = d;
			const oldA = A;
			A = B;
			B = C;
			C = oldA;
			write(slotP[A]);
			continue;
		}
		if (slotLast[B]) {
			return finish();
		}
		fetch();
		fetch();
		const oldA = A;
		const oldC = C;
		const oldB = B;
		A = oldC;
		B = oldA;
		C = oldB;
		esi = r12 === 0 ? slotP[B].x - slotP[A].x : slotP[B].y - slotP[A].y;
		write(slotP[A]);
	}
	return finish();
}
