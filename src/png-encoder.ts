/**
 * Dependency-free RGBA → PNG encoder, used by the SVG backend to embed raster
 * content (decoded DIBs, exact ROP patches, gradient tiles) as `<image>` data
 * URLs without needing any canvas implementation.
 *
 * Compression uses the platform's `CompressionStream('deflate')` (every
 * modern browser, Web Worker, Deno, Bun, and Node.js >= 18) and falls back to
 * uncompressed ("stored") deflate blocks when it is unavailable, so encoding
 * always succeeds, only the output size differs. Each scanline picks the
 * cheapest of the None/Sub/Up/Paeth filters by the usual minimum
 * sum-of-absolute-differences heuristic.
 *
 * @module png-encoder
 */

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, start: number, end: number): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) {
				c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = start; i < end; i++) {
		crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (let i = 0; i < bytes.length; ) {
		const end = Math.min(bytes.length, i + 5552);
		for (; i < end; i++) {
			a += bytes[i];
			b += a;
		}
		a %= 65521;
		b %= 65521;
	}
	return ((b << 16) | a) >>> 0;
}

/** zlib stream made of stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
	const blocks = Math.max(1, Math.ceil(raw.length / 65535));
	const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
	out[0] = 0x78;
	out[1] = 0x01;
	let o = 2;
	for (let b = 0; b < blocks; b++) {
		const start = b * 65535;
		const len = Math.min(65535, raw.length - start);
		out[o++] = b === blocks - 1 ? 1 : 0;
		out[o++] = len & 0xff;
		out[o++] = len >>> 8;
		out[o++] = ~len & 0xff;
		out[o++] = (~len >>> 8) & 0xff;
		out.set(raw.subarray(start, start + len), o);
		o += len;
	}
	const ad = adler32(raw);
	out[o++] = ad >>> 24;
	out[o++] = (ad >>> 16) & 0xff;
	out[o++] = (ad >>> 8) & 0xff;
	out[o++] = ad & 0xff;
	return out;
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === 'function' && typeof Response === 'function') {
		try {
			const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		} catch {
			/* fall through to stored blocks */
		}
	}
	return zlibStored(raw);
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Sum of the filtered bytes read as signed values: the usual filter-choice heuristic. */
function score(line: Uint8Array, stride: number): number {
	let s = 0;
	for (let i = 0; i < stride; i++) {
		const v = line[i];
		s += v < 128 ? v : 256 - v;
	}
	return s;
}

/** Filters RGBA scanlines, choosing a filter per row. */
function filterScanlines(input: ArrayLike<number>, width: number, height: number): Uint8Array {
	const data =
		input instanceof Uint8Array || input instanceof Uint8ClampedArray
			? new Uint8Array(input.buffer, input.byteOffset, input.length)
			: Uint8Array.from(input);
	const stride = width * 4;
	const words = data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, width * height) : null;
	const out = new Uint8Array((stride + 1) * height);
	const sub = new Uint8Array(stride);
	const up = new Uint8Array(stride);
	const pae = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		const prev = row - stride;
		const o = y * (stride + 1);
		if (words && y > 0) {
			// A row repeating the one above (large flat areas): Up filters it to zeros.
			const w0 = row >> 2;
			const p0 = prev >> 2;
			let same = true;
			for (let k = 0; k < width; k++) {
				if (words[w0 + k] !== words[p0 + k]) {
					same = false;
					break;
				}
			}
			if (same) {
				out[o] = 2;
				continue;
			}
		}
		const none = data.subarray(row, row + stride);
		const noneScore = score(none as Uint8Array, stride);
		if (noneScore === 0) {
			// An all-zero row (a blank area): filter None is already optimal.
			out.set(none, o + 1);
			continue;
		}
		let subScore = 0;
		let upScore = 0;
		for (let i = 0; i < 4 && i < stride; i++) {
			const x = data[row + i];
			sub[i] = x;
			subScore += x < 128 ? x : 256 - x;
		}
		for (let i = 4; i < stride; i++) {
			const v = (data[row + i] - data[row + i - 4]) & 0xff;
			sub[i] = v;
			subScore += v < 128 ? v : 256 - v;
		}
		if (y > 0) {
			for (let i = 0; i < stride; i++) {
				const v = (data[row + i] - data[prev + i]) & 0xff;
				up[i] = v;
				upScore += v < 128 ? v : 256 - v;
			}
		} else {
			up.set(none);
			upScore = noneScore;
		}
		// Filter codes: 0 None, 1 Sub, 2 Up, 4 Paeth.
		let best: Uint8Array = none as Uint8Array;
		let code = 0;
		let bestScore = noneScore;
		if (subScore < bestScore) {
			bestScore = subScore;
			best = sub;
			code = 1;
		}
		if (upScore < bestScore) {
			bestScore = upScore;
			best = up;
			code = 2;
		}
		// Paeth only pays off on busy rows; flat artwork is already near zero.
		if (y > 0 && bestScore > stride >> 3) {
			for (let i = 0; i < stride; i++) {
				const a = i >= 4 ? data[row + i - 4] : 0;
				const b = data[prev + i];
				const c = i >= 4 ? data[prev + i - 4] : 0;
				pae[i] = (data[row + i] - paeth(a, b, c)) & 0xff;
			}
			const paethScore = score(pae, stride);
			if (paethScore < bestScore) {
				best = pae;
				code = 4;
			}
		}
		out[o] = code;
		out.set(best, o + 1);
	}
	return out;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + payload.length);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, payload.length);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(payload, 8);
	dv.setUint32(8 + payload.length, crc32(out, 4, 8 + payload.length));
	return out;
}

/**
 * Encodes straight (non-premultiplied) RGBA pixels as a PNG file.
 *
 * @param data   - `width * height * 4` bytes, row-major, top-down.
 * @param width  - Image width in pixels (> 0).
 * @param height - Image height in pixels (> 0).
 */
export async function encodePng(data: ArrayLike<number>, width: number, height: number): Promise<Uint8Array> {
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, width);
	dv.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	const idat = await zlibDeflate(filterScanlines(data, width, height));
	const parts = [
		Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
		chunk('IHDR', ihdr),
		chunk('IDAT', idat),
		chunk('IEND', new Uint8Array(0)),
	];
	const total = parts.reduce((n, p) => n + p.length, 0);
	const png = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		png.set(p, o);
		o += p.length;
	}
	return png;
}
