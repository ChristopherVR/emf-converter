/**
 * Windows bitmap (raster) font files: `.fon` (a 16-bit NE executable whose
 * RT_FONT resources are FNT fonts) and bare `.fnt` files.
 *
 * GDI still draws the legacy raster faces (MS Sans Serif, MS Serif,
 * Courier, Small Fonts, System, Terminal, ...) straight from these
 * bitmaps, and metafiles naming `Helv`, `Tms Rmn` or `MS Sans Serif` get
 * them. Each FNT resource is one fixed pixel size: a header with the cell
 * metrics, a character table (width and bitmap offset per character of
 * `dfFirstChar..dfLastChar`), and the glyph bitmaps, stored as columns of
 * 8-pixel-wide bytes, `dfPixHeight` rows each, most significant bit on the
 * left ([MS-FNT] version 2.0 and 3.0).
 *
 * @module fnt-font
 */

/** One size of a raster face. */
export interface RasterFace {
	family: string;
	points: number;
	/** Vertical resolution the face was drawn for (96 for the stock `*e.fon` sets, 120 for `*f.fon`). */
	vertRes: number;
	/** Horizontal resolution the face was drawn for (differs from `vertRes` for non-square-pixel faces). */
	horizRes: number;
	/** Cell height (tmHeight). */
	pixHeight: number;
	ascent: number;
	internalLeading: number;
	externalLeading: number;
	weight: number;
	italic: boolean;
	underline: boolean;
	strikeOut: boolean;
	charSet: number;
	pitchAndFamily: number;
	avgWidth: number;
	maxWidth: number;
	firstChar: number;
	lastChar: number;
	defaultChar: number;
	breakChar: number;
	/** Advance width of a character code (0 outside the font's range). */
	width(code: number): number;
	/** The 1-byte-per-pixel bitmap of a character code (`width(code)` by `pixHeight`), top row first. */
	bitmap(code: number): Uint8Array | null;
}

function parseFnt(view: DataView, base: number, end: number): RasterFace | null {
	if (base + 118 > end) {
		return null;
	}
	const version = view.getUint16(base, true);
	if (version !== 0x200 && version !== 0x300) {
		return null;
	}
	const type = view.getUint16(base + 66, true);
	if (type & 1) {
		// Vector (stroke) fonts are not bitmaps.
		return null;
	}
	const u8 = (o: number): number => view.getUint8(base + o);
	const u16 = (o: number): number => view.getUint16(base + o, true);
	const u32 = (o: number): number => view.getUint32(base + o, true);
	const firstChar = u8(95);
	const lastChar = u8(96);
	const pixHeight = u16(88);
	const faceOff = u32(105);
	let family = '';
	for (let p = base + faceOff; p < end && view.getUint8(p) !== 0 && family.length < 64; p++) {
		family += String.fromCharCode(view.getUint8(p));
	}
	const tableOff = version === 0x300 ? 148 : 118;
	const entry = version === 0x300 ? 6 : 4;
	const count = lastChar - firstChar + 2;
	if (base + tableOff + count * entry > end) {
		return null;
	}
	const widthAt = (i: number): number => u16(tableOff + i * entry);
	const offsetAt = (i: number): number => (version === 0x300 ? u32(tableOff + i * entry + 2) : u16(tableOff + i * entry + 2));
	const defaultChar = u8(97) + firstChar;
	const index = (code: number): number => {
		if (code < firstChar || code > lastChar) {
			code = defaultChar;
		}
		return code - firstChar;
	};
	const cache = new Map<number, Uint8Array | null>();
	return {
		family,
		points: u16(68),
		vertRes: u16(70),
		horizRes: u16(72),
		pixHeight,
		ascent: u16(74),
		internalLeading: u16(76),
		externalLeading: u16(78),
		italic: u8(80) !== 0,
		underline: u8(81) !== 0,
		strikeOut: u8(82) !== 0,
		weight: u16(83),
		charSet: u8(85),
		pitchAndFamily: u8(90),
		avgWidth: u16(91),
		maxWidth: u16(93),
		firstChar,
		lastChar,
		defaultChar,
		breakChar: u8(98) + firstChar,
		width: (code) => {
			const i = index(code);
			return i >= 0 && i < count ? widthAt(i) : 0;
		},
		bitmap: (code) => {
			const i = index(code);
			if (i < 0 || i >= count) {
				return null;
			}
			let bmp = cache.get(i);
			if (bmp === undefined) {
				const w = widthAt(i);
				const off = offsetAt(i);
				const cols = Math.ceil(w / 8);
				if (w === 0 || base + off + cols * pixHeight > end) {
					bmp = null;
				} else {
					bmp = new Uint8Array(w * pixHeight);
					for (let c = 0; c < cols; c++) {
						for (let y = 0; y < pixHeight; y++) {
							const byte = view.getUint8(base + off + c * pixHeight + y);
							for (let b = 0; b < 8; b++) {
								const x = c * 8 + b;
								if (x < w && byte & (0x80 >> b)) {
									bmp[y * w + x] = 1;
								}
							}
						}
					}
				}
				cache.set(i, bmp);
			}
			return bmp;
		},
	};
}

/**
 * Parses a `.fon` (NE resource container) or bare `.fnt` file into its
 * raster faces. Returns an empty list for anything else (never throws).
 */
export function parseRasterFontFile(data: ArrayBuffer | ArrayBufferView): RasterFace[] {
	const view =
		data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
	const out: RasterFace[] = [];
	try {
		if (view.byteLength < 64) {
			return out;
		}
		const sig = view.getUint16(0, true);
		if (sig === 0x200 || sig === 0x300) {
			const f = parseFnt(view, 0, view.byteLength);
			return f ? [f] : out;
		}
		if (sig !== 0x5a4d) {
			// not 'MZ'
			return out;
		}
		const ne = view.getUint32(0x3c, true);
		if (ne + 0x40 > view.byteLength || view.getUint16(ne, true) !== 0x454e) {
			// not 'NE'
			return out;
		}
		const rt = ne + view.getUint16(ne + 0x24, true);
		const shift = view.getUint16(rt, true);
		let p = rt + 2;
		while (p + 8 <= view.byteLength) {
			const type = view.getUint16(p, true);
			if (type === 0) {
				break;
			}
			const n = view.getUint16(p + 2, true);
			p += 8;
			for (let i = 0; i < n && p + 12 <= view.byteLength; i++, p += 12) {
				if (type !== 0x8008) {
					continue;
				}
				const off = view.getUint16(p, true) * 2 ** shift;
				const len = view.getUint16(p + 2, true) * 2 ** shift;
				const f = parseFnt(view, off, Math.min(view.byteLength, off + len));
				if (f) {
					out.push(f);
				}
			}
		}
	} catch {
		return [];
	}
	return out;
}
