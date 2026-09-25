/**
 * Unit tests for the GDI font engine stack on a synthetic font
 * (`__fixtures__/test-font.ts`): TrueType parsing, the hinting interpreter,
 * the scan converter (centre rule, dropout control, 4x4 grayscale), GDI
 * font realisation (sizes, metrics, synthetic styles, lfWidth, mapping)
 * and run painting (alignment, TA_UPDATECP, OPAQUE cell, underline,
 * ETO_CLIPPED) on canvas and SVG. The pixel-for-pixel comparison against
 * real GDI output lives in `gdi-parity.fixture.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import { readFileSync } from 'node:fs';

import { fixturePath, windowsFonts } from './__fixtures__/gdi-parity-harness';
import { buildTestFnt, buildTestFon } from './__fixtures__/test-fnt';
import { buildTestFont } from './__fixtures__/test-font';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { GdiFontCollection, RasterRealizedFont, resolvePpem, type LogFontSpec } from './gdi-font-engine';
import { gdiTextCoverage, paintGdiTextRun, type GdiTextRun } from './gdi-text-render';
import { SvgContext } from './svg-context';
import { svgTreeToString } from './svg-tree';
import { parseRasterFontFile } from './fnt-font';
import { convertMetafileToSvg } from './index';
import { parseFontFile } from './ttf-font';
import { HintedSize, mulDiv, mulFix } from './ttf-hinting';
import { dropoutMode, rasterizeGray, rasterizeMono } from './ttf-raster';
import type { CanvasContext } from './emf-types';

const FONT = buildTestFont();

function spec(overrides: Partial<LogFontSpec> = {}): LogFontSpec {
	return {
		face: 'Test Sans',
		height: -10,
		width: 0,
		weight: 400,
		italic: false,
		charSet: 1,
		pitchAndFamily: 0,
		quality: 3,
		...overrides,
	};
}

describe('ttf-font', () => {
	const f = parseFontFile(FONT)[0];

	it('reads names, metrics and the character map', () => {
		expect(f.family).toBe('Test Sans');
		expect(f.subfamily).toBe('Regular');
		expect(f.unitsPerEm).toBe(2048);
		expect(f.winAscent).toBe(1800);
		expect(f.winDescent).toBe(400);
		expect(f.underlinePosition).toBe(-200);
		expect(f.strikeoutPosition).toBe(600);
		expect(f.glyphIndex(0x49)).toBe(2);
		expect(f.glyphIndex(0x6c)).toBe(3);
		expect(f.glyphIndex(0x41)).toBe(0);
		expect(f.hMetrics(2)).toEqual({ advance: 400, lsb: 100 });
		expect(f.hdmx.get(10)?.[2]).toBe(2);
	});

	it('loads outlines with on/off-curve points and instructions', () => {
		const g = f.loadGlyph(2)!;
		expect(g.xs).toEqual([100, 100, 300, 300]);
		expect(g.ys).toEqual([0, 1400, 1400, 0]);
		expect(Array.from(g.instructions)).toEqual([0xb0, 0x00, 0x2b]);
		expect(f.loadGlyph(4)!.onCurve).toEqual([true, false, true, false, true, false, true, false]);
		expect(f.loadGlyph(1)).toBeNull();
	});

	it('rejects non-TrueType data without throwing', () => {
		expect(parseFontFile(new Uint8Array([1, 2, 3, 4]))).toEqual([]);
		expect(parseFontFile(new TextEncoder().encode('OTTO' + '\0'.repeat(40)))).toEqual([]);
	});
});

describe('ttf-hinting', () => {
	const f = parseFontFile(FONT)[0];

	it('rounds 16.16 products half up, as GDI scales coordinates', () => {
		expect(mulFix(-1, 0x8000)).toBe(0);
		expect(mulFix(1, 0x8000)).toBe(1);
		expect(mulDiv(-3, 1, 2)).toBe(-2);
	});

	it('runs fpgm functions from the glyph program: MDAP[r] snaps, IUP carries the rest', () => {
		const hinted = new HintedSize(f, 10, 10, { version: 35, grayscale: false }).hintGlyph(2);
		// Point 0 sits at 100 * 10/2048 px = 31.25/64 and rounds down to 0;
		// IUP shifts the stem's other points by the same -31.
		expect(Array.from(hinted.xs)).toEqual([0, 0, 63, 63]);
		expect(Array.from(hinted.ys)).toEqual([0, 438, 438, 0]);
		expect(hinted.advance).toBe(128);
		expect(hinted.scanControl).toBe(true);
		expect(hinted.scanType).toBe(1);
	});

	it('leaves the outline unhinted when asked', () => {
		const plain = new HintedSize(f, 10, 10, { version: 35, grayscale: false }, false).hintGlyph(2);
		expect(Array.from(plain.xs)).toEqual([31, 31, 94, 94]);
	});
});

describe('ttf-raster', () => {
	const f = parseFontFile(FONT)[0];
	const size = new HintedSize(f, 10, 10, { version: 35, grayscale: false });

	it('turns on exactly the pixels whose centres the outline covers', () => {
		const g = size.hintGlyph(2);
		const b = rasterizeMono(g, dropoutMode(g.scanControl, g.scanType))!;
		expect([b.left, b.top, b.width, b.height]).toEqual([0, 7, 1, 7]);
		expect(Array.from(b.data)).toEqual([1, 1, 1, 1, 1, 1, 1]);
	});

	it('keeps a sub-pixel stem only with dropout control', () => {
		const g = size.hintGlyph(3);
		// SCANTYPE 1: simple dropout control, stubs (the stem's two ends) excluded.
		const withDropout = rasterizeMono(g, dropoutMode(true, 1))!;
		expect([withDropout.left, withDropout.width, withDropout.height]).toEqual([4, 1, 7]);
		expect(Array.from(withDropout.data)).toEqual([0, 1, 1, 1, 1, 1, 0]);
		// SCANTYPE 0 includes the stubs.
		expect(Array.from(rasterizeMono(g, dropoutMode(true, 0))!.data)).toEqual([1, 1, 1, 1, 1, 1, 1]);
		const without = rasterizeMono(g, dropoutMode(false, 1))!;
		expect(Array.from(without.data).every((v) => v === 0)).toBe(true);
	});

	it('counts 4x4 samples for grayscale', () => {
		const b = rasterizeGray(size.hintGlyph(2))!;
		expect([b.left, b.top, b.width, b.height]).toEqual([0, 7, 1, 7]);
		expect(Array.from(b.data)).toEqual([12, 16, 16, 16, 16, 16, 16]);
	});
});

describe('gdi-font-engine', () => {
	const fonts = new GdiFontCollection([FONT], 'gray');

	it('realises LOGFONT metrics the way GetTextMetrics reports them', () => {
		const r = fonts.realize(spec())!;
		expect(r.ppem).toBe(10);
		expect(r.ascent).toBe(9);
		expect(r.descent).toBe(2);
		expect(r.underlinePosition).toBe(-1);
		expect(r.strikeoutPosition).toBe(3);
		expect(r.advance(2)).toBe(2);
		expect(r.mode).toBe('mono');
		// At a non-axis angle: the head bounding box, scaled and padded.
		const f = parseFontFile(FONT)[0];
		expect(r.rotatedAscent).toBe(Math.floor((f.headYMax * 10) / f.unitsPerEm + 1.27));
		expect(r.rotatedDescent).toBe(Math.floor((-f.headYMin * 10) / f.unitsPerEm + 1.27));
	});

	it('resolves both lfHeight signs', () => {
		const f = parseFontFile(FONT)[0];
		expect(resolvePpem(f, -13)).toBe(13);
		// Cell height 11: 11 * 2048 / 2200 rounds to 10, whose cell (9 + 2) fits.
		expect(resolvePpem(f, 11)).toBe(10);
		expect(fonts.realize(spec({ height: 11 }))!.ppem).toBe(10);
	});

	it('simulates bold and italic the face lacks', () => {
		const bold = fonts.realize(spec({ weight: 700 }))!;
		expect(bold.syntheticBold).toBe(true);
		expect(bold.advance(2)).toBe(3);
		expect(bold.glyph(2).bitmap!.width).toBe(2);
		expect(fonts.realize(spec({ weight: 600 }))!.syntheticBold).toBe(true);
		expect(fonts.realize(spec({ weight: 550 }))!.syntheticBold).toBe(false);
		expect(fonts.realize(spec({ italic: true }))!.syntheticItalic).toBe(true);
	});

	it('stretches horizontally for lfWidth, but not at the natural width', () => {
		expect(fonts.realize(spec({ width: 5 }))!.ppemX).toBe(20);
		expect(fonts.realize(spec({ width: 2 }))!.ppemX).toBe(10);
	});

	it('maps quality and gasp to a rendering mode', () => {
		expect(fonts.realize(spec({ quality: 4 }))!.mode).toBe('gray');
		expect(fonts.realize(spec({ quality: 5 }))!.mode).toBe('cleartype');
		expect(fonts.realize(spec({ quality: 0 }))!.mode).toBe('gray');
		expect(new GdiFontCollection([FONT]).realize(spec({ quality: 0 }))!.mode).toBe('cleartype');
	});

	it('returns null for a face it cannot stand in for, unless mapped', () => {
		expect(fonts.realize(spec({ face: 'No Such Face' }))).toBeNull();
		expect(fonts.realize(spec({ face: 'No Such Face' }), { 'no such face': 'Test Sans' })).not.toBeNull();
	});
});

describe('raster (.fon) fonts', () => {
	const small = { pixHeight: 13, ascent: 11, internalLeading: 2, width: 5 };
	const large = { pixHeight: 16, ascent: 13, internalLeading: 3, width: 7 };
	const FON = buildTestFon([buildTestFnt(small), buildTestFnt(large)]);
	const fonts = new GdiFontCollection([FON], 'gray');
	const raster = (o: Partial<LogFontSpec> = {}): RasterRealizedFont => {
		const r = fonts.realize(spec({ face: 'Test Raster', ...o }));
		expect(r).toBeInstanceOf(RasterRealizedFont);
		return r as RasterRealizedFont;
	};

	it('parses the NE container and the FNT bitmaps (column-major, MSB left)', () => {
		const faces = parseRasterFontFile(FON);
		expect(faces.map((x) => [x.family, x.pixHeight, x.ascent, x.internalLeading])).toEqual([
			['Test Raster', 13, 11, 2],
			['Test Raster', 16, 13, 3],
		]);
		const a = faces[0].bitmap(0x41)!;
		expect(faces[0].width(0x41)).toBe(5);
		expect(a[2 * 5 + 0]).toBe(1); // em top, left column
		expect(a[2 * 5 + 4]).toBe(0); // the gap column
		expect(a[1 * 5 + 0]).toBe(0); // internal leading
		expect(parseRasterFontFile(buildTestFnt(small))).toHaveLength(1);
		expect(parseRasterFontFile(new Uint8Array(200))).toEqual([]);
	});

	it('picks a size (or a whole-number stretch) by the mapper\'s height penalties', () => {
		expect([raster({ height: -11 }).face.pixHeight, raster({ height: -11 }).scale]).toEqual([13, 1]);
		// Character height 12: 11 is one short (150) but 13 one over (640).
		expect(raster({ height: -12 }).face.pixHeight).toBe(13);
		expect(raster({ height: -13 }).face.pixHeight).toBe(16);
		// Cell heights compare the whole cell.
		expect(raster({ height: 16 }).face.pixHeight).toBe(16);
		// 26 = 2 x 13 exactly beats 16 ten pixels short.
		const big = raster({ height: -26 });
		expect([big.face.pixHeight, big.scale, big.ascent, big.descent]).toEqual([16, 2, 26, 6]);
		expect(big.advance(0x41)).toBe(14);
		expect(big.glyph(0x41).bitmap!.height).toBe(32);
	});

	it('simulates bold, italic and lfWidth on the bitmaps', () => {
		const plain = raster({ height: -11 });
		const bold = raster({ height: -11, weight: 700 });
		expect(bold.syntheticBold).toBe(true);
		expect(bold.advance(0x41)).toBe(plain.advance(0x41) + 1);
		const italic = raster({ height: -11, italic: true });
		const g = italic.glyph(0x41).bitmap!;
		// A 13-row cell leans 6 pixels; the advance is unchanged.
		expect(g.width).toBe(5 + 6);
		expect(italic.advance(0x41)).toBe(5);
		const firstInk = (row: number): number => Array.from(g.data.subarray(row * g.width, (row + 1) * g.width)).indexOf(1);
		expect(firstInk(2)).toBe(5);
		expect(firstInk(10)).toBe(1);
		const wide = raster({ height: -11, width: 10 });
		expect([wide.scale, wide.scaleX, wide.advance(0x41)]).toEqual([1, 2, 10]);
	});

	it('serves the stock raster substitutes and falls back to the default character', () => {
		const named = new GdiFontCollection([buildTestFon([buildTestFnt({ ...small, family: 'MS Sans Serif' })])], 'gray');
		const helv = named.realize(spec({ face: 'Helv', height: -11 }));
		expect(helv).toBeInstanceOf(RasterRealizedFont);
		expect(helv!.glyphIndex(0x2022)).toBe(0x95); // bullet, Windows-1252
		expect(helv!.glyphIndex(0x4e00)).toBe(0x3f); // not in the code page: the default '?'
		expect(named.realize(spec({ face: 'Helv', height: -11, quality: 5 }))!.mode).toBe('mono');
	});

	it('paints raster glyphs 1:1', async () => {
		ensureNodeCanvasModule();
		const napi = await import('@napi-rs/canvas');
		const canvas = napi.createCanvas(40, 20);
		const ctx = canvas.getContext('2d') as unknown as CanvasContext;
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, 40, 20);
		const font = raster({ height: -11 });
		const run: GdiTextRun = {
			codes: [0x41, 0x41],
			glyphIndices: false,
			x: 2,
			y: 15,
			dx: null,
			dy: null,
			textAlign: 0x18,
			textColor: '#000000',
			bkColor: '#ffffff',
			bkMode: 1,
			options: 0,
			rect: null,
			matrix: null,
			underline: false,
			strikeOut: false,
		};
		paintGdiTextRun(ctx, font, run);
		const d = ctx.getImageData(0, 0, 40, 20).data;
		const ink = (x: number, y: number): boolean => d[(y * 40 + x) * 4] < 128;
		// Baseline 15, ascent 11: rows 6..14 inked (the em), columns 2..5 and 7..10.
		expect(ink(2, 6)).toBe(true);
		expect(ink(2, 5)).toBe(false);
		expect(ink(6, 10)).toBe(false);
		expect(ink(7, 14)).toBe(true);
		expect(ink(7, 15)).toBe(false);
	});
});

describe('gdi-text-render', () => {
	const fonts = new GdiFontCollection([FONT], 'gray');
	const font = fonts.realize(spec())!;

	function run(overrides: Partial<GdiTextRun> = {}): GdiTextRun {
		return {
			codes: [0x49, 0x49],
			glyphIndices: false,
			x: 10,
			y: 20,
			dx: null,
			dy: null,
			textAlign: 0x18,
			textColor: '#000000',
			bkColor: '#ffff00',
			bkMode: 1,
			options: 0,
			rect: null,
			matrix: null,
			underline: false,
			strikeOut: false,
			...overrides,
		};
	}

	async function paint(r: GdiTextRun): Promise<{ ink: (x: number, y: number) => string; adv: { dx: number; dy: number } }> {
		const napi = await import('@napi-rs/canvas');
		await ensureNodeCanvasModule();
		const canvas = napi.createCanvas(40, 30);
		const ctx = canvas.getContext('2d') as unknown as CanvasContext;
		const adv = paintGdiTextRun(ctx, font, r);
		const data = (ctx as unknown as CanvasRenderingContext2D).getImageData(0, 0, 40, 30).data;
		const ink = (x: number, y: number): string => {
			const o = (y * 40 + x) * 4;
			return data[o + 3] === 0 ? '.' : data[o] === 0 && data[o + 1] === 0 ? '#' : 'y';
		};
		return { ink, adv };
	}

	const columns = (ink: (x: number, y: number) => string, y: number): number[] =>
		Array.from({ length: 40 }, (_, x) => x).filter((x) => ink(x, y) === '#');

	it('places glyphs at integer origins from the advance widths', async () => {
		const { ink, adv } = await paint(run());
		expect(columns(ink, 15)).toEqual([10, 12]);
		expect(ink(10, 13)).toBe('#');
		expect(ink(10, 12)).toBe('.');
		expect(adv).toEqual({ dx: 4, dy: 0 });
	});

	it('honours TA_RIGHT / TA_CENTER and moves the current position accordingly', async () => {
		const right = await paint(run({ textAlign: 0x18 | 0x02 }));
		expect(columns(right.ink, 15)).toEqual([6, 8]);
		expect(right.adv.dx).toBe(-4);
		const center = await paint(run({ textAlign: 0x18 | 0x06 }));
		expect(columns(center.ink, 15)).toEqual([8, 10]);
		expect(center.adv.dx).toBe(0);
	});

	it('uses the Dx array when present', async () => {
		const { ink } = await paint(run({ dx: [5, 5] }));
		expect(columns(ink, 15)).toEqual([10, 15]);
	});

	it('fills the OPAQUE cell and draws the underline bar', async () => {
		const { ink } = await paint(run({ bkMode: 2, underline: true }));
		expect(ink(10, 11)).toBe('y'); // baseline 20 - ascent 9
		expect(ink(10, 10)).toBe('.');
		expect(ink(13, 21)).toBe('#'); // underline 1px below the baseline
		expect(ink(10, 22)).toBe('.'); // descent 2 -> cell ends at row 21
	});

	it('clips to the ETO_CLIPPED rectangle', async () => {
		const { ink } = await paint(run({ options: 0x04, rect: { left: 0, top: 0, right: 12, bottom: 30 } }));
		expect(columns(ink, 15)).toEqual([10]);
	});

	it('exposes the run\'s glyph coverage as a device-space mask', () => {
		const cov = gdiTextCoverage(font, run())!;
		expect([cov.x, cov.y, cov.width, cov.height, cov.channels]).toEqual([10, 13, 3, 7, 1]);
		// Columns 10 and 12 are ink (255), column 11 is the gap between glyphs.
		expect(Array.from(cov.data.slice(0, 3))).toEqual([255, 0, 255]);
		const gray = gdiTextCoverage(fonts.realize(spec({ quality: 4 }))!, run())!;
		expect(Math.max(...gray.data)).toBe(255);
		expect(gdiTextCoverage(font, run({ codes: [0x20] }))).toBeNull();
	});

	it('emits SVG text at the same per-glyph origins', async () => {
		const ctx = new SvgContext(40, 30);
		paintGdiTextRun(ctx as unknown as CanvasContext, font, run({ underline: true }));
		const svg = svgTreeToString(await ctx.toTree());
		expect(svg).toContain('<text x="10 12" y="20" font-family="&quot;Test Sans&quot;" font-size="10" text-rendering="optimizeSpeed"');
		expect(svg).toContain('>II</text>');
		expect(svg).toMatch(/<path d="M10 21l4 0 0 1-4 0z"/);
	});
});

describe.skipIf(!windowsFonts())('SVG output with the Windows fonts', () => {
	it('keeps text as <text> at GDI\'s per-glyph positions, with ETO_CLIPPED as a clip path', async () => {
		const bytes = readFileSync(fixturePath('textx-eto-mono.emf'));
		const svg = await convertMetafileToSvg(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			{ dpiScale: 1, fonts: windowsFonts()! },
		);
		// The record's Dx (9, 12, 15, ...) accumulated from x = 6.
		expect(svg).toContain('<text x="6 15 27 42 51 63 78 87 99 114 123 135 150 159" y="24" font-family="Arial" font-size="16"');
		// ETO_PDY: the y list alternates with the recorded dy.
		expect(svg).toContain('y="110 113 110 113 110 113 110 113"');
		expect(svg).toMatch(/<g clip-path="url\(#[^)]+\)"><text x="6 17 26/);
		expect(svg).toContain('font-weight="700" font-style="italic"');
	});
});
