import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { cmykColour16, cmykInputCurve, cmykInputPositions, cmykPlanesToRgba } from './jpeg-cmyk';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url)));

/** Converts ink samples (C, M, Y, K bytes, 7 bytes a record with the native R, G, B after them) and counts wrong channels. */
function mismatches(data: Uint8Array, count: number, stride: number): number {
	const planes = [0, 1, 2, 3].map(() => new Uint8Array(count));
	for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) planes[c][i] = 255 - data[i * stride + c];
	const rgba = cmykPlanesToRgba(planes, count, 1, false);
	let wrong = 0;
	for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) if (rgba[i * 4 + c] !== data[i * stride + 4 + c]) wrong++;
	return wrong;
}

// icm-cmyk-samples.bin: 8,000 random ink combinations (C, M, Y, K bytes) followed by the sRGB bytes that Windows ICM
// (mscms.dll TranslateBitmapBits, RSWOP.icm to sRGB, perceptual, best mode) returns for them; GDI+ draws CMYK JPEG
// with the same result. The node table was not refined against them (they are a separate capture from the sets it used).
it('converts CMYK like the Windows ICM transform GDI+ uses', () => {
	const data = fixture('icm-cmyk-samples.bin');
	expect(data.length / 7).toBe(8000);
	expect(mismatches(data, 8000, 7)).toBe(0);
});

// icm-cmyk-val.bin.gz: 30,000 further random combinations from a set that was only ever used to measure. The old fitted table
// was wrong in 0.26% of the channel values; the table read from the module's own nodes is wrong in about one in a million.
it('converts held-out random CMYK exactly', () => {
	const data = new Uint8Array(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/icm-cmyk-val.bin.gz', import.meta.url))));
	expect(data.length / 7).toBe(30000);
	expect(mismatches(data, 30000, 7)).toBe(0);
});

// Inks that the 16-bit node table plus one got one level wrong: icm-cmyk-fit8.bin.gz (920 inks, the first set the 8-bit node
// corrections were solved against) and icm-cmyk-heldout8.bin.gz (450 inks from 128 million other random inks). Records are C, M,
// Y, K and the native R, G, B (TranslateBitmapBits). The corrections are exact for every one of the 2^32 inks (an exhaustive
// sweep, scripts/gdi-fixtures/cmyk-8bit-nodes.ts), so these must all be right.
it('converts the inks the uncorrected node table missed', () => {
	const read = (name: string): Uint8Array => new Uint8Array(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url))));
	const fit = read('icm-cmyk-fit8.bin.gz');
	const held = read('icm-cmyk-heldout8.bin.gz');
	expect(fit.length / 7).toBe(920);
	expect(held.length / 7).toBe(450);
	expect(mismatches(fit, 920, 7)).toBe(0);
	expect(mismatches(held, 450, 7)).toBe(0);
});

// The ink position: a 16-bit word w lands at x = w - (w >> 8) - 2 (not below 0) on a table of the profile curve cut into 16
// steps per entry, with the weight r / 15 between steps (r = x & 15): 15 k + r in 1/4096 cell for k = x >> 4 (the
// grid is 15 cells of 4096). The 8-bit ink v is the word 257 v.
it('places an 8-bit ink where the module puts the word 257 v', () => {
	for (let v = 1; v <= 224; v++) expect(cmykInputPositions[v]).toBe(240 * v - 1);
	expect(Array.from(cmykInputPositions.slice(224, 232))).toEqual([53759, 54006, 54254, 54501, 54750, 54997, 55245, 55492]);
	expect([cmykInputPositions[0], cmykInputPositions[254]]).toEqual([0, 61190]);
	expect(cmykInputPositions[255]).toBe(15 * 4096);
	for (let v = 1; v < 255; v++) expect(cmykInputPositions[v]).toBeGreaterThan(cmykInputPositions[v - 1]);
	const wordPosition = (w: number): number => {
		const x = Math.max(w - (w >> 8) - 2, 0);
		return 15 * (x >> 4) + (x & 15);
	};
	for (let v = 1; v <= 224; v++) expect(wordPosition(257 * v)).toBe(cmykInputPositions[v]);
});

// icm-cmyk-samples16.bin: the same inks with the 16-bit colour of BM_16b_RGB (little-endian R, G, B words; the 8-bit
// result above is the interpolated node value plus one, over 256, not the top byte of this).
it('reproduces the 16-bit colours of the Windows ICM transform through its output table', () => {
	const data = fixture('icm-cmyk-samples16.bin');
	const count = data.length / 10;
	let exact = 0;
	let worst = 0;
	for (let i = 0; i < count; i++) {
		const colour = cmykColour16([0, 1, 2, 3].map(c => cmykInputPositions[data[i * 10 + c]]));
		for (let c = 0; c < 3; c++) {
			const captured = data[i * 10 + 4 + c * 2] | (data[i * 10 + 5 + c * 2] << 8);
			if (colour[c] === captured) exact++;
			worst = Math.max(worst, Math.abs(colour[c] - captured));
		}
	}
	expect(count).toBe(8000);
	expect(exact).toBe(23794);
	expect(worst).toBeLessThanOrEqual(3);
});

// icm-cmyk-translate16.bin: TranslateColors with 16-bit CMYK words (seven words a record: C, M, Y, K in, R, G, B out).
// The first 2,000 records feed 257 v; the other 2,000 are random words. Every record whose words all sit below grid cell 13
// is reproduced exactly by the word map of the test above.
it('maps 16-bit CMYK words as x = w - (w >> 8) - 2 below grid cell 13', () => {
	const bytes = fixture('icm-cmyk-translate16.bin');
	const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
	let records = 0;
	let wrong = 0;
	for (let i = 2000; i < 4000; i++) {
		const positions = [0, 1, 2, 3].map(c => {
			const x = Math.max(words[i * 7 + c] - (words[i * 7 + c] >> 8) - 2, 0);
			return 15 * (x >> 4) + (x & 15);
		});
		if (positions.some(p => p >= 13 * 4096)) continue;
		records++;
		const colour = cmykColour16(positions);
		for (let c = 0; c < 3; c++) if (colour[c] !== words[i * 7 + 4 + c]) wrong++;
	}
	expect(records).toBe(1160);
	expect(wrong).toBe(0);
});

// The profile's own input table (identical for the four inks; read from RSWOP.icm by `generate-cmyk-lut.ts curve`).
it('places an ink on the grid by the input table of the profile', () => {
	expect([0, 1, 2, 3, 224, 225, 226, 227, 228, 254, 255].map(cmykInputCurve)).toEqual([0, 255, 511, 767, 57343, 57607, 57871, 58135, 58400, 65270, 65535]);
	for (let v = 1; v <= 224; v++) expect(cmykInputCurve(v)).toBe(256 * v - 1);
	for (let v = 225; v <= 255; v++) expect([264, 265]).toContain(cmykInputCurve(v) - cmykInputCurve(v - 1));
});
