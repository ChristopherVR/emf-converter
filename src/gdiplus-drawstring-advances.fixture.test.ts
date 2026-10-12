/** Public native controls; regenerate with scripts/gdi-fixtures/generate-drawstring-advances.ps1. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection, CLEARTYPE_NATURAL_QUALITY } from './gdi-font-engine';
import { handleEmfPlusTextImageRecord } from './emf-plus-text-image-handlers';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { EMFPLUS_DRAWSTRING } from './emf-constants';
import type { EmfPlusReplayCtx } from './emf-types';

interface AdvanceCapture {
	face: string; size: number; typo: boolean; code: number; length: number; driver: boolean;
	width: number; starts: number[]; ends: number[]; columns: number[];
}
interface MixedCapture { face: string; size: number; typo: boolean; text: string; rgba: string }
const load = <T>(name: string): T[] => JSON.parse(gunzipSync(readFileSync(
	new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url),
)).toString());
const advances = load<AdvanceCapture>('text-drawstring-advances');
const mixed = load<MixedCapture>('text-drawstring-mixed');

/** Match a repeated glyph's interior column hashes to its native single-glyph image. */
function positions(capture: AdvanceCapture): number[] {
	const single = advances.find((c) => c.face === capture.face && c.size === capture.size && c.typo === capture.typo &&
		c.code === capture.code && c.driver === capture.driver && c.length === 1)!;
	if (!single.starts.length) return [];
	const left = single.starts[0], right = single.ends.at(-1)!;
	// Keep the central profile: adjacent ClearType edge samples can overlap, even across whole-pixel origins.
	const trim = right - left >= 7 ? 2 : 0;
	const profile = single.columns.slice(left + trim, right - trim);
	const result: number[] = [];
	for (let x = 0; x < capture.columns.length - profile.length; x++) {
		if (profile.every((hash, i) => capture.columns[x + i] === hash)) result.push(x - left - trim);
	}
	return result;
}

describe('native ClearType DrawString run compensation: diagnostic evidence', () => {
	it('records repeat and realized-advance controls independently across five fonts, three sizes and both formats', () => {
		expect(advances).toHaveLength(3240);
		for (const code of [73, 72, 110, 120]) {
			const native = (driver: boolean, typo: boolean): AdvanceCapture => advances.find((c) =>
				c.face === 'Arial' && c.size === 16 && c.code === code && c.length === 40 && c.driver === driver && c.typo === typo)!;
			const driver = positions(native(true, false));
			expect(driver).toHaveLength(40);
			const width = ({ 73: 3, 72: 11, 110: 8, 120: 7 } as Record<number, number>)[code];
			expect(driver).toEqual(Array.from({ length: 40 }, (_, i) => i * width));
			const typographic = positions(native(false, true));
			const defaultFormat = positions(native(false, false));
			expect(typographic).toHaveLength(40);
			expect(defaultFormat).toHaveLength(40);
			const gaps = (p: number[]): number[] => p.slice(1).map((x, i) => x - p[i]);
			if (code === 73) {
				// Contraction can consume an em: ideal width 177.8125, forty 4px advances = 160.
				// Only the remainder past 16px is recovered, at the end of the glyph run.
				expect(gaps(typographic)).toEqual([...Array(37).fill(4), ...Array(2).fill(5)]);
				expect(gaps(defaultFormat)).toEqual([...Array(32).fill(4), ...Array(7).fill(5)]);
			} else if (code === 72) {
				expect(gaps(typographic)).toEqual([...Array(22).fill(12), ...Array(17).fill(11)]);
				expect(gaps(defaultFormat)).toEqual(Array(39).fill(12));
			} else if (code === 110) {
				expect(gaps(typographic)).toEqual([...Array(35).fill(9), ...Array(4).fill(8)]);
				expect(gaps(defaultFormat)).toEqual([...Array(10).fill(10), ...Array(29).fill(9)]);
			} else {
				expect(gaps(typographic)).toEqual(Array(39).fill(8));
				expect(gaps(defaultFormat)).toEqual(Array(39).fill(8));
			}
		}
	});
});

