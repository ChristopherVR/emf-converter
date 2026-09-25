/**
 * EMF+ state / transform / save / restore / clip record handlers.
 *
 * Also exports shared utility functions used by other handler modules.
 */

import {
	combineClipRegions,
	emptyClipShape,
	reapplyClipRegion,
	rectsClipShape,
	replayClipCmds,
	translateClipRegion,
	type ClipCombineOp,
	type ClipCombineResult,
	type ClipPathCmd,
	type ClipDomain,
	type ClipRegion,
	type ClipShape,
} from './emf-clip-region';
import { scanlineCombineRegions } from './emf-clip-scanline';
import { argbToRgba } from './emf-color-helpers';
import {
	EMFPLUS_SETWORLDTRANSFORM,
	EMFPLUS_RESETWORLDTRANSFORM,
	EMFPLUS_MULTIPLYWORLDTRANSFORM,
	EMFPLUS_TRANSLATEWORLDTRANSFORM,
	EMFPLUS_SCALEWORLDTRANSFORM,
	EMFPLUS_ROTATEWORLDTRANSFORM,
	EMFPLUS_SAVE,
	EMFPLUS_RESTORE,
	EMFPLUS_SETCLIPRECT,
	EMFPLUS_RESETCLIP,
	EMFPLUS_BEGINCONTAINERNOPARAMS,
	EMFPLUS_ENDCONTAINER,
	EMFPLUS_SETPAGETRANSFORM,
	EMFPLUS_SETANTIALIASMODE,
	EMFPLUS_SETTEXTRENDERINGHINT,
	EMFPLUS_SETINTERPOLATIONMODE,
	EMFPLUS_SETPIXELOFFSETMODE,
	EMFPLUS_SETCOMPOSITINGQUALITY,
	EMFPLUS_SETCLIPREGION,
	EMFPLUS_SETCLIPPATH,
	EMFPLUS_OFFSETCLIP,
} from './emf-constants';
import { emfLog, emfWarn } from './emf-logging';
import { createBrushGradient } from './emf-plus-brush-gradient';
import { createBrushTexture } from './emf-plus-brush-texture';
import { isHalfPixelOffset } from './emf-plus-image-resample';
import { emfPlusPathClipShape } from './emf-plus-path';
import { clipPixelRects } from './emf-plus-raster';
import { isSvgContext } from './svg-context';
import type { EmfPlusBrush, EmfPlusRegionNode, EmfPlusReplayCtx, TransformMatrix } from './emf-types';

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Multiply two affine matrices [a,b,c,d,e,f]. */
export function multiplyMatrix(m1: TransformMatrix, m2: TransformMatrix): TransformMatrix {
	return [
		m1[0] * m2[0] + m1[1] * m2[2],
		m1[0] * m2[1] + m1[1] * m2[3],
		m1[2] * m2[0] + m1[3] * m2[2],
		m1[2] * m2[1] + m1[3] * m2[3],
		m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
		m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
	];
}

/** Resolve a brush (either inline ARGB colour or object-table ref). */
export function resolveBrushColor(
	rCtx: EmfPlusReplayCtx,
	flags: number,
	brushIdOrColor: number,
): string {
	if (flags & 0x8000) {
		return argbToRgba(brushIdOrColor);
	}
	const obj = rCtx.objectTable.get(brushIdOrColor & 0xff);
	if (obj && obj.kind === 'plus-brush') {
		return obj.color;
	}
	return 'rgba(0,0,0,1)';
}

/**
 * Resolve a brush to a canvas paint style: an inline ARGB colour, a solid
 * brush colour, or a CanvasGradient/CanvasPattern for linear/path gradient
 * brushes (see `emf-plus-brush-gradient.ts`). Gradient geometry is defined
 * in brush (world) space, the same space fills execute in after
 * {@link applyPlusWorldTransform}, so the result can be assigned directly
 * to `fillStyle`.
 */
export function resolveBrushPaint(
	rCtx: EmfPlusReplayCtx,
	flags: number,
	brushIdOrColor: number,
): string | CanvasGradient | CanvasPattern {
	if (flags & 0x8000) {
		return argbToRgba(brushIdOrColor);
	}
	const obj = rCtx.objectTable.get(brushIdOrColor & 0xff);
	if (obj && obj.kind === 'plus-brush') {
		return brushPaint(rCtx, obj);
	}
	return 'rgba(0,0,0,1)';
}

