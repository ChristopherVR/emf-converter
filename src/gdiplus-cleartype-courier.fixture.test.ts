import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

interface Capture { face: string; style: number; size: number; phase: number; code: number; x: number; y: number; w: number; h: number; rgb: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-cleartype-courier.json.gz', import.meta.url))).toString());

/** Native RGB of a capture on its 64 x 64 white canvas (origin 8 + phase / 6, 48). */
function nativeRgb(c: Capture): Uint8Array {
	const out = new Uint8Array(64 * 64 * 3).fill(255);
	const src = Buffer.from(c.rgb, 'base64');
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			for (let k = 0; k < 3; k++) {
				out[((c.y + y) * 64 + c.x + x) * 3 + k] = src[(y * c.w + x) * 3 + k];
			}
		}
	}
	return out;
}

function ours(fonts: GdiFontCollection, c: Capture): Uint8Array {
	const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400, italic: !!(c.style & 2),
		charSet: 1, pitchAndFamily: 0, quality: 6, gdiPlus: true })!;
	const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: 8 + c.phase / 6, y: 48, dx: null, dy: null, textAlign: 24,
		textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false })!;
	const rgb = new Uint8Array(64 * 64 * 3).fill(255);
	for (let y = 0; y < mask.height; y++) {
		for (let x = 0; x < mask.width; x++) {
			for (let k = 0; k < 3; k++) {
				rgb[((y + mask.y) * 64 + x + mask.x) * 3 + k] = 255 - mask.data[(y * mask.width + x) * 3 + k];
			}
		}
	}
	return rgb;
}

/** Which captures (in file order, one bit each, least significant bit first) are pixel-exact today. */
const EXACT_BITS =
	'9FcuHP5rR05vMGqlN6CP01tQzektwIfwDrBx+P+/vx9cRE5vQTunJyCV0lPQSuEpaaf0/39+AAD8mJ4CVsr//9P/9+7j9//X//2/e//e1zn+/z94f/93/f9//v//R+fXu3/z+P9/4/30z3/d++//8/7/3x9gnt7kf+7hZ//nMbMvc7/p/3xe/EeuL/4j/h//mfeL347Lxx/4/wfM++/c77x9/mf0LL8xO5KfmW3L///3Dxi1R+kJUdf8/j/9b/tf//f8L/99/De5fXbDfD/v/frf92331/7+AQ3Ytf/Fzfn74ufv/3X7tfZ8u/Pf//3/Tq3O+PKYdw==';

const GIVEN_UP = ['italic 12px f phase 0'];
const STYLES = ['regular', 'bold', 'italic', 'bold italic'];
const EXACT_BY_STYLE: Record<string, number> = { regular: 257, bold: 396, italic: 324, 'bold italic': 364 };

describe.skipIf(!windowsFonts())('GDI+ ClearType glyphs of the system Courier New', () => {
	const fonts = new GdiFontCollection(windowsFonts() ?? []);
	// The body of a skipped describe still runs, so the captures are only rendered when the fonts are there.
	const exact = !windowsFonts() ? [] : captures.map((c) => {
		const native = nativeRgb(c);
		const mine = ours(fonts, c);
		return native.every((v, i) => v === mine[i]);
	});

	it('covers four styles over fourteen sizes, thirty-one characters and six origin phases of a few', () => {
		expect(captures).toHaveLength(4 * (14 * 31 + 6 * 2 * 5));
		expect(new Set(captures.map((c) => c.style)).size).toBe(4);
	});

	// Round 11 (DirectWrite's arithmetic, the default for installed fonts): 1,119 to 1,341 exact (223 gained, one given up: GIVEN_UP).
	// Before the sample-row widening and the lone-leak rule none of the 1,976 captures was exact (886 with the widening alone; the
	// font's dropout control adds 157; round 8's helper SHPIX rule adds five bold ones).
	it('matches the pinned exact captures of every style', () => {
		const byStyle: Record<string, number> = {};
		for (let i = 0; i < captures.length; i++) {
			const key = STYLES[captures[i].style];
			byStyle[key] = (byStyle[key] ?? 0) + (exact[i] ? 1 : 0);
		}
		expect(byStyle).toEqual(EXACT_BY_STYLE);
		expect(exact.filter(Boolean)).toHaveLength(1341);
	});

	// Straight-edged glyphs (E H I L T 7) are exact at nearly every size and phase of the regular and bold faces (243 of 248; 237 with the earlier arithmetic) but for a few
	// short-stem sizes, which is what makes the widening a rule and not a fit.
	it('draws the straight-edged regular and bold glyphs exactly', () => {
		let total = 0;
		let hit = 0;
		for (let i = 0; i < captures.length; i++) {
			const c = captures[i];
			if ((c.style === 0 || c.style === 1) && 'EHILT7'.includes(String.fromCharCode(c.code))) {
				total++;
				hit += exact[i] ? 1 : 0;
			}
		}
		expect({ total, hit }).toEqual({ total: 248, hit: 243 });
	});

	it('loses no exact capture and gains none unrecorded', () => {
		const bits = Buffer.from(EXACT_BITS, 'base64');
		const lost: string[] = [];
		const unrecorded: string[] = [];
		for (let i = 0; i < captures.length; i++) {
			const pinned = (bits[i >> 3] >> (i & 7)) & 1;
			const c = captures[i];
			const name = `${STYLES[c.style]} ${c.size}px ${String.fromCharCode(c.code)} phase ${c.phase}`;
			if (pinned && !exact[i]) lost.push(name);
			if (GIVEN_UP.includes(name)) expect(exact[i], name).toBe(false);
			if (!pinned && exact[i]) unrecorded.push(name);
		}
		expect(lost).toEqual([]);
		expect(unrecorded).toEqual([]);
	});
});
