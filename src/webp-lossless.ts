/**
 * WebP lossless (VP8L) bitstream encoder.
 *
 * Encodes ARGB pixels exactly. The tools used are the ones that pay off for
 * metafile renderings (flat fills, lines, text, gradients): a colour-index
 * (palette) transform when the image has at most 256 colours, otherwise
 * subtract-green plus a per-block predictor transform; LZ77 backward
 * references found through a hash chain (with the 2-D neighbourhood distance
 * codes), an optional colour cache, and canonical Huffman codes limited to
 * 15 bits. It does not chase libwebp's compression: there is no
 * cross-colour transform, no multi-group entropy image, and the predictor
 * search is a cheap residual-magnitude proxy over a subset of the modes.
 *
 * The format is specified in the "WebP Lossless Bitstream Specification"
 * (https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification).
 * The 120-entry distance-neighbourhood table below is part of that spec.
 *
 * @module webp-lossless
 */

/** Little-endian, LSB-first bit writer as VP8L requires. */
class BitWriter {
	private buf = new Uint8Array(1 << 16);
	private pos = 0;
	private acc = 0;
	private count = 0;

	/** Appends the low `n` bits (0..24) of `value`, least significant first. */
	write(value: number, n: number): void {
		if (n === 0) {
			return;
		}
		this.acc |= (value & ((1 << n) - 1)) << this.count;
		this.count += n;
		while (this.count >= 8) {
			if (this.pos === this.buf.length) {
				const bigger = new Uint8Array(this.buf.length * 2);
				bigger.set(this.buf);
				this.buf = bigger;
			}
			this.buf[this.pos++] = this.acc & 0xff;
			this.acc >>>= 8;
			this.count -= 8;
		}
	}

	/** Pads to a byte boundary and returns the written bytes. */
	finish(): Uint8Array {
		if (this.count > 0) {
			this.write(0, 8 - this.count);
		}
		return this.buf.subarray(0, this.pos);
	}
}

/** Options for {@link encodeVp8l} and {@link encodeVp8lStream}. */
export interface Vp8lOptions {
	/** `true` when any pixel is not fully opaque (sets the header alpha hint). */
	hasAlpha: boolean;
	/** Try the subtract-green transform (off for single-plane data such as alpha). Default true. */
	subtractGreen?: boolean;
}

const MAX_HUFFMAN_BITS = 15;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;
const MAX_MATCH = 4096;
const MAX_DISTANCE = (1 << 20) - 120;
const MIN_MATCH = 3;
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** The 120 (xi, yi) neighbourhood offsets that short distance codes name, in code order. */
const DISTANCE_MAP: readonly number[] = [
	0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2, 2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3, 3, 1, -3, 1,
	2, 3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0, 1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5, 3,
	4, -3, 4, 4, 3, -4, 3, 5, 0, 1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2, 4, 4, -4, 4, 3, 5, -3, 5, 5, 3,
	-5, 3, 0, 6, 6, 0, 1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6, -3, 6, 6,
	3, -6, 3, 0, 7, 7, 0, 1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7, 7, 2, -7, 2,
	3, 7, -3, 7, 7, 3, -7, 3, 5, 6, -5, 6, 6, 5, -6, 5, 8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2, 6, 6, -6, 6, 8, 3,
	5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6, 7, -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7,
];

/** Plane-code lookup by (yi * 17 + xi + 8): 1-based code, 0 when the offset has no short code. */
const PLANE_CODE = new Uint8Array(8 * 17);
for (let c = 0; c < 120; c++) {
	PLANE_CODE[DISTANCE_MAP[c * 2 + 1] * 17 + DISTANCE_MAP[c * 2] + 8] = c + 1;
}