/**
 * A brush object as a canvas paint style: a CanvasGradient/CanvasPattern
 * for a gradient or texture brush (see {@link resolveBrushPaint}), else its
 * colour. Used for a fill's brush and for a pen's own brush.
 */
export function brushPaint(rCtx: EmfPlusReplayCtx, obj: EmfPlusBrush): string | CanvasGradient | CanvasPattern {
	if (obj.gradient) {
		const g = createBrushGradient(rCtx.ctx, obj.gradient, plusWorldMatrix(rCtx));
		if (g) {
			return g;
		}
	}
	if (obj.texture) {
		const p = createBrushTexture(rCtx.ctx, obj.texture, plusWorldMatrix(rCtx));
		if (p) {
			return p;
		}
	}
	return obj.color;
}

/**
 * Compute the multiplier that converts from the current page unit to pixels
 * (assuming a 96 DPI canvas), scaled by the page scale factor.
 */
export function getPageUnitMultiplier(pageUnit: number, pageScale: number): number {
	const DPI = 96;
	let unitToPixel: number;
	switch (pageUnit) {
		case 3:
			unitToPixel = DPI / 72;
			break; // Point
		case 4:
			unitToPixel = DPI;
			break; // Inch
		case 5:
			unitToPixel = DPI / 300;
			break; // Document
		case 6:
			unitToPixel = DPI / 25.4;
			break; // Millimeter
		default:
			unitToPixel = 1;
			break; // World, Display, Pixel
	}
	return unitToPixel * pageScale;
}

/**
 * The world-to-device matrix EMF+ drawing runs under: world transform,
 * page units and DPI scale, then the replay's base (canvas-origin or
 * nested-metafile) transform, {@link EmfPlusReplayCtx.baseTransform}.
 */
export function plusWorldMatrix(rCtx: EmfPlusReplayCtx): TransformMatrix {
	const wt = rCtx.worldTransform;
	const k = getPageUnitMultiplier(rCtx.pageUnit, rCtx.pageScale) * rCtx.dpiScale;
	const m: TransformMatrix = [wt[0] * k, wt[1] * k, wt[2] * k, wt[3] * k, wt[4] * k, wt[5] * k];
	const b = rCtx.baseTransform;
	if (!b) {
		return m;
	}
	return [
		b[0] * m[0] + b[2] * m[1],
		b[1] * m[0] + b[3] * m[1],
		b[0] * m[2] + b[2] * m[3],
		b[1] * m[2] + b[3] * m[3],
		b[0] * m[4] + b[2] * m[5] + b[4],
		b[1] * m[4] + b[3] * m[5] + b[5],
	];
}

/** Apply the current EMF+ world transform to the canvas, incorporating page units and DPI scale. */
export function applyPlusWorldTransform(rCtx: EmfPlusReplayCtx, geometry: boolean = true): void {
	const m = plusWorldMatrix(rCtx);
	// Text is not placed on the antialiasing grid (see plusCanvasShift).
	const d = geometry ? plusCanvasShift(rCtx) : 0;
	rCtx.ctx.setTransform(m[0], m[1], m[2], m[3], m[4] + d, m[5] + d);
}

/**
 * Canvas-space shift between GDI+'s antialiased pixel grid and Canvas's for
 * vector geometry. GDI+'s antialiasing (SmoothingMode AntiAlias/HighQuality)
 * averages an 8x4 grid of samples that, under `PixelOffsetMode`
 * None/Default/HighSpeed, spans [x - 0.5, x + 0.5) around device pixel x
 * (measured on single edges at 1/64-pixel steps); Canvas's pixel x covers
 * [x, x + 1), so antialiased geometry is drawn half a pixel right and down.
 * Under Half/HighQuality GDI+'s grid is Canvas's. Aliased GDI+ drawing
 * (SmoothingMode None, the default) samples pixel x at x, which the
 * unshifted Canvas edge of whole-pixel geometry already reproduces, so
 * there is no shift. Pixel-indexed samplers (gradients, textures, images)
 * are unaffected: they evaluate device pixel x at GDI+'s point, and so is
 * text, which GDI+ places whatever the SmoothingMode, and SVG output.
 */
export function plusCanvasShift(rCtx: EmfPlusReplayCtx): number {
	// A raster effect only: SVG keeps the recorded geometry.
	if (isSvgContext(rCtx.ctx)) {
		return 0;
	}
	return rCtx.antiAlias && !isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0) ? 0.5 : 0;
}

