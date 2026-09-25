/**
 * An EMF embedded in a WMF.
 *
 * `GetWinMetaFileBits` (which Office and the clipboard use to produce a WMF
 * from an EMF) writes the WMF records and, ahead of them, the original EMF
 * in `META_ESCAPE` `MFCOMMENT` records (MS-WMF 2.3.6.2
 * `META_ESCAPE_ENHANCED_METAFILE`): each carries the `WMFC` identifier,
 * comment type 1, version 0x00010000, a checksum, the chunk count, this
 * chunk's size, the bytes still to come, the whole EMF's size, and then the
 * chunk. When Windows reads such a WMF back (`SetWinMetaFileBits`) it
 * reassembles and plays the EMF itself rather than its lossy WMF rendering,
 * provided every chunk is present and consistent; so does the converter.
 *
 * @module wmf-embedded-emf
 */

import { META_ESCAPE, EMR_HEADER } from './emf-constants';

/** `MFCOMMENT` escape function. */
const MFCOMMENT = 0x000f;
/** `WMFC` comment identifier. */
const WMFC = 0x43464d57;

/**
 * The EMF embedded in the WMF records starting at `start`, or `null` when
 * there is none or its chunks are incomplete or inconsistent.
 */
export function extractEmbeddedEmf(view: DataView, start: number): ArrayBuffer | null {
	let off = start;
	let out: Uint8Array<ArrayBuffer> | null = null;
	let written = 0;
	let total = 0;
	let expectedChunks = 0;
	let chunks = 0;
	let guard = 0;
	while (off + 6 <= view.byteLength && guard++ < 1_000_000) {
		const size = view.getUint32(off, true) * 2;
		const type = view.getUint16(off + 4, true);
		if (size < 6 || off + size > view.byteLength || type === 0) {
			break;
		}
		if (type === META_ESCAPE && size >= 6 + 4 + 34) {
			const d = off + 6;
			const fn = view.getUint16(d, true);
			const byteCount = view.getUint16(d + 2, true);
			const c = d + 4;
			if (fn === MFCOMMENT && byteCount >= 34 && view.getUint32(c, true) === WMFC && view.getUint32(c + 4, true) === 1) {
				// Checksum (2) and Flags (4) follow the version; then the counts.
				const count = view.getUint32(c + 18, true);
				const chunkSize = view.getUint32(c + 22, true);
				const remaining = view.getUint32(c + 26, true);
				const emfSize = view.getUint32(c + 30, true);
				const data = c + 34;
				if (chunkSize > byteCount - 34 || data + chunkSize > off + size) {
					return null;
				}
				if (!out) {
					if (emfSize === 0 || emfSize > 256 * 1024 * 1024) {
						return null;
					}
					out = new Uint8Array(emfSize);
					total = emfSize;
					expectedChunks = count;
				}
				if (emfSize !== total || written + chunkSize > total || remaining !== total - written - chunkSize) {
					return null;
				}
				out.set(new Uint8Array(view.buffer, view.byteOffset + data, chunkSize), written);
				written += chunkSize;
				chunks++;
			}
		}
		off += size;
	}
	if (!out || written !== total || chunks !== expectedChunks) {
		return null;
	}
	const emf = new DataView(out.buffer);
	if (total < 88 || emf.getUint32(0, true) !== EMR_HEADER) {
		return null;
	}
	return out.buffer;
}