/** Maps a pixel distance to the VP8L distance code (short 2-D code when one exists). */
function distanceToCode(dist: number, xsize: number): number {
	const yi = Math.floor(dist / xsize);
	const xi = dist - yi * xsize;
	let best = 0;
	if (yi < 8 && xi <= 8) {
		best = PLANE_CODE[yi * 17 + xi + 8];
	}
	if (yi + 1 < 8 && xi - xsize >= -8) {
		const c = PLANE_CODE[(yi + 1) * 17 + xi - xsize + 8];
		if (c !== 0 && (best === 0 || c < best)) {
			best = c;
		}
	}
	return best !== 0 ? best : dist + 120;
}

// Result slots of prefixEncode (module-level to avoid allocating per call).
let pfxSymbol = 0;
let pfxExtraBits = 0;
let pfxExtraValue = 0;

/** Splits a value >= 1 into a prefix symbol plus extra bits, as VP8L lengths and distances do. */
function prefixEncode(value: number): void {
	if (value <= 4) {
		pfxSymbol = value - 1;
		pfxExtraBits = 0;
		pfxExtraValue = 0;
		return;
	}
	const v = value - 1;
	const highest = 31 - Math.clz32(v);
	const second = (v >>> (highest - 1)) & 1;
	pfxExtraBits = highest - 1;
	pfxExtraValue = v & ((1 << pfxExtraBits) - 1);
	pfxSymbol = 2 * highest + second;
}

/** Canonical Huffman code: bit lengths plus bit-reversed codes ready for an LSB-first writer. */
interface HuffmanCode {
	lengths: Uint8Array;
	codes: Uint16Array;
	/** One symbol only: it is written with zero bits. */
	single: boolean;
}

/**
 * Computes length-limited Huffman code lengths for a histogram. When the
 * plain tree is too deep, the counts are floored at growing minimums
 * (flattening the tree) until it fits, which is cheap and close to optimal.
 */
function huffmanLengths(counts: ArrayLike<number>, limit: number): Uint8Array {
	const n = counts.length;
	const lengths = new Uint8Array(n);
	const syms: number[] = [];
	for (let i = 0; i < n; i++) {
		if (counts[i] > 0) {
			syms.push(i);
		}
	}
	const m = syms.length;
	if (m === 0) {
		return lengths;
	}
	if (m === 1) {
		lengths[syms[0]] = 1;
		return lengths;
	}
	const total = 2 * m - 1;
	const weight = new Float64Array(total);
	const parent = new Int32Array(total);
	const depth = new Uint8Array(total);
	for (let countMin = 1; ; countMin *= 2) {
		const order = syms.slice().sort((a, b) => Math.max(counts[a], countMin) - Math.max(counts[b], countMin) || a - b);
		for (let k = 0; k < m; k++) {
			weight[k] = Math.max(counts[order[k]], countMin);
		}
		let leaf = 0;
		let node = m;
		for (let next = m; next < total; next++) {
			let sum = 0;
			for (let pick = 0; pick < 2; pick++) {
				let take: number;
				if (leaf < m && (node >= next || weight[leaf] <= weight[node])) {
					take = leaf++;
				} else {
					take = node++;
				}
				parent[take] = next;
				sum += weight[take];
			}
			weight[next] = sum;
		}
		let maxDepth = 0;
		depth[total - 1] = 0;
		for (let i = total - 2; i >= 0; i--) {
			depth[i] = depth[parent[i]] + 1;
			if (i < m && depth[i] > maxDepth) {
				maxDepth = depth[i];
			}
		}
		if (maxDepth <= limit) {
			for (let k = 0; k < m; k++) {
				lengths[order[k]] = depth[k];
			}
			return lengths;
		}
	}
}

/** Builds canonical, bit-reversed codes from code lengths. */
function makeCode(lengths: Uint8Array): HuffmanCode {
	const n = lengths.length;
	const codes = new Uint16Array(n);
	const blCount = new Uint16Array(MAX_HUFFMAN_BITS + 2);
	let used = 0;
	for (let i = 0; i < n; i++) {
		if (lengths[i] > 0) {
			blCount[lengths[i]]++;
			used++;
		}
	}
	const next = new Uint16Array(MAX_HUFFMAN_BITS + 2);
	let code = 0;
	for (let bits = 1; bits <= MAX_HUFFMAN_BITS; bits++) {
		code = (code + blCount[bits - 1]) << 1;
		next[bits] = code;
	}
	for (let i = 0; i < n; i++) {
		const len = lengths[i];
		if (len > 0) {
			const c = next[len]++;
			let rev = 0;
			for (let b = 0; b < len; b++) {
				rev |= ((c >>> b) & 1) << (len - 1 - b);
			}
			codes[i] = rev;
		}
	}
	return { lengths, codes, single: used === 1 };
}

