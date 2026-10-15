/**
 * EMF+ pens on closed figures against GDI+ playback (`emfplus-pens` group, `GpxPenFigureCases`): a sheet of 24 figures (rectangle, ellipse,
 * triangle, concave star, closed curve, rounded path; pen widths 3, 6, 9 and 14) per pen kind, aliased and antialiased, 500 x 480 pixels.
 *
 *  - `gpx-pen-center-miter-*`: the centered control, exact in both modes.
 *  - `gpx-pen-compound-center-*`: compound arrays {0, .3, .6, 1} and {0, .2, .4, .6, .8, 1} on the same figures. Exact in both modes now: the
 *    inner side of every band meets at the point where the offset lines cross (the overlapping end points of an open polyline left spikes
 *    at the corners of a closed figure; 1,423 aliased and 6,790 antialiased pixels differed before).
 *  - `gpx-pen-inset-<join>-*`: Inset alignment. GDI+ draws the pen at twice its width, centered, and clips it to the figure with its hard
 *    (aliased) clip: the aliased sheets are exact for all three joins (the ring model before: 52, 119 and 458 differing pixels; the band
 *    swept along each edge before that: 1,581 to 1,976). Antialiased, it fills the outline of the surviving pixels, a polygon on whole-pixel
 *    coordinates with some staircase corners cut (`emf-plus-inset-outline.ts`, `emf-plus-inset-outline.fixture.test.ts`): exact now (6 differing
 *    pixels on each sheet before the hole-tip rule: a hole that touches itself at a corner is traced as separate holes), against 8,573 to 8,944
 *    before. The round join needed one more rule (`ROUND_SMOOTH_DOT` in `emf-plus-widen.ts`): the straight edge next to a turn of under
 *    about 8 degrees sits 1/16 pixel inside.
 */
import { describe, expect, it } from 'vitest';

import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

/** Differing pixels (any channel) of 240,000. */
const EXPECTED: Record<string, number> = {
	'gpx-pen-center-miter-aliased': 0,
	'gpx-pen-center-miter-aa': 0,
	'gpx-pen-compound-center-aliased': 0,
	'gpx-pen-compound-center-aa': 0,
	'gpx-pen-inset-miter-aliased': 0,
	'gpx-pen-inset-bevel-aliased': 0,
	'gpx-pen-inset-round-aliased': 0,
	'gpx-pen-inset-miter-aa': 0,
	'gpx-pen-inset-bevel-aa': 0,
	'gpx-pen-inset-round-aa': 0,
};

describe('EMF+ pens on closed figures', () => {
	for (const [name, count] of Object.entries(EXPECTED)) {
		it(`${name}: ${count} differing pixels`, async () => {
			const rendered = await renderFixture(`${name}.emf`);
			expect(rendered).not.toBeNull();
			expect(diffImages(rendered!, await loadReference(name), 0, 0).mismatched).toBe(count);
		});
	}
});
