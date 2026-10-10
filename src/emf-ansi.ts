import { JOHAB_ROWS, OEM437_HIGH, OEM_HIGH } from './emf-ansi-tables';
import type { TextCodePages } from './emf-types';

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
	0: 'windows-1252', 1: 'windows-1252', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 130: 'johab', 134: 'gbk', 136: 'big5',
	161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256',
	186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250', 255: 'ibm437',
};

/** Code pages accepted as the playback device's ANSI code page. */
const ANSI_CODE_PAGE_ENCODING: Record<number, string> = {
	874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
	1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
	1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
	1258: 'windows-1258', 54936: 'gb18030', 65001: 'utf-8',
};

/**
 * Multibyte OEM code pages, decoded through TextDecoder. On East Asian and
 * Thai systems the OEM code page is the ANSI one; the single-byte OEM pages
 * use the bundled tables of `emf-ansi-tables.ts`.
 */
const OEM_CODE_PAGE_ENCODING: Record<number, string> = {
	874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
};

/** Decodes single-byte OEM text with a 128-character high-half table. */
function decodeOemTable(bytes: readonly number[], high: string): { codes: number[]; byteLengths: number[] } {
	return { codes: bytes.map((b) => b < 128 ? b : high.charCodeAt(b - 128)), byteLengths: bytes.map(() => 1) };
}

/**
 * Decodes ANSI bytes to UTF-16 units for the shared wide-text handler.
 * Byte counts keep explicit advances aligned after multibyte decoding.
 * `codePages` are the playback device's system code pages: ANSI/DEFAULT
 * text uses its ANSI page and OEM text its OEM page (unsupported values
 * fall back to 1252 and 437). Encodings unavailable in the host's
 * TextDecoder fall back to Windows-1252.
 */
export function decodeAnsiRecord(bytes: readonly number[], charSet: number, codePages?: TextCodePages): { codes: number[]; byteLengths: number[] } {
	if (charSet === 2) {
		return { codes: [...bytes], byteLengths: bytes.map(() => 1) };
	}
	const oemCodePage = codePages?.oem;
	if (charSet === 255 && (oemCodePage === undefined || !(oemCodePage in OEM_CODE_PAGE_ENCODING))) {
		return decodeOemTable(bytes, (oemCodePage !== undefined ? OEM_HIGH[oemCodePage] : undefined) ?? OEM437_HIGH);
	}
	if (charSet === 130) {
		const codes: number[] = [];
		const byteLengths: number[] = [];
		for (let i = 0; i < bytes.length; i++) {
			const lead = bytes[i];
			const row = JOHAB_ROWS[lead];
			const code = row && i + 1 < bytes.length ? row.charCodeAt(bytes[i + 1]) : 0xfffd;
			const count = lead < 128 || code === 0xfffd ? 1 : 2;
			codes.push(lead < 128 ? lead : code);
			byteLengths.push(count);
			i += count - 1;
		}
		return { codes, byteLengths };
	}
	const ansiCodePage = codePages?.ansi;
	const label = charSet === 255 && oemCodePage !== undefined
		? OEM_CODE_PAGE_ENCODING[oemCodePage]
		: (charSet === 0 || charSet === 1) && ansiCodePage !== undefined
			? ANSI_CODE_PAGE_ENCODING[ansiCodePage] ?? 'windows-1252'
			: CHARSET_ENCODING[charSet] ?? 'windows-1252';
	if (label === 'windows-1252') {
		// Use GDI's mapping directly: some Node TextDecoder backends resolve
		// this label as Latin-1, which would leave the Euro byte as U+0080.
		return { codes: bytes.map((b) => ansiToCode(b, charSet)), byteLengths: bytes.map(() => 1) };
	}
	try {
		const decoder = new TextDecoder(label, { fatal: true, ignoreBOM: true });
		const replacementDecoder = new TextDecoder(label, { ignoreBOM: true });
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
