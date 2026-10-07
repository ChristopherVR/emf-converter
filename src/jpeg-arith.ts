/**
 * QM-coder entropy decoding for arithmetic-coded JPEG (ITU-T T.81 Annex D/F
 * and T.88).
 *
 * This is a port of the entropy decoder in libjpeg's `jdarith.c` and of the
 * probability-state table in `jaricom.c` (Independent JPEG Group, copyright
 * (C) 1991-2020 Thomas G. Lane, Guido Vollbeding; Nils Larsson's arithmetic
 * coding extension), as distributed in libjpeg-turbo. This software is based
 * in part on the work of the Independent JPEG Group; see THIRD_PARTY_NOTICES
 * for the IJG license. It produces the same quantised coefficients as the
 * Huffman decoder would for the same image; reconstruction is shared with
 * `jpeg-turbo.ts`.
 */

/** The 113 probability states of Table D.3 plus the fixed 0.5 estimate (index 113): [Qe, next index after LPS, next after MPS, switch MPS]. */
const STATES: readonly (readonly [number, number, number, number])[] = [
	[0x5a1d, 1, 1, 1], [0x2586, 14, 2, 0], [0x1114, 16, 3, 0], [0x080b, 18, 4, 0], [0x03d8, 20, 5, 0], [0x01da, 23, 6, 0], [0x00e5, 25, 7, 0],
	[0x006f, 28, 8, 0], [0x0036, 30, 9, 0], [0x001a, 33, 10, 0], [0x000d, 35, 11, 0], [0x0006, 9, 12, 0], [0x0003, 10, 13, 0], [0x0001, 12, 13, 0],
	[0x5a7f, 15, 15, 1], [0x3f25, 36, 16, 0], [0x2cf2, 38, 17, 0], [0x207c, 39, 18, 0], [0x17b9, 40, 19, 0], [0x1182, 42, 20, 0], [0x0cef, 43, 21, 0],
	[0x09a1, 45, 22, 0], [0x072f, 46, 23, 0], [0x055c, 48, 24, 0], [0x0406, 49, 25, 0], [0x0303, 51, 26, 0], [0x0240, 52, 27, 0], [0x01b1, 54, 28, 0],
	[0x0144, 56, 29, 0], [0x00f5, 57, 30, 0], [0x00b7, 59, 31, 0], [0x008a, 60, 32, 0], [0x0068, 62, 33, 0], [0x004e, 63, 34, 0], [0x003b, 32, 35, 0],
	[0x002c, 33, 9, 0], [0x5ae1, 37, 37, 1], [0x484c, 64, 38, 0], [0x3a0d, 65, 39, 0], [0x2ef1, 67, 40, 0], [0x261f, 68, 41, 0], [0x1f33, 69, 42, 0],
	[0x19a8, 70, 43, 0], [0x1518, 72, 44, 0], [0x1177, 73, 45, 0], [0x0e74, 74, 46, 0], [0x0bfb, 75, 47, 0], [0x09f8, 77, 48, 0], [0x0861, 78, 49, 0],
	[0x0706, 79, 50, 0], [0x05cd, 48, 51, 0], [0x04de, 50, 52, 0], [0x040f, 50, 53, 0], [0x0363, 51, 54, 0], [0x02d4, 52, 55, 0], [0x025c, 53, 56, 0],
	[0x01f8, 54, 57, 0], [0x01a4, 55, 58, 0], [0x0160, 56, 59, 0], [0x0125, 57, 60, 0], [0x00f6, 58, 61, 0], [0x00cb, 59, 62, 0], [0x00ab, 61, 63, 0],
	[0x008f, 61, 32, 0], [0x5b12, 65, 65, 1], [0x4d04, 80, 66, 0], [0x412c, 81, 67, 0], [0x37d8, 82, 68, 0], [0x2fe8, 83, 69, 0], [0x293c, 84, 70, 0],
	[0x2379, 86, 71, 0], [0x1edf, 87, 72, 0], [0x1aa9, 87, 73, 0], [0x174e, 72, 74, 0], [0x1424, 72, 75, 0], [0x119c, 74, 76, 0], [0x0f6b, 74, 77, 0],
	[0x0d51, 75, 78, 0], [0x0bb6, 77, 79, 0], [0x0a40, 77, 48, 0], [0x5832, 80, 81, 1], [0x4d1c, 88, 82, 0], [0x438e, 89, 83, 0], [0x3bdd, 90, 84, 0],
	[0x34ee, 91, 85, 0], [0x2eae, 92, 86, 0], [0x299a, 93, 87, 0], [0x2516, 86, 71, 0], [0x5570, 88, 89, 1], [0x4ca9, 95, 90, 0], [0x44d9, 96, 91, 0],
	[0x3e22, 97, 92, 0], [0x3824, 99, 93, 0], [0x32b4, 99, 94, 0], [0x2e17, 93, 86, 0], [0x56a8, 95, 96, 1], [0x4f46, 101, 97, 0], [0x47e5, 102, 98, 0],
	[0x41cf, 103, 99, 0], [0x3c3d, 104, 100, 0], [0x375e, 99, 93, 0], [0x5231, 105, 102, 0], [0x4c0f, 106, 103, 0], [0x4639, 107, 104, 0],
	[0x415e, 103, 99, 0], [0x5627, 105, 106, 1], [0x50e7, 108, 107, 0], [0x4b85, 109, 103, 0], [0x5597, 110, 109, 0], [0x504f, 111, 107, 0],
	[0x5a10, 110, 111, 1], [0x5522, 112, 109, 0], [0x59eb, 112, 111, 1], [0x5a1d, 113, 113, 0],
];

