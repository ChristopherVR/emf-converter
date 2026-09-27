import { describe, expect, it } from 'vitest';
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
});
