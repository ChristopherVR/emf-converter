/**
 * Records the geometry issued between `EMR_BEGINPATH` and `EMR_ENDPATH` so it
 * can be replayed later onto an isolated scratch canvas.
 *
 * `EMR_FILLPATH` / `EMR_STROKEANDFILLPATH` / `EMR_STROKEPATH` act on
 * `rCtx.ctx`'s CURRENT path, built imperatively by several preceding
 * `EMR_MOVETOEX` / `EMR_LINETO` / `EMR_POLY*TO` / `EMR_RECTANGLE` /
 * `EMR_ELLIPSE` / `EMR_ARCTO` / etc. records while `rCtx.inPath` is true.
 * That live path cannot be "re-run" on a different context, so it never
 * reached the exact bitwise ROP2 combine (`emf-rop2-exact.ts`), which needs
 * to replay the shape's drawing calls on a scratch canvas; a bracketed path
 * filled/stroked under a bitwise `SetROP2` mode fell back to the
 * approximate colour path unconditionally (a documented residual, see the
 * README), even though the exact combine already worked for every
 * IMMEDIATE (non-bracketed) shape.
 *
 * The fix: every path-building handler also appends the SAME operation, as
 * a small serialisable command, to `rCtx.pathCmds` while `inPath` is true
 * (reset on `EMR_BEGINPATH`). `EMR_FILLPATH`/`EMR_STROKEANDFILLPATH`/
 * `EMR_STROKEPATH` then build a `buildPath` closure that replays those
 * commands (see {@link replayGdiPathCmds}) and route through
 * `fillShapeExactOrFast`/`strokeShapeExactOrFast`
 * (`emf-gdi-shape-paint.ts`), exactly like an immediate shape, so a
 * bracketed path now gets the same exact-ROP2 (and exact-pattern-brush)
 * treatment.
 *
 * {@link gdiPathRecorder} is the ergonomic half: a `Proxy` over the real
 * canvas context that forwards every call through unchanged (so existing
 * handler code keeps drawing normally) while also pushing the matching
 * {@link GdiPathCmd} onto `rCtx.pathCmds`, so a handler needs only swap which
 * context object it calls into during a bracketed path, not duplicate its
 * own coordinate math.
 *
 * @module emf-gdi-path-record
 */

import type { CanvasContext, EmfGdiReplayCtx } from './emf-types';

/** A single recorded path-building call, in device (canvas pixel) space. */
export type GdiPathCmd =
	| { op: 'moveTo'; x: number; y: number }
	| { op: 'lineTo'; x: number; y: number }
	| { op: 'rect'; x: number; y: number; w: number; h: number }
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

/** Replays recorded path commands onto `target` (no implicit `beginPath()`). */
export function replayGdiPathCmds(target: CanvasContext, cmds: GdiPathCmd[]): void {
	for (const c of cmds) {
		switch (c.op) {
			case 'moveTo':
				target.moveTo(c.x, c.y);
				break;
			case 'lineTo':
				target.lineTo(c.x, c.y);
				break;
			case 'rect':
				target.rect(c.x, c.y, c.w, c.h);
				break;
			case 'bezierCurveTo':
				target.bezierCurveTo(c.cp1x, c.cp1y, c.cp2x, c.cp2y, c.x, c.y);
				break;
			case 'arcTo':
				target.arcTo(c.x1, c.y1, c.x2, c.y2, c.radius);
				break;
			case 'ellipse':
				target.ellipse(c.cx, c.cy, c.rx, c.ry, c.rotation, c.startAngle, c.endAngle, c.ccw);
				break;
			case 'closePath':
				target.closePath();
				break;
		}
	}
}

/**
 * A `CanvasContext`-shaped view over `rCtx.ctx` that also records every
 * path-building call it forwards into `rCtx.pathCmds`. Every other method
 * and property passes straight through to the real context unchanged.
 * Intended to be used ONLY for the duration of building path geometry inside
 * a `BeginPath`/`EndPath` bracket (callers check `rCtx.inPath` first).
 */
export function gdiPathRecorder(rCtx: EmfGdiReplayCtx): CanvasContext {
	const { ctx, pathCmds } = rCtx;
	return new Proxy(ctx, {
		get(target, prop, receiver) {
			switch (prop) {
				case 'moveTo':
					return (x: number, y: number) => {
						pathCmds.push({ op: 'moveTo', x, y });
						return target.moveTo(x, y);
					};
				case 'lineTo':
					return (x: number, y: number) => {
						pathCmds.push({ op: 'lineTo', x, y });
						return target.lineTo(x, y);
					};
				case 'rect':
					return (x: number, y: number, w: number, h: number) => {
						pathCmds.push({ op: 'rect', x, y, w, h });
						return target.rect(x, y, w, h);
					};
				case 'bezierCurveTo':
					return (cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) => {
						pathCmds.push({ op: 'bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
						return target.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
					};
				case 'arcTo':
					return (x1: number, y1: number, x2: number, y2: number, radius: number) => {
						pathCmds.push({ op: 'arcTo', x1, y1, x2, y2, radius });
						return target.arcTo(x1, y1, x2, y2, radius);
					};
				case 'ellipse':
					return (
						cx: number,
						cy: number,
						rx: number,
						ry: number,
						rotation: number,
						startAngle: number,
						endAngle: number,
						ccw?: boolean,
					) => {
						pathCmds.push({ op: 'ellipse', cx, cy, rx, ry, rotation, startAngle, endAngle, ccw: !!ccw });
						return target.ellipse(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw);
					};
				case 'closePath':
					return () => {
						pathCmds.push({ op: 'closePath' });
						return target.closePath();
					};
				default: {
					const value = Reflect.get(target, prop, receiver);
					return typeof value === 'function' ? value.bind(target) : value;
				}
			}
		},
	});
}
