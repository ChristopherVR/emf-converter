/**
 * A minimal PDF 1.7 file writer: numbered objects, (optionally Flate
 * compressed) streams, and the cross-reference table / trailer with exact
 * byte offsets. It knows nothing about drawing; `pdf-svg.ts` builds the
 * page content and resources on top of it.
 *
 * @module pdf-writer
 */

import { zlibDeflate } from './png-encoder';

/** Encodes a string of code points 0..255 as bytes (PDF syntax is ASCII/Latin-1). */
export function latin1Bytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		out[i] = s.charCodeAt(i) & 0xff;
	}
	return out;
}

/** Formats a number for PDF: plain decimal (never an exponent), at most 6 decimals, no trailing zeros. */
export function num(n: number): string {
	if (!Number.isFinite(n)) {
		return '0';
	}
	const r = Math.round(n * 1e6) / 1e6;
	if (r === 0) {
		return '0';
	}
	if (Number.isInteger(r)) {
		return String(r);
	}
	return r.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** A PDF text string (UTF-16BE with byte-order mark, as a hex string) for document metadata. */
export function pdfTextString(text: string): string {
	let hex = 'FEFF';
	for (let i = 0; i < text.length; i++) {
		hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
	}
	return `<${hex}>`;
}

/** A PDF name object (`/Name`), escaping every byte outside the regular printable range. */
export function pdfName(name: string): string {
	let out = '/';
	for (const ch of name) {
		const c = ch.charCodeAt(0);
		out += c > 0x20 && c < 0x7f && !'()<>[]{}/%#'.includes(ch) ? ch : `#${(c & 0xff).toString(16).padStart(2, '0')}`;
	}
	return out;
}

type Body = { kind: 'raw'; bytes: Uint8Array } | { kind: 'stream'; dict: string; data: Uint8Array; compress: boolean };

/** An in-memory PDF document under construction. */
export class PdfWriter {
	private readonly objects: Array<Body | null> = [null];

	/** Allocates an object number to be filled later with {@link set} / {@link setStream}. */
	reserve(): number {
		this.objects.push(null);
		return this.objects.length - 1;
	}

	/** Defines a non-stream object: `body` is the object's PDF syntax (a dictionary, array, number...). */
	set(objNum: number, body: string): void {
		this.objects[objNum] = { kind: 'raw', bytes: latin1Bytes(body) };
	}

	/** Adds a non-stream object and returns its number. */
	add(body: string): number {
		const n = this.reserve();
		this.set(n, body);
		return n;
	}

	/**
	 * Defines a stream object. `dict` holds the dictionary entries WITHOUT the
	 * surrounding `<< >>` and without `/Length` / `/Filter`. With `compress`,
	 * the data is deflated when the document is serialised (and left raw if
	 * that does not make it smaller or no compressor is available).
	 */
	setStream(objNum: number, dict: string, data: Uint8Array, compress = true): void {
		this.objects[objNum] = { kind: 'stream', dict, data, compress };
	}

	/** Adds a stream object and returns its number. */
	addStream(dict: string, data: Uint8Array, compress = true): number {
		const n = this.reserve();
		this.setStream(n, dict, data, compress);
		return n;
	}

	/** Number of objects defined so far (not counting the free entry 0). */
	get count(): number {
		return this.objects.length - 1;
	}

	/**
	 * Serialises the file. `root` is the catalog's object number, `info` the
	 * optional document-information dictionary's.
	 */
	async finish(root: number, info?: number): Promise<Uint8Array> {
		const chunks: Uint8Array[] = [];
		const offsets: number[] = [0];
		let pos = 0;
		const push = (b: Uint8Array): void => {
			chunks.push(b);
			pos += b.length;
		};
		// The binary comment tells transfer tools the file is not text.
		push(Uint8Array.from([...latin1Bytes('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
		for (let n = 1; n < this.objects.length; n++) {
			const body = this.objects[n] ?? { kind: 'raw' as const, bytes: latin1Bytes('null') };
			offsets[n] = pos;
			push(latin1Bytes(`${n} 0 obj\n`));
			if (body.kind === 'raw') {
				push(body.bytes);
			} else {
				let data = body.data;
				let filter = '';
				if (body.compress && data.length > 0) {
					const packed = await zlibDeflate(data);
					if (packed.length < data.length) {
						data = packed;
						filter = '/Filter /FlateDecode ';
					}
				}
				push(latin1Bytes(`<< ${body.dict} ${filter}/Length ${data.length} >>\nstream\n`));
				push(data);
				push(latin1Bytes('\nendstream'));
			}
			push(latin1Bytes('\nendobj\n'));
		}
		const xrefPos = pos;
		const size = this.objects.length;
		const rows: string[] = ['xref', `0 ${size}`, '0000000000 65535 f '];
		for (let n = 1; n < size; n++) {
			rows.push(`${String(offsets[n]).padStart(10, '0')} 00000 n `);
		}
		const trailer = `trailer\n<< /Size ${size} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
		push(latin1Bytes(rows.join('\n') + '\n' + trailer));
		const out = new Uint8Array(pos);
		let o = 0;
		for (const c of chunks) {
			out.set(c, o);
			o += c.length;
		}
		return out;
	}
}