/** Per-state packed form used by `decode`: Qe, next index after LPS (with the MPS-switch bit at 0x80) and next index after MPS. */
const QE = new Int32Array(STATES.length);
const NEXT_LPS = new Int32Array(STATES.length);
const NEXT_MPS = new Int32Array(STATES.length);
STATES.forEach(([qe, lps, mps, sw], i) => {
	QE[i] = qe;
	NEXT_LPS[i] = lps | (sw << 7);
	NEXT_MPS[i] = mps;
});

const DC_BINS = 64;
const AC_BINS = 256;

/** Per-component state the arithmetic scan decoder reads and updates. */
export interface ArithComponent {
	coefs: Int16Array;
	/** Previous DC value (shared with the Huffman path). */
	pred: number;
	/** DC conditioning category (0, 4, 8, 12 or 16). */
	ctx: number;
	dc: number;
	ac: number;
}

/** Conditioning parameters from DAC markers (defaults per T.81 F.1.4.4.1.4 and F.1.4.4.2). */
export interface ArithConditioning {
	dcL: number[];
	dcU: number[];
	acK: number[];
}

export function defaultArithConditioning(): ArithConditioning {
	return { dcL: new Array(16).fill(0), dcU: new Array(16).fill(1), acK: new Array(16).fill(5) };
}

const NATURAL = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43,
	36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

export class ArithDecoder {
	pos: number;
	private c = 0;
	private a = 0;
	private ct = -16;
	private marker = false;
	private failed = false;
	private readonly dcStats: Uint8Array[] = [];
	private readonly acStats: Uint8Array[] = [];
	private readonly fixed = new Uint8Array(1);

	constructor(
		private readonly data: Uint8Array,
		start: number,
		private readonly cond: ArithConditioning,
		private readonly components: ArithComponent[]
	) {
		this.pos = start;
		this.reset();
	}

	/** Start of scan or restart: clear statistics, contexts and the code register. */
	reset(): void {
		this.c = 0;
		this.a = 0;
		this.ct = -16;
		this.marker = false;
		this.failed = false;
		this.dcStats.length = 0;
		this.acStats.length = 0;
		for (let i = 0; i < 16; i++) {
			this.dcStats.push(new Uint8Array(DC_BINS));
			this.acStats.push(new Uint8Array(AC_BINS));
		}
		this.fixed[0] = 113;
		for (const c of this.components) {
			c.pred = 0;
			c.ctx = 0;
		}
	}

	/** Decode one binary decision with context `stats[index]`. */
	private bit(stats: Uint8Array, index: number): number {
		while (this.a < 0x8000) {
			if (--this.ct < 0) {
				let byte = 0;
				if (!this.marker) {
					byte = this.pos < this.data.length ? this.data[this.pos++] : 0;
					if (byte === 0xff) {
						do byte = this.pos < this.data.length ? this.data[this.pos++] : 0;
						while (byte === 0xff);
						if (byte === 0) byte = 0xff;
						else {
							// A marker inside the entropy-coded segment is legal: zeros are supplied from here on.
							this.marker = true;
							this.pos -= 2;
							byte = 0;
						}
					}
				}
				this.c = (this.c << 8) | byte;
				if ((this.ct += 8) < 0 && ++this.ct === 0) this.a = 0x8000;
			}
			this.a <<= 1;
		}
		let sv = stats[index];
		const state = sv & 0x7f;
		const qe = QE[state];
		const nl = NEXT_LPS[state];
		const nm = NEXT_MPS[state];
		let temp = this.a - qe;
		this.a = temp;
		temp <<= this.ct;
		if (this.c >= temp) {
			this.c -= temp;
			if (this.a < qe) {
				this.a = qe;
				stats[index] = (sv & 0x80) ^ nm;
			} else {
				this.a = qe;
				stats[index] = (sv & 0x80) ^ nl;
				sv ^= 0x80;
			}
		} else if (this.a < 0x8000) {
			if (this.a < qe) {
				stats[index] = (sv & 0x80) ^ nl;
				sv ^= 0x80;
			} else {
				stats[index] = (sv & 0x80) ^ nm;
			}
		}
		return sv >> 7;
	}

