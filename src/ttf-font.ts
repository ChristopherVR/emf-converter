/**
 * Minimal TrueType (`glyf`-flavoured sfnt) font parser: just the tables
 * Windows GDI itself reads to realise a LOGFONT and rasterise its glyphs.
 *
 * GDI draws TrueType text from the font file's own data: the em square and
 * vertical metrics (`head`, `hhea`, `OS/2`), the per-ppem advance widths
 * (`hdmx`), the cell-height table (`VDMX`), the smoothing table (`gasp`),
 * the underline/strike-out geometry (`post`, `OS/2`), the character map
 * (`cmap`), and the glyph outlines plus their hinting programs (`glyf`,
 * `loca`, `cvt `, `fpgm`, `prep`). This module exposes exactly those, parsed
 * lazily from the raw bytes, so the hinting interpreter
 * (`ttf-hinting.ts`) and the scan converter (`ttf-raster.ts`) can reproduce
 * GDI's glyph bitmaps from the same inputs GDI uses.
 *
 * CFF-flavoured OpenType (`OTTO`) fonts are not parsed (GDI rasterises them
 * with a different engine); {@link parseFontFile} skips them.
 *
 * @module ttf-font
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry of a font's `gasp` table. */
export interface GaspRange {
	/** Upper ppem bound (inclusive) this range applies to. */
	maxPpem: number;
	/** GASP_* behaviour flags (1 = gridfit, 2 = do gray, 4 = symmetric gridfit, 8 = symmetric smoothing). */
	behavior: number;
}

/** One `VDMX` record: the realised yMax/yMin of a ppem. */
export interface VdmxEntry {
	ppem: number;
	yMax: number;
	yMin: number;
}

/** An outline glyph loaded from `glyf`, in font units. */
export interface TtfGlyph {
	/** Point x coordinates (font units). */
	xs: number[];
	/** Point y coordinates (font units, y up). */
	ys: number[];
	/** Per-point on-curve flag. */
	onCurve: boolean[];
	/** Index of the last point of each contour. */
	endPts: number[];
	/** The glyph's own instructions (empty when none). */
	instructions: Uint8Array;
	/** Components of a composite glyph (then the arrays above are empty). */
	components: TtfComponent[] | null;
	/** Bounding box from the glyph header (font units). */
	xMin: number;
	yMin: number;
	xMax: number;
	yMax: number;
}

/** One component reference of a composite glyph. */
export interface TtfComponent {
	glyphIndex: number;
	flags: number;
	/** Offsets when ARGS_ARE_XY_VALUES, else the point-matching indices. */
	arg1: number;
	arg2: number;
	/** 2x2 transform (identity when no scale flags). */
	a: number;
	b: number;
	c: number;
	d: number;
}

/** Composite component flags ([OpenType] `glyf`). */
export const ARGS_ARE_XY_VALUES = 0x0002;
export const ROUND_XY_TO_GRID = 0x0004;
export const WE_HAVE_A_SCALE = 0x0008;
export const MORE_COMPONENTS = 0x0020;
export const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
export const WE_HAVE_A_TWO_BY_TWO = 0x0080;
export const WE_HAVE_INSTRUCTIONS = 0x0100;
export const USE_MY_METRICS = 0x0200;
export const SCALED_COMPONENT_OFFSET = 0x0800;

