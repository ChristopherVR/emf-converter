/**
 * WebP lossless (VP8L) decoder. Follows the "WebP Lossless Bitstream
 * Specification" and libwebp's reference decoder (BSD-3-Clause, see
 * THIRD_PARTY_NOTICES). Output is 0xAARRGGBB words; every failure throws
 * (callers turn that into `null`).
 */

const MAX_CODE_LENGTH = 15;
const FAST_BITS = 8;
const NUM_LITERAL_CODES = 256;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/**
 * Nearby-pixel distance codes: high nibble is the row offset, `8 - low nibble`
 * the column offset (libwebp `kCodeToPlane`).
 */
const CODE_TO_PLANE = new Uint8Array([
	0x18, 0x07, 0x17, 0x19, 0x28, 0x06, 0x27, 0x29, 0x16, 0x1a, 0x26, 0x2a, 0x38, 0x05, 0x37, 0x39, 0x15, 0x1b, 0x36, 0x3a,
	0x25, 0x2b, 0x48, 0x04, 0x47, 0x49, 0x14, 0x1c, 0x35, 0x3b, 0x46, 0x4a, 0x24, 0x2c, 0x58, 0x45, 0x4b, 0x34, 0x3c, 0x03,
	0x57, 0x59, 0x13, 0x1d, 0x56, 0x5a, 0x23, 0x2d, 0x44, 0x4c, 0x55, 0x5b, 0x33, 0x3d, 0x68, 0x02, 0x67, 0x69, 0x12, 0x1e,
	0x66, 0x6a, 0x22, 0x2e, 0x54, 0x5c, 0x43, 0x4d, 0x65, 0x6b, 0x32, 0x3e, 0x78, 0x01, 0x77, 0x79, 0x53, 0x5d, 0x11, 0x1f,
	0x64, 0x6c, 0x42, 0x4e, 0x76, 0x7a, 0x21, 0x2f, 0x75, 0x7b, 0x31, 0x3f, 0x63, 0x6d, 0x52, 0x5e, 0x00, 0x74, 0x7c, 0x41,
	0x4f, 0x10, 0x20, 0x62, 0x6e, 0x30, 0x73, 0x7d, 0x51, 0x5f, 0x40, 0x72, 0x7e, 0x61, 0x6f, 0x50, 0x71, 0x7f, 0x60, 0x70,
]);

/** LSB-first bit reader over a zero-padded copy of the data. */
class BitReader {
	private readonly buf: Uint8Array;
	private readonly totalBits: number;
	pos = 0;

	constructor(data: Uint8Array) {
		this.buf = new Uint8Array(data.length + 8);
		this.buf.set(data);
		this.totalBits = data.length * 8;
	}

	/** Up to 25 upcoming bits without consuming them (zeros past the end). */
	peek(): number {
		const b = this.buf, i = this.pos >> 3;
		return ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> (this.pos & 7));
	}

	skip(n: number): void {
		this.pos += n;
		if (this.pos > this.totalBits) throw new Error('VP8L: truncated');
	}

	read(n: number): number {
		const v = this.peek() & ((1 << n) - 1);
		this.skip(n);
		return v;
	}
}

interface Huffman {
	/** `length << 16 | symbol` for codes up to FAST_BITS long, else 0. */
	fast: Uint32Array;
	counts: Uint16Array;
	symbols: Uint16Array;
	/** The only symbol of a one-symbol code (read with zero bits), else -1. */
	single: number;
}

function reverseBits(v: number, n: number): number {
	let r = 0;
	for (let i = 0; i < n; i++) {
		r = (r << 1) | (v & 1);
		v >>= 1;
	}
	return r;
}

