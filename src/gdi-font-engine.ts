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
 *   widths, as GDI does. A font that forces integer ppem (every stock
 *   font) is hinted unrotated at round(ppem * max(|cos|, |sin|)) and then
 *   rotated by the matrix over its major component (`rotationMatrix`;
 *   `roundedRotationMatrix` serves the matrices that are not rotations);
 *   the remaining rotated-text differences are single edge pixels.
 *
 * @module gdi-font-engine
 */

import { parseRasterFontFile, type RasterFace } from './fnt-font';
import { pickRasterFace } from './raster-mapper';
import { parseFontFile, type TtfFont } from './ttf-font';
import { DEFAULT_DROPOUT_PPEM, HintedSize, type HintedGlyph } from './ttf-hinting';
import { msGrayBitmap, msMonoBitmap } from './ttf-msscan';
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
	 * Use linear advances and fractional positions (GDI+'s SingleBitPerPixel /
	 * AntiAlias hints). GDI never does. GDI+ grayscale retains its smoothing
	 * interpreter even when advances are linear.
	 */
	unhinted?: boolean;
	/**
	 * Antialias whatever the font's `gasp` table says (GDI+'s AntiAlias
	 * hints do; GDI turns grayscale off where `gasp` asks).
	 */
	ignoreGasp?: boolean;
	/** GDI+ smoothing uses natural-width hinting and its own coverage quantisation. */
	gdiPlus?: boolean;
	/**
	 * The horizontal stretch `eyScale / exScale` stored in a GM_COMPATIBLE text record, which native playback draws the
	 * text through (see {@link playbackStretchReacts}). Absent or 1: none.
	 */
	playbackStretch?: number;
	/** GDI+ text drawn at an identity world scale (the hinting rules of `HintEnvironment.shpixX` apply). */
	unscaledText?: boolean;
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
function slantRows(b: GlyphBitmap, extra = 0): { bitmap: GlyphBitmap; shift: (row: number) => number } {
	const span = b.height - 1;
	const lean = Math.floor(span / 2);
	const shift = (r: number): number => (span > 0 ? Math.floor(((span - r) * lean * 2 + span) / (2 * span)) : 0) + extra;
	const width = b.width + lean + extra;
	const data = new Uint8Array(width * b.height);
	for (let y = 0; y < b.height; y++) {
		data.set(b.data.subarray(y * b.width, (y + 1) * b.width), y * width + shift(y));
	}
	return { bitmap: { ...b, width, data }, shift };
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
 * has no italic face). A stretched font (`lfWidth`) shears by that factor times
 * the unrounded horizontal stretch, `lfWidth * unitsPerEm / xAvgCharWidth / ppem`
 * (Tahoma at 17 px with lfWidth 7 and 15: 0.9264 and 1.9852, not the 16/17 and
 * 34/17 of the rounded `ppemX` the outline is grid-fitted at; 1,500 points).
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
	/** Unrounded cell descent in font units, when the face supplies it. */
	winDescent?: number;
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
	/** Pixels the strike-out bar is shifted right (a slanted raster face leans it like a glyph row). */
	readonly strikeoutShift?: number;
	/**
	 * The unrounded `post` / `OS/2` bar geometry in device pixels (positions above the baseline, y up), for GDI+
	 * AntiAlias text, which draws its bars at fractional positions.
	 */
	readonly exactDecorations?: { underlinePosition: number; underlineThickness: number; strikeoutPosition: number; strikeoutThickness: number };
	readonly mode: GdiTextMode;
	readonly syntheticBold: boolean;
	readonly syntheticItalic: boolean;
	readonly gridFit: boolean;
	/** GDI+ retains both origin phases in grayscale, and only the x phase in ClearType. */
	readonly fractionalOrigins?: 'x' | 'xy';
	glyphIndex(code: number): number;
	advance(index: number): number;
	/** GDI+ ClearTypeGridFit's DrawString advance: the ClearType phantom-point advance rounded (TrueType faces only). */
	ctGridAdvance?(index: number): number;
	/** GDI+ design advance: apply tracking in font units before device scaling. */
	designAdvance?(index: number, tracking: number): number;
	rotatedAdvance(index: number, halfTurn?: boolean): number;
	/** Unrounded linear advance, which GDI accumulates along a non-axis baseline. */
	rotatedLinearAdvance?(index: number): number;
	/**
	 * tmAscent / tmDescent of the font realised at a non-axis angle
	 * (escapement or world rotation), which TA_TOP / TA_BOTTOM use there;
	 * absent where rotation does not change them.
	 */
	readonly rotatedAscent?: number;
	readonly rotatedDescent?: number;
	/**
	 * tmAscent / tmDescent of the font realised with the baseline direction `(ux, uy)` (device, y down), for any angle
	 * but zero: a quarter turn and a half turn have metrics of their own. Undefined where the upright metrics apply.
	 */
	rotatedMetrics?(ux: number, uy: number): { ascent: number; descent: number } | undefined;
	glyph(index: number, m?: readonly [number, number, number, number], subX?: number, subY?: number): GdiGlyph;
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
	readonly strikeoutShift: number;
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
		// Decorations are laid out on the unstretched face and then stretched (`text-raster-styles`, every face and
		// size): the bars are floor(cell / 12) source rows thick (at least one); the underline starts one source row
		// below the baseline (two when it is thicker than one row) and is pulled up into the cell when it would
		// leave it; the strike-out bar's top is ceil((ascent - internal leading) / 3) source rows above the baseline.
		const sourceThickness = Math.max(1, Math.floor(face.pixHeight / 12));
		this.underlineThickness = sourceThickness * n;
		this.underlinePosition = -Math.min((sourceThickness >= 2 ? 2 : 1) * n, this.descent - this.underlineThickness);
		const strikeRows = Math.ceil((face.ascent - face.internalLeading) / 3);
		this.strikeoutPosition = strikeRows * n;
		this.strikeoutThickness = this.underlineThickness;
		// A slanted face leans the strike-out bar like a glyph row measured at the middle of its top source row.
		const span = face.pixHeight - 1;
		this.strikeoutShift = obliquify && span > 0 ? Math.max(0, Math.floor(((2 * strikeRows - 1) * Math.floor(span / 2) + span) / (2 * span))) : 0;
		this.ttf = {
			family: face.family,
			weightClass: face.weight,
			fsSelection: face.italic ? 1 : 0,
			macStyle: 0,
			winAscent: this.ascent,
			winDescent: this.descent,
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
			// GDI slants first, then emboldens the slanted rows. A bold slanted bitmap leans one pixel further when the
			// face is stretched, and the smear into the column after the glyph's last one is lost where that column
			// starts a byte of the packed row (`text-raster-styles`: all 196 bold italic captures of seven faces).
			if (this.obliquify) {
				const unslanted = bitmap.width;
				const slanted = slantRows(bitmap, this.syntheticBold && n > 1 ? 1 : 0);
				bitmap = slanted.bitmap;
				if (this.syntheticBold) {
					const keep = embolden(bitmap, 1);
					for (let y = 0; y < keep.height; y++) {
						const lastColumn = unslanted + slanted.shift(y);
						if (lastColumn % 8 === 0 && (lastColumn >= bitmap.width || !bitmap.data[y * bitmap.width + lastColumn])) {
							keep.data[y * keep.width + lastColumn] = 0;
						}
					}
					bitmap = keep;
				}
			} else if (this.syntheticBold) {
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
	readonly exactDecorations: { underlinePosition: number; underlineThickness: number; strikeoutPosition: number; strikeoutThickness: number };
	readonly mode: GdiTextMode;
	readonly syntheticBold: boolean;
	readonly syntheticItalic: boolean;
	/** False for GDI+'s non-grid-fitted hints: unhinted outlines, fractional advances and origins. */
	readonly gridFit: boolean;
	readonly fractionalOrigins?: 'x' | 'xy';
	private readonly hinted: HintedSize;
	private readonly rotatedSizes = new Map<number, HintedSize>();
	private readonly rotOutlines = new Map<string, HintedGlyph>();
	/** GDI's own interpreter run, whose phantom point GDI+ grid-fit grayscale layout takes its advances from. */
	private readonly advanceSize: HintedSize | null = null;
	private readonly advanceOutlines = new Map<number, HintedGlyph>();
	private readonly hdmx: Uint8Array | undefined;
	/** lfWidth of a horizontally stretched font (0 = not stretched). */
	private readonly stretchWidth: number;
	/** The synthetic-italic shear, scaled by the unrounded horizontal stretch of a stretched font. */
	private readonly italicShear: number;
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
		private readonly gdiPlus = false,
		private readonly playbackStretched = false,
		plusUnscaled = false,
	) {
		this.ttf = ttf;
		this.gridFit = gridFit;
		this.fractionalOrigins = gdiPlus ? mode === 'gray' ? 'xy' : mode === 'cleartype' ? 'x' : undefined : undefined;
		this.stretchWidth = ppemX !== ppem ? stretchWidth : 0;
		this.italicShear = this.stretchWidth > 0 && ttf.xAvgCharWidth > 0 ? (ITALIC_SHEAR * ((this.stretchWidth * ttf.unitsPerEm) / ttf.xAvgCharWidth)) / ppem : ITALIC_SHEAR;
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
		// and padded by 1/64 em: floor(yMax * ppem / upem + ppem / 64 + 0.964)
		// (`GetTextMetrics` of Arial, Times New Roman, Tahoma, Courier New
		// and Segoe UI at lfHeight -8..-60: all 530 ascents and descents at
		// 25 degrees; the pad's last digits move by 0.005 with the angle).
		this.rotatedAscent = Math.floor((ttf.headYMax * ppem) / upem + ppem / 64 + 0.964);
		this.rotatedDescent = Math.floor((-ttf.headYMin * ppem) / upem + ppem / 64 + 0.964);
		this.underlinePosition = scale(ttf.underlinePosition);
		this.underlineThickness = scale(ttf.underlineThickness);
		this.strikeoutPosition = scale(ttf.strikeoutPosition);
		this.strikeoutThickness = scale(ttf.strikeoutSize);
		const exact = (v: number): number => (v * ppem) / upem;
		this.exactDecorations = {
			underlinePosition: exact(ttf.underlinePosition),
			underlineThickness: exact(ttf.underlineThickness),
			strikeoutPosition: exact(ttf.strikeoutPosition),
			strikeoutThickness: exact(ttf.strikeoutSize),
		};
		// GDI+ gray masks use the subpixel interpreter's x-direction rules;
		// AntiAlias also runs these programs, while keeping linear advances.
		this.hinted = new HintedSize(ttf, ppemX, ppem,
			gdiPlus && mode === 'gray'
				? { version: 40, grayscale: true, clearType: true, compatibleWidths: false, grayClearType: true, shpixX: plusUnscaled }
				: { version: 35, grayscale: mode !== 'mono', gdiArithmetic: !gdiPlus, reportStretched: playbackStretched }, gridFit || (gdiPlus && mode === 'gray'));
		this.hdmx = ppemX === ppem ? ttf.hdmx.get(ppem) : undefined;
		if (gdiPlus && mode === 'gray' && gridFit) {
			// AntiAliasGridFit spaces its glyphs by the widths GDI itself reports (`GetCharWidth32` at the same height:
			// Arial Bold 40 px W 39, I 10, v 21 and w 31, where the ClearType interpreter's phantom points round to 38,
			// 11, 22 and 32), while the shapes come from the ClearType interpreter above.
			this.advanceSize = new HintedSize(ttf, ppemX, ppem, { version: 35, grayscale: true, gdiArithmetic: true }, true);
		}
	}

	/**
	 * `GetTextMetrics` ascent / descent of the font realised at the baseline direction `(ux, uy)`: the head box with a
	 * pad at non-axis angles ({@link RealizedFont.rotatedAscent}); at a quarter turn the `OS/2` win box padded the same
	 * way, at a half turn it rounded (all 530 ascents and descents of five faces at lfHeight -8..-60 for 90, 180 and
	 * 270 degrees, escapement and world rotation alike). Undefined for an upright baseline.
	 */
	rotatedMetrics(ux: number, uy: number): { ascent: number; descent: number } | undefined {
		if (Math.abs(ux) > 1e-9 && Math.abs(uy) > 1e-9) {
			return { ascent: this.rotatedAscent, descent: this.rotatedDescent };
		}
		if (ux > 0.5) {
			return undefined;
		}
		const { winAscent, winDescent, unitsPerEm } = this.ttf;
		if (ux < -0.5) {
			return { ascent: Math.round((winAscent * this.ppem) / unitsPerEm), descent: Math.round((winDescent * this.ppem) / unitsPerEm) };
		}
		const pad = this.ppem / 64 + 0.969;
		return {
			ascent: Math.floor((winAscent * this.ppem) / unitsPerEm + pad),
			descent: Math.floor((winDescent * this.ppem) / unitsPerEm + pad),
		};
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
	 * legacy x-direction deltas are skipped, ...). For GDI's default
	 * "compatible widths" ClearType the programs run with the advance
	 * phantom point at the black-and-white advance GDI keeps for ClearType
	 * text, and the interpreter moves every stem the program sets with MIRP
	 * or MSIRP by its centre times the ratio of that advance to the natural
	 * one (`HintEnvironment.bwAdvance`). CLEARTYPE_NATURAL_QUALITY keeps the
	 * natural widths.
	 */
	private ctOutline(index: number): Outline {
		let o = this.ctOutlines.get(index);
		if (o) {
			return o;
		}
		const gi = index < this.ttf.numGlyphs ? index : NOTDEF;
		// GDI's ClearType follows the font's `gasp`: a size whose range has no GASP_GRIDFIT is drawn from the unhinted,
		// unscaled outline (Arial up to 8 ppem: 483 of the 573 differing pixels of the 8 px row become 45).
		const gridFit = this.gdiPlus || clearTypeGridFits(this.ttf, this.ppem);
		// CLEARTYPE_NATURAL_QUALITY runs the programs without GETINFO's compatible-widths bit: its glyphs match native at
		// 9 to 17 px (Arial lines of `textx-arial-ctnatural.wide.png`: 2,100 differing pixels fall to 270 in lines 1 to 8).
		this.ctSize ??= new HintedSize(this.ttf, this.ppemX, this.ppem, {
			version: 40,
			grayscale: false,
			clearType: true,
			compatibleWidths: !this.gdiPlus && !this.naturalWidths,
			gdiArithmetic: !this.gdiPlus,
			smoothingBit18: !this.gdiPlus && gridFit && clearTypeSmoothsVertically(this.ttf, this.ppem),
			reportStretched: this.playbackStretched,
			bwAdvance: !this.gdiPlus && !this.naturalWidths && gridFit ? (g: number): number => this.advance(g, true) : undefined,
		}, gridFit);
		const u = this.ctSize.hintGlyph(gi);
		o = { xs: u.xs, ys: u.ys, onCurve: u.onCurve, endPts: u.endPts };
		this.ctOutlines.set(index, o);
		return o;
	}

	/**
	 * The outline GDI grid-fits for a glyph drawn at a non-axis angle. `hintPpem` is the whole-pixel ppem GDI hints at
	 * (the rounded major component of the rotated scale, see {@link rotationHintPpem}); 0 keeps the font's own size.
	 */
	private rotatedOutline(index: number, hintPpem = 0): HintedGlyph {
		const key = `${hintPpem}|${index}`;
		let g = this.rotOutlines.get(key);
		if (!g) {
			let size = this.rotatedSizes.get(hintPpem);
			if (!size) {
				size = new HintedSize(this.ttf, hintPpem || this.ppemX, hintPpem || this.ppem, {
					version: 35,
					grayscale: this.mode !== 'mono',
					rotated: true,
					gdiArithmetic: !this.gdiPlus,
				});
				this.rotatedSizes.set(hintPpem, size);
			}
			g = size.hintGlyph(index < this.ttf.numGlyphs ? index : NOTDEF);
			this.rotOutlines.set(key, g);
		}
		return g;
	}

	/** The scaled advance of glyph `index`, rounded once. */
	private linearAdvance(index: number): number {
		const { advance } = this.ttf.hMetrics(index < this.ttf.numGlyphs ? index : NOTDEF);
		return Math.floor((advance * this.ppemX) / this.ttf.unitsPerEm + 0.5);
	}

	/** Whether glyph `index` advances linearly at this size: `head.flags` bit 4 clear, or `LTSH` (an `hdmx` record for the size comes first). */
	private ltshLinear(index: number): boolean {
		if (this.gdiPlus || this.ppemX !== this.ppem) return false;
		const hd = this.hdmx;
		if (hd && index < hd.length) return false;
		// head.flags bit 4 clear: the instructions may not alter the advance width, which is the scaled one, rounded.
		if ((this.ttf.headFlags & 0x10) === 0) return true;
		const lt = this.ttf.ltsh;
		return !!lt && index < lt.length && lt[index] > 0 && this.ppem >= lt[index];
	}

	/** Integer advance width of glyph `index`, as GetCharWidth32 reports it (GDI+ ClearType: its hinted phantom advance rounded). */
	advance(index: number, hintedOnly = false): number {
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
		} else if (!hintedOnly && this.ltshLinear(index)) {
			// `LTSH`: from its yPels on a glyph's advance is the linearly scaled one, rounded (GetCharWidth32 and
			// GGO_METRICS of Times New Roman A: hinted up to 68 px, linear from 69, hdmx records excepted).
			base = this.linearAdvance(index);
		} else if (this.advanceSize) {
			let g = this.advanceOutlines.get(index);
			if (!g) {
				g = this.advanceSize.hintGlyph(index < this.ttf.numGlyphs ? index : NOTDEF);
				this.advanceOutlines.set(index, g);
			}
			base = hd && index < hd.length ? hd[index] : Math.round(g.advance / 64);
		} else {
			base = hd && index < hd.length ? hd[index] : Math.round(this.outline(index).advance / 64);
		}
		return base + (this.syntheticBold ? 1 : 0);
	}

	/**
	 * GDI+ ClearTypeGridFit's DrawString advance: the ClearType interpreter's phantom-point advance rounded to a whole
	 * pixel (Arial 40 px bold, `text-cleartype-advances`: all 93 integer-advance glyphs; the GDI widths above match 79).
	 */
	ctGridAdvance(index: number): number {
		const gi = index < this.ttf.numGlyphs ? index : NOTDEF;
		this.ctOutline(gi);
		return Math.round(this.ctSize!.hintGlyph(gi).advance / 64) + (this.syntheticBold ? 1 : 0);
	}

	/** GDI+ rounds tracked hmtx advances to font units before device scaling. */
	designAdvance(index: number, tracking: number): number {
		const { advance } = this.ttf.hMetrics(index < this.ttf.numGlyphs ? index : NOTDEF);
		return Math.round(advance * tracking) * this.ppemX / this.ttf.unitsPerEm + (this.syntheticBold ? 1 : 0);
	}

	/**
	 * Advance of glyph `index` in a font realised with an escapement: GDI
	 * does not use the hinted/hdmx widths there but the linearly scaled
	 * advance, rounded (measured: the Dx GDI records for Times New Roman at
	 * 30 and 90 degrees).
	 */
	rotatedAdvance(index: number, halfTurn = false): number {
		const { advance } = this.ttf.hMetrics(index < this.ttf.numGlyphs ? index : NOTDEF);
		const linear = (advance * this.ppemX) / this.ttf.unitsPerEm;
		// Along a quarter-turn baseline the linear advance is first taken to 26.6 and then rounded half up (Times New Roman
		// at 9 px: E 5.4976 -> 6, H 6.4995 -> 7, the widths GDI records); along a half turn a plain round (E -> 5, H -> 6).
		// All 840 widths at 90, 180 and 270 degrees of rotated-placement*.json.gz (and, rounded the same way, the 3,360 non-axis ones).
		return (halfTurn ? Math.round(linear) : Math.floor((Math.round(linear * 64) + 32) / 64)) + (this.syntheticBold ? 1 : 0);
	}

	/** The unrounded linear advance GDI accumulates (in 28.4 fixed point) along a non-axis baseline. */
	rotatedLinearAdvance(index: number): number {
		const { advance } = this.ttf.hMetrics(index < this.ttf.numGlyphs ? index : NOTDEF);
		return (advance * this.ppemX) / this.ttf.unitsPerEm + (this.syntheticBold ? 1 : 0);
	}

	/**
	 * The glyph bitmap for `index`, optionally rotated by the 2x2 matrix
	 * `m` = [a, b, c, d] (device, y down: x' = a*x + c*y, y' = b*x + d*y,
	 * applied to the hinted outline about the pen position).
	 */
	glyph(index: number, m?: readonly [number, number, number, number], subX = 0, subY = 0): GdiGlyph {
		const key = (m ? `${index}|${m.map((v) => v.toFixed(6)).join(',')}` : String(index)) + (subX || subY ? `@${subX},${subY}` : '');
		let g = this.glyphs.get(key);
		if (g) {
			return g;
		}
		const skew = m && !(Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) && !(Math.abs(m[0]) < 1e-9 && Math.abs(m[3]) < 1e-9);
		// A glyph at a non-axis angle is grid-fitted with GETINFO's "rotated"
		// bit set, which makes the stock fonts skip their stem hints (and
		// enable dropout control), as GDI does; 90/180/270 degrees keep the
		// upright hinting (measured exact against the escapement fixtures).
		const rotation = skew && m && !this.gdiPlus && this.ppemX === this.ppem ? rotationMatrix(m, this.ppem, (this.ttf.headFlags & 8) !== 0) : null;
		const src = skew ? this.rotatedOutline(index, rotation ? rotation.ppem : 0) : this.outline(index);
		if (skew && m && rotation) {
			m = rotation.matrix;
		} else if (skew && m) {
			// GDI scales a rotated glyph by the font matrix rounded to whole
			// pixels per em (ppem*cos and ppem*sin each rounded), so a 16 px
			// glyph at 25 degrees is drawn about 16.5 px tall (measured with
			// GetGlyphOutline; it cuts the escapement fixtures' residual by
			// a fifth).
			m = roundedRotationMatrix(m, this.ppem);
		}
		let o: Outline = this.mode === 'cleartype' && !m && !this.syntheticItalic ? this.ctOutline(index) : src;
		// GDI's monochrome and grayscale bitmaps are rasterized from the coordinates the glyph program left, not re-anchored
		// at a left phantom point it moved (Microsoft Sans Serif 7 at 13 px: pp1 SHPIXed by -28/64 pixel).
		const shift = this.gdiPlus || m || this.mode === 'cleartype' ? 0 : src.rasterShift ?? 0;
		if (shift !== 0) {
			const xs = new Float64Array(o.xs.length);
			for (let i = 0; i < xs.length; i++) xs[i] = o.xs[i] + shift;
			o = { ...o, xs };
		}
		if (this.syntheticItalic || m || subX || subY) {
			const base = o;
			const n = base.xs.length;
			const xs = new Float64Array(n);
			const ys = new Float64Array(n);
			for (let i = 0; i < n; i++) {
				let x = base.xs[i];
				const y = base.ys[i];
				if (this.syntheticItalic) {
					x += y * this.italicShear;
				}
				if (m) {
					// Outline space is y up; the matrix is in device (y down) space.
					xs[i] = Math.round(m[0] * x - m[2] * y + subX);
					ys[i] = Math.round(-(m[1] * x - m[3] * y) - subY);
				} else {
					// A sixth-pixel ClearType translation is an exact whole-sample
					// move. Re-rounding it to 26.6 changes edge ties on that grid.
					xs[i] = this.gdiPlus && this.mode === 'cleartype' ? x + subX : Math.round(x + subX);
					ys[i] = y - subY;
				}
			}
			o = { xs, ys, onCurve: base.onCurve, endPts: base.endPts };
		}
		if (m && !this.gdiPlus && this.mode !== 'cleartype' && nearDiagonal(m)) {
			// A glyph turned by an odd multiple of 45 degrees is scan-converted one 26.6 unit to the right of the outline
			// `GetGlyphOutline(GGO_NATIVE)` returns (all 221 glyphs at each of 45, 135, 225 and 315 degrees of
			// `rotated-glyph-bitmaps-small.json.gz`, and no other angle): the edges that pass exactly through pixel centres,
			// which a diagonal at 45 degrees does all along, then fall on the side native puts them.
			const xs = new Float64Array(o.xs.length);
			for (let i = 0; i < xs.length; i++) xs[i] = o.xs[i] + 1;
			o = { ...o, xs };
		}
		let bitmap: GlyphBitmap | null;
		if (this.mode === 'mono') {
			// 26.6 smart-crossing selection is verified against GDI's monochrome bitmaps for upright, stretched and
			// sheared glyphs once their outlines follow GDI's hinting arithmetic (mono-condensed.json.gz: 970 to
			// 1,144 of 1,200 exact). GDI+ and transformed glyphs keep the previous arithmetic.
			const smartGrid = !m && !subX && !subY && (!this.gdiPlus || (this.ppemX === this.ppem && !this.syntheticItalic));
			const dropout = dropoutMode(src.scanSet ? src.scanControl : this.ppem <= DEFAULT_DROPOUT_PPEM, src.scanType);
			bitmap = this.gdiPlus
				? rasterizeMono(o, dropout, undefined, true, smartGrid, false, false, false, false, true)
				: msMonoBitmap(o, dropout);
		} else if (this.mode === 'cleartype') {
			// ClearType scan-converts its 6 x 1 samples with the font's own dropout control (SCANCTRL/SCANTYPE, stubs
			// excluded for types 1 and 5): thin curve ends that fall between sample rows turn a sample on. A font that
			// never runs SCANCTRL gets none (the private diagonal, opcode and vector fonts pin that).
			const dropout = src.scanSet ? dropoutMode(src.scanControl, src.scanType) : 2;
			bitmap = rasterizeClearType(o, this.gdiPlus, this.gdiPlus ? clearTypeSpread(this.ttf) : undefined, dropout, !this.gdiPlus && clearTypeSmoothsVertically(this.ttf, this.ppem));
		} else {
			// GDI's own scan converter (a font that never runs SCANCTRL gets simple dropouts up to 32 ppem, as in monochrome);
			// GDI+ AntiAlias keeps its previous behaviour.
			const dropout = src.scanSet ? dropoutMode(src.scanControl, src.scanType) : this.gdiPlus || this.ppem > DEFAULT_DROPOUT_PPEM ? 2 : 0;
			// GDI+ AntiAlias widens regular/italic Courier New by one grayscale
			// sample to the right; the grid-fit hint and bold faces do not.
			bitmap = this.gdiPlus && !this.gridFit && !m && !this.syntheticBold && !this.syntheticItalic &&
				this.ttf.weightClass < 600 && this.ttf.family.toLowerCase() === 'courier new'
				? rasterizeCourierGray(o, dropout)
				: this.gdiPlus
					? rasterizeGray(o, dropout, false, false, true)
					: msGrayBitmap(o, dropout);
		}
		if (bitmap && this.syntheticBold) {
			bitmap = embolden(bitmap, this.mode === 'mono' ? 1 : 16);
		}
		g = { bitmap, advance: this.advance(index) };
		this.glyphs.set(key, g);
		return g;
	}
}

