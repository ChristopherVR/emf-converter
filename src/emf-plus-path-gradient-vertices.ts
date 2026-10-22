/**
 * Path gradients whose surround colours differ from vertex to vertex.
 *
 * Native GDI+ does not draw these as nested boundary copies (that is how it
 * draws a uniform surround, see `pathGradientQuantum`). It fans the boundary
 * into triangles (centre, vertex i, vertex i + 1) and Gouraud-shades each one
 * with an integer scan converter; `emf-plus-path-gradient-fan.ts` is that
 * converter, read from gdiplus.dll (`DpOutputPathGradientSpan::OutputSpan`,
 * `DpTriangleData::SetTriangle` / `SetXSpan` / `OutputSpan`) and exact on all
 * 174,084 painted pixels of the 320 captures of `path-gradient-vertices.json.gz`
 * (rotated, scaled, translucent and focused ones included: native ignores
 * the FocusScales of a per-vertex fan).
 *
 * A Blend or InterpolationColors curve is applied to the centre's weight of each
 * triangle (`emf-plus-path-gradient-curves.ts`).
 *
 * @module emf-plus-path-gradient-vertices
 */

import { FanTriangle, fanTransform, premultipliedColor, unpremultipliedArgb, type FanShading } from './emf-plus-path-gradient-fan';
import { blendAdjuster, presetRamp } from './emf-plus-path-gradient-curves';
import type { EmfPlusPathGradientShape, TransformMatrix } from './emf-types';

/** A path gradient in device space, ready for per-pixel evaluation. */
export interface VertexGradient {
	/** The fan, one triangle per boundary edge, in painting order (later triangles paint over earlier ones). */
	triangles: FanTriangle[];
}

/**
 * Device-space fan of a non-uniform path gradient (FocusScales change nothing here), or `null` when it has fewer than three
 * vertices or colours. `full` maps brush space to device pixels.
 */
export function prepareVertexGradient(shape: EmfPlusPathGradientShape, full: TransformMatrix): VertexGradient | null {
	const n = shape.boundary.length;
	if (n < 3 || shape.boundaryArgb.length < n) {
		return null;
	}
	if (shape.boundaryArgb.every((color) => color === shape.boundaryArgb[0])) {
		return null;
	}
	const centre = fanTransform(full, shape.center.x, shape.center.y);
	const centreColor = premultipliedColor(shape.centerArgb);
	const device = shape.boundary.map((p) => fanTransform(full, p.x, p.y));
	const preset = presetRamp(shape.preset);
	const shading: FanShading = preset ? { preset } : { adjust: blendAdjuster(shape.blend) ?? undefined };
	const triangles: FanTriangle[] = [];
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		// a repeated vertex has no triangle
		if (shape.boundary[i].x === shape.boundary[j].x && shape.boundary[i].y === shape.boundary[j].y) continue;
		triangles.push(new FanTriangle(
			[centre[0], centre[1], device[i][0], device[i][1], device[j][0], device[j][1]],
			[centreColor, premultipliedColor(shape.boundaryArgb[i]), premultipliedColor(shape.boundaryArgb[j])],
			shading,
		));
	}
	return { triangles };
}

/**
 * The (non-premultiplied) ARGB colour of device pixel (`px`, `py`), or `null`
 * when no fan triangle's span holds it. Later fan triangles paint over earlier
 * ones; a pixel of zero alpha paints over them too. `clipLeft` and `clipRight` are the window the spans are requested for
 * (a span cut by it interpolates from the cut, see {@link FanTriangle.row}); `bitmap` converts to straight alpha the way native does
 * for a straight-alpha ARGB bitmap (see {@link unpremultipliedArgb}).
 */
export function vertexGradientColorAt(g: VertexGradient, px: number, py: number, clipLeft?: number, clipRight?: number, bitmap = false): number | null {
	let result: number | null = null;
	for (const t of g.triangles) {
		const row = t.row(py, clipLeft, clipRight);
		if (!row || px < row.xl || px >= row.xl + row.n) continue;
		const o = (px - row.xl) * 4;
		result = unpremultipliedArgb(row.argb[o], row.argb[o + 1], row.argb[o + 2], row.argb[o + 3], bitmap);
	}
	return result;
}
