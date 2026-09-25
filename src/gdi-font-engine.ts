/**
 * GDI font realisation and glyph rendering over caller-supplied TrueType
 * font files (`EmfConvertOptions.fonts`).
 *
 * Given the same font files Windows used, this reproduces what GDI itself
 * does between `CreateFontIndirect` and the glyph bitmaps `ExtTextOut`
 * blits:
 *
 * - **Font mapping**: the LOGFONT face name is looked up by family name
 *   (name ID 1, then the typographic family and full name), through the
 *   stock `FontSubstitutes` table (`MS Shell Dlg` → `Microsoft Sans Serif`,
 *   `Helvetica` → `Arial`, ...), and a face that is not available falls
 *   back by `lfPitchAndFamily` the way GDI's mapper does (FF_ROMAN →
 *   Times New Roman, FF_MODERN / fixed pitch → Courier New, otherwise
 *   Arial). Within a family the closest weight and matching slant win;
 *   a missing bold or italic is simulated.
 * - **Size**: a negative `lfHeight` is the em height (ppem); a positive one
 *   is the cell height, resolved through the font's `VDMX` table (ANSI
 *   group) or `usWinAscent + usWinDescent`. `lfWidth` stretches the font
 *   horizontally to an x-ppem of `lfWidth * unitsPerEm / xAvgCharWidth`.
 * - **Metrics**: `tmAscent`/`tmDescent` from `VDMX` or the rounded
 *   `usWinAscent`/`usWinDescent`; advance widths from `hdmx` or the hinted
 *   advance; underline and strike-out from `post`/`OS/2` (all measured
 *   against `GetTextMetrics`/`GetOutlineTextMetrics`/`GetCharWidth32` on
 *   Windows for Arial, Times New Roman, Courier New, Segoe UI and Tahoma at
 *   8..72 px: exact).
 * - **Glyphs**: hinted by the font's own TrueType instructions
 *   (`ttf-hinting.ts`) and scan-converted with TrueType dropout control
 *   (`ttf-raster.ts`): black-and-white with dropout control
 *   (NONANTIALIASED_QUALITY), 4x4-oversampled grayscale
 *   (ANTIALIASED_QUALITY, where the font's `gasp` table allows it), or
 *   ClearType (CLEARTYPE_QUALITY, and DEFAULT/DRAFT/PROOF_QUALITY under
 *   Windows' default smoothing): grid-fitted at 6x the horizontal ppem,
 *   sampled at 6x horizontally, box-filtered across R/G/B subpixels. The
 *   ClearType emulation is approximate (see `gdi-parity.fixture.test.ts`).
 * - **Rotation**: escapement and rotated world transforms rotate the
 *   grid-fitted outline; at non-axis angles the glyph is grid-fitted with
 *   GETINFO's "rotated" bit set and advances are the rounded linear
 *   widths, as GDI does. GDI additionally rounds its rotated scaling
 *   matrix, which is not reproduced (rotated text is close, not exact).
 *
 * @module gdi-font-engine
 */

import { parseRasterFontFile, type RasterFace } from './fnt-font';
import { parseFontFile, type TtfFont } from './ttf-font';
import { HintedSize, type HintedGlyph } from './ttf-hinting';
import { dropoutMode, rasterizeGray, rasterizeMono, rasterizeSamples, type GlyphBitmap, type Outline } from './ttf-raster';

/** Raw bytes of a `.ttf` or `.ttc` file. */
export type FontSource = ArrayBuffer | ArrayBufferView;

/** How glyphs are rendered: 1-bit, 17-level grayscale, or ClearType. */
export type GdiTextMode = 'mono' | 'gray' | 'cleartype';

/** LOGFONT quality constants. */
export const DEFAULT_QUALITY = 0;
export const DRAFT_QUALITY = 1;
export const PROOF_QUALITY = 2;
export const NONANTIALIASED_QUALITY = 3;
export const ANTIALIASED_QUALITY = 4;
export const CLEARTYPE_QUALITY = 5;
export const CLEARTYPE_NATURAL_QUALITY = 6;

/** A LOGFONT with its sizes already mapped to device pixels. */
export interface LogFontSpec {
	face: string;
	/** Signed device height: negative = em height, positive = cell height, 0 = default. */
	height: number;
	/** Device average character width (0 = the font's own aspect). */
	width: number;
	weight: number;
	italic: boolean;
	charSet: number;
	pitchAndFamily: number;
	quality: number;
	/**
	 * Skip grid-fitting and position glyphs at fractional pixels (GDI+'s
	 * SingleBitPerPixel / AntiAlias text rendering hints). GDI never does.
	 */
	unhinted?: boolean;
}

/**
 * Rendering mode for DEFAULT/DRAFT/PROOF quality fonts: what Windows'
 * system-wide font smoothing setting would pick. Windows' own default
 * (since Vista) is ClearType.
 */
export type DefaultTextSmoothing = GdiTextMode;

/** One rendered glyph: its bitmap relative to the pen position and its advance. */
export interface GdiGlyph {
	bitmap: GlyphBitmap | null;
	/** Integer advance width in device pixels. */
	advance: number;
}

/** Glyph index of the notdef glyph. */
const NOTDEF = 0;

/**
 * Stock `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\FontSubstitutes`
 * entries (lowercased) that point at TrueType faces.
 */