// ---------------------------------------------------------------------------
// Internal helper: save/restore logic shared between Save/Container ops
// ---------------------------------------------------------------------------

function pushState(rCtx: EmfPlusReplayCtx, stackId: number): void {
	rCtx.saveStack.push({
		transform: [...rCtx.worldTransform] as TransformMatrix,
	});
	rCtx.saveIdMap.set(stackId, rCtx.saveStack.length - 1);
}

function popState(rCtx: EmfPlusReplayCtx, stackId: number): void {
	const idx = rCtx.saveIdMap.get(stackId);
	if (idx !== undefined && idx < rCtx.saveStack.length) {
		rCtx.worldTransform = [...rCtx.saveStack[idx].transform] as TransformMatrix;
		rCtx.saveStack.length = idx;
		const newMap = new Map<number, number>();
		for (const [k, v] of rCtx.saveIdMap) {
			if (v < idx) {
				newMap.set(k, v);
			}
		}
		rCtx.saveIdMap = newMap;
	}
}

// ---------------------------------------------------------------------------
// Clip tracking (full CombineMode support via emf-clip-region)
// ---------------------------------------------------------------------------

/**
 * The effective device matrix for EMF+ drawing: world transform × page-unit
 * multiplier × DPI scale, the same matrix {@link applyPlusWorldTransform}
 * installs on the canvas. Clip shapes are recorded in this (device) space so
 * they survive later transform changes, exactly like a native canvas clip.
 */
function plusDeviceMatrix(rCtx: EmfPlusReplayCtx): TransformMatrix {
	return plusWorldMatrix(rCtx);
}

/** Build a device-space polygon shape from a world-space rectangle. */
function transformedRectShape(
	x: number,
	y: number,
	w: number,
	h: number,
	m: TransformMatrix,
): ClipShape {
	const tx = (px: number, py: number) => m[0] * px + m[2] * py + m[4];
	const ty = (px: number, py: number) => m[1] * px + m[3] * py + m[5];
	const cmds: ClipPathCmd[] = [
		{ op: 'moveTo', x: tx(x, y), y: ty(x, y) },
		{ op: 'lineTo', x: tx(x + w, y), y: ty(x + w, y) },
		{ op: 'lineTo', x: tx(x + w, y + h), y: ty(x + w, y + h) },
		{ op: 'lineTo', x: tx(x, y + h), y: ty(x, y + h) },
		{ op: 'closePath' },
	];
	return { cmds, fillRule: 'nonzero', simple: true };
}

/**
 * Build a device-space clip shape from an EMF+ region path node, with the
 * path's own FillMode (Alternate or Winding) and `simple` only when proven.
 */
function pathClipShape(path: EmfPlusRegionNode & { type: 'path' }, m: TransformMatrix): ClipShape {
	return emfPlusPathClipShape(path.path, m);
}

/** RegionNodeDataType (MS-EMFPLUS 2.1.1.27) → boolean combine op. */
const REGION_NODE_OPS: Record<number, ClipCombineOp> = {
	0: 'intersect', // legacy/lenient: treat 0 as And
	1: 'intersect', // RegionNodeDataTypeAnd
	2: 'union', // RegionNodeDataTypeOr
	3: 'xor', // RegionNodeDataTypeXor
	4: 'exclude', // RegionNodeDataTypeExclude
	5: 'complement', // RegionNodeDataTypeComplement
};

const MAX_REGION_FLATTEN_DEPTH = 64;

/**
 * Flatten an EMF+ region node tree into a tracked clip region (a list of
 * intersecting shapes, or `null` for the infinite region). Boolean combine
 * nodes are resolved exactly through {@link combineClipRegions}, which
 * scan-converts over `domain` (the canvas) when the vector form cannot hold
 * the result. `exact` is false only when no domain is given and an unbounded
 * result had to be cut to the geometry's bounding box.
 */
