/**
 * Normalises the inputs the public entry points accept into the plain
 * `ArrayBuffer` the parsers read.
 *
 * - An `ArrayBuffer` is used as is.
 * - A typed array, `DataView` or Node.js `Buffer` is copied out of its
 *   backing store when it covers only part of it. A Node `Buffer` is often a
 *   slice of a shared 8 KB pool, so passing `buf.buffer` would hand the
 *   parser someone else's bytes; accepting the view itself avoids that.
 * - A `Blob` (or `File`) is read with `arrayBuffer()`.
 * - Gzip-compressed metafiles (`.emz` / `.wmz`, as Office and Visio store
 *   them) are inflated with the platform's `DecompressionStream`.
 *
 * @module metafile-input
 */

import { emfWarn } from './emf-logging';

/** Every input form the `convertMetafile*` functions accept. */
export type MetafileInput = ArrayBuffer | ArrayBufferView | Blob;

/** Inflated `.emz` / `.wmz` payloads larger than this are refused. */
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/** Returns the input's bytes as a plain `ArrayBuffer`, inflating gzip; `null` when unreadable. */
export async function readMetafileInput(input: MetafileInput): Promise<ArrayBuffer | null> {
	let buffer: ArrayBuffer;
	if (input instanceof ArrayBuffer) {
		buffer = input;
	} else if (ArrayBuffer.isView(input)) {
		const whole = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength;
		buffer = whole && input.buffer instanceof ArrayBuffer
			? input.buffer
			: copyBytes(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
	} else if (typeof Blob !== 'undefined' && input instanceof Blob) {
		buffer = await input.arrayBuffer();
	} else {
		emfWarn('readMetafileInput: expected an ArrayBuffer, a typed array / Buffer, or a Blob');
		return null;
	}
	return isGzip(buffer) ? gunzip(buffer) : buffer;
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

/** Gzip member header: ID1 ID2 and CM = 8 (deflate). */
function isGzip(buffer: ArrayBuffer): boolean {
	if (buffer.byteLength < 18) {
		return false;
	}
	const b = new Uint8Array(buffer, 0, 3);
	return b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08;
}

async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer | null> {
	if (typeof DecompressionStream === 'undefined') {
		emfWarn('readMetafileInput: gzip input (.emz/.wmz) needs DecompressionStream, which this runtime lacks');
		return null;
	}
	try {
		const reader = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > MAX_INFLATED_BYTES) {
				await reader.cancel();
				emfWarn(`readMetafileInput: gzip input inflates past ${MAX_INFLATED_BYTES} bytes; refused`);
				return null;
			}
			chunks.push(value);
		}
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out.buffer;
	} catch (err) {
		emfWarn('readMetafileInput: gzip input is corrupt:', err instanceof Error ? err.message : err);
		return null;
	}
}
