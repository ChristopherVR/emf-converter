import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * Dropout control in the engine's monochrome and grayscale bitmaps, against native captures of the program-free
 * private polygon fonts (`scripts/gdi-fixtures/build-raster-fonts.py`): 256 random triangles and quadrilaterals on
 * the 1/64-pixel lattice at 32 ppem, so nothing is grid-fitted and every difference is scan conversion. The
 * `raster-polygons` font has no `prep`; the `-stN` fonts run SCANCTRL 0x1ff and SCANTYPE N there.
 *
 * Findings (8 October 2026):
 *  - A font that never runs SCANCTRL is scan-converted with simple dropout control up to 32 ppem and with none
 *    above (GDI monochrome bitmaps, `text-raster-mono.json.gz`): shipped for the monochrome rasterizer.
 *  - GDI's grayscale bitmaps (`GGO_GRAY4_BITMAP`) and GDI+ AntiAlias text apply the font's scan control to the 4x4
 *    oversampled outline. SCANTYPE 0 and 4 and, since round 6, 1 and 5 (the stub-excluding types, which stock
 *    fonts use; FreeType's stub rule without its overshoot exemption) are shipped: 3,106 and 3,147 of 4,096
 *    bitmaps at 8 to 32 ppem for the two stub types, 2,344 before.
 *  - GDI+ AntiAliasGridFit on a font without a `gasp` table draws GDI's monochrome bitmap from 9 to 17 ppem, and
 *    both defaults hold in grayscale too; they are not shipped (see the pinned gap below).
 */
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const json = (name: string): any[] => JSON.parse(gunzipSync(fixture(name)).toString());

const fonts: Record<string, [string, string]> = { polygons: ['raster-polygons.ttf', 'Parity Raster Polygons'] };
for (const n of [0, 1, 4, 5]) fonts[`st${n}`] = [`raster-polygons-st${n}.ttf`, `Parity Raster Polygons ST${n}`];
const collection = new GdiFontCollection(Object.values(fonts).map(([file]) => fixture(file)));

function samples(r: any): Set<string> {
	const out = new Set<string>();
	if (!r.w || !r.h) return out;
	const buffer = Buffer.from(r.data, 'base64'), stride = Math.ceil(r.w / 32) * 4;
	for (let row = 0; row < r.h; row++) for (let col = 0; col < r.w; col++) if (buffer[row * stride + (col >> 3)] & (0x80 >> (col & 7))) out.add(`${r.x + col},${r.y - 1 - row}`);
	return out;
}
function levels(r: any): Map<string, number> {
	const out = new Map<string, number>();
	if (!r.w || !r.h) return out;
	const buffer = Buffer.from(r.data, 'base64'), stride = (r.w + 3) & ~3;
	for (let row = 0; row < r.h; row++) for (let col = 0; col < r.w; col++) { const v = buffer[row * stride + col]; if (v) out.set(`${r.x + col},${r.y - 1 - row}`, v); }
	return out;
}

const mono = json('text-raster-mono.json.gz');
function gdiExact(set: string, format: 1 | 5, small: boolean): [number, number] {
	let exact = 0, total = 0;
	for (const r of mono) {
		if (r.set !== set || r.format !== format || (r.ppem <= 32) !== small) continue;
		const font = collection.realize({ face: fonts[set][1], height: -r.ppem, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: format === 1 ? 3 : 4, unhinted: false, gdiPlus: false }) as any;
		const bitmap = font.glyph(r.index + 1).bitmap;
		let same: boolean;
		if (format === 1) {
			const mine = new Set<string>();
			if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) if (bitmap.data[row * bitmap.width + col]) mine.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
			const native = samples(r);
			same = mine.size === native.size && [...native].every((k) => mine.has(k));
		} else {
			const mine = new Map<string, number>();
			if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) { const v = bitmap.data[row * bitmap.width + col]; if (v) mine.set(`${bitmap.left + col},${bitmap.top - 1 - row}`, v); }
			const native = levels(r);
			same = mine.size === native.size && [...native].every(([k, v]) => mine.get(k) === v);
		}
		total++;
		if (same) exact++;
	}
	return [exact, total];
}