export function flattenRegionNode(
	node: EmfPlusRegionNode,
	m: TransformMatrix,
	depth: number = 0,
	domain?: ClipDomain,
): ClipCombineResult {
	if (depth > MAX_REGION_FLATTEN_DEPTH) {
		emfWarn(`flattenRegionNode: depth limit (${MAX_REGION_FLATTEN_DEPTH}) exceeded`);
		return { region: [emptyClipShape()], exact: false };
	}
	switch (node.type) {
		case 'rect':
			return { region: [transformedRectShape(node.x, node.y, node.width, node.height, m)], exact: true };
		case 'path':
			return { region: [pathClipShape(node, m)], exact: true };
		case 'infinite':
			return { region: null, exact: true };
		case 'empty':
			return { region: [emptyClipShape()], exact: true };
		case 'combine': {
			const left = flattenRegionNode(node.left, m, depth + 1, domain);
			const right = flattenRegionNode(node.right, m, depth + 1, domain);
			const op = REGION_NODE_OPS[node.combineMode] ?? 'intersect';
			const combined = combineClipRegions(left.region, right.region, op, domain);
			return { region: combined.region, exact: combined.exact && left.exact && right.exact };
		}
	}
}

/** SetClip* CombineMode (MS-EMFPLUS 2.1.1.4) → boolean combine op. */
const PLUS_COMBINE_OPS: Record<number, ClipCombineOp> = {
	0: 'replace',
	1: 'intersect',
	2: 'union',
	3: 'xor',
	4: 'exclude',
	5: 'complement',
};

/**
 * The device-pixel domain for exact scanline clip combination: the canvas,
 * when the replay knows its size; otherwise derived from the geometry.
 */
function plusClipDomain(rCtx: EmfPlusReplayCtx): ClipDomain | undefined {
	if (rCtx.canvasW === undefined || rCtx.canvasH === undefined) {
		return undefined;
	}
	return { x: 0, y: 0, w: rCtx.canvasW, h: rCtx.canvasH };
}

/** Rebuild the canvas clip from the tracked EMF+ clip region. */
function reapplyPlusClip(rCtx: EmfPlusReplayCtx): void {
	reapplyClipRegion(rCtx, rCtx.clipRegion ?? null, true);
}

/**
 * Combine the tracked clip with an incoming region per the CombineMode and
 * rebuild the canvas clip state.
 */
/**
 * Unless `gdiAntialias: true` (raster output), an incoming EMF+ clip region
 * as GDI+ itself holds it: the set of device pixels whose sample point lies
 * inside (see `aliasedSampleShift`), as disjoint pixel rectangles, instead
 * of a vector clip Canvas would antialias. Otherwise the region unchanged.
 */
function pixelSnapPlusClip(rCtx: EmfPlusReplayCtx, incoming: ClipRegion): ClipRegion {
	const domain = plusClipDomain(rCtx);
	if (rCtx.gdiAntialias === true || !incoming || !domain || isSvgContext(rCtx.ctx)) {
		return incoming;
	}
	const half = isHalfPixelOffset(rCtx.pixelOffsetMode ?? 0);
	// GDI+'s own aliased scan conversion of the region (emf-plus-raster.ts).
	const exact = clipPixelRects(
		incoming.map((shape) => ({ build: (c) => replayClipCmds(c, shape.cmds), evenOdd: shape.fillRule === 'evenodd' })),
		domain,
		half,
	);
	if (exact) {
		return [rectsClipShape(exact)];
	}
	const shift = (half ? 0 : 0.5) - 1 / 32;
	const shifted = translateClipRegion(incoming, shift, shift);
	return [rectsClipShape(scanlineCombineRegions(shifted, null, 'intersect', domain))];
}

function applyPlusClipRegion(
	rCtx: EmfPlusReplayCtx,
	rawIncoming: ClipRegion,
	combineMode: number,
	opName: string,
): void {
	const incoming = pixelSnapPlusClip(rCtx, rawIncoming);
	const op = PLUS_COMBINE_OPS[combineMode];
	if (!op) {
		emfWarn(`${opName}: unknown CombineMode ${combineMode}, falling back to Intersect`);
	}
	const res = combineClipRegions(
		rCtx.clipRegion ?? null,
		incoming,
		op ?? 'intersect',
		plusClipDomain(rCtx),
	);
	if (!res.exact) {
		emfWarn(`${opName}: CombineMode ${combineMode} approximated (no canvas domain for an unbounded result)`);
	}
	rCtx.clipRegion = res.region;
	reapplyPlusClip(rCtx);
}

