import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { blendCtLevel, gdiTextCoverage } from './gdi-text-render';

/** Native black-on-white values of the seven ClearType coverage levels 0..6. */
const LEVELS = [255, 219, 182, 144, 102, 58, 0];

function load<T>(name: string): T {
	return JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString()) as T;
}

interface BlendCapture { quality: number; size: number; fg: number[]; bg: number[]; w: number; h: number; rgb: string }
interface BlendFile { captures: BlendCapture[]; smoothingType: number; smoothingContrast: number }

describe('GDI ExtTextOut ClearType blend (gdi-cleartype-blend.json.gz)', () => {
	const file = load<BlendFile>('gdi-cleartype-blend.json.gz');
	it('was captured with the system contrast the gamma 1.2 tables derive from', () => {
		expect(file.smoothingContrast).toBe(1200);
	});
	it('reproduces every native channel value of 128 text/background pairs at ClearType, natural and default quality', () => {
		let compared = 0;
		let mismatched = 0;
		for (const c of file.captures) {
			const base = file.captures.find((x) => x.quality === c.quality && x.size === c.size && x.fg.every((v) => v === 0) && x.bg.every((v) => v === 255))!;
			const black = Buffer.from(base.rgb, 'base64');
			const native = Buffer.from(c.rgb, 'base64');
			for (let p = 0; p < native.length; p += 3) {
				const k = [0, 1, 2].map((i) => LEVELS.indexOf(black[p + i]));
				for (let i = 0; i < 3; i++) {
					// A pixel with no coverage keeps its background and a fully covered one takes the text colour.
					const v = k.every((x) => x === 0) ? c.bg[i] : k.every((x) => x === 6) ? c.fg[i] : blendCtLevel(c.fg[i], c.bg[i], k[i]);
					compared++;
					if (v !== native[p + i]) mismatched++;
				}
			}
		}
		expect(compared).toBe(6873600);
		expect(mismatched).toBe(0);
	});
});

interface RasterCapture { font: string; glyph: number; rgb: string }
interface RasterFile { width: number; height: number; captures: RasterCapture[] }

describe.skipIf(!windowsFonts())('GDI ExtTextOut ClearType scan conversion (gdi-cleartype-raster.json.gz)', () => {
	const file = load<RasterFile>('gdi-cleartype-raster.json.gz');
	const fonts = new GdiFontCollection([
		...windowsFonts()!,
		readFileSync(new URL('./__fixtures__/gdi/raster-polygons.ttf', import.meta.url)),
		readFileSync(new URL('./__fixtures__/gdi/cleartype-geometry.ttf', import.meta.url)),
	]);
	const faces: Record<string, string> = { 'raster-polygons.ttf': 'Parity Raster Polygons', 'cleartype-geometry.ttf': 'Parity ClearType Geometry' };

	function mismatches(c: RasterCapture): number {
		const font = fonts.realize({ face: faces[c.font], height: -32, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 5 })!;
		const mask = gdiTextCoverage(font, {
			codes: [0xe000 + c.glyph], glyphIndices: false, x: 8, y: 36, dx: null, dy: null, textAlign: 24, textColor: '#000000',
			bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false,
		});
		const ours = new Uint8Array(file.width * file.height * 3).fill(255);
		if (mask) {
			for (let y = 0; y < mask.height; y++) {
				for (let x = 0; x < mask.width; x++) {
					for (let ch = 0; ch < 3; ch++) {
						ours[((y + mask.y) * file.width + x + mask.x) * 3 + ch] = LEVELS[Math.round((mask.data[(y * mask.width + x) * 3 + ch] * 6) / 255)];
					}
				}
			}
		}
		const native = Buffer.from(c.rgb, 'base64');
		let bad = 0;
		for (let p = 0; p < native.length; p++) if (native[p] !== ours[p]) bad++;
		return bad;
	}

	it('reproduces all 1,070 bars, slanted edges and doubly fractional bars of the geometry font exactly (five weighted sample rows per pixel)', () => {
		const geometry = file.captures.filter((c) => c.font === 'cleartype-geometry.ttf');
		expect(geometry).toHaveLength(1070);
		expect(geometry.filter((c) => mismatches(c) !== 0)).toHaveLength(0);
	});

	it('bounds the isolated one-level differences of 256 random polygons', () => {
		const polygons = file.captures.filter((c) => c.font === 'raster-polygons.ttf');
		expect(polygons).toHaveLength(256);
		let bad = 0;
		for (const c of polygons) bad += mismatches(c);
		expect(bad).toBeLessThanOrEqual(397);
	});
});
