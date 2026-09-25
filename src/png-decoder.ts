/**
 * Dependency-free PNG decoder (the counterpart of `png-encoder.ts`), so
 * PNG images can be turned into pixels with no canvas implementation: for
 * EMF+ `DrawImage` resampling (`imageResampling: 'exact'` SVG output), for
 * compressed EMF+ texture brushes, and for PNG conversion in plain Node.js.
 *
 * Supports every PNG the specification allows: colour types 0 (grey),
 * 2 (RGB), 3 (palette), 4 (grey + alpha) and 6 (RGBA), bit depths 1, 2, 4,
 * 8 and 16, all five scanline filters, Adam7 interlacing, and `tRNS`
 * transparency. Output is straight (non-premultiplied) 8-bit RGBA, as
 * `getImageData` returns it; 16-bit samples keep their high byte, as
 * browsers and Skia do. Colour-management chunks (`gAMA`, `cHRM`, `sRGB`,
 * `iCCP`) are ignored, like Skia-based canvases decoding for 2D drawing.
 *
 * The zlib stream is inflated with the platform's
 * `DecompressionStream('deflate')` (browsers, workers, Deno, Bun, Node.js
 * >= 18), falling back to a small built-in inflater when it is missing.
 *
 * @module png-decoder
 */

/** Decoded image: straight RGBA, row-major, top-down. */
export interface DecodedPng {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when `bytes` starts with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
	return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

// ---------------------------------------------------------------------------
// Inflate
// ---------------------------------------------------------------------------

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'function' && typeof Response === 'function') {
		try {
			const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		} catch {
			/* fall through to the built-in inflater (it tolerates trailing bytes) */
		}
	}
	return inflateZlibSync(data);
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193,
	12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman decoding table: symbol counts per length, and symbols in code order. */
interface Huffman {
	counts: Uint16Array;
	symbols: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
	const counts = new Uint16Array(16);
	for (let i = 0; i < n; i++) {
		counts[lengths[i]]++;
	}
	counts[0] = 0;
	const offs = new Uint16Array(16);
	for (let i = 1; i < 16; i++) {
		offs[i] = offs[i - 1] + counts[i - 1];
	}
	const symbols = new Uint16Array(n);
	for (let i = 0; i < n; i++) {
		if (lengths[i]) {
			symbols[offs[lengths[i]]++] = i;
		}
	}
	return { counts, symbols };
}

/**
 * A plain-JavaScript zlib inflater (RFC 1950/1951: stored, fixed and
 * dynamic Huffman blocks). Only used where `DecompressionStream` is missing.
 */