	/** Decode a DC difference with the Figure F.19 procedure; updates `pred` and `ctx`. Returns false on corrupt data. */
	private dcDiff(c: ArithComponent): boolean {
		const stats = this.dcStats[c.dc];
		let index = c.ctx;
		if (this.bit(stats, index) === 0) {
			c.ctx = 0;
			return true;
		}
		const sign = this.bit(stats, index + 1);
		index += 2 + sign;
		let m = this.bit(stats, index);
		if (m !== 0) {
			index = 20;
			while (this.bit(stats, index)) {
				if ((m <<= 1) === 0x8000) return false;
				index++;
			}
		}
		const low = (1 << this.cond.dcL[c.dc]) >> 1;
		const high = (1 << this.cond.dcU[c.dc]) >> 1;
		c.ctx = m < low ? 0 : m > high ? 12 + sign * 4 : 4 + sign * 4;
		let v = m;
		index += 14;
		while ((m >>= 1)) if (this.bit(stats, index)) v |= m;
		v += 1;
		c.pred += sign ? -v : v;
		return true;
	}

	/** Decode AC coefficients `ss..se` of one block (first pass or sequential), scaled by `al`. */
	private acFirst(c: ArithComponent, off: number, ss: number, se: number, al: number): void {
		const stats = this.acStats[c.ac];
		for (let k = ss; k <= se; k++) {
			let st = 3 * (k - 1);
			if (this.bit(stats, st)) break;
			while (this.bit(stats, st + 1) === 0) {
				st += 3;
				k++;
				if (k > se) {
					this.failed = true;
					return;
				}
			}
			const sign = this.bit(this.fixed, 0);
			st += 2;
			let m = this.bit(stats, st);
			if (m !== 0 && this.bit(stats, st)) {
				m <<= 1;
				st = k <= this.cond.acK[c.ac] ? 189 : 217;
				while (this.bit(stats, st)) {
					if ((m <<= 1) === 0x8000) {
						this.failed = true;
						return;
					}
					st++;
				}
			}
			let v = m;
			st += 14;
			while ((m >>= 1)) if (this.bit(stats, st)) v |= m;
			v += 1;
			c.coefs[off + NATURAL[k]] = (sign ? -v : v) * (1 << al);
		}
	}

	private acRefine(c: ArithComponent, off: number, ss: number, se: number, al: number): void {
		const stats = this.acStats[c.ac];
		const coefs = c.coefs;
		const p1 = 1 << al;
		const m1 = -1 << al;
		let kex = se;
		for (; kex > 0; kex--) if (coefs[off + NATURAL[kex]]) break;
		for (let k = ss; k <= se; k++) {
			let st = 3 * (k - 1);
			if (k > kex && this.bit(stats, st)) break;
			for (;;) {
				const at = off + NATURAL[k];
				if (coefs[at]) {
					if (this.bit(stats, st + 2)) coefs[at] += coefs[at] < 0 ? m1 : p1;
					break;
				}
				if (this.bit(stats, st + 1)) {
					coefs[at] = this.bit(this.fixed, 0) ? m1 : p1;
					break;
				}
				st += 3;
				k++;
				if (k > se) {
					this.failed = true;
					return;
				}
			}
		}
	}

	/** Decode one block. `progressive` selects the scan-specific procedures; sequential blocks pass `ss = 1, se = 63`. */
	block(c: ArithComponent, off: number, progressive: boolean, ss: number, se: number, ah: number, al: number): void {
		if (this.failed) return;
		if (!progressive) {
			if (!this.dcDiff(c)) {
				this.failed = true;
				return;
			}
			c.coefs[off] = c.pred;
			this.acFirst(c, off, 1, 63, 0);
			return;
		}
		if (ss === 0) {
			if (ah === 0) {
				if (!this.dcDiff(c)) {
					this.failed = true;
					return;
				}
				c.coefs[off] = c.pred * (1 << al);
			} else if (this.bit(this.fixed, 0)) {
				c.coefs[off] |= 1 << al;
			}
			return;
		}
		if (ah === 0) this.acFirst(c, off, ss, se, al);
		else this.acRefine(c, off, ss, se, al);
	}
}
