/**
 * Type definitions for the EMF/WMF metafile converter.
 *
 * This module centralises every interface, type alias, and factory function
 * used across the converter. It has no runtime dependencies (the `@napi-rs/canvas`
 * reference below is `import type` only) so it can be imported freely without
 * risk of circular imports.
 *
 * @module emf-types
 */

import type { Canvas as NodeCanvas, SKRSContext2D } from '@napi-rs/canvas';

import type { ClipRegion } from './emf-clip-region';

// ---------------------------------------------------------------------------
// Shared type aliases
// ---------------------------------------------------------------------------

/**
 * Union of the three 2D rendering context types the converter can target.
 * OffscreenCanvas is preferred (works in Web Workers); HTMLCanvasElement
 * is used as a fallback in older browsers; SKRSContext2D (from the optional
 * `@napi-rs/canvas` package) is used in plain Node.js with no DOM. All three
 * types are only referenced via `import type`, so nothing is pulled in at
 * runtime unless the Node backend is actually loaded.
 */
export type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | SKRSContext2D;

/**
 * Union of the three canvas element/object types the converter can create.
 * See {@link CanvasContext} for the matching rendering-context union.
 */
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement | NodeCanvas;

/**
 * A 2x3 affine transformation matrix stored as a flat 6-element tuple
 * in the order `[a, b, c, d, e, f]`, matching the six arguments of
 * {@link CanvasRenderingContext2D.setTransform}.
 *
 * The mapping is:
 * ```
 *   | a  c  e |       | scaleX  skewX   translateX |
 *   | b  d  f |  <==> | skewY   scaleY  translateY |
 *   | 0  0  1 |       | 0       0       1          |
 * ```
 */
export type TransformMatrix = [number, number, number, number, number, number];

// ---------------------------------------------------------------------------
// GDI object types
// ---------------------------------------------------------------------------

/**
 * Represents a GDI pen object created by EMR_CREATEPEN or EMR_EXTCREATEPEN.
 * Pens define the stroke style, width, and colour used when drawing lines
 * and shape outlines.
 */
export interface GdiPen {
	kind: 'pen';
	/** Pen style constant: PS_SOLID=0, PS_DASH=1, PS_DOT=2, PS_DASHDOT=3, PS_NULL=5. */
	style: number;
	/** Pen width in logical units (X axis). */
	widthX: number;
	/** CSS hex colour string, e.g. `"#ff0000"`. */
	color: string;
	/**
	 * The full pen style dword (`PS_STYLE_MASK` 0x0F, `PS_ENDCAP_MASK`
	 * 0xF00, `PS_JOIN_MASK` 0xF000, `PS_TYPE_MASK` 0xF0000). Omitted for pens
	 * that only carry `style`.
	 */
	flags?: number;
	/** `PS_USERSTYLE` dash/gap lengths (EMR_EXTCREATEPEN), in style units. */
	userStyle?: number[];
	/** True for a pen created by EMR_EXTCREATEPEN (its cosmetic/geometric type is explicit). */
	extended?: boolean;
}

/**
 * Represents a GDI brush object created by EMR_CREATEBRUSHINDIRECT.
 * Brushes define the fill colour/style for closed shapes.
 */
export interface GdiBrush {
	kind: 'brush';
	/** Brush style constant: BS_SOLID=0, BS_NULL=1 (hollow), BS_HATCHED=2, BS_PATTERN=3, BS_DIBPATTERNPT=6. */
	style: number;
	/** CSS hex colour string. */
	color: string;
	/** Repeating pattern for hatched / pattern brushes; absent for solid and null brushes. */
	pattern?: GdiBrushPattern;
}

/**
 * The repeating bitmap behind a non-solid GDI brush (see
 * `emf-gdi-brush-pattern.ts`): an HS_* hatch (brush colour over the DC
 * background colour), a monochrome pattern (0 bits = text colour, 1 bits =
 * background colour), or a colour DIB pattern.
 */
export type GdiBrushPattern =
	| { kind: 'hatch'; hatch: number }
	| { kind: 'mono'; width: number; height: number; bits: Uint8Array }
	| { kind: 'bitmap'; width: number; height: number; rgb: Uint32Array };

/**
 * Represents a GDI font object created by EMR_EXTCREATEFONTINDIRECTW.
 */
export interface GdiFont {
	kind: 'font';
	/**
	 * Signed LOGFONT `lfHeight`, in logical units. Negative means "character
	 * height" (matches directly against the font's em size); positive means
	 * "cell height" (ascent + descent + internal leading). See
	 * `resolveFontPixelHeight` in `emf-gdi-text-layout.ts` for how the sign
	 * is resolved to a CSS pixel size.
	 */
	height: number;
	/** Font weight (400 = normal, 700 = bold). */
	weight: number;
	/** Whether the font is italic. */
	italic: boolean;
	/** Whether the font is underlined. */
	underline: boolean;
	/** Whether the font is struck out. */
	strikeOut: boolean;
	/** Font family name (e.g. `"Arial"`, `"sans-serif"`). */
	family: string;
	/**
	 * LOGFONT `lfEscapement`: angle, in tenths of a degree, between the text
	 * baseline and the device x-axis (GDI documents this as measured
	 * counterclockwise). Defaults to 0 (no rotation) when absent.
	 */
	escapementTenthDeg?: number;
	/** The rest of the LOGFONT, for exact GDI font realisation (see {@link GdiFontDetails}). */
	details?: GdiFontDetails;
}

/**
 * LOGFONT fields beyond the ones every text path uses, kept so the GDI font
 * engine (`gdi-font-engine.ts`) can realise the font exactly as GDI would.
 */
export interface GdiFontDetails {
	/** `lfWidth` (logical units, 0 = the font's own aspect ratio). */
	width: number;
	/** `lfOrientation`, tenths of a degree. */
	orientationTenthDeg: number;
	/** `lfCharSet`. */
	charSet: number;
	/** `lfQuality` (0 DEFAULT .. 6 CLEARTYPE_NATURAL). */
	quality: number;
	/** `lfPitchAndFamily`. */
	pitchAndFamily: number;
}

