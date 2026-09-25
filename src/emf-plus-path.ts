/**
 * EMF+ path parsing and canvas replay.
 */

import type { ClipPathCmd, ClipShape } from './emf-clip-region';
import { flattenClipCmds } from './emf-clip-scanline';
import type { CanvasContext, EmfPlusPath, TransformMatrix } from './emf-types';

// ---------------------------------------------------------------------------
// Parse an EMF+ Path object from a DataView
// ---------------------------------------------------------------------------

/**
 * `PathPointFlags` bit GDI+ sets when the path's `FillMode` is Winding
 * (clear for Alternate). Confirmed against real GDI+ recordings
 * (`src/__fixtures__/gdi/gpx-fillpath-*`, `gpx-clippath-*`).
 */
const PATH_FLAG_WINDING = 0x2000;

export function parseEmfPlusPath(data: DataView, off: number, maxLen: number): EmfPlusPath | null {
	if (maxLen < 12) {
		return null;
	}

	const version = data.getUint32(off, true);
	void version;
	const pointCount = data.getUint32(off + 4, true);
	const pathFlags = data.getUint32(off + 8, true);

	if (pointCount === 0 || pointCount > 100000) {
		return null;
	}

	const compressed = (pathFlags & 0x4000) !== 0;
	const pointSize = compressed ? 4 : 8;
	const pointsBytes = pointCount * pointSize;
	const typesBytes = pointCount;
	const neededAfterHeader = pointsBytes + typesBytes;

	if (12 + neededAfterHeader > maxLen) {
		return null;
	}

	const points: Array<{ x: number; y: number }> = [];
	let pOff = off + 12;
	for (let i = 0; i < pointCount; i++) {
		if (compressed) {
			points.push({
				x: data.getInt16(pOff, true),
				y: data.getInt16(pOff + 2, true),
			});
			pOff += 4;
		} else {
			points.push({
				x: data.getFloat32(pOff, true),
				y: data.getFloat32(pOff + 4, true),
			});
			pOff += 8;
		}
	}

	const alignedPOff = (pOff + 3) & ~3;
	const types = new Uint8Array(data.buffer, data.byteOffset + alignedPOff, pointCount);

	return {
		kind: 'plus-path',
		points,
		types: new Uint8Array(types),
		fillRule: pathFlags & PATH_FLAG_WINDING ? 'nonzero' : 'evenodd',
	};
}

// ---------------------------------------------------------------------------
// Replay a parsed EMF+ path onto a canvas context
// ---------------------------------------------------------------------------

/**
 * Convert a parsed EMF+ path into device-space clip path commands, applying
 * an affine transform to every point. Mirrors the segment semantics of
 * {@link replayEmfPlusPath} (Start / Line / Bezier nibbles + close flag).
 */
export function emfPlusPathToClipCmds(path: EmfPlusPath, m: TransformMatrix): ClipPathCmd[] {
	const tx = (x: number, y: number) => m[0] * x + m[2] * y + m[4];
	const ty = (x: number, y: number) => m[1] * x + m[3] * y + m[5];
	const cmds: ClipPathCmd[] = [];
	const pts = path.points;
	const types = path.types;
	let i = 0;
	while (i < pts.length) {
		const t = types[i] & 0x0f;
		const close = (types[i] & 0x80) !== 0;
		if (t === 0) {
			cmds.push({ op: 'moveTo', x: tx(pts[i].x, pts[i].y), y: ty(pts[i].x, pts[i].y) });
			i++;
		} else if (t === 3) {
			if (i + 2 < pts.length) {
				cmds.push({
					op: 'bezierCurveTo',
					cp1x: tx(pts[i].x, pts[i].y),
					cp1y: ty(pts[i].x, pts[i].y),
					cp2x: tx(pts[i + 1].x, pts[i + 1].y),
					cp2y: ty(pts[i + 1].x, pts[i + 1].y),
					x: tx(pts[i + 2].x, pts[i + 2].y),
					y: ty(pts[i + 2].x, pts[i + 2].y),
				});
				if ((types[i + 2] & 0x80) !== 0) {
					cmds.push({ op: 'closePath' });
				}
				i += 3;
				continue;
			}
			break;
		} else {
			cmds.push({ op: 'lineTo', x: tx(pts[i].x, pts[i].y), y: ty(pts[i].x, pts[i].y) });
			i++;
		}
		if (close) {
			cmds.push({ op: 'closePath' });
		}
	}
	return cmds;
}