const FONT_SUBSTITUTES: Record<string, string> = {
	'ms shell dlg': 'microsoft sans serif',
	'ms shell dlg 2': 'tahoma',
	helvetica: 'arial',
	times: 'times new roman',
	'arial ce': 'arial',
	'arial cyr': 'arial',
	'arial greek': 'arial',
	'arial tur': 'arial',
	'arial baltic': 'arial',
	'courier new ce': 'courier new',
	'courier new cyr': 'courier new',
	'courier new greek': 'courier new',
	'courier new tur': 'courier new',
	'courier new baltic': 'courier new',
	'times new roman ce': 'times new roman',
	'times new roman cyr': 'times new roman',
	'times new roman greek': 'times new roman',
	'times new roman tur': 'times new roman',
	'times new roman baltic': 'times new roman',
	'tahoma armenian': 'tahoma',
	'arabic transparent': 'arial',
};

/**
 * GDI's raster-font italic: a cell `H` rows tall leans by
 * O = floor((H - 1) / 2) pixels from its bottom row to its top row, the
 * row `r` rows below the top shifting right by (H - 1 - r) * O / (H - 1)
 * rounded half up (measured on MS Sans Serif 13 and 20 px and Courier
 * 16 px cells).
 */
function slantRows(b: GlyphBitmap): GlyphBitmap {
	const span = b.height - 1;
	const lean = Math.floor(span / 2);
	const shift = (r: number): number => (span > 0 ? Math.floor(((span - r) * lean * 2 + span) / (2 * span)) : 0);
	const width = b.width + lean;
	const data = new Uint8Array(width * b.height);
	for (let y = 0; y < b.height; y++) {
		data.set(b.data.subarray(y * b.width, (y + 1) * b.width), y * width + shift(y));
	}
	return { ...b, width, data };
}

/** Raster-font stretch cost by whole-number factor (see `pickRaster`). */
const RASTER_STRETCH_COST = [0, 0, 120, 150, 250, 250];

/** A raster face's character height (cell minus internal leading). */
function unitOf(f: RasterFace): number {
	return Math.max(1, f.pixHeight - f.internalLeading);
}

/** Stock FontSubstitutes entries that point at raster (`.fon`) faces. */
const RASTER_SUBSTITUTES: Record<string, string> = {
	helv: 'ms sans serif',
	'tms rmn': 'ms serif',
};

/**
 * GDI's synthetic-italic shear, 0x5700 / 65536 (about 18.8 degrees),
 * applied to the hinted outline (x += y * shear, rounded to 1/64); the
 * advance widths are unchanged (measured with GGO_NATIVE on Tahoma, which
 * has no italic face).
 */
const ITALIC_SHEAR = 0x5700 / 65536;

function isItalicFace(f: TtfFont): boolean {
	return (f.fsSelection & 1) !== 0 || (f.macStyle & 2) !== 0;
}

// ---------------------------------------------------------------------------
// Realised font
// ---------------------------------------------------------------------------

/** The face-level facts text painting needs (a TrueType face, or a raster face's equivalent). */
export interface GdiFaceInfo {
	family: string;
	weightClass: number;
	fsSelection: number;
	macStyle: number;
	winAscent: number;
	unitsPerEm: number;
}

/** A font realised at one device size: what text layout and painting use. */
export interface GdiRealizedFont {
	readonly ttf: GdiFaceInfo;
	readonly ppem: number;
	readonly ppemX: number;
	readonly ascent: number;
	readonly descent: number;
	readonly underlinePosition: number;
	readonly underlineThickness: number;
	readonly strikeoutPosition: number;
	readonly strikeoutThickness: number;
	readonly mode: GdiTextMode;
	readonly syntheticBold: boolean;
	readonly syntheticItalic: boolean;
	readonly gridFit: boolean;
	glyphIndex(code: number): number;
	advance(index: number): number;
	rotatedAdvance(index: number): number;
	/**
	 * tmAscent / tmDescent of the font realised at a non-axis angle
	 * (escapement or world rotation), which TA_TOP / TA_BOTTOM use there;
	 * absent where rotation does not change them.
	 */
	readonly rotatedAscent?: number;
	readonly rotatedDescent?: number;
	glyph(index: number, m?: readonly [number, number, number, number], subX?: number): GdiGlyph;
	charForGlyph(index: number): number;
}

/** Windows-1252 code points for bytes 0x80..0x9F (the rest of the code page is Latin-1). */
const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
	0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** OEM_CHARSET: raster faces such as Terminal are encoded in the OEM code page (437). */
const OEM_CHARSET = 255;

/** Code page 437 code points for bytes 0x80..0xFF. */
const CP437_HIGH = [
	0xc7, 0xfc, 0xe9, 0xe2, 0xe4, 0xe0, 0xe5, 0xe7, 0xea, 0xeb, 0xe8, 0xef, 0xee, 0xec, 0xc4, 0xc5,
	0xc9, 0xe6, 0xc6, 0xf4, 0xf6, 0xf2, 0xfb, 0xf9, 0xff, 0xd6, 0xdc, 0xa2, 0xa3, 0xa5, 0x20a7, 0x0192,
	0xe1, 0xed, 0xf3, 0xfa, 0xf1, 0xd1, 0xaa, 0xba, 0xbf, 0x2310, 0xac, 0xbd, 0xbc, 0xa1, 0xab, 0xbb,
	0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
	0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
	0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
	0x03b1, 0xdf, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0xb5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
	0x2261, 0xb1, 0x2265, 0x2264, 0x2320, 0x2321, 0xf7, 0x2248, 0xb0, 0x2219, 0xb7, 0x221a, 0x207f, 0xb2, 0x25a0, 0xa0,
];