/**
 * Discriminated union of all GDI object types that can appear in the
 * metafile's object table. The `kind` field acts as the discriminator.
 */
export type GdiObject = GdiPen | GdiBrush | GdiFont;

// ---------------------------------------------------------------------------
// Drawing state
// ---------------------------------------------------------------------------

/**
 * Mutable snapshot of the current GDI drawing state.
 *
 * Mirrors the subset of the Win32 device-context state that matters for
 * canvas rendering. Instances are pushed/popped on EMR_SAVEDC / EMR_RESTOREDC
 * so that nested state changes can be undone.
 */
export interface DrawState {
	/** Current pen stroke colour (CSS hex). */
	penColor: string;
	/** Current pen width in logical units. */
	penWidth: number;
	/** Current pen style constant. */
	penStyle: number;
	/** Current pen's full style dword (see {@link GdiPen.flags}); defaults to {@link penStyle}. */
	penFlags?: number;
	/** Current pen's `PS_USERSTYLE` array. */
	penUserStyle?: number[];
	/** True when the current pen came from EMR_EXTCREATEPEN. */
	penExtended?: boolean;
	/** Arc direction (EMR_SETARCDIRECTION): 1 = AD_COUNTERCLOCKWISE (default), 2 = AD_CLOCKWISE. */
	arcDirection?: number;
	/** Miter limit (EMR_SETMITERLIMIT); GDI's default is 10. */
	miterLimit?: number;
	/** Current brush fill colour (CSS hex). */
	brushColor: string;
	/** Current brush style constant. */
	brushStyle: number;
	/** Pattern of the selected brush, or `null` for a solid / null brush. */
	brushPattern: GdiBrushPattern | null;
	/** Brush origin (EMR_SETBRUSHORGEX), in device pixels. */
	brushOrgX: number;
	brushOrgY: number;
	/** EMR_SETSTRETCHBLTMODE mode; 1 = BLACKONWHITE (GDI's default), 4 = HALFTONE. */
	stretchBltMode: number;
	/** Current text foreground colour (CSS hex). */
	textColor: string;
	/** Current background colour used for opaque text backgrounds. */
	bkColor: string;
	/** Background mode: 1 = TRANSPARENT, 2 = OPAQUE. */
	bkMode: number;
	/**
	 * Current signed LOGFONT `lfHeight`, in logical units. See
	 * {@link GdiFont.height} for the sign convention.
	 */
	fontHeight: number;
	/** Current font weight (400 = normal, 700 = bold). */
	fontWeight: number;
	/** Whether the current font is italic. */
	fontItalic: boolean;
	/** Current font family name. */
	fontFamily: string;
	/** Whether the current font is underlined. */
	fontUnderline: boolean;
	/** Whether the current font is struck out. */
	fontStrikeOut: boolean;
	/** Current LOGFONT `lfEscapement`, in tenths of a degree. See {@link GdiFont.escapementTenthDeg}. */
	fontEscapementTenthDeg: number;
	/**
	 * Optional map from lowercased Windows face name to a CSS font family that
	 * is available in the rendering environment (e.g. `{ calibri: 'Carlito' }`).
	 * Threaded from {@link EmfConvertOptions.fontFamilyMap}.
	 */
	fontFamilyMap?: Record<string, string>;
	/** The selected font's remaining LOGFONT fields (see {@link GdiFontDetails}). */
	fontDetails?: GdiFontDetails;
	/**
	 * Binary raster-operation mode set via EMR_SETROP2 / META_SETROP2.
	 * 13 = R2_COPYPEN (the default, normal source-over drawing).
	 */
	rop2: number;
	/** Current pen position X (logical coordinates). */
	curX: number;
	/** Current pen position Y (logical coordinates). */
	curY: number;
	/** Polygon fill mode: 1 = ALTERNATE (even-odd), 2 = WINDING (nonzero). */
	polyFillMode: number;
	/** Text alignment flags (TA_* bitmask). */
	textAlign: number;
	/** The current GDI world transform matrix. */
	worldTransform: TransformMatrix;
}

/**
 * Creates a fresh {@link DrawState} initialised with Win32 GDI defaults:
 * black pen, white brush, transparent background mode, identity transform, etc.
 *
 * @returns A new default DrawState instance.
 */
export function defaultState(): DrawState {
	return {
		penColor: '#000000',
		penWidth: 1,
		penStyle: 0,
		brushColor: '#ffffff',
		brushStyle: 0,
		brushPattern: null,
		brushOrgX: 0,
		brushOrgY: 0,
		stretchBltMode: 1,
		textColor: '#000000',
		bkColor: '#ffffff',
		bkMode: 1,
		// Negative (character-height convention) so the no-font-selected default
		// resolves to exactly 12px, matching this library's historical fallback.
		fontHeight: -12,
		fontWeight: 400,
		fontItalic: false,
		fontFamily: 'sans-serif',
		fontUnderline: false,
		fontStrikeOut: false,
		fontEscapementTenthDeg: 0,
		rop2: 13,
		curX: 0,
		curY: 0,
		polyFillMode: 1,
		textAlign: 0,
		worldTransform: [1, 0, 0, 1, 0, 0],
	};
}

/**
 * Creates a shallow clone of a {@link DrawState}, deep-copying the
 * `worldTransform` tuple so mutations to the clone do not affect the original.
 *
 * @param s - The state to clone.
 * @returns An independent copy of `s`.
 */
export function cloneState(s: DrawState): DrawState {
	return {
		...s,
		worldTransform: [...s.worldTransform] as TransformMatrix,
	};
}

/**
 * Per-call replay tuning threaded from {@link EmfConvertOptions} down into the
 * record-replay loops. All fields are optional; omitted values fall back to the
 * built-in safety defaults.
 */