describe('GDI+ images against GDI bitmaps of the same private fonts (native data only)', () => {
	const plusLevels = (c: any): Map<string, number> => {
		const gray = Buffer.from(c.gray, 'base64'), out = new Map<string, number>();
		for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const level = Math.round((255 - gray[y * 64 + x]) / 17); if (level) out.set(`${x - 8},${47 - y}`, level); }
		return out;
	};
	const plus = json('text-raster-polygons.json.gz');
	it('AntiAlias text is GDI\'s GGO_GRAY4_BITMAP bitmap with the 17th level mapped to the 16th: 4,969 of 5,120 images, the 151 other pixels one sample lighter', () => {
		const gray4 = new Map<string, any>();
		for (const r of mono) if (r.set === 'polygons' && r.format === 5) gray4.set(`${r.ppem}:${r.index}`, r);
		let images = 0, equal = 0, lighter = 0, other = 0;
		for (const c of plus) {
			if (c.hint !== 4) continue;
			const native = levels(gray4.get(`${c.size}:${c.index}`)), image = plusLevels(c);
			images++;
			let same = true;
			for (const key of new Set([...native.keys(), ...image.keys()])) {
				const a = native.get(key) ?? 0, b = image.get(key) ?? 0;
				if (a === b || (a === 16 && b === 15)) continue;
				same = false;
				if (b === a - 1) lighter++; else other++;
			}
			if (same) equal++;
		}
		expect({ images, equal, lighter, other }).toEqual({ images: 5120, equal: 4969, lighter: 151, other: 0 });
	});
	it('AntiAliasGridFit on a font without a gasp table is the monochrome bitmap from 9 to 17 ppem (2,304 of 2,304) and not at 8 or from 18', () => {
		const monoBits = new Map<string, any>();
		for (const r of mono) if (r.set === 'polygons' && r.format === 1) monoBits.set(`${r.ppem}:${r.index}`, r);
		const result: Record<string, number> = { inside: 0, insideTotal: 0, outside: 0, outsideTotal: 0 };
		for (const c of plus) {
			if (c.hint !== 3 || c.size > 20) continue;
			const bits = samples(monoBits.get(`${c.size}:${c.index}`)), image = plusLevels(c);
			const same = image.size === bits.size && [...bits].every((k) => image.get(k) === 15);
			const bucket = c.size >= 9 && c.size <= 17 ? 'inside' : 'outside';
			result[`${bucket}Total`]++;
			if (same) result[bucket]++;
		}
		expect(result).toEqual({ inside: 2304, insideTotal: 2304, outside: 0, outsideTotal: 1024 });
	});
	it('a bar between two sample rows or columns, touching neither centre, is drawn on the upper or right one in all 210', () => {
		const pairs: [number, number][] = [];
		for (let lo = 56; lo < 72; lo++) for (let hi = lo + 1; hi <= 72; hi++) pairs.push([lo, hi]);
		let pure = 0, upper = 0;
		for (const c of json('text-raster-bars.json.gz')) {
			if (c.hint !== 4) continue;
			const [lo, hi] = pairs[c.index % 136];
			if (lo === 56 || hi === 72) continue;
			pure++;
			const gray = Buffer.from(c.gray, 'base64');
			let lower = 0, higher = 0;
			if (c.index < 136) for (let x = 12; x < 22; x++) { lower += gray[47 * 64 + x] !== 255 ? 1 : 0; higher += gray[46 * 64 + x] !== 255 ? 1 : 0; }
			else for (let y = 36; y < 46; y++) { lower += gray[y * 64 + 8] !== 255 ? 1 : 0; higher += gray[y * 64 + 9] !== 255 ? 1 : 0; }
			if (higher > 0 && lower === 0) upper++;
		}
		expect({ pure, upper }).toEqual({ pure: 210, upper: 210 });
	});
});

describe('GDI monochrome bitmaps of the private polygon fonts (GetGlyphOutline GGO_BITMAP)', () => {
	// [exact at 8 to 32 ppem of 4,096, exact at 33 to 40 ppem of 1,024]
	const expected: Record<string, [number, number]> = {
		polygons: [4079, 1024], st0: [4079, 1024], st4: [4049, 1009],
		// SCANTYPE 1 and 5 exclude stubs; the engine's FreeType stub rule is right for about 3 in 4 bitmaps.
		st1: [3102, 774], st5: [3134, 782],
	};
	it.each(Object.keys(expected))('%s', (set) => {
		expect(gdiExact(set, 1, true)).toEqual([expected[set][0], 4096]);
		expect(gdiExact(set, 1, false)).toEqual([expected[set][1], 1024]);
	});
});

describe('GDI monochrome bitmaps of polygon fonts with hinting machinery that never runs SCANCTRL', () => {
	// Declared stack and zone sizes, a one-instruction glyph program, a cvt table or an empty prep change nothing:
	// simple dropouts up to 32 ppem (1,787 of 1,792 bitmaps at 8 to 32 ppem), none at 33 and 36 ppem (512 of 512).
	const variants = ['stack', 'glyphprog', 'cvt', 'prep'];
	const variantFonts = new GdiFontCollection(variants.map((v) => fixture(`raster-polygons-${v}.ttf`)));
	const records: any[] = json('text-raster-variants.json.gz');
	it.each(variants)('%s', (variant) => {
		const exact = { small: [0, 0], large: [0, 0] };
		for (const r of records) {
			if (r.set !== variant || r.format !== 1) continue;
			const font = variantFonts.realize({ face: `Parity Raster Polygons V${variant}`, height: -r.ppem, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3, unhinted: false, gdiPlus: false }) as any;
			const bitmap = font.glyph(r.index + 1).bitmap;
			const mine = new Set<string>();
			if (bitmap) for (let row = 0; row < bitmap.height; row++) for (let col = 0; col < bitmap.width; col++) if (bitmap.data[row * bitmap.width + col]) mine.add(`${bitmap.left + col},${bitmap.top - 1 - row}`);
			const native = samples(r);
			const bucket = r.ppem <= 32 ? exact.small : exact.large;
			bucket[1]++;
			if (mine.size === native.size && [...native].every((k) => mine.has(k))) bucket[0]++;
		}
		expect(exact.small[1]).toBe(1792);
		expect(exact.large[1]).toBe(512);
		expect(exact.small[0]).toBe(1787);
		expect(exact.large[0]).toBe(512);
	});
});

