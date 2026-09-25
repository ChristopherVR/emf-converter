/**
 * Clip-region tracking and boolean combination for Canvas 2D.
 *
 * Canvas 2D natively supports only *intersection* clipping (each `ctx.clip()`
 * call intersects the active clip with the current path). GDI and GDI+ however
 * allow the clip region to be combined with Replace, Intersect, Union, Xor,
 * Exclude, and Complement semantics, plus translation (OffsetClipRgn).
 *
 * This module makes those operations possible by tracking the active clip as a
 * list of {@link ClipShape}s (device-space path-command lists) that are
 * replayed with `ctx.clip(fillRule)`, instead of relying on the opaque canvas
 * clip state. Two properties of the even-odd fill rule do the heavy lifting
 * on the fast paths:
 *
 * - **Subtraction**: clipping with `[huge covering rect] + [shape]` under the
 *   `'evenodd'` rule keeps everything *except* the shape, so `A - B` becomes
 *   an ordinary intersection with the inverse of `B`. This works for any
 *   "parity" shape: an even-odd shape, or a simple nonzero one whose winding
 *   is only ever 0 or +/-1.
 * - **Symmetric difference**: concatenating two parity shapes under
 *   `'evenodd'` yields exactly `A XOR B` (the crossing parities add).
 *
 * Union of two simple shapes whose figures all wind the same way is their
 * nonzero concatenation.
 * Every other combination (a clip that is already an intersection of several
 * shapes, a self-overlapping nonzero path such as an EMR_SELECTCLIPPATH
 * bracket, Union of arbitrary shapes, ...) is evaluated exactly by the
 * scanline engine in `emf-clip-scanline.ts`: both operands are scan-converted
 * at device pixel centres over a finite domain (the canvas), combined span by
 * span, and returned as disjoint pixel-aligned rectangles. That result is a
 * `simple` rect-list shape, so later operations stay on the fast paths.
 *
 * @module emf-clip-region
 */

import {
	deriveClipDomain,
	flattenClipCmds,
	isDomainTruncated,
	scanlineCombineRegions,
	type ClipDomain,
} from './emf-clip-scanline';
import type { CanvasContext } from './emf-types';

export type { ClipDomain } from './emf-clip-scanline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single recorded path command in device (canvas pixel) space. The set
 * mirrors the Canvas 2D path-building calls the replay handlers emit, so a
 * recorded GDI path bracket can be stored verbatim.
 */
export type ClipPathCmd =
	| { op: 'rect'; x: number; y: number; w: number; h: number }
	| { op: 'moveTo'; x: number; y: number }
	| { op: 'lineTo'; x: number; y: number }
	| {
			op: 'bezierCurveTo';
			cp1x: number;
			cp1y: number;
			cp2x: number;
			cp2y: number;
			x: number;
			y: number;
	  }
	| { op: 'arcTo'; x1: number; y1: number; x2: number; y2: number; radius: number }
	| {
			op: 'ellipse';
			cx: number;
			cy: number;
			rx: number;
			ry: number;
			rotation: number;
			startAngle: number;
			endAngle: number;
			ccw: boolean;
	  }
	| { op: 'closePath' };

/**
 * One clip layer: a path (as replayable commands) plus the fill rule to clip
 * with. The active clip region is the intersection of all layers in a list.
 */
export interface ClipShape {
	/** Device-space path commands. */
	cmds: ClipPathCmd[];
	/** Fill rule passed to `ctx.clip()`. */
	fillRule: CanvasFillRule;
	/**
	 * True when the commands form non-overlapping figure(s) filled with the
	 * nonzero rule, i.e. the shape can be safely inverted / composed via the
	 * even-odd trick. Disjoint rectangle lists and typical single closed
	 * figures qualify.
	 */
	simple: boolean;
}

/**
 * The tracked clip region: a list of shapes applied as successive intersecting
 * `ctx.clip()` calls, or `null` for "no clip" (the infinite region).
 */
export type ClipRegion = ClipShape[] | null;

/** Boolean combination operators, matching GDI RGN_* / GDI+ CombineMode. */
export type ClipCombineOp = 'replace' | 'intersect' | 'union' | 'xor' | 'exclude' | 'complement';

/** Result of a clip combination: the new region and whether it is exact. */
export interface ClipCombineResult {
	region: ClipRegion;
	/**
	 * False only when no finite domain was supplied and the result extends
	 * beyond the geometry-derived one (see {@link combineClip}).
	 */
	exact: boolean;
}

// ---------------------------------------------------------------------------
// Shape builders
// ---------------------------------------------------------------------------

/**
 * Half-extent of the "covers everything" rectangle used to express shape
 * inversion under the even-odd rule. Far larger than any canvas (max
 * dimension is capped at 8192 by default) yet small enough to stay exact in
 * float32/float64 arithmetic.
 */