/** Convenience wrapper for single-shape clip records (SetClipRect/SetClipPath). */
function applyPlusClipShape(
	rCtx: EmfPlusReplayCtx,
	shape: ClipShape,
	combineMode: number,
	opName: string,
): void {
	applyPlusClipRegion(rCtx, [shape], combineMode, opName);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleEmfPlusStateRecord(
	rCtx: EmfPlusReplayCtx,
	recType: number,
	recFlags: number,
	dataOff: number,
	recDataSize: number,
): boolean {
	const { view } = rCtx;

	switch (recType) {
		// ---- transforms ----
		case EMFPLUS_SETWORLDTRANSFORM: {
			if (recDataSize >= 24) {
				rCtx.worldTransform = [
					view.getFloat32(dataOff, true),
					view.getFloat32(dataOff + 4, true),
					view.getFloat32(dataOff + 8, true),
					view.getFloat32(dataOff + 12, true),
					view.getFloat32(dataOff + 16, true),
					view.getFloat32(dataOff + 20, true),
				];
			}
			return true;
		}

		case EMFPLUS_RESETWORLDTRANSFORM: {
			rCtx.worldTransform = [1, 0, 0, 1, 0, 0];
			return true;
		}

		case EMFPLUS_MULTIPLYWORLDTRANSFORM: {
			if (recDataSize >= 24) {
				const xf: TransformMatrix = [
					view.getFloat32(dataOff, true),
					view.getFloat32(dataOff + 4, true),
					view.getFloat32(dataOff + 8, true),
					view.getFloat32(dataOff + 12, true),
					view.getFloat32(dataOff + 16, true),
					view.getFloat32(dataOff + 20, true),
				];
				if (recFlags & 0x2000) {
					rCtx.worldTransform = multiplyMatrix(rCtx.worldTransform, xf);
				} else {
					rCtx.worldTransform = multiplyMatrix(xf, rCtx.worldTransform);
				}
			}
			return true;
		}

		case EMFPLUS_TRANSLATEWORLDTRANSFORM: {
			if (recDataSize >= 8) {
				const dx = view.getFloat32(dataOff, true);
				const dy = view.getFloat32(dataOff + 4, true);
				const xf: TransformMatrix = [1, 0, 0, 1, dx, dy];
				if (recFlags & 0x2000) {
					rCtx.worldTransform = multiplyMatrix(rCtx.worldTransform, xf);
				} else {
					rCtx.worldTransform = multiplyMatrix(xf, rCtx.worldTransform);
				}
			}
			return true;
		}

		case EMFPLUS_SCALEWORLDTRANSFORM: {
			if (recDataSize >= 8) {
				const sx = view.getFloat32(dataOff, true);
				const sy = view.getFloat32(dataOff + 4, true);
				const xf: TransformMatrix = [sx, 0, 0, sy, 0, 0];
				if (recFlags & 0x2000) {
					rCtx.worldTransform = multiplyMatrix(rCtx.worldTransform, xf);
				} else {
					rCtx.worldTransform = multiplyMatrix(xf, rCtx.worldTransform);
				}
			}
			return true;
		}

		case EMFPLUS_ROTATEWORLDTRANSFORM: {
			if (recDataSize >= 4) {
				const angle = (view.getFloat32(dataOff, true) * Math.PI) / 180;
				const cos = Math.cos(angle);
				const sin = Math.sin(angle);
				const xf: TransformMatrix = [cos, sin, -sin, cos, 0, 0];
				if (recFlags & 0x2000) {
					rCtx.worldTransform = multiplyMatrix(rCtx.worldTransform, xf);
				} else {
					rCtx.worldTransform = multiplyMatrix(xf, rCtx.worldTransform);
				}
			}
			return true;
		}

		// ---- save / restore ----
		case EMFPLUS_SAVE: {
			if (recDataSize >= 4) {
				pushState(rCtx, view.getUint32(dataOff, true));
			}
			return true;
		}

		case EMFPLUS_RESTORE: {
			if (recDataSize >= 4) {
				popState(rCtx, view.getUint32(dataOff, true));
			}
			return true;
		}

		// ---- clipping ----
		case EMFPLUS_SETCLIPRECT: {
			if (recDataSize >= 16) {
				const combineMode = (recFlags >> 8) & 0x0f;
				const cx = view.getFloat32(dataOff, true);
				const cy = view.getFloat32(dataOff + 4, true);
				const cw = view.getFloat32(dataOff + 8, true);
				const ch = view.getFloat32(dataOff + 12, true);
				const shape = transformedRectShape(cx, cy, cw, ch, plusDeviceMatrix(rCtx));
				applyPlusClipShape(rCtx, shape, combineMode, 'SetClipRect');
			}
			return true;
		}

		case EMFPLUS_RESETCLIP: {
			rCtx.clipRegion = null;
			reapplyPlusClip(rCtx);
			emfLog('ResetClip: clip region cleared');
			return true;
		}

		case EMFPLUS_SETCLIPREGION: {
			const regionId = recFlags & 0xff;
			const combineMode = (recFlags >> 8) & 0x0f;
			const regionObj = rCtx.objectTable.get(regionId);
			if (regionObj && regionObj.kind === 'plus-region' && regionObj.nodes.length > 0) {
				const flattened = flattenRegionNode(
					regionObj.nodes[0],
					plusDeviceMatrix(rCtx),
					0,
					plusClipDomain(rCtx),
				);
				if (!flattened.exact) {
					emfWarn('SetClipRegion: region tree approximated (no canvas domain for an unbounded result)');
				}
				applyPlusClipRegion(rCtx, flattened.region, combineMode, 'SetClipRegion');
			}
			return true;
		}

		case EMFPLUS_SETCLIPPATH: {
			const pathId = recFlags & 0xff;
			const combineMode = (recFlags >> 8) & 0x0f;
			const pathObj = rCtx.objectTable.get(pathId);
			if (pathObj && pathObj.kind === 'plus-path') {
				// The path's own FillMode decides the clip's fill rule (GDI+ records
				// Winding as PathPointFlags 0x2000; Alternate, its default, as 0).
				const shape = emfPlusPathClipShape(pathObj, plusDeviceMatrix(rCtx));
				applyPlusClipShape(rCtx, shape, combineMode, 'SetClipPath');
			}
			return true;
		}

		case EMFPLUS_OFFSETCLIP: {
			if (recDataSize >= 8) {
				const dx = view.getFloat32(dataOff, true);
				const dy = view.getFloat32(dataOff + 4, true);
				if (rCtx.clipRegion) {
					// The offset is specified in world units; convert to a device
					// delta via the linear part of the effective matrix.
					const m = plusDeviceMatrix(rCtx);
					const ddx = m[0] * dx + m[2] * dy;
					const ddy = m[1] * dx + m[3] * dy;
					rCtx.clipRegion = translateClipRegion(rCtx.clipRegion, ddx, ddy);
					reapplyPlusClip(rCtx);
					emfLog(`OffsetClip: clip translated by world (${dx},${dy}) → device (${ddx},${ddy})`);
				} else {
					emfLog(`OffsetClip: dx=${dx}, dy=${dy}, no active clip, nothing to offset`);
				}
			}
			return true;
		}

		// ---- containers ----
		case EMFPLUS_BEGINCONTAINERNOPARAMS: {
			if (recDataSize >= 4) {
				pushState(rCtx, view.getUint32(dataOff, true));
			}
			return true;
		}

		case EMFPLUS_ENDCONTAINER: {
			if (recDataSize >= 4) {
				popState(rCtx, view.getUint32(dataOff, true));
			}
			return true;
		}

		// ---- page transform ----
		case EMFPLUS_SETPAGETRANSFORM: {
			const pageUnit = recFlags & 0xff;
			const pageScale = recDataSize >= 4 ? view.getFloat32(dataOff, true) : 1;
			rCtx.pageUnit = pageUnit;
			rCtx.pageScale = pageScale;
			const UNIT_NAMES: Record<number, string> = {
				0: 'World',
				1: 'Display',
				2: 'Pixel',
				3: 'Point',
				4: 'Inch',
				5: 'Document',
				6: 'Millimeter',
			};
			emfLog(`SetPageTransform: unit=${UNIT_NAMES[pageUnit] ?? pageUnit}, scale=${pageScale}`);
			return true;
		}

		// ---- image resampling hints (see emf-plus-image-resample.ts) ----
		case EMFPLUS_SETINTERPOLATIONMODE:
			rCtx.interpolationMode = recFlags & 0xff;
			return true;

		case EMFPLUS_SETPIXELOFFSETMODE:
			rCtx.pixelOffsetMode = recFlags & 0xff;
			return true;

		case EMFPLUS_SETTEXTRENDERINGHINT:
			rCtx.textRenderingHint = recFlags & 0xff;
			return true;

		// ---- antialiasing (honoured for fills and strokes unless gdiAntialias: true) ----
		case EMFPLUS_SETANTIALIASMODE:
			rCtx.antiAlias = (recFlags & 0x01) !== 0;
			return true;

		// ---- rendering hints (accepted, ignored) ----
		case EMFPLUS_SETCOMPOSITINGQUALITY:
			return true;

		default:
			return false;
	}
}