/**
 * A raster (`.fon`) face realised at one of its sizes, optionally scaled by
 * an integer factor (GDI stretches raster fonts only by whole multiples).
 * Glyphs are the font's own bitmaps; text is never antialiased or rotated
 * (GDI ignores escapement for raster fonts).
 */
export class RasterRealizedFont implements GdiRealizedFont {
	readonly ttf: GdiFaceInfo;
	readonly ppem: number;
	readonly ppemX: number;
	readonly ascent: number;
	readonly descent: number;
	readonly underlinePosition: number;
	readonly underlineThickness: number;
	readonly strikeoutPosition: number;
	readonly strikeoutThickness: number;
	readonly mode: GdiTextMode = 'mono';
	readonly syntheticBold: boolean;
	readonly syntheticItalic = false;
	readonly gridFit = true;
	private readonly glyphs = new Map<number, GdiGlyph>();

	/**
	 * @param scale - Whole-number vertical stretch.
	 * @param syntheticBold - Embolden (bold requested from a regular face).
	 * @param scaleX - Whole-number horizontal stretch (defaults to `scale`;
	 *   a non-zero lfWidth picks lfWidth / avgWidth rounded half down).
	 * @param obliquify - Slant the bitmaps (italic requested from an
	 *   upright face): GDI leans each row by about half its height above
	 *   the cell bottom (see `slantRows`), keeping the advances.
	 */
	constructor(
		readonly face: RasterFace,
		readonly scale: number,
		syntheticBold: boolean,
		readonly scaleX: number = scale,
		readonly obliquify = false,
	) {
		const n = scale;
		this.syntheticBold = syntheticBold;
		this.ascent = face.ascent * n;
		this.descent = (face.pixHeight - face.ascent) * n;
		this.ppem = (face.pixHeight - face.internalLeading) * n;
		this.ppemX = (face.pixHeight - face.internalLeading) * scaleX;
		this.underlinePosition = -n;
		this.underlineThickness = n;
		// Measured: the strike-out bar starts (ascent - internal leading) / 3,
		// rounded up, above the baseline (MS Sans Serif 13/16, Courier 13).
		this.strikeoutPosition = Math.ceil(((face.ascent - face.internalLeading) * n) / 3);
		this.strikeoutThickness = n;
		this.ttf = {
			family: face.family,
			weightClass: face.weight,
			fsSelection: face.italic ? 1 : 0,
			macStyle: 0,
			winAscent: this.ascent,
			unitsPerEm: this.ppem || 1,
		};
	}

	/** The font's 8-bit code for a Unicode character (Windows-1252 for the ANSI charsets). */
	glyphIndex(code: number): number {
		if (code < 0x80) {
			return code;
		}
		if (this.face.charSet === OEM_CHARSET) {
			const j = CP437_HIGH.indexOf(code);
			return j >= 0 ? 0x80 + j : this.face.defaultChar;
		}
		if (code >= 0xa0 && code < 0x100) {
			return code;
		}
		const i = CP1252_HIGH.indexOf(code);
		return i >= 0 ? 0x80 + i : this.face.defaultChar;
	}

	charForGlyph(index: number): number {
		if (index >= 0x80 && this.face.charSet === OEM_CHARSET) {
			return CP437_HIGH[index - 0x80] ?? index;
		}
		return index >= 0x80 && index < 0xa0 ? CP1252_HIGH[index - 0x80] : index;
	}

	advance(index: number): number {
		return this.face.width(index) * this.scaleX + (this.syntheticBold ? 1 : 0);
	}

	rotatedAdvance(index: number): number {
		return this.advance(index);
	}

	glyph(index: number): GdiGlyph {
		let g = this.glyphs.get(index);
		if (g) {
			return g;
		}
		const src = this.face.bitmap(index);
		const w = this.face.width(index);
		let bitmap: GlyphBitmap | null = null;
		if (src && w > 0) {
			const n = this.scale;
			const nx = this.scaleX;
			const h = this.face.pixHeight;
			const data = new Uint8Array(w * nx * h * n);
			for (let y = 0; y < h * n; y++) {
				for (let x = 0; x < w * nx; x++) {
					data[y * w * nx + x] = src[Math.floor(y / n) * w + Math.floor(x / nx)];
				}
			}
			bitmap = { width: w * nx, height: h * n, left: 0, top: this.ascent, data };
			// GDI slants first, then emboldens the slanted rows.
			if (this.obliquify) {
				bitmap = slantRows(bitmap);
			}
			if (this.syntheticBold) {
				bitmap = embolden(bitmap, 1);
			}
		}
		g = { bitmap, advance: this.advance(index) };
		this.glyphs.set(index, g);
		return g;
	}
}

