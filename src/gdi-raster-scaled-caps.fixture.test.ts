import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiRasterPath } from './gdi-raster';
import { widenPath, type WidenOptions } from './gdi-raster-widen';

interface Record {
	scale: string;
	width: number;
	dx?: number;
	dy?: number;
	sweep?: number;
	source: number[];
	expected: number[];
}

const load = (name: string): Record[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
const lines = load('scaled-line-caps.json.gz');
const arcs = load('scaled-cap-sweep.json.gz');
const penWidths: { scale: number | string; width: number; expected: number[]; expectedVertical: number[] }[] = JSON.parse(
	readFileSync(new URL('./__fixtures__/gdi/scaled-pen-widths.json', import.meta.url), 'utf8'),
);

/** Device pixels per logical unit of each probed transform (`scaled-line-caps-probe`). */
const scales: Record<string, number> = { s1: 1, s2: 2, 's0.5': 0.5, 's0.75': 0.75, 's1.5': 1.5, 's0.7': 0.7, 's1.3': 1.3, 's2.5': 2.5, 's0.6': 0.6, 'c10:7': 0.7, 'c4:3': 0.75 };
const c30 = Math.fround(Math.cos(Math.PI / 6));
const s30 = Math.fround(Math.sin(Math.PI / 6));

function polygons(points: number[]): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < points.length; i += 3) {
		if (points[i + 2] === 6) out.push([]);
		out[out.length - 1].push(points[i], points[i + 1]);
	}
	return out;
}

function linePath(source: number[]): GdiRasterPath {
	const path = new GdiRasterPath();
	path.moveTo(source[0], source[1]);
	path.lineTo(source[3], source[4]);
	return path;
}

function arcPath(source: number[]): GdiRasterPath {
	const pts: number[] = [];
	for (let i = 0; i < source.length; i += 3) pts.push(source[i], source[i + 1]);
	const path = new GdiRasterPath();
	path.addBeziers(pts, true);
	return path;
}

/** The options `penWidenOptions` builds for a square-capped, round-joined geometric pen under a uniform world scale `s`. */
function uniformOptions(c: Record, s: number, logical: boolean): WidenOptions {
	return {
		// The nib is the width in FIX; only the cut-less rule of the old extension (`logical` false) kept the whole-pixel pen.
		width: logical ? Math.round(c.width * s * 16) : Math.max(1, Math.floor(c.width * s + 0.5)) * 16,
		cap: 'square',
		join: 'round',
		miterLimit: 10,
		...(logical ? { cutToLogicalUnits: true, logicalScale: s, capWidth: c.width * s * 16 } : {}),
	};
}

/** The cap midpoints (start, end) of a one-segment outline: the cap extension without the perpendicular's rounding. */
function capMidpoints(o: number[]): string {
	return `${o[0] + o[2]},${o[1] + o[3]},${o[4] + o[6]},${o[5] + o[7]}`;
}

function lineCounts(name: string, options: (c: Record) => WidenOptions) {
	let caps = 0;
	let vertices = 0;
	const list = lines.filter((c) => c.scale === name);
	for (const c of list) {
		const o = widenPath(linePath(c.source), options(c))[0];
		const n = polygons(c.expected)[0];
		if (capMidpoints(o) === capMidpoints(n)) caps++;
		if (JSON.stringify(o) === JSON.stringify(n)) vertices++;
	}
	return { total: list.length, caps, vertices };
}

