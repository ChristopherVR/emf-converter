import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * The projection candidate that closes the private signed diagonal diagnostic fonts (`dot` below: each product
 * of a 26.6 distance and a 2.14 vector component rounded to nearest on its own, then summed; the production
 * interpreter rounds the sum) against the real-font GDI+ grayscale captures it was said to regress. Everything
 * here patches a private HintedSize from outside, as `scripts/check-diagonal-opcode.ts` does; nothing ships.
 *
 * Findings (8 October 2026): the regressions are one glyph, Arial 16 'y' under TextRenderingHintAntiAlias, 15
 * origins at two contrasts (30 captures, not fifteen distinct); the freedom-vector half of the candidate does
 * nothing; and the same candidate gains Times New Roman Italic 22 'a' in both grid-fitted and unfitted
 * grayscale (64 captures). Per instruction, the captures determine a projection of Arial's MDRP to be
 * combined-rounded and two projections of Times New Roman Italic's MIRP and MDRP to be per-product rounded, so
 * no opcode, function or vector-equality condition separates them.
 */
interface Capture { face: string; size: number; style: number; hint: number; contrast: number; code: number; qx: number; qy: number; rgba: string }
const load = (name: string): Capture[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
const coverage = load('text-coverage.json.gz');
const sets = [
	{ name: 'coverage', captures: coverage, scale: 4 },
	{ name: 'fine-x', captures: load('text-origin-phases.json.gz'), scale: 64 },
	{ name: 'fine-y', captures: load('text-origin-vertical-phases.json.gz'), scale: 64 },
];

type Dot = (x: number, y: number, vx: number, vy: number) => number;
const perProduct: Dot = (x, y, vx, vy) => Math.floor((x * vx + 8192) / 16384) + Math.floor((y * vy + 8192) / 16384);
const nearest: Dot = (x, y, vx, vy) => { const v = (x * vx + y * vy) / 16384; return v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5); };
const truncated: Dot = (x, y, vx, vy) => Math.trunc((x * vx + y * vy) / 16384);
const floored: Dot = (x, y, vx, vy) => Math.floor((x * vx + y * vy) / 16384);
const combined: Dot = (x, y, vx, vy) => Math.floor((x * vx + y * vy + 8192) / 16384);

function imageMatches(font: unknown, c: Capture, scale: number): boolean {
	const mask = gdiTextCoverage(font as never, { codes: [c.code], glyphIndices: false, x: 8 + c.qx / scale, y: 48 + c.qy / scale, dx: null, dy: null,
		textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
	applyTextContrast(mask.data, textGamma(c.contrast));
	const rgba = new Uint8ClampedArray(64 * 64 * 4).fill(255);
	for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
		const o = ((y + mask.y) * 64 + x + mask.x) * 4;
		rgba[o] = rgba[o + 1] = rgba[o + 2] = 255 - mask.data[y * mask.width + x];
	}
	return Buffer.from(rgba).equals(Buffer.from(c.rgba, 'base64'));
}

function realize(fonts: GdiFontCollection, c: Capture) {
	return fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400, italic: !!(c.style & 2), charSet: 1,
		pitchAndFamily: 0, quality: 4, unhinted: c.hint === 4, ignoreGasp: c.hint === 4, gdiPlus: true })!;
}

/** Exactness of every grayscale capture of the three origin sets under a patch of the private interpreter. */
function exactness(patch?: (hs: any) => void): boolean[][] {
	const fonts = new GdiFontCollection(windowsFonts()!);
	return sets.map((set) => set.captures.map((c) => {
		if (c.hint === 5) return false;
		const font = realize(fonts, c);
		const hs = (font as any).hinted;
		if (patch && !hs.__patched) { hs.__patched = true; patch(hs); }
		return imageMatches(font, c, set.scale);
	}));
}
const withProjection = (dot: Dot) => (hs: any): void => {
	hs.project = (x: number, y: number) => dot(x, y, hs.gs.pvx, hs.gs.pvy);
	hs.dualProject = (x: number, y: number) => dot(x, y, hs.gs.dvx, hs.gs.dvy);
};
const withFreedomDot = (hs: any): void => {
	const compute = hs.computeFuncs.bind(hs);
	hs.computeFuncs = () => { compute(); if (hs.gs.fvx === hs.gs.pvx && hs.gs.fvy === hs.gs.pvy) hs.fDotP = 16384; };
};
function compare(candidate: boolean[][], baseline: boolean[][]): { lost: string[]; gained: string[] } {
	const lost: Record<string, number> = {}, gained: Record<string, number> = {};
	sets.forEach((set, s) => set.captures.forEach((c, i) => {
		const key = `${c.face}/${c.size}/${String.fromCharCode(c.code)}/${c.style & 2 ? 'italic/' : ''}hint${c.hint}`;
		if (baseline[s][i] && !candidate[s][i]) lost[key] = (lost[key] ?? 0) + 1;
		if (!baseline[s][i] && candidate[s][i]) gained[key] = (gained[key] ?? 0) + 1;
	}));
	const fmt = (o: Record<string, number>): string[] => Object.entries(o).map(([k, v]) => `${k}:${v}`).sort();
	return { lost: fmt(lost), gained: fmt(gained) };
}