/** Writes one symbol with its code (nothing for a single-symbol code). */
function putSymbol(bw: BitWriter, code: HuffmanCode, sym: number): void {
	if (!code.single) {
		bw.write(code.codes[sym], code.lengths[sym]);
	}
}

/** Writes a Huffman code description (simple form when it fits, else code-length coded). */
function writeCodeLengths(bw: BitWriter, lengths: Uint8Array): void {
	const used: number[] = [];
	for (let i = 0; i < lengths.length; i++) {
		if (lengths[i] > 0) {
			used.push(i);
		}
	}
	if (used.length <= 2 && (used.length === 0 || used[used.length - 1] < 256)) {
		bw.write(1, 1);
		bw.write(Math.max(0, used.length - 1), 1);
		const first = used.length > 0 ? used[0] : 0;
		if (first < 2) {
			bw.write(0, 1);
			bw.write(first, 1);
		} else {
			bw.write(1, 1);
			bw.write(first, 8);
		}
		if (used.length === 2) {
			bw.write(used[1], 8);
		}
		return;
	}
	// Run-length tokens over the code lengths: 0..15 literal, 16 repeat previous, 17/18 zero runs.
	const tokSym: number[] = [];
	const tokExtra: number[] = [];
	const n = lengths.length;
	for (let i = 0; i < n; ) {
		const v = lengths[i];
		let run = 1;
		while (i + run < n && lengths[i + run] === v) {
			run++;
		}
		i += run;
		if (v === 0) {
			while (run >= 3) {
				if (run >= 11) {
					const take = Math.min(run, 138);
					tokSym.push(18);
					tokExtra.push(take - 11);
					run -= take;
				} else {
					tokSym.push(17);
					tokExtra.push(run - 3);
					run = 0;
				}
			}
			while (run-- > 0) {
				tokSym.push(0);
				tokExtra.push(0);
			}
		} else {
			tokSym.push(v);
			tokExtra.push(0);
			run--;
			while (run >= 3) {
				const take = Math.min(run, 6);
				tokSym.push(16);
				tokExtra.push(take - 3);
				run -= take;
			}
			while (run-- > 0) {
				tokSym.push(v);
				tokExtra.push(0);
			}
		}
	}
	const freq = new Uint32Array(19);
	for (const s of tokSym) {
		freq[s]++;
	}
	const clCode = makeCode(huffmanLengths(freq, 7));
	let numCodes = 19;
	while (numCodes > 4 && clCode.lengths[CODE_LENGTH_ORDER[numCodes - 1]] === 0) {
		numCodes--;
	}
	bw.write(0, 1);
	bw.write(numCodes - 4, 4);
	for (let i = 0; i < numCodes; i++) {
		bw.write(clCode.lengths[CODE_LENGTH_ORDER[i]], 3);
	}
	bw.write(0, 1); // all symbols are coded
	for (let t = 0; t < tokSym.length; t++) {
		const s = tokSym[t];
		putSymbol(bw, clCode, s);
		if (s === 16) {
			bw.write(tokExtra[t], 2);
		} else if (s === 17) {
			bw.write(tokExtra[t], 3);
		} else if (s === 18) {
			bw.write(tokExtra[t], 7);
		}
	}
}

/** Backward references found by {@link findBackwardRefs}: copy `len` pixels from `dist` back at `pos`. */
interface BackwardRefs {
	pos: Int32Array;
	len: Int32Array;
	dist: Int32Array;
	count: number;
}

