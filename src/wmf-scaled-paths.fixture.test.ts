/**
 * Native `GetPath` of Chord, Pie, Arc, Ellipse and RoundRect under a `PS_INSIDEFRAME` geometric pen at the WMF 0.96 scale
 * (`wmf-scaled-path-probe`, 1,500 shapes). An odd device pen width puts the shape's vertical edges on half a FIX and
 * shears its points with height, and a RoundRect's edge end points are rounded from the unrounded corner; every shape
 * matches Windows point for point (a pen as wide as the shape: an Ellipse or RoundRect keeps the box without the pen's inset, and one chord is a FIX off, see SLIVER).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { parseWmfHeader } from './emf-header-parser';
import { GdiRasterPath } from './gdi-raster';
import { createWmfPlayer } from './wmf-replay';
import { wmfShapePath } from './wmf-shapes';

interface NativeShape {
	kind: number;
	pw: number;
	box: [number, number, number, number];
	rad: [number, number, number, number];
	corner: [number, number];
	pts: number[];
}

const KINDS = ['chord', 'pie', 'arc', 'ellipse', 'roundrect'] as const;
/**
 * A chord whose pen is as wide as its box (99 units on 100): the inset box is inverted in x, which Windows still builds as a
 * sliver of 8 FIX. Four of its values are a FIX off (whole-quadrant rounding at that width).
 */
const SLIVER = 985;

describe('WMF shapes at the 0.96 scale against native GetPath', () => {
	const bytes = readFileSync(fixturePath('wmf-shapes-scaled.wmf'));
	const view = new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
	const header = parseWmfHeader(view);
	const shapes = JSON.parse(readFileSync(fixturePath('wmf-scaled-paths.json'), 'utf8')) as NativeShape[];
	const ctx = new Proxy({}, { get: () => () => undefined }) as never;
	const mismatches: Record<string, number> = {};
	let maxDelta = 0;

	for (const [index, c] of shapes.entries()) {
		const oddWidth = Math.round(c.pw * (365 / 3800) * 16) % 2 === 1;
		const name = `${KINDS[c.kind]}${oddWidth ? ' (odd width)' : ''}`;
		it(`${name} #${index}`, () => {
			const p = createWmfPlayer(view, ctx, header!, 365, 242);
			p.rCtx.state.penStyle = 6;
			p.rCtx.state.penWidth = c.pw;
			const [l, t, r, b] = c.box;
			let path: GdiRasterPath | null;
			if (c.kind < 3) {
				path = new GdiRasterPath();
				wmfShapePath.arc(p, KINDS[c.kind] as 'chord' | 'pie' | 'arc', l, t, r, b, ...c.rad, path);
			} else if (c.kind === 3) {
				path = wmfShapePath.ellipse(p, l, t, r, b);
			} else {
				path = wmfShapePath.roundRect(p, l, t, r, b, c.corner[0], c.corner[1]);
			}
			if (!path || path.getPath.types.length === 0) {
				// A pen wider than the box in y: an arc has no path.
				expect(c.pts.length).toBe(0);
				return;
			}
			const got = path?.getPath ?? { pts: [], types: [] };
			expect(got.types.length).toBe(c.pts.length / 3);
			let worst = 0;
			for (let i = 0; i < got.types.length; i++) {
				expect(got.types[i]).toBe(c.pts[3 * i + 2]);
				worst = Math.max(worst, Math.abs(got.pts[2 * i] - c.pts[3 * i]), Math.abs(got.pts[2 * i + 1] - c.pts[3 * i + 1]));
			}
			if (index === SLIVER) {
				expect(worst).toBeLessThanOrEqual(1);
				return;
			}
			maxDelta = Math.max(maxDelta, worst);
			if (worst > 0) {
				mismatches[name] = (mismatches[name] ?? 0) + 1;
			}
		});
	}

	it('every shape matches', () => {
		expect(mismatches).toEqual({});
		expect(maxDelta).toBe(0);
	});
});
