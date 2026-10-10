/**
 * Dependency-free RGBA → baseline JPEG (JFIF) encoder, used for JPEG output
 * so the result is the same on every backend (browser canvas, Web Worker,
 * `@napi-rs/canvas` and the built-in software rasteriser), which all encode
 * JPEG differently or not at all.
 *
 * Baseline sequential DCT, 8-bit samples, YCbCr with full-resolution (4:4:4) or
 * 4:2:0 chroma, the example quantisation tables of ITU-T T.81 Annex K scaled
 * by the IJG quality formula, and the Annex K Huffman tables. JPEG has no
 * alpha channel: translucent pixels are composited over a background colour.
 *
 * @module jpeg-encoder
 */

/** Options for {@link encodeJpeg}. */
export interface JpegEncodeOptions {
	/** Quality from 0 to 1, as for `canvas.toDataURL('image/jpeg', quality)` (default 0.92). */
	quality?: number;
	/** Colour under translucent pixels, as `[r, g, b]` (default white). */
	background?: readonly [number, number, number];
	/**
	 * Average chroma over 2 x 2 pixels (4:2:0) for a smaller file. Off by
	 * default: full-resolution chroma (4:4:4) keeps coloured lines and text
	 * free of colour fringes.
	 */
	chromaSubsampling?: boolean;
}

/** Default quality, the same as browsers' `toDataURL('image/jpeg')`. */
export const DEFAULT_JPEG_QUALITY = 0.92;

/** Coefficient index (natural order) of each zig-zag position. */
const ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** T.81 Annex K.1 luminance quantisation table (natural order). */
const LUMA_QUANT = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
	18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** T.81 Annex K.1 chrominance quantisation table (natural order). */
