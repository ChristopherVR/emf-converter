import { describe, expect, it, vi } from 'vitest';
import { decodeAnsiRecord } from './emf-ansi';

describe('ANSI record decoding', () => {
	it.each([0, 1])('uses a known device code page for charset %s without changing the default', (charset) => {
		const bytes = [0x41, 0xd6, 0xd0, 0xce, 0xc4, 0x42]; // A中文B, Windows code page 936
		expect(decodeAnsiRecord(bytes, charset)).toEqual({ codes: [0x41, 0xd6, 0xd0, 0xce, 0xc4, 0x42], byteLengths: [1, 1, 1, 1, 1, 1] });
		expect(decodeAnsiRecord(bytes, charset, 936)).toEqual({ codes: [0x41, 0x4e2d, 0x6587, 0x42], byteLengths: [1, 2, 2, 1] });
	});
	it('keeps an explicit charset and Symbol decoding independent of the device code page', () => {
		expect(decodeAnsiRecord([0x82, 0xa0], 128, 936)).toEqual({ codes: [0x3042], byteLengths: [2] });
		expect(decodeAnsiRecord([0xd6, 0xd0], 134, 1252)).toEqual({ codes: [0x4e2d], byteLengths: [2] });
		expect(decodeAnsiRecord([0xd6, 0xd0], 2, 936)).toEqual({ codes: [0xd6, 0xd0], byteLengths: [1, 1] });
	});
	it('supports UTF-8 surrogate pairs without losing source byte advances', () => {
		expect(decodeAnsiRecord([0x41, 0xf0, 0x9f, 0x98, 0x80, 0x42], 1, 65001)).toEqual({ codes: [0x41, 0xd83d, 0xde00, 0x42], byteLengths: [1, 0, 4, 1] });
	});
	it('preserves a UTF-8 BOM as an authored character and keeps its byte advance', () => {
		expect(decodeAnsiRecord([0xef, 0xbb, 0xbf, 0x41], 1, 65001)).toEqual({ codes: [0xfeff, 0x41], byteLengths: [3, 1] });
	});
	it('keeps the next ASCII character after invalid or truncated device-code-page bytes', () => {
		expect(decodeAnsiRecord([0xd6, 0x20, 0x41, 0xd6], 0, 936)).toEqual({ codes: [0xfffd, 0x20, 0x41, 0xfffd], byteLengths: [1, 1, 1, 1] });
	});
	it.each([0, -1, 999, NaN, Infinity])('falls back to the original ANSI page for unsupported device page %s', (page) => {
		expect(decodeAnsiRecord([0x80, 0xd6, 0xd0], 1, page)).toEqual({ codes: [0x20ac, 0xd6, 0xd0], byteLengths: [1, 1, 1] });
	});
	it('keeps Windows-1252 punctuation without a host TextDecoder', () => {
		vi.stubGlobal('TextDecoder', undefined);
		try {
			expect(decodeAnsiRecord([0x80, 0x93, 0x94], 0, 1252)).toEqual({ codes: [0x20ac, 0x201c, 0x201d], byteLengths: [1, 1, 1] });
		} finally { vi.unstubAllGlobals(); }
	});
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

	describe('charset coverage (measured from Windows)', () => {
		it('decodes ANSI charset (0) with Windows-1252 code page', () => {
			expect(decodeAnsiRecord([0x41, 0x80, 0xBE], 0)).toEqual({
				codes: [0x0041, 0x20AC, 0x00BE], byteLengths: [1, 1, 1],
			});
		});
		it('decodes DEFAULT charset (1) with Windows-1252 code page', () => {
			expect(decodeAnsiRecord([0x42, 0x8D, 0x8F], 1)).toEqual({
				codes: [0x0042, 0x008D, 0x008F], byteLengths: [1, 1, 1],
			});
		});
		it('decodes MAC charset (77) with Macintosh code page', () => {
			expect(decodeAnsiRecord([0x41, 0x80, 0xD0], 77)).toEqual({
				codes: [0x0041, 0x00C4, 0x2013], byteLengths: [1, 1, 1],
			});
		});
		it('decodes SHIFTJIS charset (128)', () => {
			expect(decodeAnsiRecord([0x41, 0x82, 0xA0], 128)).toEqual({
				codes: [0x0041, 0x3042], byteLengths: [1, 2],
			});
		});
		it('decodes HANGUL charset (129)', () => {
			expect(decodeAnsiRecord([0x41, 0xB0, 0xA1], 129)).toEqual({
				codes: [0x0041, 0xAC00], byteLengths: [1, 2],
			});
		});
		it('decodes JOHAB charset (130)', () => {
			expect(decodeAnsiRecord([0x41, 0x88, 0x41], 130)).toEqual({
				codes: [0x0041, 0x1100], byteLengths: [1, 2],
			});
		});
		it('decodes GB2312 charset (134)', () => {
			expect(decodeAnsiRecord([0x41, 0xBA, 0xBA], 134)).toEqual({
				codes: [0x0041, 0x6C49], byteLengths: [1, 2],
			});
		});
		it('decodes CHINESEBIG5 charset (136)', () => {
			expect(decodeAnsiRecord([0x41, 0xA4, 0xE5], 136)).toEqual({
				codes: [0x0041, 0x6587], byteLengths: [1, 2],
			});
		});
		it('decodes GREEK charset (161)', () => {
			expect(decodeAnsiRecord([0x41, 0xFC], 161)).toEqual({
				codes: [0x0041, 0x03CC], byteLengths: [1, 1],
			});
		});
		it('decodes TURKISH charset (162)', () => {
			expect(decodeAnsiRecord([0x41, 0xD0], 162)).toEqual({
				codes: [0x0041, 0x011E], byteLengths: [1, 1],
			});
		});
		it('decodes VIETNAMESE charset (163)', () => {
			expect(decodeAnsiRecord([0x41, 0x80], 163)).toEqual({
				codes: [0x0041, 0x20AC], byteLengths: [1, 1],
			});
		});
		it('decodes HEBREW charset (177)', () => {
			expect(decodeAnsiRecord([0x41, 0x80], 177)).toEqual({
				codes: [0x0041, 0x20AC], byteLengths: [1, 1],
			});
		});
		it('decodes ARABIC charset (178)', () => {
			expect(decodeAnsiRecord([0x41, 0x80], 178)).toEqual({
				codes: [0x0041, 0x20AC], byteLengths: [1, 1],
			});
		});
		it('decodes BALTIC charset (186)', () => {
			expect(decodeAnsiRecord([0x41, 0x80], 186)).toEqual({
				codes: [0x0041, 0x20AC], byteLengths: [1, 1],
			});
		});
		it('decodes RUSSIAN charset (204)', () => {
			expect(decodeAnsiRecord([0x41, 0xC0], 204)).toEqual({
				codes: [0x0041, 0x0410], byteLengths: [1, 1],
			});
		});
		it('decodes THAI charset (222)', () => {
			expect(decodeAnsiRecord([0x41, 0xA0], 222)).toEqual({
				codes: [0x0041, 0x00A0], byteLengths: [1, 1],
			});
		});
		it('decodes EASTEUROPE charset (238)', () => {
			expect(decodeAnsiRecord([0x41, 0x80], 238)).toEqual({
				codes: [0x0041, 0x20AC], byteLengths: [1, 1],
			});
		});
		it('decodes OEM charset (255) with custom table', () => {
			expect(decodeAnsiRecord([0x41, 0xC7, 0xC4], 255)).toEqual({
				codes: [0x0041, 0x255F, 0x2500], byteLengths: [1, 1, 1],
			});
		});
		it('falls back to Windows-1252 for unknown charset values', () => {
			expect(decodeAnsiRecord([0x41, 0x80], 999)).toEqual({
				codes: [0x0041, 0x20AC], byteLengths: [1, 1],
			});
		});
	});
});