export function inflateZlibSync(input: Uint8Array): Uint8Array {
	let pos = 2; // zlib header (CMF, FLG); the Adler-32 trailer is not checked.
	let bitBuf = 0;
	let bitCnt = 0;
	let out = new Uint8Array(Math.max(1024, input.length * 4));
	let outLen = 0;
	const need = (n: number): void => {
		if (outLen + n > out.length) {
			const next = new Uint8Array(Math.max(out.length * 2, outLen + n));
			next.set(out.subarray(0, outLen));
			out = next;
		}
	};
	const bits = (n: number): number => {
		while (bitCnt < n) {
			if (pos >= input.length) {
				throw new Error('inflate: unexpected end of data');
			}
			bitBuf |= input[pos++] << bitCnt;
			bitCnt += 8;
		}
		const v = bitBuf & ((1 << n) - 1);
		bitBuf >>>= n;
		bitCnt -= n;
		return v;
	};
	const decode = (h: Huffman): number => {
		let code = 0;
		let first = 0;
		let index = 0;
		for (let len = 1; len < 16; len++) {
			code |= bits(1);
			const count = h.counts[len];
			if (code - count < first) {
				return h.symbols[index + (code - first)];
			}
			index += count;
			first = (first + count) << 1;
			code <<= 1;
		}
		throw new Error('inflate: bad Huffman code');
	};
	let fixedLit: Huffman | null = null;
	let fixedDist: Huffman | null = null;
	let final = 0;
	while (!final) {
		final = bits(1);
		const type = bits(2);
		if (type === 0) {
			bitBuf = 0;
			bitCnt = 0;
			const len = input[pos] | (input[pos + 1] << 8);
			pos += 4;
			need(len);
			out.set(input.subarray(pos, pos + len), outLen);
			outLen += len;
			pos += len;
			continue;
		}
		let lit: Huffman;
		let dist: Huffman;
		if (type === 1) {
			if (!fixedLit || !fixedDist) {
				const l = new Uint8Array(288);
				l.fill(8, 0, 144);
				l.fill(9, 144, 256);
				l.fill(7, 256, 280);
				l.fill(8, 280, 288);
				fixedLit = buildHuffman(l, 288);
				fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30);
			}
			lit = fixedLit;
			dist = fixedDist;
		} else if (type === 2) {
			const hlit = bits(5) + 257;
			const hdist = bits(5) + 1;
			const hclen = bits(4) + 4;
			const cl = new Uint8Array(19);
			for (let i = 0; i < hclen; i++) {
				cl[CL_ORDER[i]] = bits(3);
			}
			const clh = buildHuffman(cl, 19);
			const lens = new Uint8Array(hlit + hdist);
			for (let i = 0; i < hlit + hdist; ) {
				const sym = decode(clh);
				if (sym < 16) {
					lens[i++] = sym;
				} else if (sym === 16) {
					const prev = lens[i - 1];
					for (let r = 3 + bits(2); r > 0; r--) {
						lens[i++] = prev;
					}
				} else if (sym === 17) {
					i += 3 + bits(3);
				} else {
					i += 11 + bits(7);
				}
			}
			lit = buildHuffman(lens.subarray(0, hlit), hlit);
			dist = buildHuffman(lens.subarray(hlit), hdist);
		} else {
			throw new Error('inflate: invalid block type');
		}
		for (;;) {
			const sym = decode(lit);
			if (sym < 256) {
				need(1);
				out[outLen++] = sym;
			} else if (sym === 256) {
				break;
			} else {
				const li = sym - 257;
				const len = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
				const di = decode(dist);
				const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
				need(len);
				for (let k = 0; k < len; k++) {
					out[outLen] = out[outLen - d];
					outLen++;
				}
			}
		}
	}
	return out.subarray(0, outLen);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const ADAM7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses the scanline filters of one (sub)image in place; returns the offset just past it. */
function unfilter(raw: Uint8Array, offset: number, stride: number, rows: number, bpp: number): number {
	let prev = -1;
	for (let y = 0; y < rows; y++) {
		const filter = raw[offset];
		const row = offset + 1;
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? raw[row + i - bpp] : 0;
			const b = prev >= 0 ? raw[prev + i] : 0;
			const c = prev >= 0 && i >= bpp ? raw[prev + i - bpp] : 0;
			let v = raw[row + i];
			switch (filter) {
				case 1:
					v += a;
					break;
				case 2:
					v += b;
					break;
				case 3:
					v += (a + b) >> 1;
					break;
				case 4:
					v += paeth(a, b, c);
					break;
			}
			raw[row + i] = v & 0xff;
		}
		prev = row;
		offset = row + stride;
	}
	return offset;
}

/**
 * Decodes a PNG file into straight RGBA pixels. Returns `null` for data
 * that is not a well-formed PNG (bad signature, missing header or data,
 * unsupported parameters, or a corrupt compressed stream).
 */