/** A font realised at one device size and quality, with its glyph cache. */
export class RealizedFont implements GdiRealizedFont {
	readonly ttf: TtfFont;
	readonly ppem: number;
	readonly ppemX: number;
	/** Cell ascent / descent (tmAscent / tmDescent), device pixels. */
	readonly ascent: number;
	readonly descent: number;
	/** tmAscent / tmDescent at a non-axis angle (see {@link GdiRealizedFont.rotatedAscent}). */
	readonly rotatedAscent: number;
	readonly rotatedDescent: number;
	/** Underline / strike-out: position above the baseline (y up) and thickness. */
	readonly underlinePosition: number;
	readonly underlineThickness: number;
	readonly strikeoutPosition: number;
	readonly strikeoutThickness: number;
	readonly mode: GdiTextMode;
	readonly syntheticBold: boolean;
	readonly syntheticItalic: boolean;
	/** False for GDI+'s non-grid-fitted hints: unhinted outlines, fractional advances and origins. */
	readonly gridFit: boolean;
	private readonly hinted: HintedSize;
	private rotatedSize: HintedSize | null = null;
	private readonly rotOutlines = new Map<number, HintedGlyph>();
	private readonly hdmx: Uint8Array | undefined;
	/** lfWidth of a horizontally stretched font (0 = not stretched). */
	private readonly stretchWidth: number;
	private readonly outlines = new Map<number, HintedGlyph>();
	private readonly glyphs = new Map<string, GdiGlyph>();

	constructor(
		ttf: TtfFont,
		ppem: number,
		ppemX: number,
		mode: GdiTextMode,
		syntheticBold: boolean,
		syntheticItalic: boolean,
		cellHeight = 0,
		stretchWidth = 0,
		gridFit = true,
	) {
		this.ttf = ttf;
		this.gridFit = gridFit;
		this.stretchWidth = ppemX !== ppem ? stretchWidth : 0;
		this.ppem = ppem;
		this.ppemX = ppemX;
		this.mode = mode;
		this.syntheticBold = syntheticBold;
		this.syntheticItalic = syntheticItalic;
		const upem = ttf.unitsPerEm;
		const scale = (v: number): number => Math.round((v * ppem) / upem);
		const vd = ttf.vdmx?.find((e) => e.ppem === ppem);
		const cellUnits = ttf.winAscent + ttf.winDescent;
		if (vd) {
			this.ascent = vd.yMax;
			this.descent = -vd.yMin;
		} else if (cellHeight > 0 && cellUnits > 0) {
			// A cell-height request without a VDMX entry splits the requested
			// cell itself (measured: Tahoma lfHeight 20 -> ppem 16, 17 + 3).
			this.ascent = Math.round((ttf.winAscent * cellHeight) / cellUnits);
			this.descent = cellHeight - this.ascent;
		} else {
			this.ascent = scale(ttf.winAscent);
			this.descent = scale(ttf.winDescent);
		}
		// Rotated (non-axis) realisations report the head bounding box, scaled
		// and padded: floor(yMax * ppem / upem + 1.27) (measured exact for
		// Arial and Times New Roman lfHeight -10..-24 at 25 and 45 degrees,
		// both ascent and descent; the fitted pad lies in [1.254, 1.288)).
		this.rotatedAscent = Math.floor((ttf.headYMax * ppem) / upem + 1.27);
		this.rotatedDescent = Math.floor((-ttf.headYMin * ppem) / upem + 1.27);
		this.underlinePosition = scale(ttf.underlinePosition);
		this.underlineThickness = scale(ttf.underlineThickness);
		this.strikeoutPosition = scale(ttf.strikeoutPosition);
		this.strikeoutThickness = scale(ttf.strikeoutSize);
		this.hinted = new HintedSize(ttf, ppemX, ppem, { version: 35, grayscale: mode !== 'mono' }, gridFit);
		this.hdmx = ppemX === ppem ? ttf.hdmx.get(ppem) : undefined;
	}

	/** Glyph index for a character code (UTF-16 code unit or code point). */
	glyphIndex(code: number): number {
		return this.ttf.glyphIndex(code);
	}

	private reverseCmap: Map<number, number> | null = null;

	/** A character that maps to glyph `index` (for SVG text of ETO_GLYPH_INDEX runs), or U+FFFD. */
	charForGlyph(index: number): number {
		if (!this.reverseCmap) {
			this.reverseCmap = new Map();
			for (let cp = 0xffff; cp >= 0x20; cp--) {
				const g = this.ttf.glyphIndex(cp);
				if (g) {
					this.reverseCmap.set(g, cp);
				}
			}
		}
		return this.reverseCmap.get(index) ?? 0xfffd;
	}

	private outline(index: number): HintedGlyph {
		let g = this.outlines.get(index);
		if (!g) {
			g = this.hinted.hintGlyph(index < this.ttf.numGlyphs ? index : NOTDEF);
			this.outlines.set(index, g);
		}
		return g;
	}

	private ctSize: HintedSize | null = null;
	/** CLEARTYPE_NATURAL_QUALITY: ClearType glyphs keep their own (natural) widths. */
	naturalWidths = false;
	private readonly ctOutlines = new Map<number, Outline>();

