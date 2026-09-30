import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as UTIF from 'utif';
import { normalizeGroup3 } from './tiff-group3';
import { decodePng } from './png-decoder';

const source = () => new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-tiff-bilevel-ccitt3.bin', import.meta.url))).buffer;
const reference = async () => (await decodePng(new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-tiff-bilevel-ccitt3.png', import.meta.url)))))!;

it('preserves native pixels with least-significant-bit fill order', async () => {
	const buffer = source(), page = UTIF.decode(buffer)[0];
	const bytes = new Uint8Array(buffer), start = Number((page.t273 as number[])[0]), length = Number((page.t279 as number[])[0]);
	for (let i = start; i < start + length; i++) {
		let value = bytes[i], reversed = 0;
		for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
		bytes[i] = reversed;
	}
	page.t266 = [2];
	UTIF.decodeImage(normalizeGroup3(buffer, page), page);
	expect(new Uint8ClampedArray(UTIF.toRGBA8(page))).toEqual((await reference()).data);
});

it('restarts one-dimensional rows independently in each strip', async () => {
	const original = source(), page = UTIF.decode(original)[0];
	const start = Number((page.t273 as number[])[0]), length = Number((page.t279 as number[])[0]);
	const buffer = new Uint8Array(length * 2);
	buffer.set(new Uint8Array(original, start, length)); buffer.set(buffer.subarray(0, length), length);
	page.t273 = [0, length]; page.t279 = [length, length]; page.t257 = [38]; page.t278 = [19];
	UTIF.decodeImage(normalizeGroup3(buffer.buffer, page), page);
	const expected = (await reference()).data;
	const doubled = new Uint8ClampedArray(expected.length * 2); doubled.set(expected); doubled.set(expected, expected.length);
	expect(new Uint8ClampedArray(UTIF.toRGBA8(page))).toEqual(doubled);
});

it('leaves explicit mixed one/two-dimensional strips untouched', () => {
	const buffer = source(), page = UTIF.decode(buffer)[0]; page.t292 = [1];
	expect(normalizeGroup3(buffer, page)).toBe(buffer);
});

it('rejects a strip extending outside the encoded image', () => {
	const buffer = source(), page = UTIF.decode(buffer)[0]; page.t273 = [buffer.byteLength];
	expect(() => normalizeGroup3(buffer, page)).toThrow('Invalid TIFF strip');
});
