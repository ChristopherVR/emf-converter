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
	'fQWmmb4Bg0TfoMm/b87013dt+uirM/n3HRv8+6dN/n0HBLr/1vf/f3+76W/51f/3/7///+7//9//vf/ff3/9+79P/5/f3//77/dn//X///77+7///f7//+z9v3m+eRQuM/2Khw2fn0vHp9HB5nbD8veAZbzfFzp8u6Nd7s/HjLfXksd/L9aDHyDk4MYz4CngGdAR8Ay4CHgGVCQ4AyoSnAAUAU+AiuTnUGXxc4iy4B1AWegWqS96DsQ3PIksEp5ABAlPIIKEJxBBwhOIIuEJBFX4FCLofBhhND4FGBq/Qp3ld6HCUjvwY2N/oDDwBxAIiBoIBOgLRALSAAITNyKRiS+BQMA3QGCBSKCQ8R1AUDAAACxwGEQGf18ue7+vhvnflsv67+Pl8Zfk+Pj7cfX9/Tm8/sZdfn//Dou/5Zfn32bLo6+1Qf33z/r+q3d5/327Pv6eHG5/Hwyvvz/H39+H4+vvy+Hn1/fy/Pt+/P/9P6793l/uf1uO2b8vh6zfFkv+78kh+XfB0vh7evn+5bpa//5f/3//pn2+bdcmX/LrvufvVev37fr723b5+q29fv++X+//b6/vv9/X79/769/v7nX7v9b4+9t68Pxdv17/9lI1';

const EXACT_BY_FACE: Record<string, number> = {
	'Arial': 239, 'Arial bold': 328, 'Arial italic': 211,
	'Times New Roman': 147, 'Times New Roman bold': 146, 'Times New Roman italic': 112,
	'Tahoma': 251, 'Tahoma bold': 274, 'Segoe UI': 254, 'Segoe UI bold': 285,
};

describe.skipIf(!windowsFonts())('GDI+ ClearType glyphs across sizes and styles', () => {
	const fonts = new GdiFontCollection(windowsFonts() ?? []);
	const exact = captures.map((c) => {
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
		expect(exact.filter(Boolean)).toHaveLength(2247);
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
});
