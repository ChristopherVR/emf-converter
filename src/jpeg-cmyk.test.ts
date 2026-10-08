import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { cmykInputCurve, cmykPlanesToRgba, cmykRgb16, cmykRgb16At } from './jpeg-cmyk';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url)));
const words = (name: string): Uint16Array => {
	const bytes = fixture(name);
	return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
};

// icm-cmyk-samples.bin: 8,000 random ink combinations (C, M, Y, K bytes) followed by the sRGB bytes that Windows ICM
// (mscms.dll TranslateBitmapBits, RSWOP.icm to sRGB, perceptual, best mode) returns for them; GDI+ draws CMYK JPEG
// with the same result. They were not used to solve the table (see scripts/gdi-fixtures/generate-cmyk-lut.ts).
it('converts CMYK like the Windows ICM transform GDI+ uses', () => {
	const data = fixture('icm-cmyk-samples.bin');
	const count = data.length / 7;
	const planes = [0, 1, 2, 3].map(() => new Uint8Array(count));
	for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) planes[c][i] = 255 - data[i * 7 + c];
	const rgba = cmykPlanesToRgba(planes, count, 1, false);
	let exact = 0;
	let max = 0;
	for (let i = 0; i < count; i++) {
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(rgba[i * 4 + c] - data[i * 7 + 4 + c]);
			if (d === 0) exact++;
			max = Math.max(max, d);
		}
	}
	expect(count).toBe(8000);
	// 99.79% of 24,000 channel values; the converter before the input-curve position map matched 23,824 (99.27%).
	expect(exact).toBe(23951);
	expect(max).toBeLessThanOrEqual(1);
});

// icm-cmyk-samples16.bin: the same inks with the 16-bit colour of BM_16b_RGB (little-endian R, G, B words; the 8-bit
// result above is its top byte for all but 17 of the 24,000 values, always where the 16-bit word ends in 0x00 or 0xff).
it('reproduces the 16-bit colours of the Windows ICM transform to within a level or two', () => {
	const data = fixture('icm-cmyk-samples16.bin');
	const count = data.length / 10;
	const eight = fixture('icm-cmyk-samples.bin');
	let squares = 0;
	let within1 = 0;
	let within2 = 0;
	let top = 0;
	let captureDisagrees = 0;
	let worst = 0;
	for (let i = 0; i < count; i++) {
		const colour = cmykRgb16(data[i * 10], data[i * 10 + 1], data[i * 10 + 2], data[i * 10 + 3]);
		for (let c = 0; c < 3; c++) {
			const captured = data[i * 10 + 4 + c * 2] | (data[i * 10 + 5 + c * 2] << 8);
			const clamped = Math.max(0, Math.min(65535, colour[c]));
			const d = Math.abs(clamped - captured);
			squares += d * d;
			worst = Math.max(worst, d);
			if (d <= 1) within1++;
			if (d <= 2) within2++;
			if (Math.floor(clamped / 256) === captured >> 8) top++;
			if (captured >> 8 !== eight[i * 7 + 4 + c]) {
				captureDisagrees++;
				expect([0, 255]).toContain(captured & 255);
			}
		}
	}
	expect(count).toBe(8000);
	expect(captureDisagrees).toBe(17);
	expect(top).toBe(23954);
	expect(within1).toBe(19333);
	expect(within2).toBe(23816);
	expect(worst).toBeLessThan(3.5);
	expect(Math.sqrt(squares / (count * 3))).toBeLessThan(0.8);
});

// icm-cmyk-translate16.bin: TranslateColors with 16-bit CMYK words (seven words a record: C, M, Y, K in, R, G, B out).
// The first 2,000 records feed the inks of the samples above as 257 v; Windows returns the very same 16-bit colours as the
// 8-bit path, so the 8-bit path is the 16-bit one at 257 v. The other 2,000 are random words: a word is mapped through the
// input table at index word / 257 with linear interpolation between entries (reading the high byte and an 8-bit fraction
// instead puts the nodes 17 table units apart and misses by 130 levels).
it('maps 16-bit CMYK words through the input curve at index word / 257', () => {
	const records = words('icm-cmyk-translate16.bin');
	const samples = fixture('icm-cmyk-samples16.bin');
	expect(records.length / 7).toBe(4000);
	let same = 0;
	for (let i = 0; i < 2000; i++) {
		for (let c = 0; c < 4; c++) expect(records[i * 7 + c]).toBe(samples[i * 10 + c] * 257);
		for (let c = 0; c < 3; c++) if (records[i * 7 + 4 + c] === (samples[i * 10 + 4 + c * 2] | (samples[i * 10 + 5 + c * 2] << 8))) same++;
	}
	expect(same).toBe(6000);
	const position = (word: number): number => {
		const index = word / 257;
		const k = Math.min(254, Math.floor(index));
		return cmykInputCurve(k) + (cmykInputCurve(k + 1) - cmykInputCurve(k)) * (index - k);
	};
	let unclipped = 0;
	let squares = 0;
	let within4 = 0;
	for (let i = 2000; i < 4000; i++) {
		const colour = cmykRgb16At(position(records[i * 7]), position(records[i * 7 + 1]), position(records[i * 7 + 2]), position(records[i * 7 + 3]));
		for (let c = 0; c < 3; c++) {
			const captured = records[i * 7 + 4 + c];
			if (captured === 0 || captured === 65535) continue;
			unclipped++;
			const d = Math.abs(colour[c] - captured);
			squares += d * d;
			if (d <= 4) within4++;
		}
	}
	expect(unclipped).toBe(5979);
	expect(within4).toBe(5976);
	expect(Math.sqrt(squares / unclipped)).toBeLessThan(1);
});

// The profile's own input table (identical for the four inks; read from RSWOP.icm by `generate-cmyk-lut.ts curve`).
it('places an ink on the grid by the input table of the profile', () => {
	expect([0, 1, 2, 3, 224, 225, 226, 227, 228, 254, 255].map(cmykInputCurve)).toEqual([0, 255, 511, 767, 57343, 57607, 57871, 58135, 58400, 65270, 65535]);
	for (let v = 1; v <= 224; v++) expect(cmykInputCurve(v)).toBe(256 * v - 1);
	for (let v = 225; v <= 255; v++) expect([264, 265]).toContain(cmykInputCurve(v) - cmykInputCurve(v - 1));
	// Node j of the grid is at 4369 j, so the last ink value lands exactly on the last node.
	expect(cmykInputCurve(255)).toBe(15 * 4369);
});
