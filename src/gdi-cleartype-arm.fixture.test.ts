import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * Native GDI ExtTextOut ClearType at default quality (compatible widths) against natural quality for private fonts that
 * continue a glyph program past the stem (generator `scripts/gdi-fixtures/build-cleartype-arm-fonts.py`, probe
 * `GdiClearTypeWidthProbe.cs`, mode `text-gdi-cleartype-arm`, captures `gdi-cleartype-arm.json.gz`, 765 glyphs at 16 ppem
 * in both qualities). They isolate what the diagonal letters of Arial, Tahoma and Segoe UI (V W X x A) do under the width
 * mode, and were found by bisecting the glyph programs of the system fonts (truncating the program after every
 * instruction of a copy of Arial 'V', 'W' and Tahoma 'V', 'y' and capturing each):
 *
 * 1. Stems set after IUP[x] are not moved (set `postiup`, measured here as a native fact: every glyph whose pair follows
 *    IUP[x], alone or with IUP[y] before or after it, is identical at the two qualities, every glyph whose pair comes first
 *    or follows only IUP[y] differs). Microsoft's backward-compatibility paper describes the same boundary for deltas
 *    ("a post-IUP delta occurs after the IUP instruction") but says nothing about the width mode.
 * 2. The shift acts on the outline the program is still running on: a point placed by MDRP from a shifted stem point
 *    under a projection vector perpendicular to the arm (SPVTL[1] / SDPVTL[1] on the arm's edge) follows by the share of the
 *    shift that the height along the arm gives (set `height`: 0 at the foot, the whole shift at the stem), where under an
 *    axis projection vector it follows by the whole shift (set `arm`, kinds `axis` and `spvfs-x`).
 *
 * The converter does not reproduce 2 yet (its shifts are applied to the outline after the program); the counts below are
 * what production gets, pinned so that the improvement is visible when it lands.
 */
interface Capture { set: string; size: number; quality: number; index: number; width: number; x: number; y: number; w: number; h: number; rgb: string }
interface SetInfo { set: string; file: string; family: string; count: number; meta: Record<string, unknown>; params: number[][] }

const LEVELS = [255, 219, 182, 144, 102, 58, 0];
const W = 48;
const H = 64;
const dir = new URL('./__fixtures__/gdi/', import.meta.url);
const sets: SetInfo[] = JSON.parse(readFileSync(new URL('cta-sets.json', dir), 'utf8'));
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('gdi-cleartype-arm.json.gz', dir))).toString());
const fonts = new GdiFontCollection(sets.map((s) => readFileSync(new URL(s.file, dir))));

function pixels(c: Capture): Uint8Array {
	const out = new Uint8Array(W * H * 3).fill(255);
	const rgb = Buffer.from(c.rgb, 'base64');
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) for (let i = 0; i < 3; i++) out[((y + c.y) * W + x + c.x) * 3 + i] = rgb[(y * c.w + x) * 3 + i];
	return out;
}

function render(info: SetInfo, quality: number, index: number): Uint8Array {
	const font = fonts.realize({ face: info.family, height: -16, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality })!;
	const mask = gdiTextCoverage(font, {
		codes: [0xe000 + index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24, textColor: '#000000',
		bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false,
	});
	const out = new Uint8Array(W * H * 3).fill(255);
	if (mask) {
		for (let y = 0; y < mask.height; y++) {
			for (let x = 0; x < mask.width; x++) {
				for (let ch = 0; ch < 3; ch++) out[((y + mask.y) * W + x + mask.x) * 3 + ch] = LEVELS[Math.round((mask.data[(y * mask.width + x) * 3 + ch] * 6) / 255)];
			}
		}
	}
	return out;
}

function nativeOf(set: string, quality: number): Map<number, Capture> {
	return new Map(captures.filter((c) => c.set === set && c.quality === quality).map((c) => [c.index, c]));
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.every((v, i) => v === b[i]);

describe('GDI ClearType compatible widths past the stem (gdi-cleartype-arm.json.gz)', () => {
	it('captured every glyph of every set at both qualities', () => {
		expect(sets.map((s) => s.set)).toEqual(['arm', 'height', 'postiup', 'postsmall']);
		for (const s of sets) {
			expect(captures.filter((c) => c.set === s.set && c.quality === 5)).toHaveLength(s.count);
			expect(captures.filter((c) => c.set === s.set && c.quality === 6)).toHaveLength(s.count);
		}
	});

	it('native moves no stem that the program sets after IUP[x] (set postiup)', () => {
		const set = sets.find((s) => s.set === 'postiup')!;
		const kinds = set.meta.kinds as string[];
		const compat = nativeOf('postiup', 5);
		const natural = nativeOf('postiup', 6);
		const identical: Record<string, number> = {};
		for (let i = 0; i < set.count; i++) {
			const kind = kinds[set.params[i][0]];
			if (same(pixels(compat.get(i)!), pixels(natural.get(i)!))) identical[kind] = (identical[kind] ?? 0) + 1;
		}
		const perKind = set.count / kinds.length;
		// The pair moves unless IUP[x] ran before it; IUP[y] before or after it makes no difference.
		expect(identical).toEqual({ iupx: perKind, iupxy: perKind, iupyx: perKind, 'x-pair-y': perKind });
	});

	it('native shows a stem shift of a few 1/64 px only beyond 1/16 px (set postsmall)', () => {
		const set = sets.find((s) => s.set === 'postsmall')!;
		const kinds = set.meta.kinds as string[];
		const advances = set.meta.adv as number[];
		const compat = nativeOf('postsmall', 5);
		const natural = nativeOf('postsmall', 6);
		const identical: Record<string, number[]> = {};
		for (let i = 0; i < set.count; i++) {
			const [kind, , adv] = set.params[i];
			if (same(pixels(compat.get(i)!), pixels(natural.get(i)!))) (identical[kinds[kind]] ??= []).push(advances[adv]);
		}
		// Before IUP[x] the pair of a bar whose advance is 0.2 px or more off a whole pixel (a shift of 7/64 px or more at
		// this width) shows; below that the two qualities cannot be told apart. After IUP[x] nothing ever shows.
		const small = advances.filter((a) => a <= 12.12);
		expect([...new Set(identical.none)].sort()).toEqual([...small].sort());
		expect([...new Set(identical.iupx)].sort()).toEqual([...advances].sort());
	});

	// Exact glyph captures per set at natural quality and at default quality as production renders them (see above).
	const EXPECTED: Record<string, [number, number]> = {
		arm: [224, 126],
		height: [288, 171],
		postiup: [189, 69],
		postsmall: [64, 52],
	};
	for (const s of sets) {
		it(`reproduces ${EXPECTED[s.set][0]} natural and ${EXPECTED[s.set][1]} default-quality glyphs of the ${s.set} set`, () => {
			const result = [6, 5].map((quality) => {
				const native = nativeOf(s.set, quality);
				let exact = 0;
				for (let i = 0; i < s.count; i++) if (same(pixels(native.get(i)!), render(s, quality, i))) exact++;
				return exact;
			});
			expect(result).toEqual(EXPECTED[s.set]);
		});
	}
});