export interface ReplayOptions {
	/** Record cap for the GDI/WMF stream (default {@link MAX_RECORDS_DEFAULT}). */
	maxRecords?: number;
	/** Record cap for the EMF+ stream (default {@link MAX_RECORDS_EMFPLUS_DEFAULT}). */
	maxRecordsEmfPlus?: number;
	/** Lowercased Windows-face → CSS-family overrides applied to text. */
	fontFamilyMap?: Record<string, string>;
	/**
	 * Pre-decoded EMF+ TextureFill brush images (see
	 * {@link preDecodeEmfPlusTextures} / `emf-plus-texture-predecode.ts`),
	 * threaded down into every `EmfPlusReplayCtx` so a compressed texture
	 * brush's fill uses the real image instead of falling back to black.
	 */
	textureCache?: EmfPlusTextureCache;
	/**
	 * Pre-decoded EMF+ Image objects (`emf-plus-image-predecode.ts`), so
	 * `DrawImage` paints in record order under the active clip.
	 */
	imageCache?: EmfPlusImageCache;
	/** `EmfConvertOptions.gdiAntialias`: `false` rasterises GDI vector shapes without antialiasing. */
	gdiAntialias?: boolean;
	/**
	 * Font files for exact GDI text (`EmfConvertOptions.fonts`), realised
	 * by `gdi-font-engine.ts`; omitted, text uses the canvas font engine.
	 */
	fonts?: import('./gdi-font-engine').GdiFontCollection;
	/**
	 * Replay of a metafile nested in an EMF+ `DrawImage`: its depth (1 for
	 * a metafile drawn by the top-level file). A nested replay draws into
	 * its parent's context and, when done, unwinds any canvas `save()` its
	 * own records left open.
	 */
	nestingDepth?: number;
	/**
	 * Overrides the EMF+ base transform derived from the bounds (a nested
	 * metafile drawn onto a rotated or sheared destination).
	 */
	plusBaseTransform?: TransformMatrix;
	/** `false` skips the GDI drawing records (only the EMF+ stream is replayed). */
	gdiDrawing?: boolean;
}

// ---------------------------------------------------------------------------
// EMF header types
// ---------------------------------------------------------------------------

/**
 * Axis-aligned bounding rectangle in logical (device-independent) units,
 * as stored in the EMF header's `rclBounds` / `rclFrame` fields.
 */
export interface EmfBounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

// ---------------------------------------------------------------------------
// EMF+ GDI+ object table types
// ---------------------------------------------------------------------------

/** A single colour stop of an EMF+ gradient brush (offset in 0..1). */
export interface EmfPlusGradientStop {
	/** Normalised position along the gradient (0 = start/centre side). */
	offset: number;
	/** CSS rgba() colour string. */
	color: string;
	/** The same colour as packed ARGB, for per-pixel evaluation. */
	argb?: number;
}

/**
 * GDI+ WrapMode (MS-EMFPLUS 2.1.1.42): how a gradient brush paints beyond
 * the area its own geometry defines.
 * - `'clamp'`: a path gradient paints nothing outside its boundary; a linear
 *   gradient (which GDI+ itself never records as Clamp) extends its end
 *   colours.
 * - `'tile'` / `'tile-flip-x'` / `'tile-flip-y'` / `'tile-flip-xy'`: repeat
 *   the brush's tile (the gradient rectangle, or the boundary path's bounding
 *   box) in brush space, mirroring alternate copies on the flipped axes.
 */
export type EmfPlusGradientWrapMode = 'tile' | 'tile-flip-x' | 'tile-flip-y' | 'tile-flip-xy' | 'clamp';

