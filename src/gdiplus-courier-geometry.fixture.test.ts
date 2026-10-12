import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GdiFontCollection } from './gdi-font-engine';
import { gdiTextCoverage } from './gdi-text-render';

interface Capture {
	face: string; size: number; hint: number; code: number; qx: number; qy: number;
	x: number; y: number; w: number; h: number; rgb: string;
}
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const read = (name: string): Capture[] => JSON.parse(gunzipSync(fixture(`${name}.json.gz`)).toString());
const bounds: Record<string, number[]> = JSON.parse(fixture('courier-geometry-bounds.json').toString());

function native(c: Capture): Uint8Array {
	const data = new Uint8Array(64 * 64).fill(255);
	const rgb = Buffer.from(c.rgb, 'base64');
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
		data[(c.y + y) * 64 + c.x + x] = rgb[(y * c.w + x) * 3];
	}
	return data;
}

function mismatches(fonts: GdiFontCollection, c: Capture): number {
	const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: 400,
		italic: false, charSet: 1, pitchAndFamily: 0, quality: 4, gdiPlus: true,
		ignoreGasp: c.hint === 4, unhinted: c.hint === 4 })!;
	const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false,
		x: 8 + c.qx / 4, y: 48 + c.qy / 4, dx: null, dy: null, textAlign: 24,
		textColor: '#000000', bkColor: '#ffffff', bkMode: 1, options: 0, rect: null,
		matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 });
	const actual = new Uint8Array(64 * 64).fill(255);
	let outsideInk = 0;
	if (mask) for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
		const ink = mask.data[y * mask.width + x];
		if (!ink) continue;
		const px = x + mask.x, py = y + mask.y;
		if (px < 0 || px >= 64 || py < 0 || py >= 64) { outsideInk++; continue; }
		actual[py * 64 + px] = 255 - ink;
	}
	expect(outsideInk, 'nonzero ink must stay within the native surface').toBe(0);
	const expected = native(c);
	let different = 0;
	for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) different++;
	return different;
}

describe('native GDI+ program-free Courier family geometry', () => {
	const named = read('courier-geometry');
	const renamed = read('courier-geometry-renamed');
	const groups = { named, renamed };
	const fonts = {
		named: new GdiFontCollection([fixture('courier-geometry.ttf')]),
		renamed: new GdiFontCollection([fixture('courier-geometry-renamed.ttf')]),
	};
	const measured = { named: named.map(c => mismatches(fonts.named, c)),
		renamed: renamed.map(c => mismatches(fonts.renamed, c)) };

	it('preserves every per-case ceiling and all 1393 exact full-surface controls', () => {
		for (const key of ['named', 'renamed'] as const) {
			expect(groups[key]).toHaveLength(1600);
			expect(bounds[key]).toHaveLength(1600);
			expect(measured[key].flatMap((v, i) => v > bounds[key][i] ? [i] : [])).toEqual([]);
		}
		expect(measured.named.filter(v => v === 0).length).toBeGreaterThanOrEqual(465);
		expect(measured.renamed.filter(v => v === 0).length).toBeGreaterThanOrEqual(928);
	});

	it('isolates widening by family name on unrelated outlines under both native hints', () => {
		for (let i = 0; i < named.length; i++) {
			expect([named[i].code, named[i].size, named[i].hint, named[i].qx, named[i].qy])
				.toEqual([renamed[i].code, renamed[i].size, renamed[i].hint, renamed[i].qx, renamed[i].qy]);
			expect(Buffer.from(native(named[i])).equals(Buffer.from(native(renamed[i])))).toBe(false);
		}
		for (const captures of Object.values(groups)) {
			const gridfit = captures.filter(c => c.hint === 3);
			const unfitted = captures.filter(c => c.hint === 4);
			for (let i = 0; i < gridfit.length; i++) {
				expect(Buffer.from(native(gridfit[i])).equals(Buffer.from(native(unfitted[i])))).toBe(true);
			}
		}
	});

	// Installed Courier controls do not support widening every grid-fit mask;
	// these unrelated program-free outlines expose additional open scope.
	// Default simple dropouts would improve 464 to 728/800 renamed AntiAlias
	// cases, but worsen 72 earlier polygon controls, so no default changes.
	it('pins rectangles separately from the unresolved curve/dropout coverage', () => {
		for (const key of ['named', 'renamed'] as const) for (let i = 0; i < groups[key].length; i++) {
			const c = groups[key][i];
			if ([68, 82, 97].includes(c.code) && (key === 'renamed' || c.hint === 4)) expect(measured[key][i]).toBe(0);
		}
	});
});
