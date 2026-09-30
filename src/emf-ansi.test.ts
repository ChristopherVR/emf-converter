import { describe, expect, it, vi } from 'vitest';
import { decodeAnsiRecord } from './emf-ansi';

describe('ANSI record decoding', () => {
	it('tracks source bytes for a mixed Shift-JIS string', () => {
		expect(decodeAnsiRecord([0x41, 0x82, 0xa0, 0x42], 128)).toEqual({
			codes: [0x41, 0x3042, 0x42], byteLengths: [1, 2, 1],
		});
	});
	it('preserves the following character after an invalid multibyte sequence', () => {
		expect(decodeAnsiRecord([0x82, 0x20, 0x41], 128)).toEqual({
			codes: [0xfffd, 0x20, 0x41], byteLengths: [1, 1, 1],
		});
	});
	it('keeps symbol bytes as font-specific character codes', () => {
		expect(decodeAnsiRecord([0x80, 0x41], 2)).toEqual({ codes: [0x80, 0x41], byteLengths: [1, 1] });
	});
	it('decodes OEM box drawing and accented text without TextDecoder', () => {
		vi.stubGlobal('TextDecoder', undefined);
		try {
			expect(decodeAnsiRecord([0x41, 0x80, 0x81, 0xb3, 0xc4, 0xdb], 255)).toEqual({
				codes: [0x41, 0xc7, 0xfc, 0x2502, 0x2500, 0x2588], byteLengths: [1, 1, 1, 1, 1, 1],
			});
		} finally { vi.unstubAllGlobals(); }
	});
	it('decodes Johab syllables and keeps explicit byte advances aligned', () => {
		expect(decodeAnsiRecord([0x41, 0x88, 0x61, 0xd3, 0xbd, 0x42], 130)).toEqual({
			codes: [0x41, 0xac00, 0xd7a3, 0x42], byteLengths: [1, 2, 2, 1],
		});
	});
	it('recovers after invalid or truncated Johab without consuming following ASCII', () => {
		expect(decodeAnsiRecord([0x88, 0x20, 0x41, 0x88], 130)).toEqual({
			codes: [0xfffd, 0x20, 0x41, 0xfffd], byteLengths: [1, 1, 1, 1],
		});
	});
});