/** A parsed TrueType font face. Tables are decoded once, on construction. */
export interface TtfFont {
	/** Family name (name ID 1, Windows English when present). */
	family: string;
	/** Subfamily / style name (name ID 2). */
	subfamily: string;
	/** Full name (name ID 4). */
	fullName: string;
	/** Typographic family (name ID 16), when present. */
	typoFamily: string | null;
	unitsPerEm: number;
	/** `head.flags`. */
	headFlags: number;
	/** `head.macStyle` (bit 0 bold, bit 1 italic). */
	macStyle: number;
	numGlyphs: number;
	hheaAscender: number;
	hheaDescender: number;
	hheaLineGap: number;
	/** `OS/2` fields (0 when the table is absent). */
	weightClass: number;
	widthClass: number;
	fsSelection: number;
	winAscent: number;
	winDescent: number;
	typoAscender: number;
	typoDescender: number;
	typoLineGap: number;
	xAvgCharWidth: number;
	strikeoutSize: number;
	strikeoutPosition: number;
	/** `OS/2.panose` bFamilyType..bXHeight (10 bytes) or null. */
	panose: Uint8Array | null;
	/** `post` underline geometry. */
	underlinePosition: number;
	underlineThickness: number;
	isFixedPitch: boolean;
	/** Symbol-encoded font (cmap 3,0). */
	isSymbol: boolean;
	/** `maxp` limits the interpreter needs. */
	maxStorage: number;
	maxFunctionDefs: number;
	maxInstructionDefs: number;
	maxStackElements: number;
	maxTwilightPoints: number;
	/** Control value table, in font units. */
	cvt: Int16Array;
	fpgm: Uint8Array;
	prep: Uint8Array;
	gasp: GaspRange[];
	/** `hdmx` advance widths per ppem (pixels), keyed by ppem. */
	hdmx: Map<number, Uint8Array>;
	/** `VDMX` entries for the 1:1 aspect ratio, ascending by ppem. */
	vdmx: VdmxEntry[] | null;
	/** `LTSH` yPels per glyph (ppem at/after which the glyph scales linearly), or null. */
	ltsh: Uint8Array | null;
	/** Maps a Unicode code point to a glyph index (0 = .notdef). */
	glyphIndex(codePoint: number): number;
	/** Horizontal advance and left side bearing (font units). */
	hMetrics(glyph: number): { advance: number; lsb: number };
	/** Loads a glyph's outline, or null for an empty glyph (e.g. space). */
	loadGlyph(glyph: number): TtfGlyph | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface TableRecord {
	offset: number;
	length: number;
}

function tag(view: DataView, off: number): string {
	return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}

function readTables(view: DataView, base: number): Map<string, TableRecord> | null {
	if (base + 12 > view.byteLength) {
		return null;
	}
	const version = view.getUint32(base);
	if (version !== 0x00010000 && version !== 0x74727565) {
		// 'OTTO' (CFF) and anything else: not a TrueType-outline font.
		return null;
	}
	const numTables = view.getUint16(base + 4);
	const tables = new Map<string, TableRecord>();
	for (let i = 0; i < numTables; i++) {
		const rec = base + 12 + i * 16;
		if (rec + 16 > view.byteLength) {
			return null;
		}
		const offset = view.getUint32(rec + 8);
		const length = view.getUint32(rec + 12);
		if (offset + length <= view.byteLength) {
			tables.set(tag(view, rec), { offset, length });
		}
	}
	return tables;
}

function utf16be(view: DataView, off: number, len: number): string {
	let s = '';
	for (let i = 0; i + 1 < len; i += 2) {
		s += String.fromCharCode(view.getUint16(off + i));
	}
	return s;
}

function latin1(view: DataView, off: number, len: number): string {
	let s = '';
	for (let i = 0; i < len; i++) {
		s += String.fromCharCode(view.getUint8(off + i));
	}
	return s;
}

/** Reads name IDs 1, 2, 4 and 16, preferring Windows US English, then any Windows, then Mac Roman. */
function readNames(view: DataView, t: TableRecord | undefined): Map<number, string> {
	const out = new Map<number, string>();
	if (!t) {
		return out;
	}
	const count = view.getUint16(t.offset + 2);
	const strOff = t.offset + view.getUint16(t.offset + 4);
	const score = new Map<number, number>();
	for (let i = 0; i < count; i++) {
		const r = t.offset + 6 + i * 12;
		const platform = view.getUint16(r);
		const encoding = view.getUint16(r + 2);
		const language = view.getUint16(r + 4);
		const nameId = view.getUint16(r + 6);
		const length = view.getUint16(r + 8);
		const offset = view.getUint16(r + 10);
		if (nameId !== 1 && nameId !== 2 && nameId !== 4 && nameId !== 16) {
			continue;
		}
		let s: string | null = null;
		let rank = 0;
		if (platform === 3 && (encoding === 1 || encoding === 0 || encoding === 10)) {
			s = utf16be(view, strOff + offset, length);
			rank = language === 0x409 ? 3 : 2;
		} else if (platform === 1 && encoding === 0) {
			s = latin1(view, strOff + offset, length);
			rank = 1;
		}
		if (s !== null && rank > (score.get(nameId) ?? 0)) {
			out.set(nameId, s);
			score.set(nameId, rank);
		}
	}
	return out;
}

type CmapLookup = (cp: number) => number;

function cmapFormat4(view: DataView, off: number): CmapLookup {
	const segX2 = view.getUint16(off + 6);
	const ends = off + 14;
	const starts = ends + segX2 + 2;
	const deltas = starts + segX2;
	const ranges = deltas + segX2;
	return (cp) => {
		if (cp > 0xffff) {
			return 0;
		}
		let lo = 0;
		let hi = segX2 / 2 - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const end = view.getUint16(ends + mid * 2);
			if (end < cp) {
				lo = mid + 1;
				continue;
			}
			const start = view.getUint16(starts + mid * 2);
			if (start > cp) {
				hi = mid - 1;
				continue;
			}
			const delta = view.getInt16(deltas + mid * 2);
			const rOff = view.getUint16(ranges + mid * 2);
			if (rOff === 0) {
				return (cp + delta) & 0xffff;
			}
			const gOff = ranges + mid * 2 + rOff + (cp - start) * 2;
			if (gOff + 2 > view.byteLength) {
				return 0;
			}
			const g = view.getUint16(gOff);
			return g === 0 ? 0 : (g + delta) & 0xffff;
		}
		return 0;
	};
}

