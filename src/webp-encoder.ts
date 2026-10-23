/**
 * Dependency-free WebP encoder for straight RGBA pixels.
 *
 * Lossless output (the default) is a VP8L bitstream that decodes to exactly
 * the input pixels, alpha included. Lossy output is a VP8 key frame (with
 * the alpha plane, when there is one, in a lossless ALPH chunk inside a
 * VP8X container). See {@link encodeWebp}.
 *
 * @module webp-encoder
 */

import { encodeVp8l, encodeVp8lStream } from './webp-lossless';
import { encodeVp8Frame } from './webp-vp8-encoder';

/** Options for {@link encodeWebp}. */
export interface WebpEncodeOptions {
	/** `true` for lossy VP8 output; default `false` (lossless VP8L). */
	lossy?: boolean;
	/** Lossy quality from 0 to 1. Default 0.8. Ignored for lossless output. */
	quality?: number;
}

/** Largest width or height a WebP image can have. */
export const WEBP_MAX_DIMENSION = 16383;

function fourcc(out: Uint8Array, offset: number, tag: string): void {
	for (let i = 0; i < 4; i++) {
		out[offset + i] = tag.charCodeAt(i);
	}
}

function u32le(out: Uint8Array, offset: number, v: number): void {
	out[offset] = v & 0xff;
	out[offset + 1] = (v >>> 8) & 0xff;
	out[offset + 2] = (v >>> 16) & 0xff;
	out[offset + 3] = (v >>> 24) & 0xff;
}

/** A RIFF chunk: tag, little-endian size, payload, pad byte to even length. */
function chunk(tag: string, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + payload.length + (payload.length & 1));
	fourcc(out, 0, tag);
	u32le(out, 4, payload.length);
	out.set(payload, 8);
	return out;
}

/** Wraps chunks in the RIFF/WEBP envelope. */
function riff(chunks: Uint8Array[]): Uint8Array {
	let total = 4;
	for (const c of chunks) {
		total += c.length;
	}
	const out = new Uint8Array(8 + total);
	fourcc(out, 0, 'RIFF');
	u32le(out, 4, total);
	fourcc(out, 8, 'WEBP');
	let o = 12;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

/** Packs straight RGBA bytes as 0xAARRGGBB and reports whether any pixel is not opaque. */
function toArgb(pixels: ArrayLike<number>, n: number): { argb: Uint32Array; hasAlpha: boolean } {
	const argb = new Uint32Array(n);
	let hasAlpha = false;
	for (let i = 0, j = 0; i < n; i++, j += 4) {
		const a = pixels[j + 3];
		if (a !== 255) {
			hasAlpha = true;
		}
		argb[i] = ((a << 24) | (pixels[j] << 16) | (pixels[j + 1] << 8) | pixels[j + 2]) >>> 0;
	}
	return { argb, hasAlpha };
}

/**
 * Encodes straight (non-premultiplied) RGBA pixels as a WebP file.
 *
 * By default the output is lossless (VP8L): it decodes to exactly the input
 * pixels, and signals "no alpha" in the header when every pixel is opaque.
 * With `lossy: true` it is a VP8 key frame at the given quality; any
 * transparency is stored losslessly in an ALPH chunk.
 *
 * @param pixels  - `width * height * 4` bytes (R, G, B, A), row-major, top-down.
 * @param width   - Image width, 1 to 16383.
 * @param height  - Image height, 1 to 16383.
 * @param options - See {@link WebpEncodeOptions}.
 * @throws RangeError for sizes outside 1..16383 or a pixel buffer that is too short.
 */
export function encodeWebp(
	pixels: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	options?: WebpEncodeOptions,
): Uint8Array {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > WEBP_MAX_DIMENSION ||
		height > WEBP_MAX_DIMENSION
	) {
		throw new RangeError(`WebP dimensions must be integers from 1 to ${WEBP_MAX_DIMENSION}, got ${width}x${height}`);
	}
	const n = width * height;
	if (pixels.length < n * 4) {
		throw new RangeError('WebP pixel buffer is shorter than width * height * 4');
	}
	const { argb, hasAlpha } = toArgb(pixels, n);
	if (!options?.lossy) {
		return riff([chunk('VP8L', encodeVp8l(argb, width, height, { hasAlpha }))]);
	}
	const quality = Math.min(1, Math.max(0, options.quality ?? 0.8));
	const frame = encodeVp8Frame(pixels, width, height, quality, hasAlpha);
	if (!hasAlpha) {
		return riff([chunk('VP8 ', frame)]);
	}
	// Alpha plane: green channel of a lossless stream, header byte 1 = lossless, no filtering.
	const plane = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		plane[i] = (0xff000000 | (pixels[i * 4 + 3] << 8)) >>> 0;
	}
	const stream = encodeVp8lStream(plane, width, height, { hasAlpha: false, subtractGreen: false });
	const alph = new Uint8Array(1 + stream.length);
	alph[0] = 1;
	alph.set(stream, 1);
	const vp8x = new Uint8Array(10);
	vp8x[0] = 0x10; // alpha flag
	vp8x[4] = (width - 1) & 0xff;
	vp8x[5] = ((width - 1) >>> 8) & 0xff;
	vp8x[6] = ((width - 1) >>> 16) & 0xff;
	vp8x[7] = (height - 1) & 0xff;
	vp8x[8] = ((height - 1) >>> 8) & 0xff;
	vp8x[9] = ((height - 1) >>> 16) & 0xff;
	return riff([chunk('VP8X', vp8x), chunk('ALPH', alph), chunk('VP8 ', frame)]);
}