export const CLIP_HUGE = 1 << 24; // 16,777,216 px

/** A single-rectangle clip shape. */
export function rectClipShape(x: number, y: number, w: number, h: number): ClipShape {
	return { cmds: [{ op: 'rect', x, y, w, h }], fillRule: 'nonzero', simple: true };
}

/**
 * A clip shape from a list of rectangles. RGNDATA scanline rectangles are
 * pairwise disjoint, so the result remains `simple`.
 */
export function rectsClipShape(
	rects: Array<{ x: number; y: number; w: number; h: number }>,
): ClipShape {
	return {
		cmds: rects.map((r) => ({ op: 'rect', x: r.x, y: r.y, w: r.w, h: r.h }) as ClipPathCmd),
		fillRule: 'nonzero',
		simple: true,
	};
}

/** An empty clip shape (clips everything away). */
export function emptyClipShape(): ClipShape {
	return { cmds: [{ op: 'rect', x: 0, y: 0, w: 0, h: 0 }], fillRule: 'nonzero', simple: true };
}

/** A clip shape covering the entire drawable plane. */
export function infiniteClipShape(): ClipShape {
	return rectClipShape(-CLIP_HUGE, -CLIP_HUGE, 2 * CLIP_HUGE, 2 * CLIP_HUGE);
}

// ---------------------------------------------------------------------------
// Shape transforms
// ---------------------------------------------------------------------------

/** Translate a shape by (dx, dy) device pixels; returns a new shape. */
export function translateClipShape(shape: ClipShape, dx: number, dy: number): ClipShape {
	return {
		...shape,
		cmds: shape.cmds.map((c): ClipPathCmd => {
			switch (c.op) {
				case 'rect':
					return { ...c, x: c.x + dx, y: c.y + dy };
				case 'moveTo':
				case 'lineTo':
					return { ...c, x: c.x + dx, y: c.y + dy };
				case 'bezierCurveTo':
					return {
						...c,
						cp1x: c.cp1x + dx,
						cp1y: c.cp1y + dy,
						cp2x: c.cp2x + dx,
						cp2y: c.cp2y + dy,
						x: c.x + dx,
						y: c.y + dy,
					};
				case 'arcTo':
					return { ...c, x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy };
				case 'ellipse':
					return { ...c, cx: c.cx + dx, cy: c.cy + dy };
				case 'closePath':
					return c;
			}
		}),
	};
}

/** Translate every shape of a region by (dx, dy); `null` stays `null`. */
export function translateClipRegion(region: ClipRegion, dx: number, dy: number): ClipRegion {
	if (!region) {
		return null;
	}
	return region.map((s) => translateClipShape(s, dx, dy));
}

// ---------------------------------------------------------------------------
// Boolean combination
// ---------------------------------------------------------------------------

/** True when the shape is a simple nonzero shape (winding 0 or +/-1 only). */
function isComposable(shape: ClipShape): boolean {
	return shape.simple && shape.fillRule === 'nonzero';
}

/**
 * True when membership of the shape equals "odd crossing parity": an
 * even-odd shape, or a composable nonzero one. Such shapes invert exactly
 * with the huge-rect trick and XOR exactly by even-odd concatenation.
 */
function isParity(shape: ClipShape): boolean {
	return shape.fillRule === 'evenodd' || isComposable(shape);
}

/**
 * Common orientation of a simple shape's figures: +1 / -1 when every figure
 * with non-zero area winds the same way (sign of its signed area), 0 when no
 * figure has area, and `NaN` for mixed orientations. Because a simple
 * shape's figures do not overlap, each figure's interior has winding equal
 * to its orientation.
 */
function figureOrientation(shape: ClipShape): number {
	let o = 0;
	for (const poly of flattenClipCmds(shape.cmds)) {
		let area2 = 0;
		const n = poly.length / 2;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			area2 += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
		}
		const s = Math.abs(area2) < 1e-9 ? 0 : Math.sign(area2);
		if (s === 0) {
			continue;
		}
		if (o !== 0 && s !== o) {
			return NaN;
		}
		o = s;
	}
	return o;
}

/**
 * True when the nonzero concatenation of two composable shapes is exactly
 * their union: every figure of both winds the same way, so overlaps reach
 * winding +/-2 and opposite windings can never cancel out.
 */
function canConcatUnion(a: ClipShape, b: ClipShape): boolean {
	if (!isComposable(a) || !isComposable(b)) {
		return false;
	}
	const oa = figureOrientation(a);
	const ob = figureOrientation(b);
	return !Number.isNaN(oa) && !Number.isNaN(ob) && (oa === 0 || ob === 0 || oa === ob);
}

