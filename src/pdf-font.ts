/**
 * Fonts for the PDF writer.
 *
 * Two kinds of font reach a PDF here:
 *
 * - TrueType faces the caller supplies through the `fonts` option, embedded
 *   as `CIDFontType2` fonts with `Identity-H` encoding (the two-byte code IS
 *   the glyph index), a `ToUnicode` CMap and a glyph-retaining subset (only
 *   the glyphs used, plus composite components, keep their outlines; glyph
 *   indices do not change), so the text is selectable and searchable and
 *   looks as the font draws it.
 * - Otherwise one of the standard 14 fonts (Helvetica, Times, Courier and
 *   their bold / oblique variants) chosen from the face name, with
 *   `WinAnsiEncoding`. Their glyph shapes differ from the original font.
 *
 * @module pdf-font
 */

import { parseTrueTypeFace, type TtfFont } from './ttf-font';
import { estimateTextWidth } from './text-estimate';
import { pdfName, type PdfWriter } from './pdf-writer';

/** One font the PDF page content can select with `Tf`. */
export interface PdfFont {
	/** Object number of the font dictionary (resolved when the book is finished). */
	readonly obj: number;
	/** True for an embedded TrueType font. */
	readonly embedded: boolean;
	/** Ascent / descent as fractions of the em (descent positive). */
	readonly ascent: number;
	readonly descent: number;
	/**
	 * The `Tj` hex string and advance width (in em) for a code point, or
	 * `null` when the font cannot draw it. Records the glyph as used.
	 */
	glyph(cp: number): { hex: string; advance: number } | null;
	/** Advance width of a whole string, in em. */
	width(text: string): number;
}

// ---------------------------------------------------------------------------
// Standard 14 fonts
// ---------------------------------------------------------------------------

const WIN_ANSI_HIGH: Record<number, number> = {
	0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
	0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
	0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
	0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** WinAnsi (code page 1252) byte for a code point, or -1 when it has none. */
function winAnsiByte(cp: number): number {
	if (cp >= 0x20 && cp < 0x7f) {
		return cp;
	}
	if (cp >= 0xa0 && cp <= 0xff) {
		return cp;
	}
	return WIN_ANSI_HIGH[cp] ?? -1;
}

type StdFamily = 'Helvetica' | 'Times' | 'Courier';

/** Picks a standard family from a CSS font-family list by face-name heuristics. */
export function standardFamilyFor(familyList: string): StdFamily {
	const f = familyList.toLowerCase();
	if (/courier|mono|consolas|lucida console|terminal|fixedsys|andale|menlo|monaco|typewriter/.test(f)) {
		return 'Courier';
	}
	if (/sans|arial|helvet|verdana|tahoma|calibri|segoe|trebuchet|impact/.test(f)) {
		return 'Helvetica';
	}
	if (/times|serif|georgia|garamond|palatino|cambria|book antiqua|century|bookman|minion|constantia|baskerville|didot/.test(f)) {
		return 'Times';
	}
	return 'Helvetica';
}

/** Standard-14 BaseFont name for a family and style. */
export function standardBaseFont(family: StdFamily, bold: boolean, italic: boolean): string {
	if (family === 'Times') {
		return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : italic ? 'Times-Italic' : 'Times-Roman';
	}
	const slant = family === 'Courier' || family === 'Helvetica' ? 'Oblique' : 'Italic';
	return `${family}${bold || italic ? '-' : ''}${bold ? 'Bold' : ''}${italic ? slant : ''}`;
}

// ---------------------------------------------------------------------------
// Embedded TrueType
// ---------------------------------------------------------------------------

interface FontSourceFace {
	view: DataView;
	base: number;
	ttf: TtfFont;
}

function tagAt(view: DataView, off: number): string {
	return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}

/** Every TrueType face of a font file (a `.ttc` has several), with the offset of its table directory. */
function readFaces(data: ArrayBuffer | ArrayBufferView): FontSourceFace[] {
	const view =
		data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
	const faces: FontSourceFace[] = [];
	try {
		const bases: number[] = [];
		if (view.byteLength >= 12 && tagAt(view, 0) === 'ttcf') {
			const n = view.getUint32(8);
			for (let i = 0; i < n && 12 + i * 4 + 4 <= view.byteLength; i++) {
				bases.push(view.getUint32(12 + i * 4));
			}
		} else {
			bases.push(0);
		}
		for (const base of bases) {
			const ttf = parseTrueTypeFace(view, base);
			if (ttf) {
				faces.push({ view, base, ttf });
			}
		}
	} catch {
		/* unreadable font file: contributes no faces */
	}
	return faces;
}

function checksum(bytes: Uint8Array): number {
	let sum = 0;
	const n = bytes.length & ~3;
	for (let i = 0; i < n; i += 4) {
		sum = (sum + ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3])) >>> 0;
	}
	if (n < bytes.length) {
		let last = 0;
		for (let i = n; i < n + 4; i++) {
			last = (last << 8) | (i < bytes.length ? bytes[i] : 0);
		}
		sum = (sum + last) >>> 0;
	}
	return sum;
}

