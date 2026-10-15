/**
 * Windows GDI's choice of a raster (`.fon`) face and its whole-number stretch factors for a logical font.
 *
 * Measured on native GDI with private synthetic bitmap families (`scripts/gdi-fixtures/RasterSyntheticMapperProbe.cs`,
 * `raster-mapper-synthetic.json.gz`) whose pixel height, internal leading, average width and weight are chosen one at a
 * time, and with the seven installed raster families (`raster-mapper-widths.json.gz`). The mapper is not a nearest-width
 * search over every face and factor; it works in two stages:
 *
 * 1. Every face proposes at most two candidates. The horizontal factor `kx` is fixed by the request alone: `lfWidth /
 *    avgWidth` rounded half up (1 to 5), or the vertical factor when `lfWidth` is 0. The vertical factor is
 *    `floor(request / unit)` (`unit` is the character height for a negative lfHeight and the cell height for a positive
 *    one), and the next factor is also proposed when it overshoots the request by at most `floor(unit / 4)` pixels
 *    (`floor((unit - 1) / 4)` when going from 1 to 2). A face is never stretched by more than `unit - 3`, so the faces of
 *    at most 4 pixels are never stretched at all.
 * 2. The candidates are compared by one additive cost. A face that is too small by `d` pixels costs `3 d`, one that is too
 *    big costs `12 + 3 d`; the horizontal error `|kx * avgWidth - lfWidth|` costs 1 per pixel (this is the unit of every
 *    other number); a vertical factor above 1 costs about its own value; a horizontal factor that differs from the
 *    vertical one costs an aspect penalty that is affine in the ratio of the two (8.7 times `kx / ky` when wider,
 *    7.5 times `ky / kx` when narrower, plus a small constant); a weight mismatch costs a fraction of a pixel. The
 *    cheapest candidate wins and ties go to the earlier face.
 *
 * The penalty weights are bounded by thousands of native comparisons (every constant is inside the interval the
 * native pair comparisons allow) and the choice reproduces 99.6% of 50,000 native picks; the few differences are
 * near-ties that the measured intervals cannot separate.
 */

/** The attributes of a raster face that the mapper looks at. */
export interface RasterMapperFace {
	/** Cell height in pixels. */
	readonly pixHeight: number;
	/** Internal leading in pixels (character height is `pixHeight - internalLeading`). */
	readonly internalLeading: number;
	/** Average character width in pixels. */
	readonly avgWidth: number;
	/** Weight of the face (400 regular, 700 bold). */
	readonly weight: number;
	/** Vertical resolution the face was designed for (96 or 120 dpi). */
	readonly vertRes: number;
}

/** The face GDI maps a font to and the whole-number stretches of its bitmaps. */
export interface RasterMapperPick {
	readonly index: number;
	readonly scaleY: number;
	readonly scaleX: number;
}

/** Largest vertical factor GDI uses. */
const MAX_SCALE_Y = 8;
/** Largest horizontal factor GDI uses. */
const MAX_SCALE_X = 5;
/** Cost of each pixel a stretched face is too small by. */
const COST_SMALL = 3;
/** Fixed cost of a stretched face that is too big, plus `COST_BIG` per pixel. */
const COST_BIG_BASE = 12;
const COST_BIG = 3;
/** Cost of a vertical factor n (index n). */
const COST_STRETCH = [0, 0, 2.12, 3.03, 4.1, 5.09, 5.6, 6.3, 6.85];
/**
 * Cost of vertical factors 6 to 8 when lfWidth is 0. The horizontal factor stops at 5, so for a request without a width
 * these factors cost far more (about 25, 35 and 41) than with an explicit width (COST_STRETCH plus the aspect penalty,
 * about 15, 18 and 20), and carry no aspect penalty of their own.
 */
const COST_STRETCH_NATURAL = [0, 0, 2.12, 3.03, 4.1, 5.09, 24.5, 34.5, 41.5];
/** Aspect penalty of a horizontal factor wider than the vertical one: `OVER * kx / ky + OVER0`. */
const ASPECT_OVER = 8.67;
const ASPECT_OVER0 = -0.15;
/** Aspect penalty of a horizontal factor narrower than the vertical one: `UNDER * ky / kx + UNDER0`. */
const ASPECT_UNDER = 7.39;
const ASPECT_UNDER0 = 0.33;
/** Cost per 100 weight units of distance, and when only one of the two is bold (600 and above). */
const COST_WEIGHT_LINEAR = 0.25;
const COST_WEIGHT_CLASS = 0.5;
/** Faces drawn for another resolution lose ties. */
const COST_OTHER_DPI = 0.05;

/** Face character height (cell minus internal leading) for a negative lfHeight, cell height otherwise. */
function unitOf(face: RasterMapperFace, characterHeight: boolean): number {
	return characterHeight ? Math.max(1, face.pixHeight - face.internalLeading) : face.pixHeight;
}

/** The vertical factor a face of height `unit` takes for a request of `target` pixels. */
function verticalFactor(unit: number, target: number): number {
	const cap = Math.min(MAX_SCALE_Y, Math.max(1, unit - 3));
	const n = Math.min(cap, Math.max(1, Math.floor(target / unit)));
	const overshoot = Math.floor(n === 1 ? (unit - 1) / 4 : unit / 4);
	return n + 1 <= cap && (n + 1) * unit - target <= overshoot ? n + 1 : n;
}

/**
 * Picks the face and stretches for a font of the given height (negative for a character height, positive for a
 * cell height), `lfWidth` (0 for the face's own proportions) and weight. Returns null for an empty list.
 */
export function pickRasterFace(faces: readonly RasterMapperFace[], height: number, width: number, weight: number): RasterMapperPick | null {
	if (faces.length === 0 || height === 0) {
		return null;
	}
	const characterHeight = height < 0;
	const target = Math.abs(height);
	let best: RasterMapperPick | null = null;
	let bestCost = Infinity;
	for (let index = 0; index < faces.length; index++) {
		const face = faces[index];
		const unit = unitOf(face, characterHeight);
		const avg = Math.max(1, face.avgWidth);
		const weightCost =
			(Math.abs(face.weight - weight) / 100) * COST_WEIGHT_LINEAR +
			(face.weight >= 600 !== weight >= 600 ? COST_WEIGHT_CLASS : 0) +
			(face.vertRes === 96 ? 0 : COST_OTHER_DPI);
		const ky = verticalFactor(unit, target);
		const kx = width > 0 ? Math.min(MAX_SCALE_X, Math.max(1, Math.floor((2 * width + avg) / (2 * avg)))) : Math.min(ky, MAX_SCALE_X);
		const d = unit * ky - target;
		let cost = d < 0 ? -d * COST_SMALL : d > 0 ? COST_BIG_BASE + d * COST_BIG : 0;
		if (width > 0) {
			cost += COST_STRETCH[ky] + Math.abs(kx * avg - width);
		} else {
			cost += COST_STRETCH_NATURAL[ky];
		}
		if (width > 0 || ky <= MAX_SCALE_X) {
			if (kx > ky) {
				cost += ASPECT_OVER * (kx / ky) + ASPECT_OVER0;
			} else if (kx < ky) {
				cost += ASPECT_UNDER * (ky / kx) + ASPECT_UNDER0;
			}
		}
		cost += weightCost + kx * 1e-3 + index * 1e-4;
		if (cost < bestCost - 1e-9) {
			bestCost = cost;
			best = { index, scaleY: ky, scaleX: kx };
		}
	}
	return best;
}