/** Greedy-with-lazy LZ77 over the pixels using a hash chain on pixel pairs. */
function findBackwardRefs(px: Uint32Array, xsize: number, n: number): BackwardRefs {
	const hashBits = n > 1 << 16 ? 18 : 14;
	const head = new Int32Array(1 << hashBits).fill(-1);
	const prev = new Int32Array(n);
	const maxChain = n > 1 << 22 ? 12 : n > 1 << 20 ? 24 : 48;
	let cap = 1024;
	let pos = new Int32Array(cap);
	let len = new Int32Array(cap);
	let dist = new Int32Array(cap);
	let count = 0;
	const shift = 32 - hashBits;
	const hashAt = (i: number): number => (Math.imul(px[i], 0x9e3779b1) ^ Math.imul(px[i + 1], 0x85ebca6b)) >>> shift;
	let inserted = 0; // positions < inserted are in the hash chains
	const insertUpTo = (end: number): void => {
		const stop = Math.min(end, n - 1);
		for (; inserted < stop; inserted++) {
			const h = hashAt(inserted);
			prev[inserted] = head[h];
			head[h] = inserted;
		}
	};
	let bestLen = 0;
	let bestDist = 0;
	const matchLength = (i: number, j: number, limit: number): number => {
		let l = 0;
		while (l < limit && px[i + l] === px[j + l]) {
			l++;
		}
		return l;
	};
	const search = (i: number): void => {
		bestLen = 0;
		bestDist = 0;
		const limit = Math.min(MAX_MATCH, n - i);
		if (limit < MIN_MATCH) {
			return;
		}
		if (i >= 1) {
			const l = matchLength(i, i - 1, limit);
			if (l > bestLen) {
				bestLen = l;
				bestDist = 1;
			}
		}
		if (bestLen < limit && i >= xsize && xsize > 1) {
			const l = matchLength(i, i - xsize, limit);
			if (l > bestLen) {
				bestLen = l;
				bestDist = xsize;
			}
		}
		if (bestLen >= limit) {
			return;
		}
		let j = head[hashAt(i)];
		for (let chain = 0; j >= 0 && chain < maxChain; chain++, j = prev[j]) {
			const d = i - j;
			if (d > MAX_DISTANCE) {
				break;
			}
			if (px[j + bestLen] !== px[i + bestLen]) {
				continue;
			}
			const l = matchLength(i, j, limit);
			if (l > bestLen) {
				bestLen = l;
				bestDist = d;
				if (l >= limit) {
					break;
				}
			}
		}
	};
	let i = 0;
	while (i < n) {
		insertUpTo(i);
		search(i);
		let l = bestLen;
		let d = bestDist;
		if (l >= MIN_MATCH && l < 64 && i + 1 < n) {
			// Lazy matching: a clearly longer match one pixel on beats this one.
			insertUpTo(i + 1);
			search(i + 1);
			if (bestLen > l + 1) {
				i++;
				l = bestLen;
				d = bestDist;
			}
		}
		if (l >= MIN_MATCH) {
			if (count === cap) {
				cap *= 2;
				const p2 = new Int32Array(cap);
				p2.set(pos);
				pos = p2;
				const l2 = new Int32Array(cap);
				l2.set(len);
				len = l2;
				const d2 = new Int32Array(cap);
				d2.set(dist);
				dist = d2;
			}
			pos[count] = i;
			len[count] = l;
			dist[count] = d;
			count++;
			i += l;
		} else {
			i++;
		}
	}
	return { pos, len, dist, count };
}

/** Literal / cache / copy token stream plus the histograms of its five symbol alphabets. */
interface TokenStream {
	kind: Uint8Array; // 0 literal, 1 cache hit, 2 copy
	a: Uint32Array; // argb, cache index, or copy length
	b: Uint32Array; // copy: distance code
	count: number;
	green: Uint32Array;
	red: Uint32Array;
	blue: Uint32Array;
	alpha: Uint32Array;
	dist: Uint32Array;
	extraBits: number;
}

