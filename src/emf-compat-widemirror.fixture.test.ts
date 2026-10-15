/**
 * Wide pens under the 3:2 by 1:1 map and its x mirror (`compat-widemirror-probe`, `CompatPlaybackProbe.WideMirror`): 300 random
 * lines, horizontal and vertical lines, triangles, quadrilaterals, ellipses or zero-length lines (dots) per sheet, drawn with a plain
 * `CreatePen` pen of 3 or 4 logical units (`p3`, `p4`) with the viewport x extent 2 (`u`) or -2 (`m`), recorded and played back
 * natively (`PlayEnhMetaFile`).
 *
 * What the sheets decided: an unequal-scale pen is an elliptical nib (here 2 x 3 pixels for `p3`), and when the map mirrors x its
 * flattened polygon is the one the matrix nib gives (`penPolygonMatrix`: the diamond (+-16, 0), (0, +-24) rather than the octagon
 * with (+-11, +-17)). An end pixel is then pointed where the octagon would have been square: at the point of a horizontal line the
 * native top and bottom rows stop a pixel short on the end whose fractional device position puts the corner outside the diamond.
 * Before this, the mirrored sheets differed in 410 to 681 pixels each (`p3`, 455 for lines, 536 for ellipses, 637 for triangles);
 * the unmirrored sheets were already exact.
 *
 * Dots (`dot`, zero-length lines; 98 pixels on each `p3` sheet, 196 on `p4-m`) and the 3 to 14 end pixels of the line sheets were
 * one rule: a dot whose rounded device position is a whole pixel on both axes has a nib pulled in by one FIX
 * (`gdi-dot-nib.fixture.test.ts`; the line sheets hold such zero-length figures too). What is left is the 5 pixels of the polygon
 * sheets below.
 */
import { describe, expect, it } from 'vitest';

import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

const kinds = ['line', 'hline', 'vline', 'poly3', 'poly4', 'ellipse', 'dot'];

/** Differing pixels per sheet; every sheet not listed is pixel-exact. */
const residual: Record<string, number> = {
	'compat-widemirror-poly3-p3-m': 2,
	'compat-widemirror-poly3-p4-m': 1,
	'compat-widemirror-poly4-p4-m': 2,
};

const sheets = kinds.flatMap((k) => ['p3', 'p4'].flatMap((p) => ['m', 'u'].map((m) => `compat-widemirror-${k}-${p}-${m}`)));

describe('wide plain pens under an anisotropic map that mirrors x, recorded and played back natively', () => {
	it('covers 28 sheets', () => {
		expect(sheets).toHaveLength(28);
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