/** True when a matrix row has two components of (nearly) equal magnitude: native `mth_Max45Trick`, 33/65536 apart at most. */
function nearDiagonal(m: readonly [number, number, number, number]): boolean {
	const tolerance = 33 / 65536;
	return Math.abs(Math.abs(m[0]) - Math.abs(m[1])) <= tolerance || Math.abs(Math.abs(m[2]) - Math.abs(m[3])) <= tolerance;
}

/**
 * The matrix GDI scales a rotated glyph by (native `GetGlyphOutline` of Arial at 12 to 48 px and 10 to 80 degrees under a
 * world rotation, least-squares fitted against the font-unit outlines; `rotated-glyph-matrix.json.gz`): for a pure
 * rotation the larger of `ppem * |cos|` and `ppem * |sin|` is rounded to whole pixels and the whole rotation is scaled by
 * the rounded over the exact value, so the smaller component keeps the true angle (20 px at 25 degrees: 18 / 18.126 =
 * 0.993, giving 0.900 and 0.420, where rounding both components gave 0.900 and 0.400; the native fit is 0.9000 and
 * 0.4189). Other matrices keep the component-wise rounding of the earlier fit.
 */
export function roundedRotationMatrix(m: readonly [number, number, number, number], ppem: number): [number, number, number, number] {
	const isRotation = Math.abs(m[0] - m[3]) < 1e-6 && Math.abs(m[1] + m[2]) < 1e-6;
	if (isRotation && ppem > 0) {
		const major = ppem * Math.max(Math.abs(m[0]), Math.abs(m[1]));
		const target = Math.round(major);
		if (target >= 1) {
			const k = target / major;
			return [m[0] * k, m[1] * k, m[2] * k, m[3] * k];
		}
	}
	const p = ppem;
	return [Math.round(m[0] * p) / p, Math.round(m[1] * p) / p, Math.round(m[2] * p) / p, Math.round(m[3] * p) / p];
}