function cmapFormat12(view: DataView, off: number): CmapLookup {
	const nGroups = view.getUint32(off + 12);
	return (cp) => {
		let lo = 0;
		let hi = nGroups - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const g = off + 16 + mid * 12;
			const start = view.getUint32(g);
			const end = view.getUint32(g + 4);
			if (cp < start) {
				hi = mid - 1;
			} else if (cp > end) {
				lo = mid + 1;
			} else {
				return view.getUint32(g + 8) + (cp - start);
			}
		}
		return 0;
	};
}

function cmapFormat6(view: DataView, off: number): CmapLookup {
	const first = view.getUint16(off + 6);
	const count = view.getUint16(off + 8);
	return (cp) => (cp >= first && cp < first + count ? view.getUint16(off + 10 + (cp - first) * 2) : 0);
}

function cmapFormat0(view: DataView, off: number): CmapLookup {
	return (cp) => (cp < 256 ? view.getUint8(off + 6 + cp) : 0);
}

function readCmap(view: DataView, t: TableRecord | undefined): { lookup: CmapLookup; symbol: boolean } {
	const none = { lookup: () => 0, symbol: false };
	if (!t) {
		return none;
	}
	const n = view.getUint16(t.offset + 2);
	let best: { off: number; rank: number; symbol: boolean } | null = null;
	for (let i = 0; i < n; i++) {
		const r = t.offset + 4 + i * 8;
		const platform = view.getUint16(r);
		const encoding = view.getUint16(r + 2);
		const off = t.offset + view.getUint32(r + 4);
		if (off + 4 > view.byteLength) {
			continue;
		}
		let rank = 0;
		let symbol = false;
		if (platform === 3 && encoding === 10) {
			rank = 5;
		} else if (platform === 3 && encoding === 1) {
			rank = 4;
		} else if (platform === 3 && encoding === 0) {
			rank = 3;
			symbol = true;
		} else if (platform === 0) {
			rank = 2;
		} else if (platform === 1 && encoding === 0) {
			rank = 1;
		}
		if (rank > 0 && (!best || rank > best.rank)) {
			best = { off, rank, symbol };
		}
	}
	if (!best) {
		return none;
	}
	const format = view.getUint16(best.off);
	let lookup: CmapLookup;
	switch (format) {
		case 4:
			lookup = cmapFormat4(view, best.off);
			break;
		case 12:
			lookup = cmapFormat12(view, best.off);
			break;
		case 6:
			lookup = cmapFormat6(view, best.off);
			break;
		case 0:
			lookup = cmapFormat0(view, best.off);
			break;
		default:
			return none;
	}
	if (best.symbol) {
		// Symbol fonts map their glyphs at U+F000..U+F0FF; GDI maps the
		// 8-bit character code c to U+F000 + c.
		const inner = lookup;
		lookup = (cp) => inner(cp) || (cp < 0x100 ? inner(0xf000 + cp) : 0);
	}
	return { lookup, symbol: best.symbol };
}

function readHdmx(view: DataView, t: TableRecord | undefined, numGlyphs: number): Map<number, Uint8Array> {
	const out = new Map<number, Uint8Array>();
	if (!t || t.length < 8) {
		return out;
	}
	const num = view.getInt16(t.offset + 2);
	const size = view.getInt32(t.offset + 4);
	for (let i = 0; i < num; i++) {
		const r = t.offset + 8 + i * size;
		if (r + 2 + numGlyphs > t.offset + t.length) {
			break;
		}
		out.set(view.getUint8(r), new Uint8Array(view.buffer, view.byteOffset + r + 2, numGlyphs));
	}
	return out;
}