const CHROMA_QUANT = [
	17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** A Huffman table as stored in DHT: code counts per length 1..16, then the symbols. */
interface HuffmanSpec {
	bits: number[];
	values: number[];
}

/** T.81 Annex K.3 tables. */
const DC_LUMA: HuffmanSpec = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA: HuffmanSpec = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA: HuffmanSpec = {
	bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
	values: [
		0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
		0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
		0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
		0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
		0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
		0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba,
		0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
		0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
	],
};
const AC_CHROMA: HuffmanSpec = {
	bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
	values: [
		0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81,
		0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
		0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
		0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
		0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92,
		0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
		0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
		0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
		0xf9, 0xfa,
	],
};

/** Huffman codes and lengths by symbol (T.81 Annex C). */
interface HuffmanCodes {
	code: Uint16Array;
	size: Uint8Array;
}

function buildCodes(spec: HuffmanSpec): HuffmanCodes {
	const code = new Uint16Array(256);
	const size = new Uint8Array(256);
	let next = 0;
	let k = 0;
	for (let len = 1; len <= 16; len++) {
		for (let i = 0; i < spec.bits[len - 1]; i++) {
			const symbol = spec.values[k++];
			code[symbol] = next++;
			size[symbol] = len;
		}
		next <<= 1;
	}
	return { code, size };
}

/** IJG quality scaling of a base table, returned in natural order. */
function scaleQuant(base: readonly number[], quality: number): Uint8Array {
	const q = Math.min(100, Math.max(1, Math.round(quality * 100)));
	const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
	return Uint8Array.from(base, (v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** `COS[u * 8 + x] = C(u) / 2 * cos((2x + 1) u π / 16)`, the separable forward DCT basis. */
const COS = (() => {
	const t = new Float64Array(64);
	for (let u = 0; u < 8; u++) {
		const c = u === 0 ? Math.SQRT1_2 : 1;
		for (let x = 0; x < 8; x++) {
			t[u * 8 + x] = (c / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
		}
	}
	return t;
})();

/** Forward DCT of a level-shifted 8 x 8 block, quantised, in zig-zag order. */
function fdctQuantize(block: Float64Array, quant: Uint8Array, out: Int32Array, tmp: Float64Array): void {
	for (let y = 0; y < 8; y++) {
		for (let u = 0; u < 8; u++) {
			let s = 0;
			for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * block[y * 8 + x];
			tmp[y * 8 + u] = s;
		}
	}
	for (let k = 0; k < 64; k++) {
		const n = ZIGZAG[k];
		const v = n >> 3;
		const u = n & 7;
		let s = 0;
		for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * tmp[y * 8 + u];
		out[k] = Math.round(s / quant[n]);
	}
}

/** Entropy-coded segment writer with 0xFF byte stuffing. */
class BitWriter {
	private buf = new Uint8Array(4096);
	length = 0;
	private acc = 0;
	private count = 0;

	private byte(b: number): void {
		if (this.length === this.buf.length) {
			const grown = new Uint8Array(this.buf.length * 2);
			grown.set(this.buf);
			this.buf = grown;
		}
		this.buf[this.length++] = b;
	}

	bits(value: number, size: number): void {
		for (let i = size - 1; i >= 0; i--) {
			this.acc = (this.acc << 1) | ((value >> i) & 1);
			if (++this.count === 8) {
				this.byte(this.acc);
				if (this.acc === 0xff) this.byte(0);
				this.acc = 0;
				this.count = 0;
			}
		}
	}

	/** Pads the last byte with 1 bits and returns the segment. */
	finish(): Uint8Array {
		if (this.count > 0) this.bits((1 << (8 - this.count)) - 1, 8 - this.count);
		return this.buf.subarray(0, this.length);
	}
}

/** Number of bits needed for |v| (the JPEG magnitude category). */
function category(v: number): number {
	let a = v < 0 ? -v : v;
	let n = 0;
	while (a) {
		n++;
		a >>= 1;
	}
	return n;
}

function writeBlock(w: BitWriter, coef: Int32Array, prevDc: number, dc: HuffmanCodes, ac: HuffmanCodes): number {
	const diff = coef[0] - prevDc;
	const dcSize = category(diff);
	w.bits(dc.code[dcSize], dc.size[dcSize]);
	if (dcSize) w.bits(diff < 0 ? diff - 1 : diff, dcSize);
	let run = 0;
	for (let k = 1; k < 64; k++) {
		const v = coef[k];
		if (v === 0) {
			run++;
			continue;
		}
		while (run > 15) {
			w.bits(ac.code[0xf0], ac.size[0xf0]);
			run -= 16;
		}
		const size = category(v);
		const symbol = (run << 4) | size;
		w.bits(ac.code[symbol], ac.size[symbol]);
		w.bits(v < 0 ? v - 1 : v, size);
		run = 0;
	}
	if (run > 0) w.bits(ac.code[0], ac.size[0]);
	return coef[0];
}

function segment(marker: number, payload: readonly number[] | Uint8Array): number[] {
	const len = payload.length + 2;
	return [0xff, marker, len >> 8, len & 0xff, ...payload];
}

function dhtPayload(tableClass: number, id: number, spec: HuffmanSpec): number[] {
	return [(tableClass << 4) | id, ...spec.bits, ...spec.values];
}

/**
 * Encodes straight (non-premultiplied) RGBA pixels as a baseline JPEG file.
 * Alpha is composited over {@link JpegEncodeOptions.background}.
 *
 * @param data   - `width * height * 4` bytes, row-major, top-down.
 * @param width  - Image width in pixels (1 to 65535).
 * @param height - Image height in pixels (1 to 65535).
 */
export function encodeJpeg(data: ArrayLike<number>, width: number, height: number, options: JpegEncodeOptions = {}): Uint8Array {
	if (!(width >= 1 && height >= 1 && width <= 0xffff && height <= 0xffff)) {
		throw new RangeError(`JPEG dimensions out of range: ${width}x${height}`);
	}
	const quality = Number.isFinite(options.quality) ? Math.min(1, Math.max(0, options.quality!)) : DEFAULT_JPEG_QUALITY;
	const [bgR, bgG, bgB] = options.background ?? [255, 255, 255];
	const sub = options.chromaSubsampling ?? false;
	const lumaQuant = scaleQuant(LUMA_QUANT, quality);
	const chromaQuant = scaleQuant(CHROMA_QUANT, quality);

	// Full-resolution YCbCr planes (JFIF), alpha composited over the background.
	const n = width * height;
	const Y = new Float64Array(n);
	const Cb = new Float64Array(n);
	const Cr = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const a = data[i * 4 + 3] / 255;
		const r = data[i * 4] * a + bgR * (1 - a);
		const g = data[i * 4 + 1] * a + bgG * (1 - a);
		const b = data[i * 4 + 2] * a + bgB * (1 - a);
		Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
		Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
		Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
	}

	const dcL = buildCodes(DC_LUMA);
	const acL = buildCodes(AC_LUMA);
	const dcC = buildCodes(DC_CHROMA);
	const acC = buildCodes(AC_CHROMA);
	const factor = sub ? 2 : 1;
	const mcu = 8 * factor;
	const block = new Float64Array(64);
	const tmp = new Float64Array(64);
	const coef = new Int32Array(64);
	const w = new BitWriter();
	let dcY = 0;
	let dcCb = 0;
	let dcCr = 0;

	/** Loads the luma block at (x0, y0), replicating edge pixels past the image. */
	const lumaBlock = (x0: number, y0: number): void => {
		for (let y = 0; y < 8; y++) {
			const row = Math.min(height - 1, y0 + y) * width;
			for (let x = 0; x < 8; x++) block[y * 8 + x] = Y[row + Math.min(width - 1, x0 + x)] - 128;
		}
	};
	/** Loads the chroma block of the MCU at (x0, y0), averaging `factor` x `factor` pixels. */
	const chromaBlock = (plane: Float64Array, x0: number, y0: number): void => {
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				let s = 0;
				for (let dy = 0; dy < factor; dy++) {
					const row = Math.min(height - 1, y0 + y * factor + dy) * width;
					for (let dx = 0; dx < factor; dx++) s += plane[row + Math.min(width - 1, x0 + x * factor + dx)];
				}
				block[y * 8 + x] = s / (factor * factor) - 128;
			}
		}
	};

	for (let my = 0; my < height; my += mcu) {
		for (let mx = 0; mx < width; mx += mcu) {
			for (let by = 0; by < factor; by++) {
				for (let bx = 0; bx < factor; bx++) {
					lumaBlock(mx + bx * 8, my + by * 8);
					fdctQuantize(block, lumaQuant, coef, tmp);
					dcY = writeBlock(w, coef, dcY, dcL, acL);
				}
			}
			chromaBlock(Cb, mx, my);
			fdctQuantize(block, chromaQuant, coef, tmp);
			dcCb = writeBlock(w, coef, dcCb, dcC, acC);
			chromaBlock(Cr, mx, my);
			fdctQuantize(block, chromaQuant, coef, tmp);
			dcCr = writeBlock(w, coef, dcCr, dcC, acC);
		}
	}
	const scan = w.finish();

	const sampling = (factor << 4) | factor;
	const header = [
		0xff, 0xd8,
		// APP0 JFIF 1.01, no density (aspect ratio 1:1), no thumbnail.
		...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
		...segment(0xdb, [0, ...ZIGZAG.map((i) => lumaQuant[i]), 1, ...ZIGZAG.map((i) => chromaQuant[i])]),
		...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, sampling, 0, 2, 0x11, 1, 3, 0x11, 1]),
		...segment(0xc4, [...dhtPayload(0, 0, DC_LUMA), ...dhtPayload(1, 0, AC_LUMA), ...dhtPayload(0, 1, DC_CHROMA), ...dhtPayload(1, 1, AC_CHROMA)]),
		...segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]),
	];
	const out = new Uint8Array(header.length + scan.length + 2);
	out.set(header, 0);
	out.set(scan, header.length);
	out[out.length - 2] = 0xff;
	out[out.length - 1] = 0xd9;
	return out;
}
