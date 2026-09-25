/**
 * Unit tests for the EMF record handlers added with the `emf-records`
 * fixtures: the pure arithmetic each one reproduces from GDI, plus the SVG
 * output of a few of the fixtures (rasterised by Skia's SVG renderer).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { convertMetafileToSvg } from './emf-converter';
import { alphaBlendPixel } from './emf-gdi-blend-blits';
import { floodSpans } from './emf-gdi-floodfill';
import { rectGradientLevel } from './emf-gdi-gradient-fill';
import { EMF_NO_EFFECT_RECORDS } from './emf-gdi-misc-records';
import { DEFAULT_PALETTE_ENTRIES, resolveColorRefRgb } from './emf-gdi-palette';
import { frameSpans } from './emf-gdi-region-records';
import { angleArcPieces, SpanList } from './gdi-raster';

describe('alphaBlendPixel', () => {
	it('blends a constant alpha as D + round((S - D) * SCA / 255)', () => {
		expect(alphaBlendPixel(0xff000000 | 0xe03020, 0x405060, 128, false)).toBe(0x904040);
		expect(alphaBlendPixel(0xff000000 | 0xe03020, 0x405060, 0, false)).toBe(-1);
	});

	it('adds a premultiplied source over D * (255 - A) / 255, skipping A = 0', () => {
		expect(alphaBlendPixel(0x80402010, 0xffffff, 255, true)).toBe(0xbf9f8f);
		expect(alphaBlendPixel(0x00402010, 0xffffff, 255, true)).toBe(-1);
	});

	it('carries an overflowing (non-premultiplied) channel into the next one', () => {
		// Blue 224 + round(38 * 254 / 255) = 262: wraps to 6 and carries into green.
		const out = alphaBlendPixel((1 << 24) | (32 << 16) | (48 << 8) | 224, (73 << 16) | (53 << 8) | 38, 255, true);
		expect(out & 0xff).toBe(6);
		expect((out >> 8) & 0xff).toBe(48 + 53 + 1);
	});
});

describe('rectGradientLevel', () => {
	it('is the 16.16 DDA with the step rounded down', () => {
		expect(rectGradientLevel(0, 0xffff, 229, 230)).toBe(254);
		expect(rectGradientLevel(0xe0e0, 0x1010, 114, 115)).toBe(17);
		expect(rectGradientLevel(0x8000, 0x8000, 7, 10)).toBe(128);
	});
});

describe('resolveColorRefRgb', () => {
	const pal = [0xc02020, 0x20b040, 0x3040d0];
	it('reads PALETTEINDEX from the palette, out of range as entry 0', () => {
		expect(resolveColorRefRgb(0x01000001, pal)).toBe(0x20b040);
		expect(resolveColorRefRgb(0x01000009, pal)).toBe(0xc02020);
		expect(resolveColorRefRgb(0x01000002, DEFAULT_PALETTE_ENTRIES)).toBe(0x008000);
	});

	it('paints DIBPALETTEINDEX black on a true colour surface and PALETTERGB as its RGB', () => {
		expect(resolveColorRefRgb(0x10ff0003, pal)).toBe(0);
		expect(resolveColorRefRgb(0x02336699, pal)).toBe(0x996633);
		expect(resolveColorRefRgb(0x00336699, pal)).toBe(0x996633);
	});
});

describe('frameSpans', () => {
	it('frames a square by the width and height, with full inside corners', () => {
		const spans = new SpanList();
		for (let y = 0; y < 10; y++) {
			spans.add(y, 0, 10);
		}
		const frame = frameSpans(spans, 2, 1);
		const px = new Set<string>();
		for (let i = 0; i < frame.length * 3; i += 3) {
			for (let x = frame.data[i + 1]; x < frame.data[i + 2]; x++) {
				px.add(`${x},${frame.data[i]}`);
			}
		}
		expect(px.has('0,5')).toBe(true);
		expect(px.has('1,5')).toBe(true);
		expect(px.has('2,5')).toBe(false);
		expect(px.has('5,0')).toBe(true);
		expect(px.has('5,1')).toBe(false);
		expect(px.size).toBe(100 - 6 * 8);
	});
});

describe('floodSpans', () => {
	it('spreads through 4-connected pixels only', () => {
		// A 5x5 white square with a black diagonal line: the diagonal holds a 4-connected fill.
		const w = 5;
		const data = new Uint8ClampedArray(w * w * 4).fill(255);
		for (let i = 0; i < w; i++) {
			data.fill(0, (i * w + i) * 4, (i * w + i) * 4 + 3);
		}
		const spans = floodSpans(data, w, w, 4, 0, (rgb) => rgb !== 0, new Uint8Array(w * w).fill(1));
		let n = 0;
		for (let i = 0; i < spans.length * 3; i += 3) {
			n += spans.data[i + 2] - spans.data[i + 1];
		}
		expect(n).toBe(10);
	});
});

describe('angleArcPieces', () => {
	it('cuts at quadrant boundaries with GDI\'s trailing zero-length piece', () => {
		expect(angleArcPieces(0, 90).map((p) => [p.from, p.to])).toEqual([
			[0, 90],
			[90, 90],
		]);
		expect(angleArcPieces(-30, -60).map((p) => [p.from, p.to])).toEqual([[-30, -90]]);
	});

	it('draws a sweep past a full turn as the remainder, then round again', () => {
		const pieces = angleArcPieces(10, 400);
		expect(pieces.map((p) => p.to)).toEqual([50, 90, 180, 270, 360, 370, 410]);
		expect(pieces.filter((p) => p.first).map((p) => p.from)).toEqual([10, 50, 370]);
	});
});

describe('informational records', () => {
	it('consumes the colour space, ICM, OpenGL and escape records', () => {
		for (const t of [16, 99, 100, 101, 102, 103, 104, 105, 106, 109, 110, 111, 112, 113, 119, 121, 122]) {
			expect(EMF_NO_EFFECT_RECORDS.has(t)).toBe(true);
		}
	});
});

describe('SVG output of the emf-records fixtures', () => {
	async function svgOf(name: string, options: Record<string, unknown> = {}): Promise<string> {
		const bytes = readFileSync(fixturePath(name + '.emf'));
		return (await convertMetafileToSvg(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { dpiScale: 1, ...options }))!;
	}

	// Pixel parity of these patches is covered by the PNG cases (the SVG embeds
	// the very same exact pixels, see svg-software-shadow.fixture.test.ts);
	// Skia's SVG renderer does not draw embedded data-URL images.
	it.each(['emfrec-alphablend', 'emfrec-plgblt', 'emfrec-gradient-tri', 'emfrec-floodfill', 'emfrec-maskblt'])(
		'%s embeds its exact pixels as image patches',
		async (name) => {
			expect(await svgOf(name)).toContain('<image');
		},
	);

	it('keeps regions and rectangle gradients as vector geometry by default', async () => {
		expect(await svgOf('emfrec-gradient-rect')).toContain('<linearGradient');
		const regions = await svgOf('emfrec-fillrgn-scaled');
		expect(regions).toContain('<path');
		expect(regions).not.toContain('<image');
	});
});
