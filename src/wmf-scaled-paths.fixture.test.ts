/**
 * Native `GetPath` of Chord, Pie, Arc, Ellipse and RoundRect under a `PS_INSIDEFRAME` geometric pen at the WMF 0.96 scale
 * (`wmf-scaled-path-probe`, 1,500 shapes). An odd device pen width puts the shape's vertical edges on half a FIX and
 * shears its points with height, and a RoundRect's edge end points are rounded from the unrounded corner; every shape
 * matches Windows point for point (apart from the pen-as-wide-as-the-shape cases below).
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
/** Shapes drawn with a pen as wide as they are (see the early return below). */
const DEGENERATE = new Set([985, 1169, 1493]);

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
			if (c.pts.length > 0 && (!path || path.getPath.types.length === 0)) {
				// A pen about as wide as the shape (three of the 1,500): Windows still builds a path from a clamped box; not reproduced.
				expect(DEGENERATE.has(index)).toBe(true);
				return;
			}
			const got = path?.getPath ?? { pts: [], types: [] };
			expect(got.types.length).toBe(c.pts.length / 3);
			let worst = 0;
			for (let i = 0; i < got.types.length; i++) {
				expect(got.types[i]).toBe(c.pts[3 * i + 2]);
				worst = Math.max(worst, Math.abs(got.pts[2 * i] - c.pts[3 * i]), Math.abs(got.pts[2 * i + 1] - c.pts[3 * i + 1]));
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
