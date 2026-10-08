/**
 * GM_COMPATIBLE drawing recorded into a metafile and played back natively (`compat-playback-probe`, `CompatPlaybackProbe.cs`).
 * The compat rules of the converter were fitted to calls drawn straight onto a device; an EMF is played back from its records,
 * so each is re-measured here against `PlayEnhMetaFile`:
 *
 *  - `compat-playback-<map>-<pen>`: 36 mixed shapes (Ellipse, Arc, Chord, Pie, Rectangle, RoundRect, Polygon, lines, a clockwise
 *    Chord) under map modes 1:1, 4:3, 10:7, 3:4, 2:1 and 3:2 by 1:1, with a null, cosmetic, 3 and 7 pixel plain, 5 and 9 pixel
 *    geometric and dotted pen. Counts below are differing pixels of 126,000 (before the playback rules: 133,868 over the 102
 *    sheets in all, after: 259).
 *  - `compat-rects-<map>-<pen>`: 315 Rectangles each at every fractional phase of ten maps (4:3, 10:7, 3:4, 7:3, 5:4, 1:2, the 4:3
 *    map with window and viewport origins, 1:2 with origins, and world scales 3/4 and 4/3) under a cosmetic, null and dotted pen:
 *    a cosmetic or dotted pen puts every edge of the outline and the fill at `ceil(device coordinate)`.
 *  - `compat-ellipses-<map>-<pen>`: 315 null-pen Ellipses at the same phases: the quarter-pixel growth of a null pen's box
 *    happens exactly when all four device edges are whole pixels, at any scale.
 *
 * What is left in `compat-playback-*` is arcs (radials of Arc, Chord and Pie, one to four pixels each, and one dotted
 * Chord of 37): see docs/outstanding-work.md.
 */
import { describe, expect, it } from 'vitest';

import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

const maps = ['id', 'r43', 'r107', 'r34', 'r21', 'r32x11'];
const pens = ['null', 'cosmetic', 'wide3', 'wide7', 'geo5', 'geosq9', 'dash'];
const sweeps = ['r43', 'r107', 'r34', 'r73', 'r54', 'r12', 'r43o', 'r12o', 'w43', 'w34'];

/** Differing pixels per sheet; every sheet not listed is pixel-exact. */
const residual: Record<string, number> = {
	'compat-playback-id-null': 2,
	'compat-playback-r107-cosmetic': 8,
	'compat-playback-r107-dash': 37,
	'compat-playback-r107-geo5': 12,
	'compat-playback-r107-geosq9': 20,
	'compat-playback-r107-null': 3,
	'compat-playback-r107-wide3': 12,
	'compat-playback-r107-wide7': 7,
	'compat-playback-r21-null': 3,
	'compat-playback-r32x11-cosmetic': 1,
	'compat-playback-r32x11-dash': 4,
	'compat-playback-r32x11-geo5': 10,
	'compat-playback-r32x11-geosq9': 2,
	'compat-playback-r32x11-null': 3,
	'compat-playback-r32x11-wide7': 7,
	'compat-playback-r34-cosmetic': 14,
	'compat-playback-r34-dash': 21,
	'compat-playback-r34-geo5': 18,
	'compat-playback-r34-geosq9': 55,
	'compat-playback-r34-null': 3,
	'compat-playback-r34-wide3': 11,
	'compat-playback-r34-wide7': 6,
};

const sheets = [
	...maps.flatMap((m) => pens.map((p) => `compat-playback-${m}-${p}`)),
	...sweeps.flatMap((s) => ['cosmetic', 'null', 'dot'].map((p) => `compat-rects-${s}-${p}`)),
	...sweeps.flatMap((s) => ['cosmetic', 'null', 'dot'].map((p) => `compat-ellipses-${s}-${p}`)),
];

describe('GM_COMPATIBLE drawing recorded and played back natively', () => {
	it('covers 102 sheets', () => {
		expect(sheets).toHaveLength(102);
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