describe('GDI grayscale bitmaps of the private polygon fonts (GetGlyphOutline GGO_GRAY4_BITMAP)', () => {
	// polygons has no SCANCTRL: GDI draws simple dropouts up to 32 ppem (3,852 of 4,096 would match), the engine none yet.
	const expected: Record<string, [number, number]> = {
		polygons: [517, 1019], st0: [3852, 967], st4: [3747, 945], st1: [3106, 778], st5: [3147, 782],
	};
	it.each(Object.keys(expected))('%s', (set) => {
		expect(gdiExact(set, 5, true)).toEqual([expected[set][0], 4096]);
		expect(gdiExact(set, 5, false)).toEqual([expected[set][1], 1024]);
	});
});

describe('GDI+ DrawDriverString images of the private polygon fonts', () => {
	function plusExact(set: string, hint: number, small: boolean): [number, number] {
		const captures = json(set === 'polygons' ? 'text-raster-polygons.json.gz' : `text-raster-polygons-${set}.json.gz`);
		let exact = 0, total = 0;
		for (const c of captures) {
			if (c.hint !== hint || (c.size <= 32) !== small) continue;
			const font = collection.realize({ face: fonts[set][1], height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: hint === 4, ignoreGasp: hint === 4, gdiPlus: true })!;
			const mask = gdiTextCoverage(font, { codes: [0xe000 + c.index], glyphIndices: false, x: 8, y: 48, dx: null, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
			applyTextContrast(mask.data, textGamma(0));
			const image = new Uint8Array(64 * 64).fill(255);
			for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
				const yy = y + mask.y, xx = x + mask.x;
				if (yy >= 0 && yy < 64 && xx >= 0 && xx < 64) image[yy * 64 + xx] = 255 - mask.data[y * mask.width + x];
			}
			total++;
			if (Buffer.from(image).equals(Buffer.from(c.gray, 'base64'))) exact++;
		}
		return [exact, total];
	}
	// Not modelled, and pinned as they are: a font without SCANCTRL gets simple dropouts up to 32 ppem (3,709 of 4,096
	// AntiAlias images would match), and AntiAliasGridFit on a font without gasp draws GDI's monochrome bitmap from 9
	// to 17 ppem (3,907 of 4,096 would match). Applying either as a default exceeds committed per-case ceilings of the
	// private diagonal-hinting coverage tests (30 captures whose residual is the unresolved diagonal hinting), so
	// neither ships; docs/outstanding-work.md has the figures.
	it('AntiAlias, a font without SCANCTRL', () => {
		expect(plusExact('polygons', 4, true)).toEqual([517, 4096]);
		expect(plusExact('polygons', 4, false)).toEqual([1019, 1024]);
	});
	it('AntiAliasGridFit, a font without gasp', () => {
		expect(plusExact('polygons', 3, true)).toEqual([227, 4096]);
		expect(plusExact('polygons', 3, false)).toEqual([1019, 1024]);
	});
	it.each([['st0', 3709, 940], ['st4', 3712, 937], ['st1', 3106, 778], ['st5', 3147, 782]] as const)('AntiAlias, SCANTYPE %s', (set, small, large) => {
		expect(plusExact(set, 4, true)).toEqual([small, 4096]);
		expect(plusExact(set, 4, false)).toEqual([large, 1024]);
	});
});

describe.skipIf(!existsSync(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'georgia.ttf')))('Georgia (SCANTYPE 4) GDI+ grayscale glyphs', () => {
	// text-real-glyphs: every printable ASCII glyph at 9 to 24 ppem, AntiAlias and AntiAliasGridFit, origin (6, 28).
	it('draws 1,042 grid-fitted and 736 unfitted glyphs of 1,128 exactly (942 and 476 without smart dropout control)', () => {
		const georgia = new GdiFontCollection([readFileSync(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'georgia.ttf'))]);
		const exact: Record<number, number> = { 3: 0, 4: 0 };
		let total = 0;
		for (const c of json('text-real-glyphs.json.gz')) {
			if (c.face !== 'Georgia') continue;
			const font = georgia.realize({ face: 'Georgia', height: -c.size, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: c.hint === 4, ignoreGasp: c.hint === 4, gdiPlus: true })!;
			const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: 6, y: 28, dx: null, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
			applyTextContrast(mask.data, textGamma(0));
			const image = new Uint8Array(40 * 40).fill(255);
			for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
				const yy = y + mask.y, xx = x + mask.x;
				if (yy >= 0 && yy < 40 && xx >= 0 && xx < 40) image[yy * 40 + xx] = 255 - mask.data[y * mask.width + x];
			}
			if (c.hint === 3) total++;
			if (Buffer.from(image).equals(Buffer.from(c.gray, 'base64'))) exact[c.hint]++;
		}
		expect(total).toBe(1128);
		expect(exact).toEqual({ 3: 1042, 4: 736 });
	});
});