/**
 * Builds a glyph-retaining TrueType subset: every table PDF viewers need,
 * with the outlines of unused glyphs emptied (glyph indices are unchanged,
 * so the `Identity-H` codes stay valid). `used` must already contain the
 * composite-glyph closure.
 */
function buildSubset(face: FontSourceFace, used: Set<number>): Uint8Array | null {
	const { view, base, ttf } = face;
	const dir = new Map<string, { offset: number; length: number }>();
	const numTables = view.getUint16(base + 4);
	for (let i = 0; i < numTables; i++) {
		const rec = base + 12 + i * 16;
		dir.set(tagAt(view, rec), { offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) });
	}
	const table = (tag: string): Uint8Array | null => {
		const t = dir.get(tag);
		return t && t.offset + t.length <= view.byteLength
			? new Uint8Array(view.buffer, view.byteOffset + t.offset, t.length)
			: null;
	};
	const head = table('head');
	const glyf = table('glyf');
	const loca = table('loca');
	const hhea = table('hhea');
	const maxp = table('maxp');
	const hmtx = table('hmtx');
	if (!head || !glyf || !loca || !hhea || !maxp || !hmtx) {
		return null;
	}
	const longLoca = new DataView(head.buffer, head.byteOffset, head.length).getInt16(50) === 1;
	const locaView = new DataView(loca.buffer, loca.byteOffset, loca.length);
	const locaAt = (g: number): number => (longLoca ? locaView.getUint32(g * 4) : locaView.getUint16(g * 2) * 2);
	const n = ttf.numGlyphs;

	const pieces: Uint8Array[] = [];
	const newLoca = new DataView(new ArrayBuffer((n + 1) * 4));
	let pos = 0;
	for (let g = 0; g < n; g++) {
		newLoca.setUint32(g * 4, pos);
		if (!used.has(g)) {
			continue;
		}
		const start = locaAt(g);
		const end = locaAt(g + 1);
		if (end > start && end <= glyf.length) {
			const padded = (end - start + 3) & ~3;
			const piece = new Uint8Array(padded);
			piece.set(glyf.subarray(start, end));
			pieces.push(piece);
			pos += padded;
		}
	}
	newLoca.setUint32(n * 4, pos);
	const newGlyf = new Uint8Array(pos);
	let o = 0;
	for (const p of pieces) {
		newGlyf.set(p, o);
		o += p.length;
	}
	const newHead = head.slice();
	const headView = new DataView(newHead.buffer);
	headView.setInt16(50, 1); // long loca offsets
	headView.setUint32(8, 0); // checkSumAdjustment, patched below

	const tables: Array<[string, Uint8Array]> = [
		['head', newHead],
		['hhea', hhea],
		['maxp', maxp],
		['hmtx', hmtx],
		['loca', new Uint8Array(newLoca.buffer)],
		['glyf', newGlyf],
	];
	for (const optional of ['cvt ', 'fpgm', 'prep']) {
		const t = table(optional);
		if (t) {
			tables.push([optional, t]);
		}
	}
	tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));

	const count = tables.length;
	let entrySelector = 0;
	while (1 << (entrySelector + 1) <= count) {
		entrySelector++;
	}
	const searchRange = (1 << entrySelector) * 16;
	let total = 12 + count * 16;
	const offsets: number[] = [];
	for (const [, data] of tables) {
		offsets.push(total);
		total += (data.length + 3) & ~3;
	}
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, 0x00010000);
	dv.setUint16(4, count);
	dv.setUint16(6, searchRange);
	dv.setUint16(8, entrySelector);
	dv.setUint16(10, count * 16 - searchRange);
	tables.forEach(([tag, data], i) => {
		const rec = 12 + i * 16;
		for (let k = 0; k < 4; k++) {
			out[rec + k] = tag.charCodeAt(k);
		}
		dv.setUint32(rec + 4, checksum(data));
		dv.setUint32(rec + 8, offsets[i]);
		dv.setUint32(rec + 12, data.length);
		out.set(data, offsets[i]);
	});
	const headIndex = tables.findIndex(([tag]) => tag === 'head');
	dv.setUint32(offsets[headIndex] + 8, (0xb1b0afba - checksum(out)) >>> 0);
	return out;
}

