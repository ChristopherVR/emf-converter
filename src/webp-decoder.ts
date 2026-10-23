/**
 * Dependency-free WebP decoder: lossy (VP8), lossless (VP8L), the extended
 * format with ALPH alpha, and animated files (first frame only).
 *
 * Lossy output follows libwebp's default decoder (fancy chroma upsampling),
 * which is what Windows (WIC) and browsers use, see `webp-vp8.ts`.
 */
import { decodeVp8, vp8ToRgba } from './webp-vp8';
import { decodeVp8l, decodeVp8lAlpha } from './webp-vp8l';

/** Straight (non-premultiplied) RGBA pixels. */
export interface WebpPixels {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

/** Largest width or height accepted, as for the other bundled decoders. */
const MAX_SIZE = 8192;

interface Chunk { type: string; data: Uint8Array }

function readChunks(b: Uint8Array, start: number, end: number): Chunk[] {
	const chunks: Chunk[] = [];
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	for (let p = start; p + 8 <= end; ) {
		const type = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
		const size = v.getUint32(p + 4, true);
		// A truncated final chunk is clamped; decoding it decides whether it is usable.
		chunks.push({ type, data: b.subarray(p + 8, Math.min(p + 8 + size, end)) });
		p += 8 + size + (size & 1);
	}
	return chunks;
}

/** Reverses the alpha prediction filter chosen by the encoder (ALPH chunk, libwebp `filters.c`). */
function unfilterAlpha(a: Uint8Array, w: number, h: number, filter: number): void {
	if (filter === 0) return;
	for (let y = 0; y < h; y++) {
		const row = y * w;
		if (y === 0 || filter === 1) {
			// Horizontal: running sum along the row, seeded from the pixel above (zero on the first row).
			let pred = y === 0 ? 0 : a[row - w];
			if (filter !== 1) pred = 0;
			for (let x = 0; x < w; x++) {
				a[row + x] = (a[row + x] + pred) & 255;
				pred = a[row + x];
			}
		} else if (filter === 2) {
			for (let x = 0; x < w; x++) a[row + x] = (a[row + x] + a[row - w + x]) & 255;
		} else {
			let left = a[row - w], topLeft = left;
			for (let x = 0; x < w; x++) {
				const top = a[row - w + x];
				const grad = left + top - topLeft;
				left = (a[row + x] + (grad < 0 ? 0 : grad > 255 ? 255 : grad)) & 255;
				topLeft = top;
				a[row + x] = left;
			}
		}
	}
}

function decodeAlpha(chunk: Uint8Array, w: number, h: number): Uint8Array {
	if (chunk.length <= 1) throw new Error('WebP: empty ALPH');
	const method = chunk[0] & 3, filter = (chunk[0] >> 2) & 3, pre = (chunk[0] >> 4) & 3, reserved = chunk[0] >> 6;
	if (method > 1 || pre > 1 || reserved) throw new Error('WebP: bad ALPH header');
	let alpha: Uint8Array;
	if (method === 0) {
		if (chunk.length - 1 < w * h) throw new Error('WebP: short ALPH');
		alpha = chunk.slice(1, 1 + w * h);
	} else {
		alpha = decodeVp8lAlpha(chunk.subarray(1), w, h);
	}
	unfilterAlpha(alpha, w, h, filter);
	return alpha;
}

/** Decodes one still bitstream (`VP8 ` or `VP8L`, plus its optional ALPH) to RGBA. */
function decodeBitstream(chunks: Chunk[]): WebpPixels {
	const image = chunks.find((c) => c.type === 'VP8 ' || c.type === 'VP8L');
	if (!image) throw new Error('WebP: no image data');
	if (image.type === 'VP8L') {
		// Check the declared size before allocating anything.
		const head = image.data.length >= 5 ? image.data[1] | (image.data[2] << 8) | (image.data[3] << 16) | (image.data[4] << 24) : 0;
		if ((head & 0x3fff) + 1 > MAX_SIZE || ((head >>> 14) & 0x3fff) + 1 > MAX_SIZE) throw new Error('WebP: too large');
		const { argb, width, height } = decodeVp8l(image.data);
		const data = new Uint8ClampedArray(width * height * 4);
		for (let i = 0; i < argb.length; i++) {
			const p = argb[i];
			data[i * 4] = (p >>> 16) & 255;
			data[i * 4 + 1] = (p >>> 8) & 255;
			data[i * 4 + 2] = p & 255;
			data[i * 4 + 3] = p >>> 24;
		}
		return { data, width, height };
	}
	const w = ((image.data[6] | (image.data[7] << 8)) & 0x3fff) || 0, h = ((image.data[8] | (image.data[9] << 8)) & 0x3fff) || 0;
	if (w > MAX_SIZE || h > MAX_SIZE) throw new Error('WebP: too large');
	const frame = decodeVp8(image.data);
	const alph = chunks.find((c) => c.type === 'ALPH');
	const alpha = alph ? decodeAlpha(alph.data, frame.width, frame.height) : null;
	return { data: vp8ToRgba(frame, alpha), width: frame.width, height: frame.height };
}

/**
 * Decodes a WebP file to straight RGBA, or `null` when it is invalid,
 * unsupported or larger than 8192 pixels on a side.
 *
 * For an animated file only the first frame is decoded, composited onto a
 * transparent canvas of the animation's size (the canvas background colour
 * is ignored, as libwebp's animation decoder does).
 */
export function decodeWebp(bytes: Uint8Array): WebpPixels | null {
	try {
		const b = bytes;
		if (b.length < 20 || b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46 || b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null;
		const riffSize = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
		const end = Math.min(b.length, 8 + riffSize);
		const chunks = readChunks(b, 12, end);
		const vp8x = chunks[0]?.type === 'VP8X' ? chunks[0].data : null;
		if (!vp8x) return decodeBitstream(chunks);
		if (vp8x.length < 10) return null;
		const canvasW = (vp8x[4] | (vp8x[5] << 8) | (vp8x[6] << 16)) + 1, canvasH = (vp8x[7] | (vp8x[8] << 8) | (vp8x[9] << 16)) + 1;
		if (canvasW > MAX_SIZE || canvasH > MAX_SIZE) return null;
		if (!(vp8x[0] & 0x02)) {
			const still = decodeBitstream(chunks);
			return still.width === canvasW && still.height === canvasH ? still : null;
		}
		const anmf = chunks.find((c) => c.type === 'ANMF');
		if (!anmf || anmf.data.length < 16) return null;
		const a = anmf.data;
		const x0 = (a[0] | (a[1] << 8) | (a[2] << 16)) * 2, y0 = (a[3] | (a[4] << 8) | (a[5] << 16)) * 2;
		const fw = (a[6] | (a[7] << 8) | (a[8] << 16)) + 1, fh = (a[9] | (a[10] << 8) | (a[11] << 16)) + 1;
		if (x0 + fw > canvasW || y0 + fh > canvasH) return null;
		const frame = decodeBitstream(readChunks(a, 16, a.length));
		if (frame.width !== fw || frame.height !== fh) return null;
		const data = new Uint8ClampedArray(canvasW * canvasH * 4);
		for (let y = 0; y < fh; y++) data.set(frame.data.subarray(y * fw * 4, (y + 1) * fw * 4), ((y0 + y) * canvasW + x0) * 4);
		return { data, width: canvasW, height: canvasH };
	} catch {
		return null;
	}
}