/**
 * How GDI grid-fits and scales a glyph under a pure rotation `m` (`RotationMatrixProbe.cs`, private fonts read through
 * `GetGlyphOutline(GGO_NATIVE)`; `rotation-matrix.json.gz`). A font with `head.flags` bit 3 (force integer ppem; every
 * stock font here) is hinted unrotated at the whole-pixel ppem `round(ppem * max(|cos|, |sin|))` and then multiplied by
 * the rotation over its major component: 1 on the major diagonal and, on the minor ones, `A / B` with
 * `A = round(min(|cos|, |sin|) * ppem * 32)` and `B = round(max(|cos|, |sin|) * ppem * 32)` (not the exact tangent: the
 * ratio of two components rounded to a coarse grid, which moves a far point by up to a pixel). A font without the flag
 * is hinted at its own ppem and rotated exactly. Returns null when `m` is not a pure rotation.
 */
export function rotationMatrix(
	m: readonly [number, number, number, number],
	ppem: number,
	integerPpem: boolean,
): { ppem: number; matrix: [number, number, number, number] } | null {
	const isRotation = Math.abs(m[0] - m[3]) < 1e-6 && Math.abs(m[1] + m[2]) < 1e-6;
	if (!isRotation || ppem <= 0) {
		return null;
	}
	if (!integerPpem) {
		return { ppem: 0, matrix: [m[0], m[1], m[2], m[3]] };
	}
	const major = Math.max(Math.abs(m[0]), Math.abs(m[1]));
	const minor = Math.min(Math.abs(m[0]), Math.abs(m[1]));
	const majorFixed = Math.round(major * ppem * 32);
	const target = Math.floor((majorFixed + 16) / 32);
	if (target < 1) {
		return null;
	}
	// The ratio is a 16.16 number (the integers k / 65536 read off the far points of the private fonts).
	const q = Math.round((Math.round(minor * ppem * 32) / majorFixed) * 65536) / 65536;
	const xMajor = Math.abs(m[0]) >= Math.abs(m[1]);
	const sg = (v: number): number => (v < 0 ? -1 : 1);
	return {
		ppem: target,
		matrix: xMajor ? [sg(m[0]), sg(m[1]) * q, sg(m[2]) * q, sg(m[3])] : [sg(m[0]) * q, sg(m[1]), sg(m[2]), sg(m[3]) * q],
	};
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
	 * The raster face and whole-number stretches GDI's font mapper picks for a height (character height when
	 * negative, cell height when positive), `lfWidth` and weight; see `pickRasterFace`. `width` 0 keeps the face's
	 * own proportions (horizontal factor equal to the vertical one, at most 5).
	 */
	private pickRaster(faces: RasterFace[], height: number, weight: number, width = 0): { face: RasterFace; scale: number; scaleX: number } | null {
		if (faces.length === 0) {
			return null;
		}
		if (height === 0) {
			const sorted = faces.slice().sort((a, b) => a.pixHeight - b.pixHeight);
			const face = sorted.find((f) => f.points >= 10) ?? sorted[0];
			return { face, scale: 1, scaleX: 1 };
		}
		const pick = pickRasterFace(faces, height, width, weight);
		return pick ? { face: faces[pick.index], scale: pick.scaleY, scaleX: pick.scaleX } : null;
	}

	private realizeRaster(faces: RasterFace[], spec: LogFontSpec): GdiRealizedFont | null {
		const weight = spec.weight || 400;
		const pick = this.pickRaster(faces, spec.height, weight, spec.width > 0 ? spec.width : 0);
		if (!pick) {
			return null;
		}
		const { face, scale, scaleX } = pick;
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
					this.modeFor(best, spec.quality, ppem, spec.ignoreGasp),
					synthBold,
					synthItalic,
					cellHeight,
					spec.width,
					!spec.unhinted,
					spec.gdiPlus,
					!!spec.playbackStretch && playbackStretchReacts(best, spec.height, spec.playbackStretch),
					!!spec.unscaledText,
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
	private modeFor(font: TtfFont, quality: number, ppem: number, ignoreGasp = false): GdiTextMode {
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
		if (mode === 'gray' && !ignoreGasp) {
			const range = font.gasp.find((r) => ppem <= r.maxPpem);
			if (range && (range.behavior & 2) === 0) {
				return 'mono';
			}
		}
		return mode;
	}
}