/** Largest vertex count {@link isSingleSimpleFigure} checks for self-intersection. */
const MAX_SIMPLE_CHECK_VERTICES = 512;

/** True when segments p1-p2 and p3-p4 properly cross (touching endpoints do not count). */
function segmentsCross(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x3: number,
	y3: number,
	x4: number,
	y4: number,
): boolean {
	const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3);
	const d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
	const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
	const d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
	return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * True when device-space clip commands flatten to exactly one closed
 * figure whose edges never cross: its winding is 0 or +/-1 everywhere, so
 * the clip machinery may invert and compose it as a `simple` shape
 * (`emf-clip-region.ts`). Several figures, which may overlap, or a
 * self-intersecting one are not simple. Pure.
 */
export function isSingleSimpleFigure(cmds: ClipPathCmd[]): boolean {
	const polys = flattenClipCmds(cmds);
	if (polys.length !== 1) {
		return false;
	}
	const poly = polys[0];
	const n = poly.length / 2;
	if (n < 3) {
		return true;
	}
	if (n > MAX_SIMPLE_CHECK_VERTICES) {
		return false;
	}
	for (let i = 0; i < n; i++) {
		const i2 = (i + 1) % n;
		for (let j = i + 2; j < n; j++) {
			const j2 = (j + 1) % n;
			if (j2 === i) {
				continue;
			}
			if (
				segmentsCross(
					poly[2 * i],
					poly[2 * i + 1],
					poly[2 * i2],
					poly[2 * i2 + 1],
					poly[2 * j],
					poly[2 * j + 1],
					poly[2 * j2],
					poly[2 * j2 + 1],
				)
			) {
				return false;
			}
		}
	}
	return true;
}

/**
 * The device-space clip shape of an EMF+ path under matrix `m`, filled
 * with the path's own GDI+ `FillMode` (see {@link EmfPlusPath.fillRule})
 * and marked `simple` only when it provably is (see
 * {@link isSingleSimpleFigure}).
 */
export function emfPlusPathClipShape(path: EmfPlusPath, m: TransformMatrix): ClipShape {
	const cmds = emfPlusPathToClipCmds(path, m);
	return { cmds, fillRule: path.fillRule ?? 'nonzero', simple: isSingleSimpleFigure(cmds) };
}

export function replayEmfPlusPath(ctx: CanvasContext, path: EmfPlusPath): void {
	ctx.beginPath();
	const pts = path.points;
	const types = path.types;
	let i = 0;
	while (i < pts.length) {
		const t = types[i] & 0x0f;
		const close = (types[i] & 0x80) !== 0;
		if (t === 0) {
			ctx.moveTo(pts[i].x, pts[i].y);
			i++;
		} else if (t === 1) {
			ctx.lineTo(pts[i].x, pts[i].y);
			i++;
		} else if (t === 3) {
			if (i + 2 < pts.length) {
				ctx.bezierCurveTo(
					pts[i].x,
					pts[i].y,
					pts[i + 1].x,
					pts[i + 1].y,
					pts[i + 2].x,
					pts[i + 2].y,
				);
				if ((types[i + 2] & 0x80) !== 0) {
					ctx.closePath();
				}
				i += 3;
				continue;
			} else {
				break;
			}
		} else {
			ctx.lineTo(pts[i].x, pts[i].y);
			i++;
		}
		if (close) {
			ctx.closePath();
		}
	}
}