/** Applies the colour cache (if any) over the literal/copy decisions and tallies histograms. */
function buildTokens(px: Uint32Array, n: number, refs: BackwardRefs, cacheBits: number, xsize: number): TokenStream {
	const cacheSize = cacheBits > 0 ? 1 << cacheBits : 0;
	const ts: TokenStream = {
		kind: new Uint8Array(n),
		a: new Uint32Array(n),
		b: new Uint32Array(n),
		count: 0,
		green: new Uint32Array(256 + NUM_LENGTH_CODES + cacheSize),
		red: new Uint32Array(256),
		blue: new Uint32Array(256),
		alpha: new Uint32Array(256),
		dist: new Uint32Array(NUM_DISTANCE_CODES),
		extraBits: 0,
	};
	const cache = new Uint32Array(cacheSize || 1);
	const shift = 32 - cacheBits;
	let t = 0;
	let ri = 0;
	let i = 0;
	while (i < n) {
		if (ri < refs.count && refs.pos[ri] === i) {
			const l = refs.len[ri];
			const code = distanceToCode(refs.dist[ri], xsize);
			ri++;
			ts.kind[t] = 2;
			ts.a[t] = l;
			ts.b[t] = code;
			t++;
			prefixEncode(l);
			ts.green[256 + pfxSymbol]++;
			ts.extraBits += pfxExtraBits;
			prefixEncode(code);
			ts.dist[pfxSymbol]++;
			ts.extraBits += pfxExtraBits;
			if (cacheSize > 0) {
				for (let k = 0; k < l; k++) {
					const v = px[i + k];
					cache[Math.imul(v, 0x1e35a7bd) >>> shift] = v;
				}
			}
			i += l;
			continue;
		}
		const v = px[i++];
		if (cacheSize > 0) {
			const key = Math.imul(v, 0x1e35a7bd) >>> shift;
			if (cache[key] === v) {
				ts.kind[t] = 1;
				ts.a[t] = key;
				t++;
				ts.green[256 + NUM_LENGTH_CODES + key]++;
				continue;
			}
			cache[key] = v;
		}
		ts.kind[t] = 0;
		ts.a[t] = v;
		t++;
		ts.green[(v >>> 8) & 0xff]++;
		ts.red[(v >>> 16) & 0xff]++;
		ts.blue[v & 0xff]++;
		ts.alpha[v >>> 24]++;
	}
	ts.count = t;
	return ts;
}

/** Estimated coded size in bits of a token stream (symbol bits plus extra bits). */
function streamCost(ts: TokenStream): number {
	let bits = ts.extraBits;
	for (const hist of [ts.green, ts.red, ts.blue, ts.alpha, ts.dist]) {
		const lengths = huffmanLengths(hist, MAX_HUFFMAN_BITS);
		let used = 0;
		for (let s = 0; s < hist.length; s++) {
			if (hist[s] > 0) {
				bits += hist[s] * lengths[s];
				used++;
			}
		}
		bits += used * 6; // rough cost of describing the code
	}
	return bits;
}

/**
 * Writes one entropy-coded image (the format's "image data"): optional colour
 * cache, a single prefix-code group, then the tokens. `main` marks the
 * full-resolution image, which alone may have a cache and a meta-prefix bit.
 */