/**
 * Whether the horizontal stretch `stretch` (`eyScale / exScale` of a GM_COMPATIBLE text record, 1.00055838 on a
 * 3840 x 2160 display at 150%) makes native playback re-grid-fit a height of this face.
 *
 * Native playback draws such text through `diag(eyScale / exScale, 1)`: patching every record's `eyScale` of
 * `textpb-segoeui-cell-q3.emf` to its `exScale` makes `PlayEnhMetaFile` draw exactly the direct drawing (0 of 2,102,400
 * pixels differ, 4,050 without the patch), so the stretch comes from the record, not from the playing device. For
 * Segoe UI the stretched size `M = round(32 E s) / 32` (E the exact em size, `h * unitsPerEm / (winAscent + winDescent)`
 * for a cell height and `|h|` for an em height) either equals the unstretched `round(32 E) / 32`, which changes nothing,
 * or lies at least 15/16 pixel from the ppem GDI realised, which switches grid-fitting off at that size while the
 * outline keeps the unstretched scale: the nine cell heights 24, 35, 36, 39, 40, 56, 58, 59 and 64 and no em height at
 * the playback ratio; all 5,330 native outcomes of `text-stretch-hinting.json.gz` agree
 * (`gdi-text-stretch-hinting.fixture.test.ts`). Calibri-like fonts follow another rule and the other stock faces change
 * by the x scale alone; neither is modelled.
 */