/**
 * The inverse of a parity shape: a huge covering rect concatenated with the
 * shape's own commands, filled even-odd. Points inside the shape gain one
 * extra crossing (excluded); everything else stays included.
 */
function invertClipShape(shape: ClipShape): ClipShape {
	return {
		cmds: [
			{ op: 'rect', x: -CLIP_HUGE, y: -CLIP_HUGE, w: 2 * CLIP_HUGE, h: 2 * CLIP_HUGE },
			...shape.cmds,
		],
		fillRule: 'evenodd',
		simple: false,
	};
}

/** A point far outside any finite geometry, used to test unboundedness. */
const FAR_PROBE: ClipDomain = { x: 1 << 23, y: 1 << 23, w: 1, h: 1 };

/**
 * Exact fallback: evaluate `current op incoming` with the scanline engine
 * and return the result as a simple, disjoint rect-list shape.
 *
 * With an explicit `domain` the result is exact inside it (and the caller
 * never draws outside it). Without one, the domain is derived from the
 * operands' finite geometry, and the result is reported exact only when it
 * does not extend beyond that box (i.e. it is bounded).
 */
function scanlineCombine(
	current: ClipRegion,
	incoming: ClipRegion,
	op: ClipCombineOp,
	domain: ClipDomain | undefined,
): ClipCombineResult {
	const dom = domain ?? deriveClipDomain(current, incoming);
	const rects = scanlineCombineRegions(current, incoming, op, dom);
	let exact = !isDomainTruncated(dom);
	if (!domain && scanlineCombineRegions(current, incoming, op, FAR_PROBE).length > 0) {
		// Unbounded result clipped to a geometry-derived box.
		exact = false;
	}
	return { region: [rects.length > 0 ? rectsClipShape(rects) : emptyClipShape()], exact };
}

/**
 * Combine the current clip region with a new shape.
 *
 * Semantics (matching GDI `ExtSelectClipRgn` / GDI+ `CombineMode`):
 * - `replace`    -> new = shape
 * - `intersect`  -> new = current AND shape
 * - `union`      -> new = current OR shape
 * - `xor`        -> new = (current OR shape) - (current AND shape)
 * - `exclude`    -> new = current - shape
 * - `complement` -> new = shape - current
 *
 * Operations expressible as stacked `ctx.clip()` layers keep their vector
 * form (see the module docs). Everything else is resolved exactly by
 * scan conversion over `domain`, the finite device area that will ever be
 * drawn (normally the canvas: `{ x: 0, y: 0, w: canvasW, h: canvasH }`).
 * When `domain` is omitted it is derived from the operands' geometry.
 */
export function combineClip(
	current: ClipRegion,
	shape: ClipShape,
	op: ClipCombineOp,
	domain?: ClipDomain,
): ClipCombineResult {
	switch (op) {
		case 'replace':
			return { region: [shape], exact: true };

		case 'intersect':
			return { region: current ? [...current, shape] : [shape], exact: true };

		case 'exclude': {
			// current - shape == current AND NOT shape
			if (isParity(shape)) {
				const inv = invertClipShape(shape);
				return { region: current ? [...current, inv] : [inv], exact: true };
			}
			return scanlineCombine(current, [shape], op, domain);
		}

		case 'union': {
			if (!current) {
				// infinite OR anything = infinite
				return { region: null, exact: true };
			}
			if (current.length === 1 && canConcatUnion(current[0], shape)) {
				// Same-orientation simple shapes: nonzero concatenation is exactly
				// the union (overlaps reach winding 2, never 0).
				return {
					region: [
						{ cmds: [...current[0].cmds, ...shape.cmds], fillRule: 'nonzero', simple: false },
					],
					exact: true,
				};
			}
			return scanlineCombine(current, [shape], op, domain);
		}

		case 'xor': {
			if (!current) {
				// infinite XOR shape = NOT shape
				if (isParity(shape)) {
					return { region: [invertClipShape(shape)], exact: true };
				}
				return scanlineCombine(current, [shape], op, domain);
			}
			if (current.length === 1 && isParity(current[0]) && isParity(shape)) {
				// Even-odd over the concatenation is exactly the symmetric difference.
				return {
					region: [
						{ cmds: [...current[0].cmds, ...shape.cmds], fillRule: 'evenodd', simple: false },
					],
					exact: true,
				};
			}
			return scanlineCombine(current, [shape], op, domain);
		}

		case 'complement': {
			// shape - current
			if (!current) {
				// shape - infinite = empty
				return { region: [emptyClipShape()], exact: true };
			}
			if (current.length === 1 && isParity(current[0])) {
				return { region: [shape, invertClipShape(current[0])], exact: true };
			}
			return scanlineCombine(current, [shape], op, domain);
		}
	}
}