function writeImage(bw: BitWriter, px: Uint32Array, xsize: number, ysize: number, main: boolean): void {
	const n = xsize * ysize;
	const refs = findBackwardRefs(px, xsize, n);
	let best: TokenStream | null = null;
	let bestBits = 0;
	let bestCache = 0;
	const trials = main ? [0, 6, 10] : [0];
	for (const cacheBits of trials) {
		const ts = buildTokens(px, n, refs, cacheBits, xsize);
		const bits = trials.length > 1 ? streamCost(ts) : 0;
		if (best === null || bits < bestBits) {
			best = ts;
			bestBits = bits;
			bestCache = cacheBits;
		}
	}
	const ts = best as TokenStream;
	if (bestCache > 0) {
		bw.write(1, 1);
		bw.write(bestCache, 4);
	} else {
		bw.write(0, 1);
	}
	if (main) {
		bw.write(0, 1); // a single prefix-code group
	}
	const greenCode = makeCode(huffmanLengths(ts.green, MAX_HUFFMAN_BITS));
	const redCode = makeCode(huffmanLengths(ts.red, MAX_HUFFMAN_BITS));
	const blueCode = makeCode(huffmanLengths(ts.blue, MAX_HUFFMAN_BITS));
	const alphaCode = makeCode(huffmanLengths(ts.alpha, MAX_HUFFMAN_BITS));
	const distCode = makeCode(huffmanLengths(ts.dist, MAX_HUFFMAN_BITS));
	for (const code of [greenCode, redCode, blueCode, alphaCode, distCode]) {
		writeCodeLengths(bw, code.lengths);
	}
	for (let t = 0; t < ts.count; t++) {
		const kind = ts.kind[t];
		if (kind === 0) {
			const v = ts.a[t];
			putSymbol(bw, greenCode, (v >>> 8) & 0xff);
			putSymbol(bw, redCode, (v >>> 16) & 0xff);
			putSymbol(bw, blueCode, v & 0xff);
			putSymbol(bw, alphaCode, v >>> 24);
		} else if (kind === 1) {
			putSymbol(bw, greenCode, 256 + NUM_LENGTH_CODES + ts.a[t]);
		} else {
			prefixEncode(ts.a[t]);
			putSymbol(bw, greenCode, 256 + pfxSymbol);
			bw.write(pfxExtraValue, pfxExtraBits);
			prefixEncode(ts.b[t]);
			putSymbol(bw, distCode, pfxSymbol);
			bw.write(pfxExtraValue, pfxExtraBits);
		}
	}
}

/** Per-channel `a - b` modulo 256 of two packed ARGB pixels. */
function subPixels(a: number, b: number): number {
	return (
		((((a >>> 24) - (b >>> 24)) & 0xff) << 24) |
		((((a >>> 16) - (b >>> 16)) & 0xff) << 16) |
		((((a >>> 8) - (b >>> 8)) & 0xff) << 8) |
		(((a - b) & 0xff))
	) >>> 0;
}

/** Per-channel average (rounded down) of two packed ARGB pixels. */
function average2(a: number, b: number): number {
	return ((((a ^ b) & 0xfefefefe) >>> 1) + (a & b)) >>> 0;
}