function readVdmx(view: DataView, t: TableRecord | undefined): VdmxEntry[] | null {
	if (!t || t.length < 6) {
		return null;
	}
	const numRatios = view.getUint16(t.offset + 4);
	let chosen = -1;
	for (let i = 0; i < numRatios; i++) {
		const r = t.offset + 6 + i * 4;
		const charSet = view.getUint8(r);
		const xRatio = view.getUint8(r + 1);
		const yStart = view.getUint8(r + 2);
		const yEnd = view.getUint8(r + 3);
		// Windows only honours groups computed for the ANSI subset
		// (bCharSet 1) and ignores the rest ([OpenType] VDMX); measured:
		// Tahoma's bCharSet-0 group is not what GDI's tmAscent reports.
		if (charSet !== 1) {
			continue;
		}
		// Ratio 0:0:0 is the catch-all; 1:1 lies within [yStart, yEnd].
		if ((xRatio === 0 && yStart === 0 && yEnd === 0) || (xRatio === 1 && yStart <= 1 && yEnd >= 1)) {
			chosen = i;
			break;
		}
	}
	if (chosen < 0) {
		return null;
	}
	const groupOff = t.offset + view.getUint16(t.offset + 6 + numRatios * 4 + chosen * 2);
	if (groupOff + 4 > view.byteLength) {
		return null;
	}
	const recs = view.getUint16(groupOff);
	const out: VdmxEntry[] = [];
	for (let i = 0; i < recs; i++) {
		const e = groupOff + 4 + i * 6;
		out.push({ ppem: view.getUint16(e), yMax: view.getInt16(e + 2), yMin: view.getInt16(e + 4) });
	}
	return out;
}

function readGlyph(view: DataView, glyf: TableRecord, start: number, end: number): TtfGlyph | null {
	if (end <= start) {
		return null;
	}
	const p0 = glyf.offset + start;
	const nContours = view.getInt16(p0);
	const xMin = view.getInt16(p0 + 2);
	const yMin = view.getInt16(p0 + 4);
	const xMax = view.getInt16(p0 + 6);
	const yMax = view.getInt16(p0 + 8);
	let p = p0 + 10;
	if (nContours >= 0) {
		const endPts: number[] = [];
		for (let i = 0; i < nContours; i++) {
			endPts.push(view.getUint16(p));
			p += 2;
		}
		const nPts = nContours > 0 ? endPts[nContours - 1] + 1 : 0;
		const insLen = view.getUint16(p);
		p += 2;
		const instructions = new Uint8Array(view.buffer, view.byteOffset + p, insLen);
		p += insLen;
		const flags = new Uint8Array(nPts);
		for (let i = 0; i < nPts; ) {
			const f = view.getUint8(p++);
			flags[i++] = f;
			if (f & 8) {
				let rep = view.getUint8(p++);
				while (rep-- > 0 && i < nPts) {
					flags[i++] = f;
				}
			}
		}
		const xs: number[] = new Array(nPts);
		const ys: number[] = new Array(nPts);
		let v = 0;
		for (let i = 0; i < nPts; i++) {
			const f = flags[i];
			if (f & 2) {
				const d = view.getUint8(p++);
				v += f & 16 ? d : -d;
			} else if (!(f & 16)) {
				v += view.getInt16(p);
				p += 2;
			}
			xs[i] = v;
		}
		v = 0;
		for (let i = 0; i < nPts; i++) {
			const f = flags[i];
			if (f & 4) {
				const d = view.getUint8(p++);
				v += f & 32 ? d : -d;
			} else if (!(f & 32)) {
				v += view.getInt16(p);
				p += 2;
			}
			ys[i] = v;
		}
		const onCurve: boolean[] = new Array(nPts);
		for (let i = 0; i < nPts; i++) {
			onCurve[i] = (flags[i] & 1) !== 0;
		}
		return { xs, ys, onCurve, endPts, instructions, components: null, xMin, yMin, xMax, yMax };
	}
	const components: TtfComponent[] = [];
	let flags = 0;
	do {
		flags = view.getUint16(p);
		const glyphIndex = view.getUint16(p + 2);
		p += 4;
		let arg1: number;
		let arg2: number;
		if (flags & 1) {
			// ARG_1_AND_2_ARE_WORDS
			arg1 = flags & ARGS_ARE_XY_VALUES ? view.getInt16(p) : view.getUint16(p);
			arg2 = flags & ARGS_ARE_XY_VALUES ? view.getInt16(p + 2) : view.getUint16(p + 2);
			p += 4;
		} else {
			arg1 = flags & ARGS_ARE_XY_VALUES ? view.getInt8(p) : view.getUint8(p);
			arg2 = flags & ARGS_ARE_XY_VALUES ? view.getInt8(p + 1) : view.getUint8(p + 1);
			p += 2;
		}
		let a = 1;
		let b = 0;
		let c = 0;
		let d = 1;
		if (flags & WE_HAVE_A_SCALE) {
			a = d = view.getInt16(p) / 16384;
			p += 2;
		} else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
			a = view.getInt16(p) / 16384;
			d = view.getInt16(p + 2) / 16384;
			p += 4;
		} else if (flags & WE_HAVE_A_TWO_BY_TWO) {
			a = view.getInt16(p) / 16384;
			b = view.getInt16(p + 2) / 16384;
			c = view.getInt16(p + 4) / 16384;
			d = view.getInt16(p + 6) / 16384;
			p += 8;
		}
		components.push({ glyphIndex, flags, arg1, arg2, a, b, c, d });
	} while (flags & MORE_COMPONENTS);
	let instructions: Uint8Array = new Uint8Array(0);
	if (flags & WE_HAVE_INSTRUCTIONS) {
		const n = view.getUint16(p);
		instructions = new Uint8Array(view.buffer, view.byteOffset + p + 2, n);
	}
	return { xs: [], ys: [], onCurve: [], endPts: [], instructions, components, xMin, yMin, xMax, yMax };
}

