/**
 * Native `WidenPath` of dashed, square-capped arcs under world scales 2, 0.5, 0.75 and 1.5 and the 1/16 and 2 by 1 anisotropic map
 * modes (`scaled-dash-cap-probe`: a stock `PS_DASH` pen and a user style, every 6 degrees of sweep at two start angles, 118 arcs per
 * transform and style, 1,416 outlines).
 *
 * A dashed pen under such a scale lays its pattern out in logical units and measures each flattened segment by its logical vector rounded
 * to the nearest whole unit (the device vector over the axis scale, ties away from zero), places the cut points at the same fraction of
 * the real segment, scales a square cap at a dash end by real over measured length, and extends the path's own start and end caps by
 * the tangent cut to whole logical units (as for undashed pens). Before, a scaled dashed pen used the device vector's exact length:
 * only 95 of the 1,416 outlines were fill-identical (the dash phase drifted by a pixel or more along the arc, up to 800 pixels).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath, fillPolygonSpans, type SpanList } from './gdi-raster';
import type { EmfGdiReplayCtx } from './emf-types';
import { penWidenOptions } from './emf-gdi-raster-shapes';
import { widenPath, type WidenOptions } from './gdi-raster-widen';

const cases: any[] = JSON.parse(gunzipSync(readFileSync(fixturePath('scaled-dash-caps.json.gz'))).toString());
/** Device pixels per logical unit along x and y of each probed transform. */
const scales: Record<string, [number, number]> = { s2: [2, 2], 's0.5': [0.5, 0.5], 's0.75': [0.75, 0.75], 's1.5': [1.5, 1.5], aniso16: [1 / 16, 1], aniso2: [0.5, 1] };

function pixels(spans: SpanList): Set<number> {
	const set = new Set<number>();
	for (let k = 0; k < spans.length * 3; k += 3) for (let x = spans.data[k + 1]; x < spans.data[k + 2]; x++) set.add(spans.data[k] * 4096 + x);
	return set;
}
function nativePolygons(points: number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) out.push([]);
		out[out.length - 1].push(points[i], points[i + 1]);
	}
	return out;
}
function differing(ours: number[][], native: number[][]): number {
	const a = pixels(fillPolygonSpans(ours, true));
	const b = pixels(fillPolygonSpans(native, true));
	let d = 0;
	for (const v of a) if (!b.has(v)) d++;
	for (const v of b) if (!a.has(v)) d++;
	return d;
}

/** The options `penWidenOptions` builds for the capture's pen under its transform (a replay context with just what it reads). */
function options(c: any): WidenOptions {
	const [mx, my] = scales[c.scale];
	const flags = 0x10000 | c.style | 0x100;
	const ctx = {
		state: { worldTransform: [mx, 0, 0, my, 0, 0], penWidth: c.width, penStyle: flags, penFlags: flags, penExtended: true, penUserStyle: c.dashes, miterLimit: 10 },
		sx: 1,
		sy: 1,
		bounds: { left: 0, top: 0 },
		useMappingMode: false,
		wholeDevicePixels: undefined,
	};
	return penWidenOptions(ctx as unknown as EmfGdiReplayCtx);
}

it('widens dashed square-capped arcs under six scales as native does: 1,416 of 1,416 fill identically (95 before)', () => {
	expect(cases).toHaveLength(1416);
	const bad: Record<string, number> = {};
	for (const c of cases) {
		const pts: number[] = [];
		for (let i = 0; i < c.source.length; i += 3) pts.push(c.source[i], c.source[i + 1]);
		const path = new GdiRasterPath();
		path.addBeziers(pts, true);
		if (differing(widenPath(path, options(c)), nativePolygons(c.expected)) > 0) {
			const key = `${c.scale}/${c.style}`;
			bad[key] = (bad[key] ?? 0) + 1;
		}
	}
	expect(bad).toEqual({});
});