/** An embedded TrueType font: records glyph use, then writes the subset and the CID font objects. */
class EmbeddedFont implements PdfFont {
	readonly embedded = true;
	readonly ascent: number;
	readonly descent: number;
	private readonly used = new Map<number, number>(); // glyph -> first code point
	private readonly upem: number;

	constructor(
		readonly obj: number,
		private readonly face: FontSourceFace,
		private readonly baseName: string,
	) {
		const t = face.ttf;
		this.upem = t.unitsPerEm || 1000;
		this.ascent = (t.hheaAscender || t.winAscent || this.upem * 0.8) / this.upem;
		this.descent = Math.abs(t.hheaDescender || -t.winDescent || -this.upem * 0.2) / this.upem;
	}

	glyph(cp: number): { hex: string; advance: number } | null {
		const g = this.face.ttf.glyphIndex(cp);
		if (g === 0) {
			return null;
		}
		if (!this.used.has(g)) {
			this.used.set(g, cp);
		}
		return { hex: g.toString(16).padStart(4, '0'), advance: this.face.ttf.hMetrics(g).advance / this.upem };
	}

	width(text: string): number {
		let w = 0;
		for (const ch of text) {
			const g = this.face.ttf.glyphIndex(ch.codePointAt(0)!);
			w += this.face.ttf.hMetrics(g).advance / this.upem;
		}
		return w;
	}