/** Builds a canonical prefix code; throws unless the lengths describe a complete code. */
function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
	const counts = new Uint16Array(MAX_CODE_LENGTH + 1);
	let used = 0, last = 0;
	for (let i = 0; i < n; i++) {
		if (lengths[i]) {
			counts[lengths[i]]++;
			used++;
			last = i;
		}
	}
	const fast = new Uint32Array(1 << FAST_BITS);
	if (used === 0) throw new Error('VP8L: empty prefix code');
	if (used === 1) return { fast, counts, symbols: new Uint16Array(0), single: last };
	let left = 1;
	for (let len = 1; len <= MAX_CODE_LENGTH; len++) {
		left = (left << 1) - counts[len];
		if (left < 0) throw new Error('VP8L: oversubscribed prefix code');
	}
	if (left !== 0) throw new Error('VP8L: incomplete prefix code');
	const offsets = new Uint16Array(MAX_CODE_LENGTH + 2);
	for (let len = 1; len <= MAX_CODE_LENGTH; len++) offsets[len + 1] = offsets[len] + counts[len];
	const symbols = new Uint16Array(used);
	const next = offsets.slice();
	for (let i = 0; i < n; i++) if (lengths[i]) symbols[next[lengths[i]]++] = i;
	// Fast table for short codes: stream bits arrive first-bit-first, so index by the reversed code.
	let code = 0, index = 0;
	for (let len = 1; len <= MAX_CODE_LENGTH; len++) {
		for (let k = 0; k < counts[len]; k++, code++, index++) {
			if (len <= FAST_BITS) {
				const rev = reverseBits(code, len);
				for (let j = rev; j < 1 << FAST_BITS; j += 1 << len) fast[j] = (len << 16) | symbols[index];
			}
		}
		code <<= 1;
	}
	return { fast, counts, symbols, single: -1 };
}

function readSymbol(br: BitReader, h: Huffman): number {
	if (h.single >= 0) return h.single;
	const bits = br.peek();
	const f = h.fast[bits & ((1 << FAST_BITS) - 1)];
	if (f !== 0) {
		br.skip(f >>> 16);
		return f & 0xffff;
	}
	let code = 0, first = 0, index = 0;
	for (let len = 1; len <= MAX_CODE_LENGTH; len++) {
		code |= (bits >> (len - 1)) & 1;
		const count = h.counts[len];
		if (code - count < first) {
			br.skip(len);
			return h.symbols[index + (code - first)];
		}
		index += count;
		first = (first + count) << 1;
		code <<= 1;
	}
	throw new Error('VP8L: bad prefix code');
}

function readHuffmanCode(br: BitReader, alphabetSize: number): Huffman {
	const lengths = new Uint8Array(alphabetSize);
	if (br.read(1)) {
		// Simple code: one or two symbols, no lengths transmitted.
		const numSymbols = br.read(1) + 1;
		const first = br.read(1) ? br.read(8) : br.read(1);
		if (first < alphabetSize) lengths[first] = 1;
		if (numSymbols === 2) {
			const second = br.read(8);
			if (second < alphabetSize) lengths[second] = 1;
		}
	} else {
		const clLengths = new Uint8Array(19);
		const numCodes = br.read(4) + 4;
		for (let i = 0; i < numCodes; i++) clLengths[CODE_LENGTH_ORDER[i]] = br.read(3);
		const cl = buildHuffman(clLengths, 19);
		let maxSymbol = alphabetSize;
		if (br.read(1)) {
			const lengthBits = 2 + 2 * br.read(3);
			maxSymbol = 2 + br.read(lengthBits);
			if (maxSymbol > alphabetSize) throw new Error('VP8L: bad code length count');
		}
		let symbol = 0, prev = 8;
		while (symbol < alphabetSize) {
			if (maxSymbol-- === 0) break;
			const c = readSymbol(br, cl);
			if (c < 16) {
				lengths[symbol++] = c;
				if (c !== 0) prev = c;
			} else {
				const slot = c - 16;
				const repeat = br.read([2, 3, 7][slot]) + [3, 3, 11][slot];
				if (symbol + repeat > alphabetSize) throw new Error('VP8L: bad code length repeat');
				const value = c === 16 ? prev : 0;
				for (let i = 0; i < repeat; i++) lengths[symbol++] = value;
			}
		}
	}
	return buildHuffman(lengths, alphabetSize);
}