export function playbackStretchReacts(font: TtfFont, height: number, stretch: number): boolean {
	if (!(stretch > 0) || stretch === 1 || font.family.toLowerCase() !== 'segoe ui') {
		return false;
	}
	const cell = font.winAscent + font.winDescent;
	const em = height < 0 ? -height : (height * font.unitsPerEm) / cell;
	const ppem = height < 0 ? -height : resolvePpem(font, height);
	const unstretched = Math.floor(em * 32 + 0.5);
	const stretched = Math.floor(em * 32 * stretch + 0.5);
	return stretched !== unstretched && Math.abs(stretched / 32 - ppem) >= 15 / 16;
}

/**
 * The ppem GDI realises a signed device `lfHeight` at: the em height for a
 * negative value; for a positive (cell) height, the largest `VDMX` ppem
 * whose yMax - yMin fits, else `height * unitsPerEm / (winAscent +
 * winDescent)` rounded, then stepped down while that ppem's own cell
 * (`VDMX`, or `(winAscent + winDescent) * ppem / unitsPerEm` rounded once) is still taller than requested. The result
 * is the em height `tmHeight - tmInternalLeading` of the native font at all 117 cell heights 4..120 of Arial, Times
 * New Roman, Courier New, Segoe UI and Tahoma (rounding ascent and descent separately put Segoe UI at 6 for cell 9
 * and three faces one off at cells 4 to 6; those realised glyph images differ).
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
			: Math.round(((font.winAscent + font.winDescent) * ppem) / upem);
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
 * Courier New's regular/italic GDI+ AntiAlias raster: widen each 4x4 sample
 * row one sample right before counting coverage. Native quarter-origin
 * controls prove this is a raster adjustment, not an origin shift: all
 * left edges stay put while right edges grow. A private copy with only its
 * family renamed renders without it (CourierGrayProbe.cs); bold faces,
 * AntiAliasGridFit and classic GDI do not use this adjustment.
 */