/**
 * Combine two full regions (each an intersection list or `null` = infinite).
 *
 * Delegates to {@link combineClip} when the incoming region is a single
 * shape. Multi-shape and infinite incoming regions keep the vector form for
 * `replace` / `intersect`, the infinite-operand identities, and inversions of
 * a single parity shape; all other combinations are resolved exactly by
 * scan conversion over `domain` (see {@link combineClip}).
 */
export function combineClipRegions(
	current: ClipRegion,
	incoming: ClipRegion,
	op: ClipCombineOp,
	domain?: ClipDomain,
): ClipCombineResult {
	if (op === 'replace') {
		return { region: incoming, exact: true };
	}
	if (incoming && incoming.length === 1) {
		return combineClip(current, incoming[0], op, domain);
	}

	if (!incoming) {
		// Incoming operand is the infinite region.
		switch (op) {
			case 'intersect':
				return { region: current, exact: true };
			case 'union':
				return { region: null, exact: true };
			case 'exclude':
				// current - infinite = empty
				return { region: [emptyClipShape()], exact: true };
			case 'xor':
			case 'complement': {
				// Both reduce to NOT current (infinite - current / symmetric difference).
				if (!current) {
					return { region: [emptyClipShape()], exact: true };
				}
				if (current.length === 1 && isParity(current[0])) {
					return { region: [invertClipShape(current[0])], exact: true };
				}
				return scanlineCombine(current, incoming, op, domain);
			}
		}
	}

	// Incoming region is an intersection of zero, two, or more shapes.
	switch (op) {
		case 'intersect':
			return { region: current ? [...current, ...incoming] : incoming, exact: true };
		case 'union':
			if (!current) {
				return { region: null, exact: true };
			}
			return scanlineCombine(current, incoming, op, domain);
		case 'complement': {
			// incoming - current == incoming AND NOT current
			if (!current) {
				return { region: [emptyClipShape()], exact: true };
			}
			if (current.length === 1 && isParity(current[0])) {
				return { region: [...incoming, invertClipShape(current[0])], exact: true };
			}
			return scanlineCombine(current, incoming, op, domain);
		}
		case 'xor':
		case 'exclude':
			return scanlineCombine(current, incoming, op, domain);
	}
}

// ---------------------------------------------------------------------------
// Canvas application
// ---------------------------------------------------------------------------

/** Replay recorded path commands onto a canvas context (no beginPath). */
export function replayClipCmds(ctx: CanvasContext, cmds: ClipPathCmd[]): void {
	for (const c of cmds) {
		switch (c.op) {
			case 'rect':
				ctx.rect(c.x, c.y, c.w, c.h);
				break;
			case 'moveTo':
				ctx.moveTo(c.x, c.y);
				break;
			case 'lineTo':
				ctx.lineTo(c.x, c.y);
				break;
			case 'bezierCurveTo':
				ctx.bezierCurveTo(c.cp1x, c.cp1y, c.cp2x, c.cp2y, c.x, c.y);
				break;
			case 'arcTo':
				ctx.arcTo(c.x1, c.y1, c.x2, c.y2, c.radius);
				break;
			case 'ellipse':
				ctx.ellipse(c.cx, c.cy, c.rx, c.ry, c.rotation, c.startAngle, c.endAngle, c.ccw);
				break;
			case 'closePath':
				ctx.closePath();
				break;
		}
	}
}

/**
 * Apply every shape of a region as successive `ctx.clip()` calls.
 * The caller is responsible for the surrounding `ctx.save()` bracket.
 */
export function applyClipShapes(ctx: CanvasContext, shapes: ClipShape[]): void {
	for (const s of shapes) {
		ctx.beginPath();
		replayClipCmds(ctx, s.cmds);
		try {
			ctx.clip(s.fillRule);
		} catch {
			/* ignore clip errors (e.g. degenerate paths) */
		}
	}
}

/**
 * Rebuild the canvas clip state from a tracked region.
 *
 * Unwinds every save made for clipping (restoring the pre-clip canvas state),
 * then, when a region is active, opens a single fresh save bracket and
 * replays all clip shapes into it. Contexts that never touch clipping keep a
 * `clipSaveDepth` of 0 and are unaffected.
 */
export function reapplyClipRegion(
	holder: { ctx: CanvasContext; clipSaveDepth: number },
	region: ClipRegion,
	identityTransform = false,
): void {
	const { ctx } = holder;
	while (holder.clipSaveDepth > 0) {
		ctx.restore();
		holder.clipSaveDepth--;
	}
	if (region) {
		ctx.save();
		holder.clipSaveDepth = 1;
		if (identityTransform) {
			// Clip shapes are recorded in device space; neutralise any active
			// world transform so they clip where they were recorded.
			ctx.setTransform(1, 0, 0, 1, 0, 0);
		}
		applyClipShapes(ctx, region);
	}
}