describe('native WidenPath of square-capped segments under world scales', () => {
	it('captures 323 segments per transform, 400 pen widths per scale and 358 arcs per transform', () => {
		for (const name of Object.keys(scales)) expect(lines.filter((c) => c.scale === name)).toHaveLength(323);
		expect(lines.filter((c) => c.scale === 'rot30')).toHaveLength(323);
		for (const name of ['s2', 's0.5', 's0.75', 's1.5', 'rot30', 'aniso16', 'aniso2']) expect(arcs.filter((c) => c.scale === name)).toHaveLength(358);
	});

	it('extends a segment by the device vector over its logical vector cut to the nearest whole unit, at every scale', () => {
		// Half the width is the unrounded one and the nib is the width in FIX (a 0.7 scale of a 17 unit pen is 190 FIX across and
		// extends 95.2 FIX): every vertex of every segment is native, including the scales where the pen is not a whole number of pixels
		// (the perpendicular rounded a whole-pixel pen at 260, 224, 158 and 268 of 323 vectors under 0.7, 1.3, 2.5 and 10:7).
		for (const name of Object.keys(scales)) {
			const { total, caps, vertices } = lineCounts(name, (c) => uniformOptions(c, scales[name], true));
			expect({ name, caps, vertices, total }).toEqual({ name, caps: 323, vertices: 323, total: 323 });
		}
	});

	it('is far from the old exact-vector extension where a device vector is not a whole number of logical units', () => {
		// Integer scales (and 0.5, 0.75, 1.5) already agreed: their device vectors are multiples of the unit.
		const before: Record<string, number> = { 's0.7': 66, 's1.3': 0, 's2.5': 0, 's0.6': 272, 'c10:7': 90, 'c4:3': 72 };
		for (const [name, expected] of Object.entries(before)) {
			expect({ name, caps: lineCounts(name, (c) => uniformOptions(c, scales[name], false)).caps }).toEqual({ name, caps: expected });
		}
	});

	it('extends a rotated segment the same way (30 degrees, the matrix nib)', () => {
		const options = (c: Record): WidenOptions => ({
			width: c.width * 16,
			matrix: [c30, s30, -s30, c30],
			deviceNib: true,
			cap: 'square',
			join: 'round',
			miterLimit: 10,
			cutToLogicalUnits: true,
		});
		expect(lineCounts('rot30', options).caps).toBe(323);
		// Before the cut: 259 of 323.
		expect(lineCounts('rot30', (c) => ({ ...options(c), cutToLogicalUnits: false })).caps).toBe(259);
	});

	it('draws arcs under a world scale with the same cap rule', () => {
		// Counts of the 358 swept arcs that are vertex for vertex identical; with the exact vector: 2, 170, 135 and 53, and before the
		// cut rounded ties away from zero (a logical vector of 3.5 units normalises by 4, not 3): 344, 315, 324 and 329.
		const exact: Record<string, number> = {};
		for (const name of ['s2', 's0.5', 's0.75', 's1.5']) {
			exact[name] = arcs
				.filter((c) => c.scale === name)
				.filter((c) => {
					const o = widenPath(arcPath(c.source), { ...uniformOptions(c, scales[name], true), width: 12 * 16, capWidth: 12 * 16 });
					return JSON.stringify(o) === JSON.stringify(polygons(c.expected));
				}).length;
		}
		expect(exact).toEqual({ s2: 358, 's0.5': 358, 's0.75': 358, 's1.5': 358 });
	});

	it('draws arcs under unequal axis scales with the same cap rule', () => {
		const run = (name: string, options: WidenOptions) =>
			arcs.filter((c) => c.scale === name).filter((c) => JSON.stringify(widenPath(arcPath(c.source), options)) === JSON.stringify(polygons(c.expected))).length;
		// Before the cut: 125 of 358 (2:1) and 164 (1:16).
		expect(run('aniso2', { width: 6 * 16, height: 12 * 16, cap: 'square', join: 'round', miterLimit: 10, cutToLogicalUnits: true, logicalScale: [0.5, 1] })).toBeGreaterThanOrEqual(356);
		expect(run('aniso16', { width: 3 * 16, height: 48 * 16, cap: 'square', join: 'round', miterLimit: 10, cutToLogicalUnits: true, logicalScale: [1 / 16, 1] })).toBe(358);
	});

	it('widens a pen at its width in FIX: 400 horizontal and 400 vertical flat-capped pens under ten scales are native vertex for vertex', () => {
		// Whole-pixel widths matched only 367 of the vertical outlines; the pen's whole-pixel extent is the perpendicular's rounding.
		const pens = penWidths.filter((r) => typeof r.scale === 'number');
		let horizontal = 0;
		let vertical = 0;
		for (const r of pens) {
			const s = r.scale as number;
			const options: WidenOptions = { width: Math.max(1, Math.round(r.width * s * 16)), cap: 'flat', join: 'round', miterLimit: 10 };
			const x0 = Math.round(100 * s * 16);
			const x1 = Math.round(140 * s * 16);
			const h = new GdiRasterPath();
			h.moveTo(x0, x0);
			h.lineTo(x1, x0);
			if (JSON.stringify(widenPath(h, options)) === JSON.stringify(polygons(r.expected))) horizontal++;
			const v = new GdiRasterPath();
			v.moveTo(x0, x0);
			v.lineTo(x0, x1);
			if (JSON.stringify(widenPath(v, options)) === JSON.stringify(polygons(r.expectedVertical))) vertical++;
		}
		expect({ horizontal, vertical, total: pens.length }).toEqual({ horizontal: 400, vertical: 400, total: 400 });
	});

	it('rounds a geometric pen to whole device pixels (half up) under a scale or map mode', () => {
		const rounded = penWidths.filter((r) => typeof r.scale === 'number');
		expect(rounded.length).toBe(400);
		let wrong = 0;
		for (const r of rounded) {
			const horizontal = r.expected;
			const height = Math.max(horizontal[1], horizontal[4], horizontal[7], horizontal[10]) - Math.min(horizontal[1], horizontal[4], horizontal[7], horizontal[10]);
			if (height !== Math.max(1, Math.floor(r.width * (r.scale as number) + 0.5)) * 16) wrong++;
		}
		expect(wrong).toBe(0);
	});
});
