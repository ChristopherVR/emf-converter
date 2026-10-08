import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

// Private diagnostic fonts (scripts/gdi-fixtures/build-alignrp-fonts.py): one tall stem whose program optionally touches
// points, optionally runs IUP[x] and/or IUP[y], and then aligns the top left point to a reference point with ALIGNRP, in
// y to the baseline point or in x to the top right point (either moves the point onto a triangle's edge). Four table
// layouts: `prep` and `gasp`, `gasp` only, `prep` only, neither.
const KINDS = ['control', 'y-pre-untouched-ref', 'y-pre-touched-ref', 'y-post-both', 'y-post-iupy', 'y-post-iupx', 'y-post-both-untouched-ref', 'x-pre',
	'x-post-both', 'x-post-iupx', 'x-post-iupy', 'x-post-both-untouched-ref', 'xy-post-both', 'y-post-both-point-untouched', 'x-post-both-point-untouched'];

interface Capture { layout: string; index: number; size: number; hint: number; x: number; y: number; w: number; h: number; rgb: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-alignrp.json.gz', import.meta.url))).toString());
const fonts = new GdiFontCollection(['a', 'b', 'c', 'd'].map((l) => readFileSync(new URL(`./__fixtures__/gdi/alignrp-${l}.ttf`, import.meta.url))));

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

function ours(c: Capture): Uint8Array {
	const font = fonts.realize({ face: `Parity Align ${c.layout.toUpperCase()}`, height: -c.size, width: 0, weight: 400, italic: false, charSet: 1,
		pitchAndFamily: 0, quality: 6, gdiPlus: true })!;
	const mask = gdiTextCoverage(font, { codes: [0xe000 + c.index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24,
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

const differingRows = (a: Uint8Array, b: Uint8Array): number[] => {
	const rows: number[] = [];
	for (let y = 0; y < 64; y++) {
		for (let i = 0; i < 192; i++) {
			if (a[y * 192 + i] !== b[y * 192 + i]) {
				rows.push(y);
				break;
			}
		}
	}
	return rows;
};

describe('ALIGNRP around the IUPs in the private diagnostic fonts', () => {
	it('holds fifteen kinds of program in four table layouts at 16 ppem through two hints', () => {
		expect(captures).toHaveLength(15 * 4 * 2);
	});

	// Native honours the alignment in every kind: before or after either IUP, in x or y, against a touched or an
	// untouched reference, for a touched or an untouched point, whatever tables the font has. All 13 single-axis kinds draw
	// the same triangle (moving the top left point onto the baseline or onto the top right point gives one shape), so the
	// round-5 "ALIGNRP in y after IUP[y]" lead (native leaves the point where it was) is not a rule of the interpreter.
	it('draws one triangle for every single-axis ALIGNRP kind, ClearType and grayscale, in every layout', () => {
		for (const layout of ['a', 'b', 'c', 'd']) {
			for (const hint of [3, 5]) {
				const set = captures.filter((c) => c.layout === layout && c.hint === hint);
				const triangle = nativeRgb(set.find((c) => KINDS[c.index] === 'y-pre-untouched-ref')!);
				const control = nativeRgb(set.find((c) => KINDS[c.index] === 'control')!);
				// GDI+ AntiAliasGridFit does not run the glyph programs of a font without a `gasp` table (layouts c and d): every
				// kind is the plain stem there. ClearType runs them whatever tables the font has.
				const programsRun = hint === 5 || layout === 'a' || layout === 'b';
				expect(differingRows(control, triangle).length > 0, `${layout} ${hint} triangle differs from the stem`).toBe(programsRun);
				for (const c of set) {
					if (KINDS[c.index] === 'control' || KINDS[c.index] === 'xy-post-both') continue;
					expect(differingRows(nativeRgb(c), triangle), `${layout} ${hint} ${KINDS[c.index]}`).toEqual([]);
				}
			}
		}
	});

	// Both axes in one program leave a zero-width line, which native still draws one sample wide (scan-converter dropout
	// control, for fonts that never run SCANCTRL). Our ClearType keeps no dropout control for such a font: the private
	// diagonal, opcode and vector fonts (src/ttf-diagonal-coverage.fixture.test.ts and siblings) fix that. The rows below
	// are what differs from native: the apex row of every triangle and the whole zero-width line.
	it('matches the ClearType triangles but for the apex row, and the zero-width line not at all', () => {
		for (const c of captures.filter((x) => x.hint === 5)) {
			const rows = differingRows(nativeRgb(c), ours(c));
			if (KINDS[c.index] === 'control') expect(rows, `${c.layout} control`).toEqual([]);
			else if (KINDS[c.index] === 'xy-post-both') expect(rows, `${c.layout} xy`).toEqual([39, 40, 41, 42, 43, 44, 45, 46, 47]);
			else expect(rows, `${c.layout} ${KINDS[c.index]}`).toEqual([39]);
		}
	});
});