	/** Writes the subset font program and all font objects. */
	finish(writer: PdfWriter, compress: boolean): void {
		const { ttf } = this.face;
		// Composite glyphs need their components' outlines too.
		const closure = new Set<number>([0, ...this.used.keys()]);
		const queue = [...closure];
		while (queue.length) {
			const g = queue.pop()!;
			for (const c of ttf.loadGlyph(g)?.components ?? []) {
				if (!closure.has(c.glyphIndex)) {
					closure.add(c.glyphIndex);
					queue.push(c.glyphIndex);
				}
			}
		}
		const program = buildSubset(this.face, closure);
		const scale = 1000 / this.upem;
		const widths: string[] = [];
		const cmap: string[] = [];
		for (const [g, cp] of [...this.used.entries()].sort((a, b) => a[0] - b[0])) {
			widths.push(`${g} [${Math.round(ttf.hMetrics(g).advance * scale)}]`);
			cmap.push(`<${g.toString(16).padStart(4, '0')}> <${utf16Hex(cp)}>`);
		}
		const name = this.baseName;
		const fontFile = program ? writer.addStream(`/Length1 ${program.length}`, program, compress) : 0;
		const bbox = this.bbox();
		const italicAngle = (ttf.fsSelection & 1) !== 0 || (ttf.macStyle & 2) !== 0 ? -12 : 0;
		const flags = 32 | (ttf.isFixedPitch ? 1 : 0) | (italicAngle ? 64 : 0);
		const descriptor = writer.add(
			`<< /Type /FontDescriptor /FontName ${pdfName(name)} /Flags ${flags} /FontBBox [${bbox}] ` +
				`/ItalicAngle ${italicAngle} /Ascent ${Math.round(this.ascent * 1000)} /Descent ${-Math.round(this.descent * 1000)} ` +
				`/CapHeight ${Math.round(this.ascent * 700)} /StemV ${ttf.weightClass >= 600 ? 140 : 80}` +
				`${fontFile ? ` /FontFile2 ${fontFile} 0 R` : ''} >>`,
		);
		const cid = writer.add(
			`<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${pdfName(name)} ` +
				`/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
				`/FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths.join(' ')}] /CIDToGIDMap /Identity >>`,
		);
		const chunks: string[] = [];
		for (let i = 0; i < cmap.length; i += 100) {
			const part = cmap.slice(i, i + 100);
			chunks.push(`${part.length} beginbfchar\n${part.join('\n')}\nendbfchar`);
		}
		const toUnicode =
			'/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
			'/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
			'/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
			'1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
			chunks.join('\n') +
			'\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
		const toUnicodeObj = writer.addStream('', Uint8Array.from(toUnicode, (c) => c.charCodeAt(0) & 0xff), compress);
		writer.set(
			this.obj,
			`<< /Type /Font /Subtype /Type0 /BaseFont ${pdfName(name)} /Encoding /Identity-H ` +
				`/DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicodeObj} 0 R >>`,
		);
	}

	private bbox(): string {
		const t = this.face.ttf;
		const view = this.face.view;
		// head bbox: xMin yMin xMax yMax at offset 36 of the head table.
		const numTables = view.getUint16(this.face.base + 4);
		for (let i = 0; i < numTables; i++) {
			const rec = this.face.base + 12 + i * 16;
			if (tagAt(view, rec) === 'head') {
				const off = view.getUint32(rec + 8);
				const s = 1000 / this.upem;
				return [view.getInt16(off + 36), view.getInt16(off + 38), view.getInt16(off + 40), view.getInt16(off + 42)]
					.map((v) => Math.round(v * s))
					.join(' ');
			}
		}
		return `0 ${t.headYMin} 1000 ${t.headYMax}`;
	}
}

/** UTF-16BE hex (no angle brackets) of a code point. */
function utf16Hex(cp: number): string {
	if (cp > 0xffff) {
		const v = cp - 0x10000;
		return (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
	}
	return cp.toString(16).padStart(4, '0');
}

class StandardFont implements PdfFont {
	readonly embedded = false;
	readonly ascent: number;
	readonly descent: number;
	constructor(
		readonly obj: number,
		private readonly family: StdFamily,
	) {
		this.ascent = family === 'Courier' ? 0.63 : family === 'Times' ? 0.68 : 0.72;
		this.descent = family === 'Courier' ? 0.2 : 0.22;
	}

	glyph(cp: number): { hex: string; advance: number } | null {
		let b = winAnsiByte(cp);
		if (b < 0) {
			// No WinAnsi glyph: a visible placeholder rather than a silent gap.
			b = 0x3f;
		}
		return { hex: b.toString(16).padStart(2, '0'), advance: this.advanceOf(String.fromCodePoint(cp)) };
	}

	private advanceOf(text: string): number {
		return this.family === 'Courier' ? 0.6 * [...text].length : estimateTextWidth(text, 1);
	}

	width(text: string): number {
		return this.advanceOf(text);
	}
}

// ---------------------------------------------------------------------------
// Font book
// ---------------------------------------------------------------------------

/** Splits a CSS `font-family` list into unquoted family names. */
export function splitFamilies(list: string): string[] {
	return list
		.split(',')
		.map((s) => s.trim().replace(/^["']|["']$/g, '').trim())
		.filter(Boolean);
}

/** Creates fonts on demand for a document, embedding supplied TrueType faces and falling back to the standard 14. */
export class PdfFontBook {
	private readonly byFamily = new Map<string, FontSourceFace[]>();
	private readonly cache = new Map<string, PdfFont>();
	private readonly embeddedFonts: EmbeddedFont[] = [];
	private subsetCounter = 0;

	constructor(
		private readonly writer: PdfWriter,
		sources: ReadonlyArray<ArrayBuffer | ArrayBufferView> = [],
		private readonly compress = true,
	) {
		for (const src of sources) {
			for (const face of readFaces(src)) {
				for (const name of [face.ttf.family, face.ttf.typoFamily, face.ttf.fullName]) {
					if (name) {
						const k = name.toLowerCase().trim();
						const list = this.byFamily.get(k) ?? [];
						if (!list.includes(face)) {
							list.push(face);
						}
						this.byFamily.set(k, list);
					}
				}
			}
		}
	}

	private findFace(families: string[], bold: boolean, italic: boolean): FontSourceFace | null {
		for (const fam of families) {
			const faces = this.byFamily.get(fam.toLowerCase());
			if (!faces || faces.length === 0) {
				continue;
			}
			const want = bold ? 700 : 400;
			let best = faces[0];
			let bestScore = Infinity;
			for (const f of faces) {
				const isItalic = (f.ttf.fsSelection & 1) !== 0 || (f.ttf.macStyle & 2) !== 0;
				const score = Math.abs(f.ttf.weightClass - want) + (isItalic !== italic ? 1000 : 0);
				if (score < bestScore) {
					bestScore = score;
					best = f;
				}
			}
			return best;
		}
		return null;
	}

	/** The font for a CSS family list and style (cached per distinct face). */
	resolve(familyList: string, bold: boolean, italic: boolean): PdfFont {
		const face = this.findFace(splitFamilies(familyList), bold, italic);
		if (face) {
			const key = `ttf:${face.ttf.fullName}:${face.base}:${face.ttf.family}:${face.ttf.weightClass}:${face.view.byteLength}`;
			let font = this.cache.get(key);
			if (!font) {
				const tag = String.fromCharCode(65 + (this.subsetCounter % 26), 65 + (Math.floor(this.subsetCounter / 26) % 26), 65, 66, 67, 68);
				this.subsetCounter++;
				const ps = (face.ttf.fullName || face.ttf.family || 'Font').replace(/[^A-Za-z0-9-]/g, '') || 'Font';
				const e = new EmbeddedFont(this.writer.reserve(), face, `${tag}+${ps}`);
				this.embeddedFonts.push(e);
				font = e;
				this.cache.set(key, font);
			}
			return font;
		}
		const family = standardFamilyFor(familyList);
		const baseFont = standardBaseFont(family, bold, italic);
		let font = this.cache.get(baseFont);
		if (!font) {
			font = new StandardFont(
				this.writer.add(`<< /Type /Font /Subtype /Type1 /BaseFont ${pdfName(baseFont)} /Encoding /WinAnsiEncoding >>`),
				family,
			);
			this.cache.set(baseFont, font);
		}
		return font;
	}

	/** Writes the subset programs and CID font objects of every embedded font. Call once, after all text is placed. */
	finish(): void {
		for (const f of this.embeddedFonts) {
			f.finish(this.writer, this.compress);
		}
	}
}