export async function decodePng(bytes: Uint8Array): Promise<DecodedPng | null> {
	if (!isPng(bytes)) {
		return null;
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = -1;
	let interlace = 0;
	let palette: Uint8Array | null = null;
	let trns: Uint8Array | null = null;
	const idat: Uint8Array[] = [];
	let idatLen = 0;
	for (let p = 8; p + 12 <= bytes.length; ) {
		const len = dv.getUint32(p);
		const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
		const body = bytes.subarray(p + 8, Math.min(bytes.length, p + 8 + len));
		if (type === 'IHDR' && body.length >= 13) {
			width = dv.getUint32(p + 8);
			height = dv.getUint32(p + 12);
			depth = body[8];
			colorType = body[9];
			interlace = body[12];
		} else if (type === 'PLTE') {
			palette = body;
		} else if (type === 'tRNS') {
			trns = body;
		} else if (type === 'IDAT') {
			idat.push(body);
			idatLen += body.length;
		} else if (type === 'IEND') {
			break;
		}
		p += 12 + len;
	}
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
	const validDepth =
		colorType === 0
			? [1, 2, 4, 8, 16].includes(depth)
			: colorType === 3
				? [1, 2, 4, 8].includes(depth)
				: [8, 16].includes(depth);
	if (!channels || !validDepth || width <= 0 || height <= 0 || idatLen === 0 || (colorType === 3 && !palette)) {
		return null;
	}
	if (width * height > 0x10000000) {
		return null;
	}
	const compressed = new Uint8Array(idatLen);
	let o = 0;
	for (const part of idat) {
		compressed.set(part, o);
		o += part.length;
	}
	let raw: Uint8Array;
	try {
		raw = await inflateZlib(compressed);
	} catch {
		return null;
	}
	const bitsPerPixel = channels * depth;
	const bpp = Math.max(1, bitsPerPixel >> 3);
	const out = new Uint8ClampedArray(width * height * 4);
	const maxSample = (1 << depth) - 1;
	// tRNS keys compare full-precision samples.
	const keyGray = trns && colorType === 0 && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
	const keyRgb =
		trns && colorType === 2 && trns.length >= 6
			? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]]
			: null;

	/** Reads sample `index` of a row starting at `row` (full precision). */
	const sampleAt = (row: number, index: number): number => {
		if (depth === 8) {
			return raw[row + index];
		}
		if (depth === 16) {
			return (raw[row + index * 2] << 8) | raw[row + index * 2 + 1];
		}
		const bit = index * depth;
		return (raw[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & maxSample;
	};
	const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxSample));

	const writeRow = (row: number, count: number, y: number, x0: number, dx: number): void => {
		for (let i = 0; i < count; i++) {
			const di = (y * width + x0 + i * dx) * 4;
			if (colorType === 3) {
				const idx = sampleAt(row, i);
				out[di] = palette![idx * 3] ?? 0;
				out[di + 1] = palette![idx * 3 + 1] ?? 0;
				out[di + 2] = palette![idx * 3 + 2] ?? 0;
				out[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
			} else if (colorType === 0 || colorType === 4) {
				const g = sampleAt(row, i * channels);
				const v = to8(g);
				out[di] = v;
				out[di + 1] = v;
				out[di + 2] = v;
				out[di + 3] = colorType === 4 ? to8(sampleAt(row, i * channels + 1)) : g === keyGray ? 0 : 255;
			} else {
				const r = sampleAt(row, i * channels);
				const g = sampleAt(row, i * channels + 1);
				const b = sampleAt(row, i * channels + 2);
				out[di] = to8(r);
				out[di + 1] = to8(g);
				out[di + 2] = to8(b);
				out[di + 3] =
					colorType === 6
						? to8(sampleAt(row, i * channels + 3))
						: keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2]
							? 0
							: 255;
			}
		}
	};

	let offset = 0;
	const passes = interlace === 1 ? ADAM7 : [[0, 0, 1, 1]];
	for (const [px, py, sx, sy] of passes) {
		const pw = Math.ceil((width - px) / sx);
		const ph = Math.ceil((height - py) / sy);
		if (pw <= 0 || ph <= 0) {
			continue;
		}
		const stride = Math.ceil((pw * bitsPerPixel) / 8);
		if (offset + ph * (stride + 1) > raw.length) {
			return null;
		}
		const start = offset;
		offset = unfilter(raw, offset, stride, ph, bpp);
		for (let r = 0; r < ph; r++) {
			writeRow(start + r * (stride + 1) + 1, pw, py + r * sy, px, sx);
		}
	}
	return { width, height, data: out };
}