function rasterizeCourierGray(o: Outline, dropout: number): GlyphBitmap | null {
	const samples = rasterizeSamples(o, 4, 4, 1, dropout, false, false, true, true);
	if (!samples) return null;
	const { box, hi } = samples;
	const width = box.xMax - box.xMin;
	const height = box.yMax - box.yMin;
	const data = new Uint8Array(width * height);
	for (let y = 0; y < hi.height; y++) {
		const row = y * hi.width;
		for (let x = 0; x < hi.width; x++) {
			if (hi.data[row + x] || (x > 0 && hi.data[row + x - 1])) {
				data[Math.floor(y / 4) * width + Math.floor(x / 4)]++;
			}
		}
	}
	return { width, height, left: box.xMin, top: box.yMax, data };
}

/** How far a ClearType sample row is widened before filtering: samples to the left and to the right. */
interface ClearTypeSpread {
	left: number;
	right: number;
}

/**
 * GDI+ ClearType draws the system Courier New wider than its outline. Every sample row is widened by
 * one sample on the left and two on the right (one on the right for the bold faces) before the 3-tap
 * filter, and a lone half-subpixel's leak into the neighbouring pixel is dropped
 * (`text-cleartype-courier.json.gz`: straight-edged glyphs are exact at every size, phase and style
 * measured). The behaviour follows the family name, not the font file: a private copy of `cour.ttf`
 * renamed to anything else renders unwidened, and the same file under its own name is widened. Other
 * faces, and GDI's own ClearType, are not widened (the latter is unmeasured for Courier New).
 */