const subSample = (size: number, bits: number): number => (size + (1 << bits) - 1) >> bits;

function copyValue(br: BitReader, symbol: number): number {
	if (symbol < 4) return symbol + 1;
	const extra = (symbol - 2) >> 1;
	return (((2 + (symbol & 1)) << extra) + br.read(extra)) + 1;
}

/** Decodes an entropy-coded image (the main image, or a transform/meta sub-image). */
function decodeEntropyImage(br: BitReader, width: number, height: number, level0: boolean): { pixels: Uint32Array; transforms: Transform[]; width: number } {
	const transforms: Transform[] = [];
	let xsize = width;
	if (level0) {
		const seen = new Set<number>();
		while (br.read(1)) {
			const type = br.read(2);
			if (seen.has(type)) throw new Error('VP8L: repeated transform');
			seen.add(type);
			const t: Transform = { type, bits: 0, xsize, ysize: height, data: new Uint32Array(0) };
			if (type === 0 || type === 1) {
				t.bits = br.read(3) + 2;
				t.data = decodeEntropyImage(br, subSample(xsize, t.bits), subSample(height, t.bits), false).pixels;
			} else if (type === 3) {
				const n = br.read(8) + 1;
				const table = decodeEntropyImage(br, n, 1, false).pixels;
				// The palette is delta-coded per component.
				const palette = new Uint32Array(n > 16 ? 256 : n > 4 ? 16 : n > 2 ? 4 : 2);
				palette.set(table);
				for (let i = 1; i < n; i++) {
					const a = palette[i - 1], b = palette[i];
					const lo = ((a & 0x00ff00ff) + (b & 0x00ff00ff)) & 0x00ff00ff;
					const hi = ((a & 0xff00ff00) + (b & 0xff00ff00)) & 0xff00ff00;
					palette[i] = (lo | hi) >>> 0;
				}
				t.data = palette;
				t.bits = n > 16 ? 0 : n > 4 ? 1 : n > 2 ? 2 : 3;
				xsize = subSample(xsize, t.bits);
			}
			transforms.push(t);
		}
	}
	let cacheBits = 0;
	if (br.read(1)) {
		cacheBits = br.read(4);
		if (cacheBits < 1 || cacheBits > 11) throw new Error('VP8L: bad colour cache size');
	}
	let metaBits = 0, metaWidth = 0, meta: Uint32Array | null = null, numGroups = 1;
	if (level0 && br.read(1)) {
		metaBits = br.read(3) + 2;
		metaWidth = subSample(xsize, metaBits);
		meta = decodeEntropyImage(br, metaWidth, subSample(height, metaBits), false).pixels;
		for (let i = 0; i < meta.length; i++) {
			const g = (meta[i] >>> 8) & 0xffff;
			if (g >= numGroups) numGroups = g + 1;
		}
	}
	const cacheSize = cacheBits ? 1 << cacheBits : 0;
	const alphabets = [NUM_LITERAL_CODES + NUM_LENGTH_CODES + cacheSize, 256, 256, 256, NUM_DISTANCE_CODES];
	const groups: Huffman[][] = [];
	for (let g = 0; g < numGroups; g++) groups.push(alphabets.map((a) => readHuffmanCode(br, a)));

	const total = xsize * height;
	const out = new Uint32Array(total);
	const cache = cacheBits ? new Uint32Array(cacheSize) : null;
	const shift = 32 - cacheBits;
	const mask = meta ? (1 << metaBits) - 1 : -1;
	const groupAt = (x: number, y: number): Huffman[] => groups[meta ? (meta[(y >> metaBits) * metaWidth + (x >> metaBits)] >>> 8) & 0xffff : 0];
	let pos = 0, x = 0, y = 0;
	let group = groupAt(0, 0);
	while (pos < total) {
		if ((x & mask) === 0) group = groupAt(x, y);
		const s = readSymbol(br, group[0]);
		if (s < NUM_LITERAL_CODES) {
			const r = readSymbol(br, group[1]);
			const b = readSymbol(br, group[2]);
			const a = readSymbol(br, group[3]);
			const argb = ((a << 24) | (r << 16) | (s << 8) | b) >>> 0;
			out[pos++] = argb;
			if (cache) cache[Math.imul(0x1e35a7bd, argb) >>> shift] = argb;
			if (++x >= xsize) { x = 0; y++; }
		} else if (s < NUM_LITERAL_CODES + NUM_LENGTH_CODES) {
			const length = copyValue(br, s - NUM_LITERAL_CODES);
			const distCode = copyValue(br, readSymbol(br, group[4]));
			let dist: number;
			if (distCode > 120) {
				dist = distCode - 120;
			} else {
				const v = CODE_TO_PLANE[distCode - 1];
				dist = (v >> 4) * xsize + 8 - (v & 15);
				if (dist < 1) dist = 1;
			}
			if (pos < dist || total - pos < length) throw new Error('VP8L: bad backward reference');
			for (let i = 0; i < length; i++, pos++) {
				const argb = out[pos - dist];
				out[pos] = argb;
				if (cache) cache[Math.imul(0x1e35a7bd, argb) >>> shift] = argb;
			}
			x += length;
			while (x >= xsize) { x -= xsize; y++; }
			if (pos < total) group = groupAt(x, y);
		} else {
			if (!cache || s - 280 >= cacheSize) throw new Error('VP8L: bad cache index');
			out[pos++] = cache[s - 280];
			if (++x >= xsize) { x = 0; y++; }
		}
	}
	return { pixels: out, transforms, width: xsize };
}