	/**
	 * The outline ClearType rasterises. It is grid-fitted at the real ppem
	 * with the Microsoft rasterizer's ClearType interpreter rules (see
	 * `HintEnvironment.clearType`: x rounds on a 1/16-pixel virtual grid,
	 * legacy x-direction deltas are skipped, ...), then, for GDI's default
	 * "compatible widths" ClearType, scaled horizontally so the glyph's
	 * natural (unhinted) advance fills the black-and-white advance width
	 * GDI keeps for ClearType text. CLEARTYPE_NATURAL_QUALITY keeps the
	 * natural widths unscaled.
	 */
	private ctOutline(index: number): Outline {
		let o = this.ctOutlines.get(index);
		if (o) {
			return o;
		}
		const gi = index < this.ttf.numGlyphs ? index : NOTDEF;
		this.ctSize ??= new HintedSize(this.ttf, this.ppemX, this.ppem, { version: 40, grayscale: false, clearType: true });
		const u = this.ctSize.hintGlyph(gi);
		const natural = (this.ttf.hMetrics(gi).advance * this.ppemX) / this.ttf.unitsPerEm;
		const k = !this.naturalWidths && natural > 0 ? this.advance(index) / natural : 1;
		o = { xs: Array.from(u.xs, (v) => v * k), ys: u.ys, onCurve: u.onCurve, endPts: u.endPts };
		this.ctOutlines.set(index, o);
		return o;
	}

	private rotatedOutline(index: number): HintedGlyph {
		let g = this.rotOutlines.get(index);
		if (!g) {
			this.rotatedSize ??= new HintedSize(this.ttf, this.ppemX, this.ppem, {
				version: 35,
				grayscale: this.mode !== 'mono',
				rotated: true,
			});
			g = this.rotatedSize.hintGlyph(index < this.ttf.numGlyphs ? index : NOTDEF);
			this.rotOutlines.set(index, g);
		}
		return g;
	}

	/** Integer advance width of glyph `index`, as GetCharWidth32 reports it. */
	advance(index: number): number {
		const hd = this.hdmx;
		let base: number;
		if (this.stretchWidth > 0) {
			// A stretched font advances linearly at lfWidth / xAvgCharWidth
			// pixels per font unit, unrounded scale (measured against
			// GetCharWidth32 for Arial/Times/Tahoma at lfWidth 4..19).
			const { advance } = this.ttf.hMetrics(index < this.ttf.numGlyphs ? index : NOTDEF);
			base = Math.round((advance * this.stretchWidth) / this.ttf.xAvgCharWidth);
		} else if (!this.gridFit) {
			base = this.outline(index).linearAdvance / 64;
		} else {
			base = hd && index < hd.length ? hd[index] : Math.round(this.outline(index).advance / 64);
		}
		return base + (this.syntheticBold ? 1 : 0);
	}

	/**
	 * Advance of glyph `index` in a font realised with an escapement: GDI
	 * does not use the hinted/hdmx widths there but the linearly scaled
	 * advance, rounded (measured: the Dx GDI records for Times New Roman at
	 * 30 and 90 degrees).
	 */
	rotatedAdvance(index: number): number {
		const { advance } = this.ttf.hMetrics(index < this.ttf.numGlyphs ? index : NOTDEF);
		return Math.round((advance * this.ppemX) / this.ttf.unitsPerEm) + (this.syntheticBold ? 1 : 0);
	}

	/**
	 * The glyph bitmap for `index`, optionally rotated by the 2x2 matrix
	 * `m` = [a, b, c, d] (device, y down: x' = a*x + c*y, y' = b*x + d*y,
	 * applied to the hinted outline about the pen position).
	 */
	glyph(index: number, m?: readonly [number, number, number, number], subX = 0): GdiGlyph {
		const key = (m ? `${index}|${m.map((v) => v.toFixed(6)).join(',')}` : String(index)) + (subX ? `@${subX}` : '');
		let g = this.glyphs.get(key);
		if (g) {
			return g;
		}
		const skew = m && !(Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) && !(Math.abs(m[0]) < 1e-9 && Math.abs(m[3]) < 1e-9);
		// A glyph at a non-axis angle is grid-fitted with GETINFO's "rotated"
		// bit set, which makes the stock fonts skip their stem hints (and
		// enable dropout control), as GDI does; 90/180/270 degrees keep the
		// upright hinting (measured exact against the escapement fixtures).
		const src = skew ? this.rotatedOutline(index) : this.outline(index);
		if (skew && m) {
			// GDI scales a rotated glyph by the font matrix rounded to whole
			// pixels per em (ppem*cos and ppem*sin each rounded), so a 16 px
			// glyph at 25 degrees is drawn about 16.5 px tall (measured with
			// GetGlyphOutline; it cuts the escapement fixtures' residual by
			// a fifth).
			const p = this.ppem;
			m = [Math.round(m[0] * p) / p, Math.round(m[1] * p) / p, Math.round(m[2] * p) / p, Math.round(m[3] * p) / p];
		}
		let o: Outline = src;
		if (this.syntheticItalic || m || subX) {
			const n = src.xs.length;
			const xs = new Float64Array(n);
			const ys = new Float64Array(n);
			for (let i = 0; i < n; i++) {
				let x = src.xs[i];
				const y = src.ys[i];
				if (this.syntheticItalic) {
					x += y * ITALIC_SHEAR;
				}
				if (m) {
					// Outline space is y up; the matrix is in device (y down) space.
					xs[i] = Math.round(m[0] * x - m[2] * y);
					ys[i] = Math.round(-(m[1] * x - m[3] * y));
				} else {
					xs[i] = Math.round(x + subX);
					ys[i] = y;
				}
			}
			o = { xs, ys, onCurve: src.onCurve, endPts: src.endPts };
		}
		let bitmap: GlyphBitmap | null;
		if (this.mode === 'mono') {
			bitmap = rasterizeMono(o, dropoutMode(src.scanControl, src.scanType));
		} else if (this.mode === 'cleartype') {
			bitmap = rasterizeClearType(!m && !this.syntheticItalic ? this.ctOutline(index) : o);
		} else {
			bitmap = rasterizeGray(o);
		}
		if (bitmap && this.syntheticBold) {
			bitmap = embolden(bitmap, this.mode === 'mono' ? 1 : 16);
		}
		g = { bitmap, advance: this.advance(index) };
		this.glyphs.set(key, g);
		return g;
	}
}