describe.skipIf(!windowsFonts())('the per-product projection candidate against real-font GDI+ grayscale captures', () => {
	const baseline = exactness();
	it('the closed set is exact today: 2,400 coverage, 1,280 x-phase and 1,280 y-phase controls', () => {
		const closedCoverage = coverage.filter((c) => {
			const char = String.fromCharCode(c.code);
			return c.face === 'Segoe UI' || (c.face === 'Times New Roman' && 'IvSy028'.includes(char)) || (c.size === 40 && 'IgaS0148'.includes(char)) || (c.size === 16 && (c.hint === 3 ? char !== 'y' : 'Igay048'.includes(char)));
		});
		expect(closedCoverage).toHaveLength(2400);
		expect(baseline[0].filter(Boolean).length).toBe(2400);
		expect(baseline[1].filter(Boolean).length).toBe(1280);
		expect(baseline[2].filter(Boolean).length).toBe(1280);
	});
	it('loses thirty Arial 16 y captures (fifteen origins, two contrasts) and gains sixty-four Times New Roman Italic 22 a', () => {
		expect(compare(exactness(withProjection(perProduct)), baseline)).toEqual({
			lost: ['Arial/16/y/hint4:30'],
			gained: ['Times New Roman/22/a/italic/hint3:32', 'Times New Roman/22/a/italic/hint4:32'],
		});
	});
	it('the freedom-vector half of the candidate changes no capture', () => {
		expect(compare(exactness(withFreedomDot), baseline)).toEqual({ lost: [], gained: [] });
	});
	it('rounding the exact sum to nearest is the production arithmetic; truncating or flooring it is much worse', () => {
		expect(compare(exactness(withProjection(nearest)), baseline)).toEqual({ lost: [], gained: [] });
		expect(compare(exactness(withProjection(truncated)), baseline).lost.reduce((n, s) => n + Number(s.split(':').pop()), 0)).toBe(576);
		const floor = compare(exactness(withProjection(floored)), baseline);
		expect(floor.lost.reduce((n, s) => n + Number(s.split(':').pop()), 0)).toBe(574);
		expect(floor.gained).toEqual(['Arial/16/y/hint3:32']);
	});
});

/** Which rounding each projection needs, by enumerating every assignment of the disagreeing projections. */
describe.skipIf(!windowsFonts())('call-level determination of the disagreeing projections', () => {
	interface Call { n: number; fn: string; op: number; dx: number; dy: number; vx: number; vy: number }
	function enumerate(face: string, size: number, ch: string, style: number): { calls: Call[]; masks: number[] } {
		const cap = coverage.find((c) => c.face === face && c.size === size && String.fromCharCode(c.code) === ch && c.hint === 4 && c.style === style && c.contrast === 0 && c.qx === 0 && c.qy === 0)!;
		const run = (pick: (n: number) => boolean, collect?: Call[]): boolean => {
			const fonts = new GdiFontCollection(windowsFonts()!);
			const font = realize(fonts, cap);
			const hs = (font as any).hinted;
			let n = -1, op = -1;
			const step = hs.step.bind(hs);
			hs.step = (o: number, code: Uint8Array, ip: number) => { op = o; return step(o, code, ip); };
			for (const [name, vx, vy] of [['project', 'pvx', 'pvy'], ['dualProject', 'dvx', 'dvy']] as const) {
				hs[name] = (x: number, y: number) => {
					const a = hs.gs[vx], b = hs.gs[vy];
					const c = combined(x, y, a, b), p = perProduct(x, y, a, b);
					if (c === p) return c;
					n++;
					collect?.push({ n, fn: name, op, dx: x, dy: y, vx: a, vy: b });
					return pick(n) ? p : c;
				};
			}
			return imageMatches(font, cap, 4);
		};
		const calls: Call[] = [];
		run(() => false, calls);
		const masks: number[] = [];
		for (let m = 0; m < 1 << calls.length; m++) if (run((n) => ((m >> n) & 1) === 1)) masks.push(m);
		return { calls, masks };
	}
	const verdicts = (r: { calls: Call[]; masks: number[] }): string[] => r.calls.map((c) => {
		const ones = r.masks.filter((m) => ((m >> c.n) & 1) === 1).length;
		return `${c.fn} 0x${c.op.toString(16)} (${c.dx},${c.dy}): ${ones === r.masks.length ? 'per-product' : ones === 0 ? 'combined' : 'either'}`;
	});
	it('Arial 16 y needs its MDRP project combined; Times New Roman Italic 22 a needs a MIRP dual and an MDRP project per-product', () => {
		const arial = enumerate('Arial', 16, 'y', 0);
		expect(arial.masks).toHaveLength(8);
		expect(verdicts(arial)).toEqual([
			'dualProject 0xc4 (298,-861): either', 'project 0xc4 (142,-475): combined', 'dualProject 0xc4 (-404,-1080): either', 'dualProject 0xc4 (-301,-861): either',
		]);
		const times = enumerate('Times New Roman', 22, 'a', 2);
		expect(times.masks).toHaveLength(4);
		expect(verdicts(times)).toEqual([
			'dualProject 0xe4 (95,-52): per-product', 'dualProject 0xc4 (220,791): either', 'project 0xc4 (-16,-113): per-product', 'project 0x3c (-113,-460): either',
		]);
	});
});
