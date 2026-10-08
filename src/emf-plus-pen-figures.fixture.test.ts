/**
 * EMF+ pens on closed figures against GDI+ playback (`emfplus-pens` group, `GpxPenFigureCases`): a sheet of 24 figures (rectangle, ellipse,
 * triangle, concave star, closed curve, rounded path; pen widths 3, 6, 9 and 14) per pen kind, aliased and antialiased, 500 x 480 pixels.
 *
 *  - `gpx-pen-center-miter-*`: the centered control, exact in both modes.
 *  - `gpx-pen-compound-center-*`: compound arrays {0, .3, .6, 1} and {0, .2, .4, .6, .8, 1} on the same figures. Exact in both modes now: the
 *    inner side of every band meets at the point where the offset lines cross (the overlapping end points of an open polyline left spikes
 *    at the corners of a closed figure; 1,423 aliased and 6,790 antialiased pixels differed before).
 *  - `gpx-pen-inset-<join>-*`: Inset alignment. GDI+ strokes the ring between the figure and the figure offset inward by the whole width, not
 *    the band swept along each edge, which put a spike outside every acute corner of a polygon (1,581 to 1,976 aliased pixels differ
 *    before). The corners of the inner boundary are where the offset lines meet; at a reflex vertex it takes the pen's join. A pen that fills
 *    the figure completely leaves no hole. The aliased sheets fall to 52, 119 and 458 differing pixels for miter, bevel and round joins; the
 *    antialiased ones keep about 8,600 pixels (one antialiasing sample along the curved edges, both outer and inner; the centered control is
 *    exact, so it is the inset's own flattening) and the round join keeps 90 pixels per width on the rounded path.
 */
import { describe, expect, it } from 'vitest';

import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

/** Differing pixels (any channel) of 240,000. */
const EXPECTED: Record<string, number> = {
	'gpx-pen-center-miter-aliased': 0,
	'gpx-pen-center-miter-aa': 0,
	'gpx-pen-compound-center-aliased': 0,
	'gpx-pen-compound-center-aa': 0,
	'gpx-pen-inset-miter-aliased': 52,
	'gpx-pen-inset-bevel-aliased': 119,
	'gpx-pen-inset-round-aliased': 458,
	'gpx-pen-inset-miter-aa': 8573,
	'gpx-pen-inset-bevel-aa': 8649,
	'gpx-pen-inset-round-aa': 8944,
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
