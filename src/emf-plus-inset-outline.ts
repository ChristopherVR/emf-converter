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
 * The cut is a local rule on the loop's corners (read off 65,000 corners of `Widen` outlines; see `emf-plus-pen-figures.fixture.test.ts`).
 * Every corner of a staircase ends one vertical edge, at its top or its bottom:
 *
 * - a corner at the top of its vertical edge stays;
 * - a corner at the bottom of a vertical edge one row high is cut;
 * - at the bottom of a longer one it stays when the loop turns toward the edge's own side (south then east, west then north), and also
 *   when it turns away (east then north, south then west) only if the horizontal edge is at least two pixels long;
 * - a valley (a horizontal edge with both vertical edges rising from it) keeps its left corner when the left edge is at least two rows
 *   high and its right corner when the right edge and the valley are both at least two long, or whenever the left edge is one row;
 * - an isolated rectangle (a pixel, or a thin run of pixels) loses its bottom left corner, and its bottom right one when it is a single
 *   pixel wide and more than one tall.
 *
 * Where two set pixels touch only at a corner the loops are traced apart (the unset pixels are joined), with one exception measured on 3,000
 * random Inset polygons (`inset-contacts.json.gz`, `inset-contacts-probe`): a hole whose own loop touches itself at such a corner (the
 * last pixel of a hole, or any dead end) is traced as separate holes. GDI+ pairs the corner that way at all 791 contacts with a self-touching hole where the two pairings differ,
 * and never at a contact between two different loops or on an outer loop, except one in about 3,700 where the pairings differ (`splitAtRepeats`).
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
 * The staircase outline of the set pixels of `mask` (`w` x `h`, row-major, non-zero is set): clockwise loops (y down) with the set pixels
 * on the right, one vertex per corner.
 */
export function traceMaskLoops(mask: ArrayLike<number>, w: number, h: number): Corner[][] {
	const set = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] !== 0;
	// Directed unit edges with the set pixels on the right (clockwise around a set pixel, y down), keyed by their start vertex.
	const stride = w + 1;
	const out = new Map<number, number[]>();
	const add = (x0: number, y0: number, x1: number, y1: number): void => {
		const key = y0 * stride + x0;
		const to = y1 * stride + x1;
		const list = out.get(key);
		if (list) {
			list.push(to);
		} else {
			out.set(key, [to]);
		}
	};
	for (let j = 0; j < h; j++) {
		for (let i = 0; i < w; i++) {
			if (!set(i, j)) {
				continue;
			}
			if (!set(i, j - 1)) add(i, j, i + 1, j);
			if (!set(i + 1, j)) add(i + 1, j, i + 1, j + 1);
			if (!set(i, j + 1)) add(i + 1, j + 1, i, j + 1);
			if (!set(i - 1, j)) add(i, j + 1, i, j);
		}
	}
	const loops: Corner[][] = [];
	for (const [startKey, starts] of out) {
		while (starts.length > 0) {
			// Walk one loop: take the start edge, then follow edges, turning right at a vertex shared by two loops (set pixels that only
			// touch at a corner stay apart).
			const loop: Corner[] = [];
			let from = startKey;
			let to = starts.pop() as number;
			let guard = 0;
			for (;;) {
				const fx = from % stride, fy = (from - fx) / stride;
				loop.push({ x: fx, y: fy });
				if (to === startKey) {
					break;
				}
				const tx = to % stride, ty = (to - tx) / stride;
				const list = out.get(to);
				if (!list || list.length === 0 || ++guard > 4 * (w + 1) * (h + 1)) {
					break;
				}
				let pick = 0;
				if (list.length > 1) {
					const dx = tx - fx, dy = ty - fy;
					let best = -Infinity;
					list.forEach((cand, k) => {
						const cx = cand % stride, cy = (cand - cx) / stride;
						const cross = dx * (cy - ty) - dy * (cx - tx);
						if (cross > best) {
							best = cross;
							pick = k;
						}
					});
				}
				const next = list.splice(pick, 1)[0];
				from = to;
				to = next;
			}
			if (loop.length >= 4) {
				if (signedArea(loop) < 0) {
					// A hole that touches itself at a corner is traced as separate holes (see the module comment).
					loops.push(...splitAtRepeats(loop));
				} else {
					loops.push(loop);
				}
			}
		}
	}
	return loops.map(mergeCollinear).filter((l) => l.length >= 4);
}