function clamp255(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** The predictor for `mode` (0..13) given left, top, top-right and top-left pixels. */
function predictPixel(mode: number, L: number, T: number, TR: number, TL: number): number {
	switch (mode) {
		case 0:
			return 0xff000000;
		case 1:
			return L;
		case 2:
			return T;
		case 3:
			return TR;
		case 4:
			return TL;
		case 5:
			return average2(average2(L, TR), T);
		case 6:
			return average2(L, TL);
		case 7:
			return average2(L, T);
		case 8:
			return average2(TL, T);
		case 9:
			return average2(T, TR);
		case 10:
			return average2(average2(L, TL), average2(T, TR));
		case 11: {
			// Select: whichever of L and T is closer to the gradient estimate L + T - TL.
			let pL = 0;
			let pT = 0;
			for (let s = 0; s < 32; s += 8) {
				const l = (L >>> s) & 0xff;
				const t = (T >>> s) & 0xff;
				const tl = (TL >>> s) & 0xff;
				pL += Math.abs(t - tl);
				pT += Math.abs(l - tl);
			}
			return pL < pT ? L : T;
		}
		case 12: {
			let out = 0;
			for (let s = 0; s < 32; s += 8) {
				out |= clamp255(((L >>> s) & 0xff) + ((T >>> s) & 0xff) - ((TL >>> s) & 0xff)) << s;
			}
			return out >>> 0;
		}
		default: {
			const avg = average2(L, T);
			let out = 0;
			for (let s = 0; s < 32; s += 8) {
				const a = (avg >>> s) & 0xff;
				const c = (TL >>> s) & 0xff;
				out |= clamp255(a + (((a - c) / 2) | 0)) << s;
			}
			return out >>> 0;
		}
	}
}

/** Approximate coded bits of a residual byte by its signed magnitude. */
const RESIDUAL_COST = new Float32Array(256);
for (let r = 0; r < 256; r++) {
	const m = r < 128 ? r : 256 - r;
	RESIDUAL_COST[r] = m === 0 ? 0 : 1.5 + 2 * Math.log2(m);
}

/** Predictor modes tried per block, cheapest-to-test first. */
const CANDIDATE_MODES = [1, 2, 11, 12, 13, 3, 4, 7];

/**
 * Applies the predictor transform: picks a mode per block and returns the
 * residual image plus the block-mode image (mode in the green channel).
 */
function predictorTransform(
	px: Uint32Array,
	w: number,
	h: number,
	bits: number,
): { residual: Uint32Array; modes: Uint32Array; bw: number; bh: number } {
	const size = 1 << bits;
	const bw = Math.ceil(w / size);
	const bh = Math.ceil(h / size);
	const modes = new Uint32Array(bw * bh);
	const residual = new Uint32Array(w * h);
	for (let by = 0; by < bh; by++) {
		for (let bx = 0; bx < bw; bx++) {
			const x0 = bx * size;
			const y0 = by * size;
			const x1 = Math.min(w, x0 + size);
			const y1 = Math.min(h, y0 + size);
			let bestMode = 1;
			let bestCost = Infinity;
			for (const mode of CANDIDATE_MODES) {
				let cost = 0;
				for (let y = y0; y < y1 && cost < bestCost; y++) {
					for (let x = x0; x < x1; x++) {
						const i = y * w + x;
						if (y === 0 || x === 0) {
							continue; // edge pixels use fixed predictors, identical for every mode
						}
						const p = predictPixel(mode, px[i - 1], px[i - w], px[i - w + 1], px[i - w - 1]);
						const v = px[i];
						if (p !== v) {
							cost +=
								RESIDUAL_COST[((v >>> 24) - (p >>> 24)) & 0xff] +
								RESIDUAL_COST[((v >>> 16) - (p >>> 16)) & 0xff] +
								RESIDUAL_COST[((v >>> 8) - (p >>> 8)) & 0xff] +
								RESIDUAL_COST[(v - p) & 0xff];
						}
					}
				}
				if (cost < bestCost) {
					bestCost = cost;
					bestMode = mode;
					if (cost === 0) {
						break;
					}
				}
			}
			modes[by * bw + bx] = (0xff000000 | (bestMode << 8)) >>> 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const i = y * w + x;
					let p: number;
					if (y === 0) {
						p = x === 0 ? 0xff000000 : px[i - 1];
					} else if (x === 0) {
						p = px[i - w];
					} else {
						p = predictPixel(bestMode, px[i - 1], px[i - w], px[i - w + 1], px[i - w - 1]);
					}
					residual[i] = subPixels(px[i], p);
				}
			}
		}
	}
	return { residual, modes, bw, bh };
}

/** Collects the distinct colours (insertion order) when there are at most 256, else null. */
function collectPalette(px: Uint32Array): Uint32Array | null {
	const index = new Map<number, number>();
	for (let i = 0; i < px.length; i++) {
		if (!index.has(px[i])) {
			if (index.size === 256) {
				return null;
			}
			index.set(px[i], index.size);
		}
	}
	return Uint32Array.from(index.keys());
}

