import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

interface Capture { face: string; style: number; size: number; code: number; x: number; y: number; w: number; h: number; rgb: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-cleartype-sizes.json.gz', import.meta.url))).toString());

/** Native RGB of a capture on its 64 x 64 white canvas (origin 8, 48). */
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
	const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24,
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

const faceKey = (c: Capture): string => `${c.face}${['', ' bold', ' italic', ' bold italic'][c.style]}`;

/**
 * Which captures (in file order, one bit each, least significant bit first) are pixel-exact today. A capture
 * becoming exact is an improvement to record here; one that stops being exact is a regression.
 */
const EXACT_BITS =
	'/73//b/1//XfzP//f+7993////yv+///Hbv//+f///837br/1vf/f3+76W/51f/3/7///+7//9//vf/ff3/9+79P/5/f3//77/dn//X///77+7///f7//+z9v3m+eXx+c/3utz+f/3/Xp/3P7n7X//eAb7/fl399u+Nd7s/nrLfXktd/L96/HyDk9Pb7////ffv//9z/+3nu/vc75+//37v+5e/9//fn+n//c9u/553v/+tW/e97zu+3//+v3//5x+/f/8f37/vj+/+/8/17v334vz/+//xvvn9vH1+//5/n9/nDU3v+Y2P/9Xb31zvvi96P9+v7zbrTeee/tyaRu2+/W/03fWyPyL/W/91j9zNgge95+MTOf/9/e///rvv//vv+//P/+7/8/v3//ff//7/9/8ff/3//j9v/5b/v/2b/p6+1Uf//3///r/9/////f/7fPe//P13//3/v/9/v9/////fv3/fy/ft++v//f+7933/u//v//////6//fv////1//X/b//h7///+5/5b////////9n3+bf8mf/L/vvfvX+v////73///+q/9f/+//+//b//v/9//7//7/9//7n/7v9b/+9/69/xd/1//9/I1';

const EXACT_BY_FACE: Record<string, number> = {
	'Arial': 314, 'Arial bold': 328, 'Arial italic': 264,
	'Times New Roman': 308, 'Times New Roman bold': 297, 'Times New Roman italic': 250,
	'Tahoma': 317, 'Tahoma bold': 330, 'Segoe UI': 325, 'Segoe UI bold': 326,
};

/**
 * Captures that were exact before ClearType used the font's dropout control and are not now: our geometry has a thin tail
 * end there that native's does not, and the dropout rule keeps the sample the old rendering happened to lack. The rule
 * gains 645 captures; these two are the price (see docs/outstanding-work.md, "ClearType dropout control").
 */
const KNOWN_LOSSES = ['Arial 11px g', 'Tahoma bold 18px y'];

describe.skipIf(!windowsFonts())('GDI+ ClearType glyphs across sizes and styles', () => {
	const fonts = new GdiFontCollection(windowsFonts() ?? []);
	// The body of a skipped describe still runs, so the captures are only rendered when the fonts are there.
	const exact = !windowsFonts() ? [] : captures.map((c) => {
		const native = nativeRgb(c);
		const mine = ours(fonts, c);
		return native.every((v, i) => v === mine[i]);
	});

	it('covers ten faces over twelve sizes and thirty-one characters', () => {
		expect(captures).toHaveLength(10 * 12 * 31);
		expect(new Set(captures.map(faceKey)).size).toBe(10);
	});

	// Arial, Times New Roman and Tahoma carry per-size tweaks (SHPIX shifts of a few sixty-fourths of a
	// pixel along x, selected by the rendering mode the prep program stores) that native ClearType applies
	// to the stems and curves; the generic per-size helper functions are not applied. Their y DELTAPs
	// after IUP[y] are not applied either.
	it('matches the pinned exact captures of every face', () => {
		const byFace: Record<string, number> = {};
		for (let i = 0; i < captures.length; i++) {
			byFace[faceKey(captures[i])] = (byFace[faceKey(captures[i])] ?? 0) + (exact[i] ? 1 : 0);
		}
		expect(byFace).toEqual(EXACT_BY_FACE);
		expect(exact.filter(Boolean)).toHaveLength(3059);
	});

	it('loses no exact capture and gains none unrecorded', () => {
		const bits = Buffer.from(EXACT_BITS, 'base64');
		const lost: string[] = [];
		const unrecorded: string[] = [];
		for (let i = 0; i < captures.length; i++) {
			const pinned = (bits[i >> 3] >> (i & 7)) & 1;
			const name = `${faceKey(captures[i])} ${captures[i].size}px ${String.fromCharCode(captures[i].code)}`;
			if (pinned && !exact[i]) lost.push(name);
			if (!pinned && exact[i]) unrecorded.push(name);
		}
		expect(lost).toEqual([]);
		expect(unrecorded).toEqual([]);
	});

	it('records the two captures the dropout rule gave up', () => {
		const names = new Map(captures.map((c, i) => [`${faceKey(c)} ${c.size}px ${String.fromCharCode(c.code)}`, exact[i]]));
		for (const name of KNOWN_LOSSES) expect(names.get(name), name).toBe(false);
	});
});