/** Axis-aligned rectangle in brush space. */
export interface EmfPlusRectF {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Geometry + colour stops of a GDI+ linear gradient brush. */
export interface EmfPlusLinearGradient {
	type: 'linear';
	/** Gradient start point in world space (`rect`'s left-middle through `transform`). */
	x1: number;
	y1: number;
	/** Gradient end point in world space (`rect`'s right-middle through `transform`). */
	x2: number;
	y2: number;
	/** Colour stops ordered by offset (0 = start colour, 1 = end colour). */
	stops: EmfPlusGradientStop[];
	/** How the brush paints beyond one gradient period. */
	wrapMode: EmfPlusGradientWrapMode;
	/**
	 * The brush's own rectangle in brush space: colour varies along its x
	 * axis only, and it is the tile the wrap mode repeats. Absent on
	 * descriptors built by hand (older callers); rendering then falls back
	 * to the `x1..y2` segment.
	 */
	rect?: EmfPlusRectF;
	/** Brush space to world space (GDI+ encodes the gradient angle here). */
	transform?: TransformMatrix | null;
	/**
	 * The colour ramp exactly as recorded (end colours plus the optional
	 * preset colours or blend factors, and the gamma flag), from which
	 * `emf-plus-linear-ramp.ts` rebuilds GDI+'s own interpolation table.
	 * Absent on descriptors built by hand; rendering then uses `stops`.
	 */
	ramp?: EmfPlusLinearRamp;
}

/**
 * The recorded colour ramp of a GDI+ linear gradient brush
 * (MS-EMFPLUS 2.2.2.24): the start and end colours, plus either preset
 * colours (`InterpolationColors`) or blend factors (`Blend`), and the
 * `BrushDataIsGammaCorrected` flag.
 */
export interface EmfPlusLinearRamp {
	/** Start colour, packed ARGB. */
	startArgb: number;
	/** End colour, packed ARGB. */
	endArgb: number;
	/** Preset colours (`InterpolationColors`): ascending positions (0..1) and packed ARGB colours. */
	preset: { positions: number[]; argb: number[] } | null;
	/** Blend factors (`Blend`): ascending positions (0..1) and factors (0 = start colour, 1 = end colour). */
	blend: { positions: number[]; factors: number[] } | null;
	/** True when the brush interpolates in linear light (gamma 2.2). */
	gammaCorrected: boolean;
}

/**
 * The exact geometry of a GDI+ path gradient, in brush space: colours
 * interpolate from `center` out to the flattened `boundary` along each ray.
 */
export interface EmfPlusPathGradientShape {
	/** Centre point (brush space). */
	center: { x: number; y: number };
	/** Centre colour, packed ARGB. */
	centerArgb: number;
	/** Flattened closed boundary polygon (brush space). */
	boundary: Array<{ x: number; y: number }>;
	/** Surround colour at each boundary vertex, packed ARGB. */
	boundaryArgb: number[];
	/** Blend factors: positions run boundary (0) to centre (1); factor = share of centre colour. */
	blend: { positions: number[]; factors: number[] } | null;
	/** Preset colours (InterpolationColors): positions run boundary (0) to centre (1). */
	preset: { positions: number[]; argb: number[] } | null;
	/** Focus scales (inner region painted in the centre colour), when present. */
	focus: { x: number; y: number } | null;
	/** Brush space to world space. */
	transform: TransformMatrix | null;
}

/**
 * A GDI+ path gradient brush. `cx`/`cy`/`r`/`stops` describe a radial
 * approximation used only where the exact renderer cannot run (no pattern
 * support); `shape` carries the exact boundary-shaped geometry.
 */
export interface EmfPlusRadialGradient {
	type: 'radial';
	/** Centre point in world space. */
	cx: number;
	cy: number;
	/** Radius reaching the farthest boundary point (world space). */
	r: number;
	/** Colour stops ordered by offset (0 = centre colour, 1 = boundary colour). */
	stops: EmfPlusGradientStop[];
	/** How the brush paints beyond its boundary path. */
	wrapMode: EmfPlusGradientWrapMode;
	/** Exact path-gradient geometry (absent on hand-built descriptors). */
	shape?: EmfPlusPathGradientShape;
}

/** Union of the gradient descriptors an EMF+ brush can carry. */
export type EmfPlusGradient = EmfPlusLinearGradient | EmfPlusRadialGradient;

/**
 * A parsed EMF+ TextureFill brush (brush type 2, MS-EMFPLUS 2.2.2.45): an
 * embedded pixel-format bitmap tiled per `wrapMode`, optionally sheared by a
 * brush transform. Only pixel-format (uncompressed) embedded images decode
 * synchronously into `rgba`; a compressed (PNG/JPEG) embedded image cannot be
 * decoded within a synchronous fill and leaves the brush without a texture,
 * so callers fall back to the solid colour.
 */
export interface EmfPlusTexture {
	width: number;
	height: number;
	/** Top-down, non-premultiplied RGBA pixels, `width * height * 4` bytes. */
	rgba: Uint8ClampedArray;
	wrapMode: EmfPlusGradientWrapMode;
	transform: TransformMatrix | null;
}

/** A texture brush's embedded image, decoded ahead of replay (see {@link EmfPlusReplayCtx.textureCache}). */
export interface EmfPlusDecodedTexture {
	width: number;
	height: number;
	/** Top-down, non-premultiplied RGBA pixels, `width * height * 4` bytes. */
	rgba: Uint8ClampedArray;
}

/** Maps a brush object's cache key (see {@link EmfPlusReplayCtx.textureCache}) to its pre-decoded texture image. */
export type EmfPlusTextureCache = Map<number, EmfPlusDecodedTexture>;

/**
 * An EMF+ Image object's content, prepared ahead of replay (see
 * `emf-plus-image-predecode.ts`) so `DrawImage` can paint it synchronously,
 * in record order and under the clip active at that record: a raster
 * bitmap's decoded pixels, or, for an embedded metafile, the pre-decoded
 * caches its own nested replay needs.
 */
export type EmfPlusPreDecodedImage =
	| {
			kind: 'bitmap';
			width: number;
			height: number;
			/** Top-down, non-premultiplied RGBA pixels, `width * height * 4` bytes. */
			rgba: Uint8ClampedArray;
	  }
	| { kind: 'metafile'; caches: EmfPlusMetafileCaches };

/** Maps an Image object's cache key (see {@link EmfPlusImage.cacheKey}) to its pre-decoded content. */
export type EmfPlusImageCache = Map<number, EmfPlusPreDecodedImage>;

/** Everything one metafile's replay pre-decodes: compressed texture brush images and Image objects. */
export interface EmfPlusMetafileCaches {
	textures: EmfPlusTextureCache;
	images: EmfPlusImageCache;
}

/** An EMF+ (GDI+) brush object (solid colour, hatch, gradient, or texture). */
export interface EmfPlusBrush {
	kind: 'plus-brush';
	/** Primary CSS rgba() colour (solid colour, or gradient/texture fallback). */
	color: string;
	/** Present for linear/path gradient brushes; rendered as a CanvasGradient. */
	gradient?: EmfPlusGradient;
	/** Present for a texture-fill brush with a decodable embedded bitmap. */
	texture?: EmfPlusTexture | null;
}

/** An EMF+ (GDI+) pen object used for stroking shapes. */
export interface EmfPlusPen {
	kind: 'plus-pen';
	/** CSS rgba() colour string. */
	color: string;
	/** Pen width in world units. */
	width: number;
	/** Dash style enum: 0=Solid, 1=Dash, 2=Dot, 3=DashDot, 4=DashDotDot, 5=Custom. */
	dashStyle: number;
	/** GDI+ `LineCap` at the start / end (0 Flat, 1 Square, 2 Round, 3 Triangle, 0x1x anchors). */
	startCap?: number;
	endCap?: number;
	/** GDI+ `LineJoin`: 0 Miter, 1 Bevel, 2 Round, 3 MiterClipped. */
	lineJoin?: number;
	/** Miter limit, in pen widths (GDI+ default 10). */
	miterLimit?: number;
	/** Dash offset, in pen widths. */
	dashOffset?: number;
	/** GDI+ `DashCap` on every dash end (0 Flat, 2 Round, 3 Triangle); the start/end caps only cap the line itself. */
	dashCap?: number;
	/** Custom dash pattern (`PenDataDashedLine`), in pen widths. */
	dashPattern?: number[] | null;
	/** GDI+ `PenAlignment`: 0 Center, 1 Inset. */
	alignment?: number;
	/** Pen transform (`PenDataTransform`), applied to the pen's width and shape. */
	transform?: TransformMatrix | null;
	/**
	 * The pen's brush: a solid colour is also in {@link color}; a texture or
	 * gradient brush paints the stroke's pixels (see `emf-plus-stroke.ts`).
	 */
	brush?: EmfPlusBrush | null;
}

/** An EMF+ (GDI+) font object used for text rendering. */
export interface EmfPlusFont {
	kind: 'plus-font';
	/** Font em-size in points. */
	emSize: number;
	/** Style flags bitmask: 1=Bold, 2=Italic, 4=Underline, 8=Strikeout. */
	flags: number;
	/** Font family name. */
	family: string;
	/** GDI+ `Unit` of `emSize` (0 World, 2 Pixel, 3 Point, ...); absent = World. */
	unit?: number;
}

/**
 * An EMF+ (GDI+) path object: an ordered list of points with per-point
 * type bytes that specify move-to (0), line-to (1), or bezier (3) segments.
 */
export interface EmfPlusPath {
	kind: 'plus-path';
	/** Ordered path vertices. */
	points: Array<{ x: number; y: number }>;
	/**
	 * Per-point type byte array. Low nibble encodes the segment type
	 * (0=Start, 1=Line, 3=Bezier); bit 7 signals "close sub-path".
	 */
	types: Uint8Array;
	/**
	 * The path's GDI+ `FillMode`, which a path fill and a path clip honour:
	 * `'evenodd'` for Alternate (GDI+'s default), `'nonzero'` for Winding
	 * (`PathPointFlags` bit 0x2000, as GDI+ records it). Absent on paths
	 * built by hand, which fill nonzero.
	 */
	fillRule?: CanvasFillRule;
}

/** An EMF+ (GDI+) image object: either a raster bitmap or an embedded metafile. */
export interface EmfPlusImage {
	kind: 'plus-image';
	/** Raw image bytes, or `null` when decoding failed / data was out of bounds. */
	data: ArrayBuffer | SharedArrayBuffer | null;
	/** Image type: 0=Unknown, 1=Bitmap, 2=Metafile (embedded EMF/WMF). */
	type: number;
	/**
	 * The object's key in the pre-decoded image cache
	 * ({@link EmfPlusReplayCtx.imageCache}): the `dataOff` of its
	 * `EMFPLUS_OBJECT` record, or of the first record of a continuation run.
	 */
	cacheKey?: number;
}

/** An EMF+ (GDI+) string format object controlling text layout and alignment. */
export interface EmfPlusStringFormat {
	kind: 'plus-stringformat';
	/** StringFormat flags bitmask. */
	flags: number;
	/** Horizontal alignment: 0=Near, 1=Center, 2=Far. */
	alignment: number;
	/** Vertical (line) alignment: 0=Near, 1=Center, 2=Far. */
	lineAlignment: number;
}

/** An EMF+ (GDI+) image-attributes object (colour remapping, gamma, etc.). Currently a stub. */
export interface EmfPlusImageAttributes {
	kind: 'plus-imageattributes';
	/**
	 * `WrapMode` a `DrawImage` with these attributes applies beyond the
	 * source rectangle (MS-EMFPLUS 2.2.1.5), when recorded.
	 */
	wrapMode?: EmfPlusGradientWrapMode;
	/** Packed ARGB colour outside the source rectangle under WrapMode Clamp. */
	clampArgb?: number;
}

/**
 * An EMF+ Region object representing a complex clipping region.
 * Regions can be built from rectangles, paths, or combined from other regions
 * using boolean operations (Intersect, Union, Xor, Exclude, Complement).
 */
export interface EmfPlusRegion {
	kind: 'plus-region';
	/** The region node tree - a recursive structure. */
	nodes: EmfPlusRegionNode[];
}

/**
 * A node in the EMF+ region tree. Each node is either:
 * - A rectangle leaf (type "rect")
 * - A path leaf (type "path") referencing an EmfPlusPath
 * - An infinite region (type "infinite")
 * - An empty region (type "empty")
 * - A combination node (type "combine") with two children. `combineMode`
 *   holds the RegionNodeDataType value from MS-EMFPLUS 2.1.1.27:
 *   1 = And (intersect), 2 = Or (union), 3 = Xor, 4 = Exclude, 5 = Complement.
 */
export type EmfPlusRegionNode =
	| { type: 'rect'; x: number; y: number; width: number; height: number }
	| { type: 'path'; path: EmfPlusPath }
	| { type: 'infinite' }
	| { type: 'empty' }
	| { type: 'combine'; combineMode: number; left: EmfPlusRegionNode; right: EmfPlusRegionNode };

/**
 * Discriminated union of all EMF+ object types stored in the per-file
 * object table (indexed 0-63). The `kind` field acts as the discriminator.
 */
export type EmfPlusObject =
	| EmfPlusBrush
	| EmfPlusPen
	| EmfPlusFont
	| EmfPlusPath
	| EmfPlusImage
	| EmfPlusStringFormat
	| EmfPlusImageAttributes
	| EmfPlusRegion;

// ---------------------------------------------------------------------------
// Deferred image draw (resolved asynchronously after sync replay)
// ---------------------------------------------------------------------------

/**
 * Descriptor for an image draw that was encountered during the synchronous
 * record replay but cannot be executed immediately because
 * {@link createImageBitmap} is asynchronous.
 *
 * After all records have been replayed, the list of deferred images is
 * processed sequentially in {@link processDeferredImages}.
 */
export interface DeferredImageDraw {
	/** Raw image bytes (PNG/BMP/EMF/WMF). */
	imageData: ArrayBuffer | SharedArrayBuffer;
	/** Destination X in logical coordinates. */
	dx: number;
	/** Destination Y in logical coordinates. */
	dy: number;
	/** Destination width in logical coordinates. */
	dw: number;
	/** Destination height in logical coordinates. */
	dh: number;
	/** The world transform that was active at the time of the draw call. */
	transform: TransformMatrix;
	/** When true, imageData is an embedded EMF/WMF metafile that must be recursively converted. */
	isMetafile?: boolean;
	/**
	 * SVG output only: the placeholder reserved at the draw's position in the
	 * record stream (see `SvgContext.reserveSlot`), so the image keeps its
	 * recorded z-order and clip once decoded.
	 */
	svgSlot?: unknown;
	/**
	 * Present for an EMF+ raster `DrawImage`/`DrawImagePoints` whose
	 * `InterpolationMode` is modelled by `emf-plus-image-resample.ts`: the
	 * image is then resampled per device pixel the way GDI+ does, instead of
	 * being scaled by Canvas `drawImage` into `dx`/`dy`/`dw`/`dh` (which
	 * remain as the fallback).
	 */
	resample?: DeferredImageResample;
}

/**
 * The GDI+ `DrawImage` resampling kernel of an `InterpolationMode`
 * (see `emf-plus-image-resample.ts`): nearest texel, point-sampled bilinear
 * (Default, LowQuality, Bilinear), point-sampled bicubic (Bicubic), or the
 * area-integrated, reduction-prefiltered high-quality kernels.
 */
export type ImageResampleKernel = 'nearest' | 'bilinear' | 'bicubic' | 'hq-bilinear' | 'hq-bicubic';

/** How to resample a deferred EMF+ image draw the way GDI+ does (see {@link DeferredImageDraw.resample}). */
export interface DeferredImageResample {
	/** Source rectangle, in image pixels. */
	srcX: number;
	srcY: number;
	srcW: number;
	srcH: number;
	/** Maps a source-pixel coordinate to a device-pixel coordinate. */
	toDevice: TransformMatrix;
	/** Resampling kernel, from the active GDI+ `InterpolationMode`. */
	kernel: ImageResampleKernel;
	/** True under `PixelOffsetMode` Half/HighQuality (pixel centres), false under None/Default. */
	halfPixelOffset: boolean;
	/**
	 * The draw's `ImageAttributes` WrapMode: a kernel tap outside the source
	 * rectangle then reads the bitmap's own texel, and one outside the bitmap
	 * wraps within it (Tile/TileFlipX/Y/XY) or reads `clampArgb` (Clamp),
	 * as measured on the `gpx-image-attr-*` fixtures. Absent: a tap outside
	 * the source rectangle is transparent, GDI+'s default without attributes.
	 */
	wrap?: EmfPlusGradientWrapMode;
	/** Packed ARGB read outside the source rectangle under `wrap` Clamp. */
	clampArgb?: number;
}

// ---------------------------------------------------------------------------
// EMF+ persistent state (survives across multiple EMR_COMMENT records)
// ---------------------------------------------------------------------------

/**
 * Persistent EMF+ state that survives across multiple EMR_COMMENT records.
 *
 * A single EMF file may contain many EMR_COMMENT records, each carrying a
 * batch of EMF+ sub-records. The object table, world transform, and save
 * stack must persist between those batches so that objects defined in one
 * comment can be referenced in a later one.
 */
export interface EmfPlusState {
	/** GDI+ object table keyed by 0-based object ID (max 63). */
	objectTable: Map<number, EmfPlusObject>;
	/** Current GDI+ world transform matrix. */
	worldTransform: TransformMatrix;
	/** Stack of saved transforms for Save/Restore and BeginContainer/EndContainer. */
	saveStack: Array<{ transform: TransformMatrix }>;
	/** Maps the caller-supplied save/container ID to an index in {@link saveStack}. */
	saveIdMap: Map<number, number>;
	/** Tracked clip region (device-space shapes), persisted across comment batches. */
	clipRegion: ClipRegion;
	/** Number of canvas save() brackets currently open for clip management. */
	clipSaveDepth: number;
	/**
	 * An `EMFPLUS_OBJECT` continuation run still being reassembled when the
	 * previous `EMR_COMMENT` batch ended (runs routinely span several
	 * comments); see `emf-plus-continuation.ts`.
	 */
	continuation?: Pick<
		EmfPlusReplayCtx,
		| 'continuationBuffer'
		| 'continuationObjectId'
		| 'continuationObjectType'
		| 'continuationTotalSize'
		| 'continuationOffset'
		| 'continuationKey'
	>;
	/** Active GDI+ `InterpolationMode` (`EmfPlusSetInterpolationMode`; 0 = Default when absent). */
	interpolationMode?: number;
	/** Active GDI+ `PixelOffsetMode` (`EmfPlusSetPixelOffsetMode`; 0 = Default when absent). */
	pixelOffsetMode?: number;
	/** Active GDI+ `TextRenderingHint` (`EmfPlusSetTextRenderingHint`; 0 = SystemDefault when absent). */
	textRenderingHint?: number;
	/** Active page unit (`EmfPlusSetPageTransform`), persisted across comment batches. */
	pageUnit?: number;
	/** Active page scale (`EmfPlusSetPageTransform`), persisted across comment batches. */
	pageScale?: number;
	/**
	 * Device-space mapping applied after world x page units x DPI scale:
	 * the metafile's device origin (its header bounds' top-left) moved to
	 * the canvas origin, or, for a metafile nested in a `DrawImage`, the
	 * mapping onto the destination (see {@link EmfPlusReplayCtx.baseTransform}).
	 */
	baseTransform?: TransformMatrix;
	/** Pre-decoded Image objects (see {@link EmfPlusReplayCtx.imageCache}). */
	imageCache?: EmfPlusImageCache;
	/** Nesting depth of an embedded metafile (see {@link EmfPlusReplayCtx.nestingDepth}). */
	nestingDepth?: number;
	/** Active GDI+ antialiasing (see {@link EmfPlusReplayCtx.antiAlias}). */
	antiAlias?: boolean;
	/** `EmfConvertOptions.gdiAntialias`, for nested metafile replays. */
	gdiAntialias?: boolean;
}

/**
 * Factory that creates a clean initial {@link EmfPlusState} with an empty
 * object table and identity world transform.
 *
 * @returns A freshly initialised EMF+ state.
 */
export function createEmfPlusState(): EmfPlusState {
	return {
		objectTable: new Map(),
		worldTransform: [1, 0, 0, 1, 0, 0],
		saveStack: [],
		saveIdMap: new Map(),
		clipRegion: null,
		clipSaveDepth: 0,
	};
}

// ---------------------------------------------------------------------------
// WMF header type
// ---------------------------------------------------------------------------

/**
 * Parsed WMF file header. Combines fields from the optional Aldus
 * placeable header (magic `0x9AC6CDD7`) and the standard WMF header.
 */
export interface WmfHeader {
	/** Total header byte size (placeable header + standard header). */
	headerSize: number;
	/** Largest record size in bytes (used as a sanity-check upper bound). */
	maxRecordSize: number;
	/** Left edge of the bounding rectangle (logical units). */
	boundsLeft: number;
	/** Top edge of the bounding rectangle (logical units). */
	boundsTop: number;
	/** Right edge of the bounding rectangle (logical units). */
	boundsRight: number;
	/** Bottom edge of the bounding rectangle (logical units). */
	boundsBottom: number;
	/** Logical units per inch (from the placeable header; defaults to 96). */
	unitsPerInch: number;
}

// ---------------------------------------------------------------------------
// WMF coordinate helpers
// ---------------------------------------------------------------------------

/**
 * Coordinate-mapping closures for WMF replay.
 *
 * Each function converts a value from WMF logical coordinates to canvas
 * pixel coordinates, taking the current window origin/extent and canvas
 * dimensions into account.
 */
export interface WmfCoord {
	/** Map logical X position to canvas X. */
	mx: (x: number) => number;
	/** Map logical Y position to canvas Y. */
	my: (y: number) => number;
	/** Map logical width to canvas width. */
	mw: (w: number) => number;
	/** Map logical height to canvas height. */
	mh: (h: number) => number;
}

/**
 * Context object passed through the WMF record handler chain.
 * Bundles the DataView, rendering context, current drawing state,
 * and coordinate-mapping helpers.
 */
export interface WmfReplayCtx {
	/** DataView over the raw WMF file bytes. */
	view: DataView;
	/** Target canvas 2D rendering context. */
	ctx: CanvasContext;
	/** Mutable GDI drawing state. */
	state: DrawState;
	/** Coordinate-mapping closures (logical -> canvas). */
	coord: WmfCoord;
	/** Font files for exact GDI text (see {@link ReplayOptions.fonts}). */
	fonts?: import('./gdi-font-engine').GdiFontCollection;
}

// ---------------------------------------------------------------------------
// EMF+ replay context (shared state passed to handler functions)
// ---------------------------------------------------------------------------

/**
 * Context object threaded through every EMF+ record handler.
 *
 * It carries both the persistent GDI+ object table and the transient
 * rendering state (world transform, save stack, deferred image queue).
 */
export interface EmfPlusReplayCtx {
	/** Target canvas 2D rendering context. */
	ctx: CanvasContext;
	/** DataView over the raw metafile bytes. */
	view: DataView;
	/** GDI+ object table (brush, pen, path, font, image, etc.). */
	objectTable: Map<number, EmfPlusObject>;
	/** Current GDI+ world transform. */
	worldTransform: TransformMatrix;
	/** Accumulator for image draws that must be resolved asynchronously. */
	deferredImages: DeferredImageDraw[];
	/** Save/container transform stack. */
	saveStack: Array<{ transform: TransformMatrix }>;
	/** Maps caller-supplied save/container IDs to stack indices. */
	saveIdMap: Map<number, number>;
	/** Running count of Image objects parsed (for diagnostics). */
	totalImageObjects: number;
	/** Running count of DrawImage / DrawImagePoints calls (for diagnostics). */
	totalDrawImageCalls: number;
	/** Number of ctx.save() calls made specifically for clip management. */
	clipSaveDepth: number;
	/** Current page unit (0=World, 2=Pixel, 3=Point, 4=Inch, 5=Document, 6=Millimeter). */
	pageUnit: number;
	/** Current page scale factor. */
	pageScale: number;
	/** Buffer for accumulating continuation object data. */
	continuationBuffer: Uint8Array | null;
	/** The object ID of the current continuation sequence. */
	continuationObjectId: number;
	/** The object type of the current continuation sequence. */
	continuationObjectType: number;
	/** Total size expected for the continuation object. */
	continuationTotalSize: number;
	/** Byte offset into continuationBuffer for the next chunk. */
	continuationOffset: number;
	/**
	 * `dataOff` of the first record of the continuation run in progress: the
	 * run's texture-cache key (see `emf-plus-continuation.ts`).
	 */
	continuationKey?: number;
	/** DPI scale factor applied to the canvas (1 = normal, 2 = HiDPI). */
	dpiScale: number;
	/**
	 * Canvas size in device pixels: the finite domain over which clip
	 * combinations that need scan conversion are evaluated. When absent the
	 * domain is derived from the clip geometry.
	 */
	canvasW?: number;
	/** Canvas height in device pixels (see {@link canvasW}). */
	canvasH?: number;
	/** Optional lowercased-face → CSS-family overrides for text rendering. */
	fontFamilyMap?: Record<string, string>;
	/**
	 * Tracked clip region as device-space shapes (`null` = no clip). Enables
	 * Union/Xor/Exclude/Complement CombineModes and OffsetClip, which Canvas 2D
	 * cannot express through successive `clip()` calls alone.
	 */
	clipRegion?: ClipRegion;
	/**
	 * Pre-decoded EMF+ TextureFill brush images, keyed by the brush object's
	 * `cacheKey` (`emf-plus-continuation.ts`): the `dataOff` of its
	 * `EMFPLUS_OBJECT` record, or of the first record of a continuation run.
	 * Stable across the async pre-scan pass and this synchronous replay pass,
	 * since both walk the same raw buffer and reassemble continuation runs
	 * with the same code. Set once by {@link preDecodeEmfPlusTextures} before
	 * replay begins; consulted by `parseEmfPlusBrushObject` when a
	 * TextureFill brush's embedded image is a compressed (PNG/JPEG) bitmap
	 * the synchronous parse cannot decode.
	 */
	textureCache?: EmfPlusTextureCache;
	/** Active GDI+ `InterpolationMode` (0 = Default when absent); see {@link EmfPlusState.interpolationMode}. */
	interpolationMode?: number;
	/** Active GDI+ `PixelOffsetMode` (0 = Default when absent); see {@link EmfPlusState.pixelOffsetMode}. */
	pixelOffsetMode?: number;
	/** Active GDI+ `TextRenderingHint`; see {@link EmfPlusState.textRenderingHint}. */
	textRenderingHint?: number;
	/** Font files for exact text (see {@link ReplayOptions.fonts}). */
	fonts?: import('./gdi-font-engine').GdiFontCollection;
	/**
	 * Canvas-space affine applied after world x page units x DPI scale (see
	 * `plusWorldMatrix`): translates the metafile's device origin (its
	 * header bounds' top-left, which a drawing reaching above or left of
	 * device (0, 0) moves negative) to the canvas origin, and places a nested
	 * metafile onto its `DrawImage` destination. Identity when absent.
	 */
	baseTransform?: TransformMatrix;
	/**
	 * Pre-decoded Image objects keyed by {@link EmfPlusImage.cacheKey}: a
	 * `DrawImage` whose image is here is painted immediately, in record
	 * order and under the clip active at that record, instead of being
	 * deferred until after replay.
	 */
	imageCache?: EmfPlusImageCache;
	/** Nesting depth of an embedded metafile being replayed (0 = the top-level file). */
	nestingDepth?: number;
	/**
	 * GDI+ `SmoothingMode` antialiasing (`EmfPlusSetAntiAliasMode` flag A):
	 * `false`/absent is GDI+'s default (SmoothingMode None, aliased edges).
	 */
	antiAlias?: boolean;
	/** `EmfConvertOptions.gdiAntialias`, threaded through for nested metafile replays. */
	gdiAntialias?: boolean;
}

// ---------------------------------------------------------------------------
// EMF GDI replay context (shared state passed to handler functions)
// ---------------------------------------------------------------------------

/**
 * Context object threaded through every EMF GDI record handler.
 *
 * It bundles the canvas context, the binary DataView, the GDI object table,
 * the mutable drawing state, coordinate-mapping parameters, and bookkeeping
 * flags such as `inPath` and `clipSaveDepth`.
 */
export interface EmfGdiReplayCtx {
	/** Target canvas 2D rendering context. */
	ctx: CanvasContext;
	/** DataView over the raw EMF file bytes. */
	view: DataView;
	/** GDI object table: maps object handles to pen/brush/font objects. */
	objectTable: Map<number, GdiObject>;
	/** Mutable GDI drawing state (colours, font, pen position, …). */
	state: DrawState;
	/** Stack of saved DrawStates for EMR_SAVEDC / EMR_RESTOREDC. */
	stateStack: DrawState[];
	/** True while inside a BeginPath / EndPath bracket. */
	inPath: boolean;
	/** Window origin (logical coordinates). */
	windowOrg: { x: number; y: number };
	/** Window extent (logical size). */
	windowExt: { cx: number; cy: number };
	/** Viewport origin (device coordinates). */
	viewportOrg: { x: number; y: number };
	/** Viewport extent (device size). */
	viewportExt: { cx: number; cy: number };
	/** When true, use window/viewport mapping instead of simple bounds-based scaling. */
	useMappingMode: boolean;
	/**
	 * Tracks how many extra `ctx.save()` calls were made for clipping rects,
	 * so they can be unwound before a state save/restore.
	 */
	clipSaveDepth: number;
	/**
	 * Tracked clip region as device-space shapes (`null`/`undefined` = no
	 * clip). Kept in sync with the canvas clip so Exclude/Xor/Offset region
	 * operations can rebuild the clip state.
	 */
	clipRegion?: ClipRegion;
	/** Saved clip regions parallel to {@link stateStack} (EMR_SAVEDC). */
	clipStack?: Array<{ region: ClipRegion }>;
	/** Logical bounding rectangle from the EMF header. */
	bounds: EmfBounds;
	/** Output canvas width in pixels. */
	canvasW: number;
	/** Output canvas height in pixels. */
	canvasH: number;
	/** Horizontal scale factor: `canvasW / logicalWidth`. */
	sx: number;
	/** Vertical scale factor: `canvasH / logicalHeight`. */
	sy: number;
	/**
	 * Recorded geometry for the CURRENT `BeginPath`/`EndPath` bracket (reset
	 * on `EMR_BEGINPATH`), device-space, so `EMR_FILLPATH`/
	 * `EMR_STROKEANDFILLPATH`/`EMR_STROKEPATH` can replay it onto a scratch
	 * canvas for the exact bitwise ROP2 combine. See `emf-gdi-path-record.ts`.
	 */
	pathCmds: import('./emf-gdi-path-record').GdiPathCmd[];
	/**
	 * `false` renders GDI vector fills and strokes without antialiasing, one
	 * device pixel at a time, the way GDI itself rasterises them (see
	 * `emf-gdi-shape-paint.ts`). Omitted/`true` keeps Canvas's antialiased
	 * `fill()`/`stroke()`. Threaded from {@link ReplayOptions.gdiAntialias}.
	 */
	gdiAntialias?: boolean;
	/** Font files for exact GDI text (see {@link ReplayOptions.fonts}). */
	fonts?: import('./gdi-font-engine').GdiFontCollection;
	/**
	 * The current `BeginPath`/`EndPath` bracket's geometry in device FIX, as
	 * the GDI rasteriser needs it (`gdi-raster.ts`); built alongside
	 * {@link pathCmds}.
	 */
	rasterPath?: import('./gdi-raster').GdiRasterPath;
	/**
	 * The cosmetic pen's dash-pattern position, carried across consecutive
	 * EMR_LINETO records (GDI restarts it at a MoveTo or any other call).
	 */
	lineStyle?: import('./gdi-raster').StyleState;
	/**
	 * Deferred exact pixels (`emf-gdi-raster-layer.ts`): `undefined` until
	 * first needed, `null` when the replay cannot use one.
	 */
	rasterLayer?: import('./emf-gdi-raster-layer').RasterLayer | null;
}