describe.skipIf(!windowsFonts())('native ClearType advance baseline', () => {
	it('preserves every unambiguous DriverString realized-advance origin without substituting DrawString widths', () => {
		const fonts = new GdiFontCollection(windowsFonts()!);
		let compared = 0;
		for (const c of advances.filter((c) => c.driver && c.code !== 32)) {
			const native = positions(c);
			// Ambiguous or overlapping profiles are kept as capture data; never infer positions from them.
			if (native.length !== c.length) continue;
			const font = fonts.realize({ face: c.face, height: -c.size, width: 0, weight: 400, italic: false,
				charSet: 1, pitchAndFamily: 0, quality: CLEARTYPE_NATURAL_QUALITY, gdiPlus: true })!;
			const width = font.advance(font.glyphIndex(c.code));
			expect(native, `${c.face} ${c.size} ${String.fromCharCode(c.code)} ${c.length}`).toEqual(
				Array.from({ length: c.length }, (_, i) => i * width),
			);
			compared++;
		}
		expect(compared).toBe(1136);
	});

	it('pins each of 150 mixed DrawString captures; run correction stays open without relaxing a case', async () => {
		await ensureNodeCanvasModule();
		const fonts = new GdiFontCollection(windowsFonts()!);
		expect(mixed).toHaveLength(150);
		const ceilings = [
			810,165,471,480,724,732,165,468,512,735,1303,336,1022,6,937,1303,336,1013,6,926,
			1623,270,2067,6,1122,1623,270,2067,6,1122,131,59,247,471,12,131,59,210,455,425,
			904,170,500,585,456,904,170,500,687,456,2112,1,3,15,1706,2112,243,3,15,1088,
			1011,220,731,486,728,1010,191,714,560,718,1142,210,620,666,1158,1365,210,649,692,1161,
			2571,319,957,1038,732,2571,390,957,1038,732,832,198,549,408,471,832,198,549,408,546,
			1268,284,964,6,865,1268,284,953,6,852,2242,389,1151,906,1059,2242,389,1151,906,1059,
			1030,253,788,597,669,1014,237,750,583,658,1084,247,827,573,675,1122,238,863,669,699,
			2095,439,1603,1209,1340,2072,427,1582,1111,1292,
		];
		for (const [index, c] of mixed.entries()) {
			const canvas = createCanvas(600, 80), ctx = canvas.getContext('2d');
			ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 600, 80);
			const view = new DataView(new ArrayBuffer(28 + c.text.length * 2));
			view.setUint32(0, 0xff000000, true); view.setUint32(4, 1, true); view.setUint32(8, c.text.length, true);
			view.setFloat32(12, 8, true); view.setFloat32(16, 8, true);
			view.setFloat32(20, 2000, true); view.setFloat32(24, 2000, true);
			for (let i = 0; i < c.text.length; i++) view.setUint16(28 + 2 * i, c.text.charCodeAt(i), true);
			const rCtx: EmfPlusReplayCtx = {
				ctx: ctx as unknown as CanvasRenderingContext2D, view,
				objectTable: new Map([
					[0, { kind: 'plus-font', family: c.face, emSize: c.size, flags: 0, unit: 2 }],
					[1, { kind: 'plus-stringformat', flags: c.typo ? 0x6004 : 0, alignment: 0, lineAlignment: 0,
						leadingMargin: c.typo ? 0 : 1 / 6, trailingMargin: c.typo ? 0 : 1 / 6, tracking: c.typo ? 1 : 1.03 }],
				]),
				worldTransform: [1,0,0,1,0,0], deferredImages: [], saveStack: [], saveIdMap: new Map(),
				totalImageObjects: 0, totalDrawImageCalls: 0, clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1,
				continuationBuffer: null, continuationObjectId: 0, continuationObjectType: 0, continuationTotalSize: 0,
				continuationOffset: 0, fonts, textRenderingHint: 5, ext: { textContrast: 0 },
			};
			expect(handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWSTRING, 0x8000, 0, view.byteLength)).toBe(true);
			const actual = ctx.getImageData(0, 0, 600, 80).data, native = Buffer.from(c.rgba, 'base64');
			let different = 0;
			for (let i = 0; i < actual.length; i += 4) {
				if (actual[i] !== native[i] || actual[i + 1] !== native[i + 1] || actual[i + 2] !== native[i + 2] ||
					actual[i + 3] !== native[i + 3]) different++;
			}
			expect(different, `${c.face} ${c.size} ${c.typo ? 'typographic' : 'default'} ${c.text}`).toBeLessThanOrEqual(ceilings[index]);
		}
	});
});
