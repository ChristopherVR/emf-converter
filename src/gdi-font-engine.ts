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

/** A font realised at one device size and quality, with its glyph cache. */
export class RealizedFont {
	readonly ttf: TtfFont;
	readonly ppem: number;
	readonly ppemX: number;
	/** Cell ascent / descent (tmAscent / tmDescent), device pixels. */
	readonly ascent: number;
	readonly descent: number;
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
	private readonly realized = new Map<string, RealizedFont | null>();
	readonly defaultSmoothing: DefaultTextSmoothing;

	constructor(sources: readonly FontSource[], defaultSmoothing: DefaultTextSmoothing = 'cleartype') {
		this.defaultSmoothing = defaultSmoothing;
		for (const src of sources) {
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
		return this.families.size;
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

	/** Realises `spec`, or null when no supplied font can stand in for it. */
	realize(spec: LogFontSpec, fontFamilyMap?: Record<string, string>): RealizedFont | null {
		const key = JSON.stringify(spec) + (fontFamilyMap ? JSON.stringify(fontFamilyMap) : '');
		if (this.realized.has(key)) {
			return this.realized.get(key)!;
		}
		const faces = this.familyFaces(spec.face, spec.pitchAndFamily, fontFamilyMap);
		let result: RealizedFont | null = null;
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
			const ppem = resolvePpem(best, spec.height);
			// lfWidth equal to the natural tmAveCharWidth is no stretch at all
			// (measured: Times New Roman 11 px with lfWidth 4).
			const naturalAvg = Math.round((best.xAvgCharWidth * ppem) / best.unitsPerEm);
			const ppemX =
				spec.width > 0 && best.xAvgCharWidth > 0 && spec.width !== naturalAvg
					? Math.max(1, Math.round((spec.width * best.unitsPerEm) / best.xAvgCharWidth))
					: ppem;
			if (ppem > 0 && ppem <= 2048) {
				result = new RealizedFont(
					best,
					ppem,
					ppemX,
					this.modeFor(best, spec.quality, ppem),
					synthBold,
					synthItalic,
					spec.height > 0 ? Math.round(spec.height) : 0,
					spec.width,
					!spec.unhinted,
				);
				result.naturalWidths = spec.quality === CLEARTYPE_NATURAL_QUALITY;
			}
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