/** Writes the stream body (transforms and image data) for the palette route. */
function writePalette(bw: BitWriter, px: Uint32Array, w: number, h: number, palette: Uint32Array): void {
	const colours = palette.length;
	const index = new Map<number, number>();
	palette.forEach((c, i) => index.set(c, i));
	const bundleBits = colours <= 2 ? 3 : colours <= 4 ? 2 : colours <= 16 ? 1 : 0;
	const bpp = 8 >> bundleBits; // bits per index
	const pw = Math.ceil(w / (1 << bundleBits));
	const packed = new Uint32Array(pw * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const idx = index.get(px[y * w + x]) as number;
			const o = y * pw + (x >> bundleBits);
			const g = ((packed[o] >>> 8) & 0xff) | (idx << (bpp * (x & ((1 << bundleBits) - 1))));
			packed[o] = (0xff000000 | (g << 8)) >>> 0;
		}
	}
	const delta = new Uint32Array(colours);
	for (let i = 0; i < colours; i++) {
		delta[i] = i === 0 ? palette[0] : subPixels(palette[i], palette[i - 1]);
	}
	bw.write(1, 1);
	bw.write(3, 2);
	bw.write(colours - 1, 8);
	writeImage(bw, delta, colours, 1, false);
	bw.write(0, 1); // no more transforms
	writeImage(bw, packed, pw, h, true);
}

/** Writes the stream body (transforms and image data) for the predictor route. */
function writePredicted(bw: BitWriter, px: Uint32Array, w: number, h: number, subtractGreen: boolean): void {
	let work = px;
	if (subtractGreen) {
		work = new Uint32Array(px.length);
		for (let i = 0; i < px.length; i++) {
			const v = px[i];
			const g = (v >>> 8) & 0xff;
			work[i] = ((v & 0xff00ff00) | ((((v >>> 16) - g) & 0xff) << 16) | ((v - g) & 0xff)) >>> 0;
		}
		bw.write(1, 1);
		bw.write(2, 2);
	}
	const bits = 4;
	const { residual, modes, bw: mw, bh: mh } = predictorTransform(work, w, h, bits);
	bw.write(1, 1);
	bw.write(0, 2);
	bw.write(bits - 2, 3);
	writeImage(bw, modes, mw, mh, false);
	bw.write(0, 1); // no more transforms
	writeImage(bw, residual, w, h, true);
}

/**
 * Encodes ARGB pixels as a VP8L image stream without the 5-byte header
 * (transforms + image data). This is the form the ALPH chunk of a lossy
 * WebP uses (with the plane in the green channel).
 *
 * @param argb    - `width * height` packed 0xAARRGGBB pixels.
 * @param width   - Image width (1..16384).
 * @param height  - Image height (1..16384).
 * @param options - See {@link Vp8lOptions}.
 */
export function encodeVp8lStream(argb: Uint32Array, width: number, height: number, options: Vp8lOptions): Uint8Array {
	const palette = collectPalette(argb);
	let best: Uint8Array | null = null;
	const attempt = (write: (bw: BitWriter) => void): void => {
		const bw = new BitWriter();
		write(bw);
		const bytes = bw.finish();
		if (best === null || bytes.length < best.length) {
			best = bytes;
		}
	};
	if (palette !== null) {
		attempt((bw) => writePalette(bw, argb, width, height, palette));
	}
	// A palette image rarely gains from prediction when bundling applies; skip the slow route then.
	if (palette === null || palette.length > 16) {
		attempt((bw) => writePredicted(bw, argb, width, height, options.subtractGreen !== false));
	}
	return best as unknown as Uint8Array;
}

/**
 * Encodes ARGB pixels as a complete VP8L bitstream (the payload of a
 * `VP8L` chunk).
 *
 * @param argb    - `width * height` packed 0xAARRGGBB pixels.
 * @param width   - Image width (1..16384).
 * @param height  - Image height (1..16384).
 * @param options - See {@link Vp8lOptions}.
 */
export function encodeVp8l(argb: Uint32Array, width: number, height: number, options: Vp8lOptions): Uint8Array {
	const body = encodeVp8lStream(argb, width, height, options);
	const head = new BitWriter();
	head.write(0x2f, 8);
	head.write(width - 1, 14);
	head.write(height - 1, 14);
	head.write(options.hasAlpha ? 1 : 0, 1);
	head.write(0, 3); // version
	const headBytes = head.finish();
	const out = new Uint8Array(headBytes.length + body.length);
	out.set(headBytes);
	out.set(body, headBytes.length);
	return out;
}