/**
 * The outline GDI+ fills for the set pixels of `mask` (`w` x `h`, row-major, non-zero is set): the loops of {@link traceMaskLoops} with
 * their corners cut as GDI+ cuts them (see the module comment), as flat `x, y` pairs in 28.4 units offset by (`ox`, `oy`) pixels.
 */
export function insetMaskOutline(mask: ArrayLike<number>, w: number, h: number, ox: number, oy: number): number[][] {
	return traceMaskLoops(mask, w, h)
		.map(cutCorners)
		.filter((l) => l.length >= 3)
		.map((loop) => {
			const flat: number[] = [];
			for (const c of loop) {
				flat.push((c.x + ox) * 16, (c.y + oy) * 16);
			}
			return flat;
		});
}

/** The shoelace area of a loop in pixel units (y down): positive for the clockwise outer loops, negative for holes. */
function signedArea(loop: Corner[]): number {
	let a = 0;
	for (let i = 0; i < loop.length; i++) {
		const p = loop[i], q = loop[(i + 1) % loop.length];
		a += p.x * q.y - q.x * p.y;
	}
	return a / 2;
}

/** Splits a loop at every vertex it visits twice into the loops between the visits. */
function splitAtRepeats(loop: Corner[]): Corner[][] {
	const out: Corner[][] = [];
	const stack: Corner[] = [];
	const at = new Map<string, number>();
	for (const c of loop) {
		const key = `${c.x},${c.y}`;
		const k = at.get(key);
		if (k !== undefined) {
			const cycle = stack.splice(k);
			for (const d of cycle) {
				at.delete(`${d.x},${d.y}`);
			}
			out.push(cycle);
		}
		at.set(key, stack.length);
		stack.push(c);
	}
	out.push(stack);
	return out;
}

function mergeCollinear(loop: Corner[]): Corner[] {
	const n = loop.length;
	const res: Corner[] = [];
	for (let i = 0; i < n; i++) {
		const a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n];
		if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) {
			res.push(b);
		}
	}
	return res;
}

/** Applies the corner rule of the module comment to one loop (clockwise, y down, alternating horizontal and vertical edges). */
export function cutCorners(loop: Corner[]): Corner[] {
	const n = loop.length;
	if (n < 4) {
		return loop;
	}
	if (n === 4) {
		const x0 = Math.min(...loop.map((c) => c.x)), x1 = Math.max(...loop.map((c) => c.x));
		const y0 = Math.min(...loop.map((c) => c.y)), y1 = Math.max(...loop.map((c) => c.y));
		const width = x1 - x0, height = y1 - y0;
		return loop.filter((c) => {
			if (c.y !== y1) {
				return true;
			}
			return c.x === x0 ? height >= 2 : !(width === 1 && height >= 2);
		});
	}
	const keep = new Array<boolean>(n).fill(true);
	for (let i = 0; i < n; i++) {
		const a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n];
		if (a.x === b.x) {
			// Incoming vertical edge a -> b, outgoing horizontal b -> c: the bottom end of the vertical edge when the loop goes south.
			if (b.y < a.y) {
				continue;
			}
			keep[i] = b.y - a.y >= 2 && (c.x > b.x || Math.abs(c.x - b.x) >= 2);
		} else {
			// Incoming horizontal a -> b, outgoing vertical b -> c: the bottom end of the vertical edge when the loop goes north.
			if (c.y > b.y) {
				continue;
			}
			keep[i] = b.y - c.y >= 2 && (b.x < a.x || Math.abs(b.x - a.x) >= 2);
		}
	}
	// A valley overrides the corner rule at its two ends.
	for (let i = 0; i < n; i++) {
		const p = loop[i], q = loop[(i + 1) % n];
		const before = loop[(i + n - 1) % n], after = loop[(i + 2) % n];
		if (p.y !== q.y || before.y >= p.y || after.y >= q.y) {
			continue;
		}
		const leftFirst = p.x < q.x;
		const li = leftFirst ? i : (i + 1) % n;
		const ri = leftFirst ? (i + 1) % n : i;
		const vl = leftFirst ? p.y - before.y : q.y - after.y;
		const vr = leftFirst ? q.y - after.y : p.y - before.y;
		keep[li] = vl >= 2;
		keep[ri] = (vr >= 2 && Math.abs(q.x - p.x) >= 2) || vl === 1;
	}
	return loop.filter((_, i) => keep[i]);
}
