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
 * What is left: the dots (`dot`, zero-length lines) of `p3` and `p4` (98 and 196 pixels on the mirrored sheets, 98 on the
 * unmirrored `p3` sheet): at a whole-pixel centre the native 1 x 3 bar excludes the vertex of the nib on the pixel centre where
 * the converter includes it, and a few `p4` ends.
 */
import { describe, expect, it } from 'vitest';

import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

const kinds = ['line', 'hline', 'vline', 'poly3', 'poly4', 'ellipse', 'dot'];

/** Differing pixels per sheet; every sheet not listed is pixel-exact. */
const residual: Record<string, number> = {
	'compat-widemirror-line-p3-m': 3,
	'compat-widemirror-line-p3-u': 3,
	'compat-widemirror-line-p4-m': 6,
	'compat-widemirror-hline-p3-m': 4,
	'compat-widemirror-hline-p3-u': 4,
	'compat-widemirror-hline-p4-m': 8,
	'compat-widemirror-vline-p3-m': 7,
	'compat-widemirror-vline-p3-u': 7,
	'compat-widemirror-vline-p4-m': 14,
	'compat-widemirror-poly3-p3-m': 2,
	'compat-widemirror-poly3-p4-m': 1,
	'compat-widemirror-poly4-p4-m': 2,
	'compat-widemirror-dot-p3-m': 98,
	'compat-widemirror-dot-p3-u': 98,
	'compat-widemirror-dot-p4-m': 196,
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
