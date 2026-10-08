/**
 * GM_COMPATIBLE drawing recorded under maps that mirror an axis and played back natively
 * (`compat-playback-mirror-probe`, `CompatPlaybackProbe.RunMirrored` and `RectSweepMirrored`):
 *
 *  - `compat-playback-m<x|y|xy>-<map>-<pen>`: the 36 mixed shapes of `compat-playback-*` (Ellipse, Arc, Chord, Pie, Rectangle,
 *    RoundRect, Polygon, lines and a clockwise Chord) under a negative viewport x extent, y extent or both (the viewport origin at
 *    the far edge), for the 1:1, 10:7, 3:4 and 3:2 by 1:1 maps and a null, cosmetic, plain 3, geometric round 5 and dotted pen:
 *    60 sheets. Differing pixels of 126,000 per sheet below; before the mirroring rules 399,930 over the 60 sheets, now 410.
 *  - `compat-rects-m<x|y|xy>-<sweep>-<pen>` and `compat-ellipses-m...`: 315 Rectangles or null/cosmetic/dotted-pen Ellipses at
 *    every fractional phase of the 4:3, 10:7, 3:4 and 1:2 maps mirrored the same three ways, 72 sheets (150,507 differing pixels
 *    before, none now).
 *
 * What the sheets decided (paths: `emf-compat-playback-shapes.fixture.test.ts`): the record carries the call's direction inverted
 * once when the map's determinant is negative and a box in device order; an arc, a Chord and a Pie are the logical shape mapped
 * point by point with the roundings of the mirrored axes flipped; a Rectangle drawn with a cosmetic or dotted pen takes every edge
 * to `ceil(device coordinate)` in any orientation, a drawn Rectangle is traversed in device order whichever way the map mirrors
 * (a dotted outline shows it), and a RoundRect is the logical shape mapped (its horizontal controls round down under a mirrored x).
 *
 * What is left (410 pixels): a wide pen under the anisotropic 3:2 by 1:1 map that mirrors x puts a diagonal edge pixel of
 * polygons, lines, ellipses and arcs on the other side (169 and 166 pixels on `wide3`, the plain 3 unit pen: the nib's
 * perpendicular rounding is not mirror symmetric), and the RoundRect corner under the non-dyadic maps (a handful of pixels, as
 * unmirrored; the RoundRect half-width under a mirrored x is a FIX off in about one shape of five).
 */
import { describe, expect, it } from 'vitest';

import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

const mirrors = ['x', 'y', 'xy'];
const maps = ['id', 'r107', 'r34', 'r32x11'];
const pens = ['null', 'cosmetic', 'wide3', 'geo5', 'dash'];
const sweeps = ['r43', 'r107', 'r34', 'r12'];

/** Differing pixels per sheet; every sheet not listed is pixel-exact. */
const residual: Record<string, number> = {
	'compat-playback-mx-r107-wide3': 6,
	'compat-playback-mx-r34-wide3': 3,
	'compat-playback-mx-r34-geo5': 2,
	'compat-playback-mx-r34-dash': 7,
	'compat-playback-mx-r32x11-cosmetic': 4,
	'compat-playback-mx-r32x11-wide3': 169,
	'compat-playback-mx-r32x11-geo5': 12,
	'compat-playback-my-r107-cosmetic': 1,
	'compat-playback-my-r107-geo5': 1,
	'compat-playback-my-r34-geo5': 4,
	'compat-playback-my-r32x11-cosmetic': 1,
	'compat-playback-mxy-r107-null': 1,
	'compat-playback-mxy-r107-cosmetic': 2,
	'compat-playback-mxy-r107-wide3': 2,
	'compat-playback-mxy-r107-dash': 3,
	'compat-playback-mxy-r34-null': 1,
	'compat-playback-mxy-r34-wide3': 6,
	'compat-playback-mxy-r34-dash': 3,
	'compat-playback-mxy-r32x11-cosmetic': 4,
	'compat-playback-mxy-r32x11-wide3': 166,
	'compat-playback-mxy-r32x11-geo5': 12,
};

const sheets = [
	...mirrors.flatMap((mi) => maps.flatMap((m) => pens.map((p) => `compat-playback-m${mi}-${m}-${p}`))),
	...['rects', 'ellipses'].flatMap((shape) => mirrors.flatMap((mi) => sweeps.flatMap((s) => ['cosmetic', 'null', 'dot'].map((p) => `compat-${shape}-m${mi}-${s}-${p}`)))),
];

describe('GM_COMPATIBLE drawing under mirrored maps, recorded and played back natively', () => {
	it('covers 132 sheets and 410 differing pixels', () => {
		expect(sheets).toHaveLength(132);
		expect(Object.values(residual).reduce((a, b) => a + b, 0)).toBe(410);
	});
	for (const name of sheets) {
		it(`${name}: ${residual[name] ?? 0} differing pixels`, async () => {
			const rendered = await renderFixture(`${name}.emf`);
			expect(rendered).not.toBeNull();
			const diff = diffImages(rendered!, await loadReference(name), 0, 0);
			expect(diff.mismatched).toBe(residual[name] ?? 0);
		});
	}
});
