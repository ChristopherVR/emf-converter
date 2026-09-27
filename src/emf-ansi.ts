/** Windows-1252 mapping used by the EMF/WMF ANSI text records. */
const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
	0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** Decodes one ANSI byte for the selected LOGFONT charset (unknown ANSI pages fall back to Windows-1252). */
export function ansiToCode(b: number, charSet: number): number {
	return charSet === 2 ? b : b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
}

const CHARSET_ENCODING: Record<number, string> = {
	0: 'windows-1252', 1: 'windows-1252', 128: 'shift_jis', 129: 'euc-kr', 130: 'johab', 134: 'gbk', 136: 'big5',
	161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256',
	186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250', 255: 'ibm437',
};

/**
 * Decodes ANSI bytes to UTF-16 units for the shared wide-text handler.
 * Byte counts keep explicit advances aligned after multibyte decoding.
 * Encodings unavailable in the host's TextDecoder fall back to Windows-1252.
 */
export function decodeAnsiRecord(bytes: readonly number[], charSet: number): { codes: number[]; byteLengths: number[] } {
	if (charSet === 2) {
		return { codes: [...bytes], byteLengths: bytes.map(() => 1) };
	}
	const label = CHARSET_ENCODING[charSet] ?? 'windows-1252';
	try {
		const decoder = new TextDecoder(label, { fatal: true });
		const replacementDecoder = new TextDecoder(label);
		const source = new Uint8Array(bytes);
		const codes: number[] = [];
		const byteLengths: number[] = [];
		let i = 0;
		while (i < bytes.length) {
			let decoded: string | null = null;
			let consumed = 1;
			for (let n = 1; n <= Math.min(4, bytes.length - i); n++) {
				try {
					const candidate = decoder.decode(source.subarray(i, i + n));
					if (candidate.length > 0) {
						decoded = candidate;
						consumed = n;
						break;
					}
				} catch {
					// The next byte may complete a multibyte character.
				}
			}
			if (decoded === null) {
				decoded = replacementDecoder.decode(source.subarray(i, i + 1));
			}
			for (let j = 0; j < decoded.length; j++) {
				codes.push(decoded.charCodeAt(j));
				// Keep a multi-unit character at one origin, then advance.
				byteLengths.push(j === decoded.length - 1 ? consumed : 0);
			}
			i += consumed;
		}
		return { codes, byteLengths };
	} catch {
		return { codes: bytes.map((b) => ansiToCode(b, charSet)), byteLengths: bytes.map(() => 1) };
	}
}
