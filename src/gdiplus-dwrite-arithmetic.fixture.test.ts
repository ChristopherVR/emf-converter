import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { applyTextContrast, textGamma } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

/**
 * DirectWrite's ClearType arithmetic for installed fonts under GDI+ grayscale text (round 11, `HintEnvironment.dwriteArithmetic`):
 * per-product projections and the every-vector-but-y ClearType direction, read in DWrite.dll and confirmed here against the
 * committed native captures. Exact captures with the model on and off; the model is opt-in on this branch.
 */
const load = (name: string): any[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))).toString());
const red = (c: any): Uint8Array => { const b = Buffer.from(c.rgba, 'base64'), o = new Uint8Array(64 * 64); for (let i = 0; i < o.length; i++) o[i] = b[i * 4]; return o; };

function exact(installed: boolean, file: string, size: number, origin: (c: any) => [number, number], expected: (c: any) => Uint8Array): number {
	const fonts = new GdiFontCollection(windowsFonts()!, 'cleartype', { installedFonts: installed });
	let n = 0;
	for (const c of load(file)) {
		if (c.hint === 5) continue;
		const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: c.style & 1 ? 700 : 400, italic: !!(c.style & 2), charSet: 1,
			pitchAndFamily: 0, quality: 4, unhinted: c.hint === 4, ignoreGasp: c.hint === 4, gdiPlus: true, unscaledText: true })!;
		const [x, y] = origin(c);
		const m = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x, y, dx: null, dy: null, textAlign: 24, textColor: '#000000',
			bkColor: '#ffffff', bkMode: 1, options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
		applyTextContrast(m.data, textGamma(c.contrast ?? 0));
		const img = new Uint8Array(size * size).fill(255);
		for (let yy = 0; yy < m.height; yy++) for (let xx = 0; xx < m.width; xx++) {
			const py = yy + m.y, px = xx + m.x;
			if (py >= 0 && py < size && px >= 0 && px < size) img[py * size + px] = 255 - m.data[yy * m.width + xx];
		}
		if (Buffer.from(img).equals(Buffer.from(expected(c)))) n++;
	}
	return n;
}

describe.skipIf(!windowsFonts())('DirectWrite arithmetic for installed fonts (GDI+ grayscale)', () => {
	it('text-real-glyphs: 17,409 exact without, 19,494 with', () => {
		const g = (c: any) => new Uint8Array(Buffer.from(c.gray, 'base64'));
		expect(exact(false, 'text-real-glyphs.json.gz', 40, () => [6, 28], g)).toBe(17409);
		expect(exact(true, 'text-real-glyphs.json.gz', 40, () => [6, 28], g)).toBe(19494);
	}, 240000);
	it('text-origin-phases and vertical phases: every grayscale capture exact with the model', () => {
		for (const f of ['text-origin-phases.json.gz', 'text-origin-vertical-phases.json.gz']) {
			expect(exact(false, f, 64, (c) => [8 + c.qx / 64, 48 + c.qy / 64], red)).toBe(1408);
			expect(exact(true, f, 64, (c) => [8 + c.qx / 64, 48 + c.qy / 64], red)).toBe(1536);
		}
	}, 240000);
});