interface Transform {
	/** 0 predictor, 1 cross colour, 2 subtract green, 3 colour indexing */
	type: number;
	bits: number;
	/** Image width and height this transform applies to (unpacked, for colour indexing). */
	xsize: number;
	ysize: number;
	data: Uint32Array;
}

const avg2 = (a: number, b: number): number => ((((a ^ b) & 0xfefefefe) >>> 1) + (a & b)) >>> 0;
const clip255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

function select(t: number, l: number, tl: number): number {
	let d = 0;
	for (let s = 0; s < 32; s += 8) {
		const a = (t >>> s) & 255, b = (l >>> s) & 255, c = (tl >>> s) & 255;
		d += Math.abs(b - c) - Math.abs(a - c);
	}
	return d <= 0 ? t : l;
}

function addSubFull(a: number, b: number, c: number): number {
	let r = 0;
	for (let s = 0; s < 32; s += 8) r |= clip255(((a >>> s) & 255) + ((b >>> s) & 255) - ((c >>> s) & 255)) << s;
	return r >>> 0;
}

function addSubHalf(a: number, b: number): number {
	let r = 0;
	for (let s = 0; s < 32; s += 8) {
		const x = (a >>> s) & 255, y = (b >>> s) & 255;
		r |= clip255(x + Math.trunc((x - y) / 2)) << s;
	}
	return r >>> 0;
}

function predict(mode: number, l: number, t: number, tr: number, tl: number): number {
	switch (mode) {
		case 1: return l;
		case 2: return t;
		case 3: return tr;
		case 4: return tl;
		case 5: return avg2(avg2(l, tr), t);
		case 6: return avg2(l, tl);
		case 7: return avg2(l, t);
		case 8: return avg2(tl, t);
		case 9: return avg2(t, tr);
		case 10: return avg2(avg2(l, tl), avg2(t, tr));
		case 11: return select(t, l, tl);
		case 12: return addSubFull(l, t, tl);
		case 13: return addSubHalf(avg2(l, t), tl);
		default: return 0xff000000;
	}
}

/** Adds two ARGB words per component, modulo 256. */
const addPixels = (a: number, b: number): number => ((((a & 0xff00ff00) >>> 0) + ((b & 0xff00ff00) >>> 0)) & 0xff00ff00 | (((a & 0x00ff00ff) + (b & 0x00ff00ff)) & 0x00ff00ff)) >>> 0;