function clearTypeSpread(ttf: TtfFont): ClearTypeSpread | undefined {
	if (ttf.family.toLowerCase() !== 'courier new') {
		return undefined;
	}
	return { left: 1, right: ttf.weightClass >= 600 ? 1 : 2 };
}

/** Whether the `gasp` range holding `ppem` asks for grid-fitting (GASP_GRIDFIT); a font without `gasp` does. */
function clearTypeGridFits(ttf: TtfFont, ppem: number): boolean {
	const range = ttf.gasp.find((r) => ppem <= r.maxPpem);
	return range ? (range.behavior & 1) !== 0 : true;
}

/** GDI ClearType with symmetric smoothing samples five rows per pixel, weighted 1 2 3 2 1 (see `rasterizeClearType`). */
const CLEARTYPE_ROWS = 5;
const CLEARTYPE_ROW_WEIGHTS = [1, 2, 3, 2, 1];

/**
 * Whether GDI's ClearType smooths vertically at this size: the `gasp` range holding the ppem has GASP_SYMMETRIC_SMOOTHING
 * (8), or the font has no `gasp` (the private program-free fonts of `gdi-cleartype-raster.json.gz`). Arial's ranges are
 * 1 to 8 (10: smoothing, no grid-fit), 9 to 17 (5: grid-fit, no smoothing) and 18 up (15), and the rows of
 * `textx-arial-q0-default` change character exactly at 8, 9 and 18 (Segoe UI: 8, 9 and 20).
 */
