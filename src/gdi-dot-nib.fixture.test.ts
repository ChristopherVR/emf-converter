/**
 * The nib of a dot (a zero-length `LineTo`) of a wide plain pen, recorded and played back natively (`compat-dot-grid-probe`,
 * `CompatPlaybackProbe.DotGrid`, `compat-dot-grid.json.gz`): `WidenPath` of a `MoveTo`/`LineTo` to the same point at every sub-pixel
 * device position under the 2 by 3 and 2.67 by 4 pixel nibs of `compat-widemirror` (both signs of the x extent), and at one whole pixel
 * under fifteen other pens and maps, plus eight short lines at a whole-pixel start.
 *
 * What the captures decided: the nib is whole everywhere except at a dot whose rounded device position is a whole pixel on both axes.
 * There every vertex but the pen's first and its opposite (the top and the bottom of an ellipse) sits one FIX nearer the centre along
 * each axis it is off the centre ((+-16, 0) is (+-15, 0), (+-11, +-17) is (+-10, +-16), the digital pens of 2 to 5 pixels and the flattened
 * circles of 8 and 12 pixels alike). A line at a whole-pixel start keeps its whole nib. The pulled nib takes the pixels at whole-pixel
 * neighbours out of the fill (a 3 pixel pen dot is a 1 by 3 bar rather than a bar with a neighbour), the 98 pixels of each 3-unit
 * `compat-widemirror-dot` sheet.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { GdiRasterPath } from './gdi-raster';
import { widenPath } from './gdi-raster-widen';

interface Variant {
	v: string;
	/** Map mode, window extents, viewport extents, pen width. */
	map: [number, number, number, number, number, number];
	dots: { rec: [number, number]; played: number[] }[];
}

const variants: Variant[] = JSON.parse(gunzipSync(readFileSync(fixturePath('compat-dot-grid.json.gz'))).toString());
const W = 420;

/** The device FIX centre of a recorded dot: nearest, a tie going up on y and toward the x extent's sign. */
function device(v: Variant, lx: number, ly: number): [number, number] {
	const [mode, wx, wy, vx, vy] = v.map;
	if (mode !== 8) {
		return [lx * 16, ly * 16];
	}
	const fx = (vx < 0 ? W * 16 : 0) + (lx * vx * 16) / wx;
	const fy = (ly * vy * 16) / wy;
	return [vx < 0 ? Math.ceil(fx - 0.5) : Math.floor(fx + 0.5), Math.floor(fy + 0.5)];
}

function outline(v: Variant, x0: number, y0: number, x1: number, y1: number): Set<string> {
	const [mode, wx, wy, vx, vy, pw] = v.map;
	const sx = mode === 8 ? Math.abs(vx / wx) : 1;
	const sy = mode === 8 ? Math.abs(vy / wy) : 1;
	const path = new GdiRasterPath();
	path.moveTo(x0, y0);
	path.lineTo(x1, y1);
	const out = widenPath(path, {
		width: vx < 0 ? pw * 16 : Math.round(pw * sx * 16),
		...(sx !== sy && vx > 0 ? { height: Math.round(pw * sy * 16) } : {}),
		...(vx < 0 ? { matrix: [vx / wx, 0, 0, vy / wy] as [number, number, number, number], deviceNib: true } : {}),
		cap: 'round',
		join: 'round',
		miterLimit: 10,
	});
	const set = new Set<string>();
	for (const f of out) {
		for (let i = 0; i + 1 < f.length; i += 2) {
			set.add(`${f[i]},${f[i + 1]}`);
		}
	}
	return set;
}

function nativeSet(played: number[]): Set<string> {
	const set = new Set<string>();
	for (let i = 0; i + 2 < played.length; i += 3) {
		set.add(`${played[i]},${played[i + 1]}`);
	}
	return set;
}

function same(a: Set<string>, b: Set<string>): boolean {
	return a.size === b.size && [...a].every((k) => b.has(k));
}

it('covers the captured variants', () => {
	expect(variants.map((v) => v.v)).toHaveLength(23);
	expect(variants.slice(0, 4).map((v) => v.dots.length)).toEqual([2048, 2048, 768, 768]);
	expect(variants.slice(4).map((v) => v.dots.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1]);
});

for (const v of variants.filter((c) => !c.v.startsWith('L'))) {
	it(`${v.v}: ${v.dots.length} dots have the native nib`, () => {
		let wrong = 0;
		for (const d of v.dots) {
			const [x, y] = device(v, d.rec[0], d.rec[1]);
			if (!same(outline(v, x, y, x, y), nativeSet(d.played))) {
				wrong++;
			}
		}
		expect(wrong).toBe(0);
	});
}

for (const v of variants.filter((c) => c.v.startsWith('L'))) {
	it(`${v.v}: a line from a whole pixel keeps the whole nib`, () => {
		const [mode, wx, wy, vx, vy] = v.map;
		const dx = v.v.endsWith('-v') ? 0 : 20;
		const dy = v.v.endsWith('-h') ? 0 : v.v.endsWith('-v') ? 20 : 7;
		const k = (l: number, a: number, b: number): number => (mode === 8 ? Math.round((l * a * 16) / b) : l * 16);
		const x0 = k(50, vx, wx), y0 = k(50, vy, wy);
		const x1 = k(50 + dx, vx, wx), y1 = k(50 + dy, vy, wy);
		expect(same(outline(v, x0, y0, x1, y1), nativeSet(v.dots[0].played))).toBe(true);
	});
}
