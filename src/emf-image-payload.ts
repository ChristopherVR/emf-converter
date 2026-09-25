/**
 * Small, canvas-free helpers for embedded image bytes shared by the SVG
 * output and the in-order EMF+ `DrawImage` path: MIME sniffing of
 * browser-native formats, intrinsic size from their headers, and a pure
 * JavaScript BMP decode.
 *
 * @module emf-image-payload
 */

import { decodeDibToImageData } from './emf-dib-decoder';
import type { ImagePayload } from './svg-context';

/** Identifies image bytes browsers and SVG renderers display natively. */
export function sniffImageMime(bytes: Uint8Array): string | null {
	const b = bytes;
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return 'image/png';
	}
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		return 'image/jpeg';
	}
	if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
		return 'image/gif';
	}
	if (
		b.length >= 12 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	) {
		return 'image/webp';
	}
	return null;
}

/** Intrinsic pixel size of a payload (PNG/JPEG/GIF/WebP headers are parsed), or `null`. */
export function payloadSize(p: ImagePayload): { w: number; h: number } | null {
	if (p.kind === 'rgba') {
		return { w: p.width, h: p.height };
	}
	if (p.kind !== 'encoded') {
		return null;
	}
	const b = p.bytes;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	try {
		if (p.mime === 'image/png' && b.length >= 24) {
			return { w: dv.getUint32(16), h: dv.getUint32(20) };
		}
		if (p.mime === 'image/gif' && b.length >= 10) {
			return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
		}
		if (p.mime === 'image/jpeg') {
			for (let i = 2; i + 9 < b.length; ) {
				if (b[i] !== 0xff) {
					i++;
					continue;
				}
				const marker = b[i + 1];
				const len = dv.getUint16(i + 2);
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) };
				}
				i += 2 + len;
			}
		}
		if (p.mime === 'image/webp' && b.length >= 30) {
			const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
			if (chunk === 'VP8X') {
				return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
			}
			if (chunk === 'VP8 ') {
				return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
			}
			if (chunk === 'VP8L') {
				const bits = dv.getUint32(21, true);
				return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
			}
		}
	} catch {
		/* truncated header */
	}
	return null;
}

/** Decodes a BMP file (`BM` + BITMAPFILEHEADER + DIB) without any canvas. */
export function decodeBmpFile(bytes: ArrayBuffer): ImagePayload | null {
	const view = new DataView(bytes);
	if (view.byteLength < 26 || view.getUint8(0) !== 0x42 || view.getUint8(1) !== 0x4d) {
		return null;
	}
	const bitsOffset = view.getUint32(10, true);
	const image = decodeDibToImageData(view, 14, bitsOffset, view.byteLength - bitsOffset);
	return image ? { kind: 'rgba', data: image.data, width: image.width, height: image.height } : null;
}