/**
 * Parses one TrueType face starting at `base` (0 for a plain `.ttf`, the
 * table-directory offset of one member for a `.ttc`). Returns null for a
 * non-TrueType or truncated face.
 */
export function parseTrueTypeFace(view: DataView, base = 0): TtfFont | null {
	const tables = readTables(view, base);
	if (!tables) {
		return null;
	}
	const head = tables.get('head');
	const hhea = tables.get('hhea');
	const maxp = tables.get('maxp');
	const hmtx = tables.get('hmtx');
	const loca = tables.get('loca');
	const glyf = tables.get('glyf');
	if (!head || !hhea || !maxp || !hmtx || !loca || !glyf) {
		return null;
	}
	const unitsPerEm = view.getUint16(head.offset + 18);
	const headFlags = view.getUint16(head.offset + 16);
	const macStyle = view.getUint16(head.offset + 44);
	const longLoca = view.getInt16(head.offset + 50) === 1;
	const numGlyphs = view.getUint16(maxp.offset + 4);
	const maxpV1 = maxp.length >= 32;
	const numHMetrics = view.getUint16(hhea.offset + 34);
	const names = readNames(view, tables.get('name'));
	const cmap = readCmap(view, tables.get('cmap'));

	const os2 = tables.get('OS/2');
	const post = tables.get('post');
	const cvtT = tables.get('cvt ');
	const fpgmT = tables.get('fpgm');
	const prepT = tables.get('prep');
	const gaspT = tables.get('gasp');
	const ltshT = tables.get('LTSH');

	const cvt = new Int16Array(cvtT ? cvtT.length >> 1 : 0);
	for (let i = 0; i < cvt.length; i++) {
		cvt[i] = view.getInt16(cvtT!.offset + i * 2);
	}
	const bytes = (t: TableRecord | undefined): Uint8Array =>
		t ? new Uint8Array(view.buffer, view.byteOffset + t.offset, t.length) : new Uint8Array(0);
	const gasp: GaspRange[] = [];
	if (gaspT && gaspT.length >= 4) {
		const n = view.getUint16(gaspT.offset + 2);
		for (let i = 0; i < n && 4 + i * 4 + 4 <= gaspT.length; i++) {
			gasp.push({
				maxPpem: view.getUint16(gaspT.offset + 4 + i * 4),
				behavior: view.getUint16(gaspT.offset + 6 + i * 4),
			});
		}
	}

	const locaAt = (g: number): number =>
		longLoca ? view.getUint32(loca.offset + g * 4) : view.getUint16(loca.offset + g * 2) * 2;
	const glyphCache = new Map<number, TtfGlyph | null>();

	return {
		family: names.get(1) ?? '',
		subfamily: names.get(2) ?? '',
		fullName: names.get(4) ?? '',
		typoFamily: names.get(16) ?? null,
		unitsPerEm,
		headFlags,
		macStyle,
		numGlyphs,
		hheaAscender: view.getInt16(hhea.offset + 4),
		hheaDescender: view.getInt16(hhea.offset + 6),
		hheaLineGap: view.getInt16(hhea.offset + 8),
		weightClass: os2 ? view.getUint16(os2.offset + 4) : macStyle & 1 ? 700 : 400,
		widthClass: os2 ? view.getUint16(os2.offset + 6) : 5,
		fsSelection: os2 ? view.getUint16(os2.offset + 62) : 0,
		winAscent: os2 ? view.getUint16(os2.offset + 74) : view.getInt16(hhea.offset + 4),
		winDescent: os2 ? view.getUint16(os2.offset + 76) : -view.getInt16(hhea.offset + 6),
		typoAscender: os2 ? view.getInt16(os2.offset + 68) : 0,
		typoDescender: os2 ? view.getInt16(os2.offset + 70) : 0,
		typoLineGap: os2 ? view.getInt16(os2.offset + 72) : 0,
		xAvgCharWidth: os2 ? view.getInt16(os2.offset + 2) : 0,
		strikeoutSize: os2 ? view.getInt16(os2.offset + 26) : 0,
		strikeoutPosition: os2 ? view.getInt16(os2.offset + 28) : 0,
		panose: os2 ? new Uint8Array(view.buffer, view.byteOffset + os2.offset + 32, 10) : null,
		underlinePosition: post ? view.getInt16(post.offset + 8) : 0,
		underlineThickness: post ? view.getInt16(post.offset + 10) : 0,
		isFixedPitch: post ? view.getUint32(post.offset + 12) !== 0 : false,
		isSymbol: cmap.symbol,
		maxStorage: maxpV1 ? view.getUint16(maxp.offset + 18) : 0,
		maxFunctionDefs: maxpV1 ? view.getUint16(maxp.offset + 20) : 0,
		maxInstructionDefs: maxpV1 ? view.getUint16(maxp.offset + 22) : 0,
		maxStackElements: maxpV1 ? view.getUint16(maxp.offset + 24) : 0,
		maxTwilightPoints: maxpV1 ? view.getUint16(maxp.offset + 16) : 0,
		cvt,
		fpgm: bytes(fpgmT),
		prep: bytes(prepT),
		gasp,
		hdmx: readHdmx(view, tables.get('hdmx'), numGlyphs),
		vdmx: readVdmx(view, tables.get('VDMX')),
		ltsh: ltshT && ltshT.length >= 4 + numGlyphs ? bytes(ltshT).subarray(4, 4 + numGlyphs) : null,
		glyphIndex: (cp) => {
			const g = cmap.lookup(cp);
			return g < numGlyphs ? g : 0;
		},
		hMetrics: (g) => {
			const i = Math.min(g, numHMetrics - 1);
			const advance = view.getUint16(hmtx.offset + i * 4);
			const lsb =
				g < numHMetrics
					? view.getInt16(hmtx.offset + g * 4 + 2)
					: view.getInt16(hmtx.offset + numHMetrics * 4 + (g - numHMetrics) * 2);
			return { advance, lsb };
		},
		loadGlyph: (g) => {
			if (g < 0 || g >= numGlyphs) {
				return null;
			}
			let cached = glyphCache.get(g);
			if (cached === undefined) {
				try {
					cached = readGlyph(view, glyf, locaAt(g), locaAt(g + 1));
				} catch {
					cached = null;
				}
				glyphCache.set(g, cached);
			}
			return cached;
		},
	};
}

/**
 * Parses a `.ttf` or `.ttc` file into its TrueType faces (empty for an
 * unsupported or corrupt file, never throws).
 */
export function parseFontFile(data: ArrayBuffer | ArrayBufferView): TtfFont[] {
	const view =
		data instanceof ArrayBuffer
			? new DataView(data)
			: new DataView(data.buffer, data.byteOffset, data.byteLength);
	try {
		if (view.byteLength >= 12 && tag(view, 0) === 'ttcf') {
			const n = view.getUint32(8);
			const out: TtfFont[] = [];
			for (let i = 0; i < n && 12 + i * 4 + 4 <= view.byteLength; i++) {
				const face = parseTrueTypeFace(view, view.getUint32(12 + i * 4));
				if (face) {
					out.push(face);
				}
			}
			return out;
		}
		const face = parseTrueTypeFace(view, 0);
		return face ? [face] : [];
	} catch {
		return [];
	}
}