function applyTransform(t: Transform, src: Uint32Array, width: number): Uint32Array {
	const height = t.ysize;
	if (t.type === 0) {
		const out = new Uint32Array(width * height);
		const tilesPerRow = subSample(width, t.bits);
		for (let y = 0; y < height; y++) {
			const row = y * width;
			for (let x = 0; x < width; x++) {
				const i = row + x;
				let p: number;
				if (y === 0) p = x === 0 ? 0xff000000 : out[i - 1];
				else if (x === 0) p = out[i - width];
				else p = predict((t.data[(y >> t.bits) * tilesPerRow + (x >> t.bits)] >>> 8) & 15, out[i - 1], out[i - width], out[i - width + 1], out[i - width - 1]);
				out[i] = addPixels(src[i], p);
			}
		}
		return out;
	}
	if (t.type === 1) {
		const out = new Uint32Array(width * height);
		const tilesPerRow = subSample(width, t.bits);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const code = t.data[(y >> t.bits) * tilesPerRow + (x >> t.bits)];
				const g2r = (code << 24) >> 24, g2b = (code << 16) >> 24, r2b = (code << 8) >> 24;
				const argb = src[y * width + x];
				const green = (argb << 16) >> 24;
				let red = (argb >>> 16) & 255, blue = argb & 255;
				red = (red + ((g2r * green) >> 5)) & 255;
				blue = (blue + ((g2b * green) >> 5) + ((r2b * ((red << 24) >> 24)) >> 5)) & 255;
				out[y * width + x] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0;
			}
		}
		return out;
	}
	if (t.type === 2) {
		const out = new Uint32Array(src.length);
		for (let i = 0; i < src.length; i++) {
			const argb = src[i], g = (argb >>> 8) & 255;
			out[i] = ((argb & 0xff00ff00) | ((((argb >>> 16) + g) & 255) << 16) | ((argb + g) & 255)) >>> 0;
		}
		return out;
	}
	// Colour indexing: unpack `1 << (3 - bits)` indices per word, then look up the palette.
	const out = new Uint32Array(t.xsize * height);
	const perWord = 1 << t.bits;
	const bitsPer = 8 >> t.bits;
	const idxMask = (1 << bitsPer) - 1;
	const packedWidth = subSample(t.xsize, t.bits);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < t.xsize; x++) {
			let idx: number;
			if (t.bits === 0) idx = (src[y * packedWidth + x] >>> 8) & 255;
			else idx = (((src[y * packedWidth + (x >> t.bits)] >>> 8) & 255) >> ((x & (perWord - 1)) * bitsPer)) & idxMask;
			out[y * t.xsize + x] = idx < t.data.length ? t.data[idx] : 0;
		}
	}
	return out;
}

function decodeStream(br: BitReader, width: number, height: number): Uint32Array {
	const { pixels, transforms, width: codedWidth } = decodeEntropyImage(br, width, height, true);
	let out = pixels, w = codedWidth;
	for (let i = transforms.length - 1; i >= 0; i--) {
		const t = transforms[i];
		w = t.type === 3 ? t.xsize : w;
		out = applyTransform(t, out, w);
	}
	return out;
}

/** Decodes a `VP8L` chunk payload to ARGB words. */
export function decodeVp8l(data: Uint8Array): { argb: Uint32Array; width: number; height: number } {
	if (data.length < 5 || data[0] !== 0x2f) throw new Error('VP8L: bad signature');
	const head = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
	const width = (head & 0x3fff) + 1, height = ((head >>> 14) & 0x3fff) + 1;
	if ((head >>> 29) !== 0) throw new Error('VP8L: bad version');
	const br = new BitReader(data);
	br.pos = 40;
	return { argb: decodeStream(br, width, height), width, height };
}

/** Decodes the headerless lossless stream of an `ALPH` chunk to one alpha byte per pixel. */
export function decodeVp8lAlpha(data: Uint8Array, width: number, height: number): Uint8Array {
	const px = decodeStream(new BitReader(data), width, height);
	const alpha = new Uint8Array(px.length);
	for (let i = 0; i < px.length; i++) alpha[i] = (px[i] >>> 8) & 255;
	return alpha;
}
