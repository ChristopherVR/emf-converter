import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as UTIF from 'utif';
import { decodeJpegTiff } from './tiff-jpeg';

const fixture = () => {
	const bytes = new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/codec-tiff-jpeg-rgb-strips.bin', import.meta.url)));
	return { bytes, page: UTIF.decode(bytes.slice().buffer)[0] };
};

it('rejects JPEG strips outside the encoded TIFF', () => {
	const { bytes, page } = fixture(); page.t273 = [bytes.length];
	expect(() => decodeJpegTiff(bytes, page)).toThrow('Invalid TIFF JPEG data');
});
it('rejects JPEG strip dimensions that disagree with the TIFF directory', () => {
	const { bytes, page } = fixture(); page.t256 = [38];
	expect(() => decodeJpegTiff(bytes, page)).toThrow('Invalid TIFF JPEG dimensions');
});
it('rejects missing tiles and invalid tile sizes', () => {
	const { bytes, page } = fixture(); page.t322 = [16]; page.t323 = [16]; page.t324 = [8]; page.t325 = [10];
	expect(() => decodeJpegTiff(bytes, page)).toThrow('Invalid TIFF JPEG offsets');
	page.t322 = [0];
	expect(() => decodeJpegTiff(bytes, page)).toThrow('Invalid TIFF JPEG block');
});
it('leaves unsupported sample formats to the general TIFF decoder', () => {
	const { bytes, page } = fixture(); page.t258 = [16, 16, 16];
	expect(decodeJpegTiff(bytes, page)).toBeNull();
});