/** GDI's bitmap emboldening: each row OR-ed (max-ed) with itself shifted one pixel right. */
function embolden(b: GlyphBitmap, full: number): GlyphBitmap {
	const w = b.width + 1;
	const data = new Uint8Array(w * b.height);
	for (let y = 0; y < b.height; y++) {
		for (let x = 0; x < w; x++) {
			const a = x < b.width ? b.data[y * b.width + x] : 0;
			const l = x > 0 ? b.data[y * b.width + x - 1] : 0;
			data[y * w + x] = Math.min(full, Math.max(a, l));
		}
	}
	return { width: w, height: b.height, left: b.left, top: b.top, data };
}

// ---------------------------------------------------------------------------
// Collection / mapper
// ---------------------------------------------------------------------------

const collectionCache = new WeakMap<object, GdiFontCollection>();

/** The fonts a conversion may realise LOGFONTs from. */
export class GdiFontCollection {
	private readonly families = new Map<string, TtfFont[]>();
	private readonly rasterFamilies = new Map<string, RasterFace[]>();
	private readonly realized = new Map<string, GdiRealizedFont | null>();
	readonly defaultSmoothing: DefaultTextSmoothing;

	constructor(sources: readonly FontSource[], defaultSmoothing: DefaultTextSmoothing = 'cleartype') {
		this.defaultSmoothing = defaultSmoothing;
		for (const src of sources) {
			for (const face of parseRasterFontFile(src)) {
				const k = face.family.toLowerCase().trim();
				const list = this.rasterFamilies.get(k) ?? [];
				list.push(face);
				this.rasterFamilies.set(k, list);
			}
			for (const face of parseFontFile(src)) {
				this.add(face.family, face);
				if (face.typoFamily && face.typoFamily !== face.family) {
					this.addAlias(face.typoFamily, face);
				}
				if (face.fullName && face.fullName !== face.family) {
					this.addAlias(face.fullName, face);
				}
			}
		}
	}

	/**
	 * A collection for `sources`, cached per sources array (so converting
	 * many files with the same `fonts` option parses each font once).
	 */
	static for(sources: readonly FontSource[], defaultSmoothing: DefaultTextSmoothing = 'cleartype'): GdiFontCollection {
		const key = sources as object;
		let c = collectionCache.get(key);
		if (!c || c.defaultSmoothing !== defaultSmoothing) {
			c = new GdiFontCollection(sources, defaultSmoothing);
			collectionCache.set(key, c);
		}
		return c;
	}

	get size(): number {
		return this.families.size + this.rasterFamilies.size;
	}

	private add(name: string, face: TtfFont): void {
		const k = name.toLowerCase().trim();
		const list = this.families.get(k) ?? [];
		list.push(face);
		this.families.set(k, list);
	}

	/** Secondary names only apply when no face claims them as its primary family. */
	private addAlias(name: string, face: TtfFont): void {
		const k = name.toLowerCase().trim();
		const list = this.families.get(k);
		if (!list) {
			this.families.set(k, [face]);
		} else if (!list.some((f) => f.family.toLowerCase().trim() === k)) {
			list.push(face);
		}
	}