function clearTypeSmoothsVertically(ttf: TtfFont, ppem: number): boolean {
	if (ttf.gasp.length === 0) {
		return true;
	}
	const range = ttf.gasp.find((r) => ppem <= r.maxPpem);
	return range ? (range.behavior & 8) !== 0 : false;
}

/**
 * ClearType rasterisation as GDI does it: the outline is sampled at 6x
 * horizontally (2 samples per R/G/B subpixel), each
 * subpixel's coverage is averaged with its two neighbours (a 3-tap box
 * filter across subpixels), giving one 0..255 alpha per colour channel.
 * With `vertical` (symmetric smoothing) each pixel row is sampled at five
 * rows, weighted 1 2 3 2 1 (`gdi-cleartype-raster.json.gz`: bars, slanted
 * edges and bars with both edges fractional at 32 ppem, all 1,070 exact;
 * otherwise one sample row per pixel).
 * Fitted to the edge profiles of `textx-arial-cleartype` (an Arial stem at
 * 72 px reproduces to within 1 level per channel). GDI+ truncates the
 * coverage instead of rounding it (native baseline-controlled captures).
 * A `spread` widens every sample row first (see `clearTypeSpread`); `dropout` is the scan converter's dropout mode.
 */
function rasterizeClearType(o: Outline, truncate = false, spread?: ClearTypeSpread, dropout = 2, vertical = false): GlyphBitmap | null {
	const S = CLEARTYPE_OVERSAMPLE / 3;
	// The stub rule has no overshoot exception here: native excludes the stubs it exempts (13 of 13 determined cases).
	const KY = vertical ? CLEARTYPE_ROWS : 1;
	const WT = vertical ? CLEARTYPE_ROW_WEIGHTS : [1];
	const WSUM = WT.reduce((a, c) => a + c, 0);
	const r = rasterizeSamples(o, CLEARTYPE_OVERSAMPLE, KY, 1, dropout, false, false, false, true);
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
		for (let yy = 0; yy < KY; yy++) {
		const row = (y * KY + yy) * hi.width;
		for (let x = 0; x < hi.width; x++) {
			let on = hi.data[row + x] !== 0;
			if (spread && !on) {
				// The sample is on when any sample from `right` before it to `left` after it is.
				for (let k = x - spread.right; k <= x + spread.left && !on; k++) {
					on = k >= 0 && k < hi.width && hi.data[row + k] !== 0;
				}
			}
			if (on) {
				sub[Math.floor(x / S)] += WT[yy] ?? 1;
			}
		}
		}
		for (let j = 0; j < n; j++) {
			const before = j > 0 ? sub[j - 1] : 0;
			const after = j + 1 < n ? sub[j + 1] : 0;
			let acc = before + sub[j] + after;
			// A lone sample's one-sixth leak into the next pixel is not drawn (see `clearTypeSpread`).
			if (spread && acc === 1 && sub[j] === 0 && ((j % 3 === 0 && before === 1) || ((j + 1) % 3 === 0 && after === 1))) {
				acc = 0;
			}
			data[y * n + j] = (truncate ? Math.floor : Math.round)((255 * acc) / (3 * S * WSUM));
		}
	}
	return { width, height, left: box.xMin, top: box.yMax, data, channels: 3 };
}