	/** The faces of a family, following GDI's substitutions and pitch/family fallback. */
	private familyFaces(face: string, pitchAndFamily: number, fontFamilyMap?: Record<string, string>): TtfFont[] | null {
		const k = face.toLowerCase().trim();
		const direct = this.families.get(k);
		if (direct) {
			return direct;
		}
		const mapped = fontFamilyMap?.[k];
		if (mapped) {
			const m = this.families.get(mapped.replace(/^["']|["']$/g, '').toLowerCase().trim());
			if (m) {
				return m;
			}
		}
		const sub = FONT_SUBSTITUTES[k];
		if (sub && this.families.get(sub)) {
			return this.families.get(sub)!;
		}
		const family = pitchAndFamily & 0xf0;
		const fixed = (pitchAndFamily & 3) === 1;
		const fallback =
			family === 0x10 ? 'times new roman' : family === 0x30 || fixed ? 'courier new' : 'arial';
		return this.families.get(fallback) ?? null;
	}

	/**
	 * The raster size GDI's font mapper picks for a device height, as a face
	 * and a whole-number stretch (1 to 5). Heights compare as character
	 * heights for a negative lfHeight and cell heights for a positive one.
	 * The cost model is fitted to GetTextMetrics over lfHeight -60..60 for
	 * MS Sans Serif, MS Serif, Courier, Small Fonts, System and Terminal
	 * (98% exact): 150 per pixel too small; 290 plus 350 per pixel too big;
	 * a stretch cost by factor (120, 150, 250, 250 for 2x..5x) plus 100 per
	 * extra factor divided by the face's character height (small faces
	 * stretch less readily); ties go to the smaller stretch, then to the
	 * 96 dpi face. A weight mismatch costs 3 per 10 units (so Terminal's
	 * bold 8 pixel size serves regular requests).
	 */
	private pickRaster(faces: RasterFace[], height: number, weight: number): { face: RasterFace; scale: number } | null {
		const pool = faces;
		if (pool.length === 0) {
			return null;
		}
		if (height === 0) {
			const sorted = pool.slice().sort((a, b) => a.pixHeight - b.pixHeight);
			return { face: sorted.find((f) => f.points >= 10) ?? sorted[0], scale: 1 };
		}
		const target = Math.abs(height);
		let best: { face: RasterFace; scale: number } | null = null;
		let bestCost = Infinity;
		for (const f of pool) {
			const unit = height < 0 ? unitOf(f) : f.pixHeight;
			for (let n = 1; n <= 5; n++) {
				const d = unit * n - target;
				const cost =
					(d < 0 ? -d * 150 : d > 0 ? 290 + d * 350 : 0) +
					RASTER_STRETCH_COST[n] +
					(n > 1 ? (100 * (n - 1)) / unitOf(f) : 0) +
					(Math.abs(f.weight - weight) * 3) / 10 +
					n * 0.01 +
					(f.vertRes === 96 ? 0 : 0.001);
				if (cost < bestCost) {
					bestCost = cost;
					best = { face: f, scale: n };
				}
			}
		}
		return best;
	}

	private realizeRaster(faces: RasterFace[], spec: LogFontSpec): GdiRealizedFont | null {
		const weight = spec.weight || 400;
		const pick = this.pickRaster(faces, spec.height, weight);
		if (!pick) {
			return null;
		}
		const { face, scale } = pick;
		const scaleX = spec.width > 0 && face.avgWidth > 0 ? Math.max(1, Math.ceil(spec.width / face.avgWidth - 0.5)) : scale;
		return new RasterRealizedFont(face, scale, weight >= 600 && face.weight < 600, scaleX, spec.italic && !face.italic);
	}

	/**
	 * MS Shell Dlg renders with Microsoft Sans Serif but GDI snaps small
	 * sizes to the MS Sans Serif bitmap sizes: when the raster mapper would
	 * pick an unstretched 8 or 10 point bitmap whose cell is at most one
	 * pixel taller than the TrueType cell `ttCell`, the TrueType ppem
	 * becomes that bitmap's character height (measured: lfHeight -9..-12
	 * give ppem 11, -13..-15 ppem 13, cell heights 12..15 ppem 11 and
	 * 16..19 ppem 13, while -8 and cell heights up to 11 stay unsnapped).
	 */
	private shellDlgPpem(spec: LogFontSpec, ttCell: number): number {
		const raster = this.rasterFamilies.get('ms sans serif');
		if (!raster || spec.height === 0) {
			return 0;
		}
		const pick = this.pickRaster(raster, spec.height, spec.weight || 400);
		if (!pick || pick.scale !== 1 || pick.face.pixHeight > 16) {
			return 0;
		}
		const f = pick.face;
		return f.pixHeight <= ttCell + 1 ? f.pixHeight - f.internalLeading : 0;
	}

	/** Realises `spec`, or null when no supplied font can stand in for it. */
	realize(spec: LogFontSpec, fontFamilyMap?: Record<string, string>): GdiRealizedFont | null {
		const key = JSON.stringify(spec) + (fontFamilyMap ? JSON.stringify(fontFamilyMap) : '');
		if (this.realized.has(key)) {
			return this.realized.get(key)!;
		}
		const k = spec.face.toLowerCase().trim();
		if (!this.families.has(k)) {
			const rasterName = this.rasterFamilies.has(k) ? k : RASTER_SUBSTITUTES[k];
			const raster = rasterName ? this.rasterFamilies.get(rasterName) : undefined;
			if (raster) {
				const r = this.realizeRaster(raster, spec);
				this.realized.set(key, r);
				return r;
			}
		}
		const faces = this.familyFaces(spec.face, spec.pitchAndFamily, fontFamilyMap);
		let result: GdiRealizedFont | null = null;
		if (faces && faces.length > 0) {
			const weight = spec.weight || 400;
			let best = faces[0];
			let bestScore = Infinity;
			for (const f of faces) {
				// A heavier face costs three times its weight distance, a lighter
				// one once (measured: Arial/Tahoma/Segoe UI at lfWeight 600
				// realise the regular face emboldened, at 650 the bold face).
				const dw = f.weightClass - weight;
				const score = (isItalicFace(f) !== spec.italic ? 10000 : 0) + (dw > 0 ? dw * 3 : -dw);
				if (score < bestScore) {
					best = f;
					bestScore = score;
				}
			}
			const synthItalic = spec.italic && !isItalicFace(best);
			const synthBold = weight >= 600 && best.weightClass < 600;
			const make = (ppem: number, cellHeight: number): RealizedFont | null => {
				if (!(ppem > 0 && ppem <= 2048)) {
					return null;
				}
				// lfWidth equal to the natural tmAveCharWidth is no stretch at all
				// (measured: Times New Roman 11 px with lfWidth 4).
				const naturalAvg = Math.round((best.xAvgCharWidth * ppem) / best.unitsPerEm);
				const ppemX =
					spec.width > 0 && best.xAvgCharWidth > 0 && spec.width !== naturalAvg
						? Math.max(1, Math.round((spec.width * best.unitsPerEm) / best.xAvgCharWidth))
						: ppem;
				const tt = new RealizedFont(
					best,
					ppem,
					ppemX,
					this.modeFor(best, spec.quality, ppem),
					synthBold,
					synthItalic,
					cellHeight,
					spec.width,
					!spec.unhinted,
				);
				tt.naturalWidths = spec.quality === CLEARTYPE_NATURAL_QUALITY;
				return tt;
			};
			let tt = make(resolvePpem(best, spec.height), spec.height > 0 ? Math.round(spec.height) : 0);
			if (tt && k === 'ms shell dlg') {
				const snapped = this.shellDlgPpem(spec, tt.ascent + tt.descent);
				if (snapped && snapped !== tt.ppem) {
					tt = make(snapped, 0);
				}
			}
			result = tt;
		}
		this.realized.set(key, result);
		return result;
	}

	/** Rendering mode for a LOGFONT quality at a ppem (honouring the font's `gasp`). */
	private modeFor(font: TtfFont, quality: number, ppem: number): GdiTextMode {
		let mode: GdiTextMode;
		switch (quality) {
			case NONANTIALIASED_QUALITY:
				return 'mono';
			case ANTIALIASED_QUALITY:
				mode = 'gray';
				break;
			case CLEARTYPE_QUALITY:
			case CLEARTYPE_NATURAL_QUALITY:
				mode = 'cleartype';
				break;
			default:
				mode = this.defaultSmoothing;
		}
		if (mode === 'gray') {
			const range = font.gasp.find((r) => ppem <= r.maxPpem);
			if (range && (range.behavior & 2) === 0) {
				return 'mono';
			}
		}
		return mode;
	}
}

/**
 * The ppem GDI realises a signed device `lfHeight` at: the em height for a
 * negative value; for a positive (cell) height, the largest `VDMX` ppem
 * whose yMax - yMin fits, else `height * unitsPerEm / (winAscent +
 * winDescent)` rounded, then stepped down while that ppem's own cell
 * (`VDMX`, or the rounded win metrics) is still taller than requested (measured against
 * `GetTextMetrics` for five faces at every cell height 5..72: exact).
 */
export function resolvePpem(font: TtfFont, height: number): number {
	if (height < 0) {
		return Math.round(-height);
	}
	const h = Math.round(height === 0 ? 16 : height);
	const vd = font.vdmx;
	if (vd && vd.length > 0) {
		let found = 0;
		for (let i = 0; i < vd.length; i++) {
			const cell = vd[i].yMax - vd[i].yMin;
			if (cell === h) {
				found = vd[i].ppem;
				break;
			}
			if (cell > h) {
				found = i > 0 ? vd[i - 1].ppem : 0;
				break;
			}
		}
		if (found > 0) {
			return found;
		}
	}
	const cellUnits = font.winAscent + font.winDescent || font.hheaAscender - font.hheaDescender;
	let ppem = Math.max(1, Math.round((h * font.unitsPerEm) / (cellUnits || font.unitsPerEm)));
	const upem = font.unitsPerEm;
	while (ppem > 1) {
		const e = vd?.find((v) => v.ppem === ppem);
		const cell = e
			? e.yMax - e.yMin
			: Math.round((font.winAscent * ppem) / upem) + Math.round((font.winDescent * ppem) / upem);
		if (cell <= h) {
			break;
		}
		ppem--;
	}
	return ppem;
}

/** ClearType's horizontal oversampling: 2 samples per subpixel, 6 per pixel. */
const CLEARTYPE_OVERSAMPLE = 6;

/**
 * ClearType rasterisation as GDI does it: the outline is sampled at 6x
 * horizontally (2 samples per R/G/B subpixel, one row per pixel), each
 * subpixel's coverage is averaged with its two neighbours (a 3-tap box
 * filter across subpixels), giving one 0..255 alpha per colour channel.
 * Fitted to the edge profiles of `textx-arial-cleartype` (an Arial stem at
 * 72 px reproduces to within 1 level per channel).
 */
function rasterizeClearType(o: Outline): GlyphBitmap | null {
	const S = CLEARTYPE_OVERSAMPLE / 3;
	const r = rasterizeSamples(o, CLEARTYPE_OVERSAMPLE, 1, 1);
	if (!r) {
		return null;
	}
	const { box, hi } = r;
	const width = box.xMax - box.xMin;
	const height = box.yMax - box.yMin;
	const n = width * 3;
	const sub = new Float64Array(n);
	const data = new Uint8Array(n * height);
	for (let y = 0; y < height; y++) {
		sub.fill(0);
		const row = y * hi.width;
		for (let x = 0; x < hi.width; x++) {
			if (hi.data[row + x]) {
				sub[Math.floor(x / S)] += 1;
			}
		}
		for (let j = 0; j < n; j++) {
			const acc = (j > 0 ? sub[j - 1] : 0) + sub[j] + (j + 1 < n ? sub[j + 1] : 0);
			data[y * n + j] = Math.round((255 * acc) / (3 * S));
		}
	}
	return { width, height, left: box.xMin, top: box.yMax, data, channels: 3 };
}
