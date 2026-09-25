/**
 * EMF / EMF+ / WMF record-type constants and related numeric definitions.
 *
 * These constants mirror the record-type identifiers defined in the
 * Microsoft EMF (MS-EMF), EMF+ (MS-EMFPLUS), and WMF (MS-WMF) specifications.
 * They are used by the record-replay loops to dispatch each record to the
 * correct handler function.
 *
 * @module emf-constants
 */

// ---------------------------------------------------------------------------
// EMF record type constants (32-bit, from [MS-EMF] section 2.1.1)
// ---------------------------------------------------------------------------

/** EMR_HEADER: the mandatory first record of every EMF file. */
export const EMR_HEADER = 1;
export const EMR_POLYBEZIER = 2;
export const EMR_POLYGON = 3;
export const EMR_POLYLINE = 4;
export const EMR_POLYBEZIERTO = 5;
export const EMR_POLYLINETO = 6;
export const EMR_POLYPOLYLINE = 7;
export const EMR_POLYPOLYGON = 8;
export const EMR_SETWINDOWEXTEX = 9;
export const EMR_SETWINDOWORGEX = 10;
export const EMR_SETVIEWPORTEXTEX = 11;
export const EMR_SETVIEWPORTORGEX = 12;
export const EMR_SETBRUSHORGEX = 13;
export const EMR_CREATEMONOBRUSH = 93;
export const EMR_CREATEDIBPATTERNBRUSHPT = 94;
export const EMR_STRETCHBLT = 77;
export const EMR_EOF = 14;
export const EMR_SETPIXELV = 15;
export const EMR_SETMAPMODE = 17;
export const EMR_SETBKMODE = 18;
export const EMR_SETPOLYFILLMODE = 19;
export const EMR_SETROP2 = 20;
export const EMR_SETSTRETCHBLTMODE = 21;

// Binary raster-operation (ROP2) modes: the 1..16 wire values shared by
// EMR_SETROP2 and META_SETROP2 (MS-WMF 2.1.1.31). Only a subset has a faithful
// Canvas globalCompositeOperation equivalent; see `rop2ToGco` in emf-canvas-helpers.
export const R2_BLACK = 1;
export const R2_NOTMERGEPEN = 2;
export const R2_MASKNOTPEN = 3;
export const R2_NOTCOPYPEN = 4;
export const R2_MASKPENNOT = 5;
export const R2_NOT = 6;
export const R2_XORPEN = 7;
export const R2_NOTMASKPEN = 8;
export const R2_MASKPEN = 9;
export const R2_NOTXORPEN = 10;
export const R2_NOP = 11;
export const R2_MERGENOTPEN = 12;
export const R2_COPYPEN = 13;
export const R2_MERGEPENNOT = 14;
export const R2_MERGEPEN = 15;
export const R2_WHITE = 16;

// Ternary raster-operation (ROP3) codes used by EMR_BITBLT / EMR_STRETCHDIBITS
// (MS-WMF 2.1.1.28 lists the full 256-code table; only the common subset GDI
// itself actually emits from BitBlt/StretchBlt is named here). See
// `classifyRop3` in emf-rop3.ts for how each is emulated on Canvas 2D.
export const ROP3_SRCCOPY = 0x00cc0020;
export const ROP3_SRCPAINT = 0x00ee0086;
export const ROP3_SRCAND = 0x008800c6;
export const ROP3_SRCINVERT = 0x00660046;
export const ROP3_SRCERASE = 0x00440328;
export const ROP3_NOTSRCCOPY = 0x00330008;
export const ROP3_NOTSRCERASE = 0x001100a6;
export const ROP3_MERGECOPY = 0x00c000ca;
export const ROP3_MERGEPAINT = 0x00bb0226;
export const ROP3_PATCOPY = 0x00f00021;
export const ROP3_PATPAINT = 0x00fb0a09;
export const ROP3_PATINVERT = 0x005a0049;
export const ROP3_DSTINVERT = 0x00550009;
export const ROP3_BLACKNESS = 0x00000042;
export const ROP3_WHITENESS = 0x00ff0062;

/**
 * Hard cap on the output canvas width/height in pixels. Guards against
 * pathological metafiles requesting gigantic surfaces. Overridable per call via
 * {@link EmfConvertOptions.maxCanvasDimension}.
 */
export const MAX_CANVAS_DIMENSION = 8192;

/** Default record-processing cap for GDI (EMF) and WMF streams. */
export const MAX_RECORDS_DEFAULT = 200000;

/** Default record-processing cap for the finer-grained EMF+ record stream. */
export const MAX_RECORDS_EMFPLUS_DEFAULT = 500000;
export const EMR_SETTEXTALIGN = 22;
export const EMR_SETTEXTCOLOR = 24;
export const EMR_SETBKCOLOR = 25;
export const EMR_OFFSETCLIPRGN = 26;
export const EMR_MOVETOEX = 27;
export const EMR_SETMETARGN = 28;
export const EMR_EXCLUDECLIPRECT = 29;
export const EMR_INTERSECTCLIPRECT = 30;
export const EMR_SCALEVIEWPORTEXTEX = 31;
export const EMR_SCALEWINDOWEXTEX = 32;
export const EMR_SAVEDC = 33;
export const EMR_RESTOREDC = 34;
export const EMR_SETWORLDTRANSFORM = 35;
export const EMR_MODIFYWORLDTRANSFORM = 36;
export const EMR_SELECTOBJECT = 37;
export const EMR_CREATEPEN = 38;
export const EMR_CREATEBRUSHINDIRECT = 39;
export const EMR_DELETEOBJECT = 40;
export const EMR_ELLIPSE = 42;
export const EMR_RECTANGLE = 43;
export const EMR_ROUNDRECT = 44;
export const EMR_ARC = 45;
export const EMR_CHORD = 46;
export const EMR_PIE = 47;
export const EMR_LINETO = 54;
export const EMR_ARCTO = 55;
export const EMR_SETARCDIRECTION = 57;
export const EMR_SETMITERLIMIT = 58;
export const EMR_BEGINPATH = 59;
export const EMR_ENDPATH = 60;
export const EMR_CLOSEFIGURE = 61;
export const EMR_FILLPATH = 62;
export const EMR_STROKEANDFILLPATH = 63;
export const EMR_STROKEPATH = 64;
export const EMR_SELECTCLIPPATH = 67;
export const EMR_COMMENT = 70;
export const EMR_EXTSELECTCLIPRGN = 75;
export const EMR_BITBLT = 76;
export const EMR_STRETCHDIBITS = 81;
export const EMR_EXTCREATEFONTINDIRECTW = 82;
export const EMR_EXTTEXTOUTW = 84;
export const EMR_POLYBEZIER16 = 85;
export const EMR_POLYGON16 = 86;
export const EMR_POLYLINE16 = 87;
export const EMR_POLYBEZIERTO16 = 88;
export const EMR_POLYLINETO16 = 89;
export const EMR_POLYPOLYGON16 = 91;
export const EMR_EXTCREATEPEN = 95;
export const EMR_SETICMMODE = 98;
export const EMR_SETLAYOUT = 115;

// Records handled since the GDI record-coverage work (see `emf-gdi-*` modules).
export const EMR_SETMAPPERFLAGS = 16;
export const EMR_SETCOLORADJUSTMENT = 23;
export const EMR_ANGLEARC = 41;
export const EMR_SELECTPALETTE = 48;
export const EMR_CREATEPALETTE = 49;
export const EMR_SETPALETTEENTRIES = 50;
export const EMR_RESIZEPALETTE = 51;
export const EMR_REALIZEPALETTE = 52;
export const EMR_EXTFLOODFILL = 53;
export const EMR_POLYDRAW = 56;
export const EMR_FLATTENPATH = 65;
export const EMR_WIDENPATH = 66;
export const EMR_ABORTPATH = 68;
export const EMR_FILLRGN = 71;
export const EMR_FRAMERGN = 72;
export const EMR_INVERTRGN = 73;
export const EMR_PAINTRGN = 74;
export const EMR_MASKBLT = 78;
export const EMR_PLGBLT = 79;
export const EMR_SETDIBITSTODEVICE = 80;
export const EMR_EXTTEXTOUTA = 83;
export const EMR_POLYPOLYLINE16 = 90;
export const EMR_POLYDRAW16 = 92;
export const EMR_POLYTEXTOUTA = 96;
export const EMR_POLYTEXTOUTW = 97;
export const EMR_CREATECOLORSPACE = 99;
export const EMR_SETCOLORSPACE = 100;
export const EMR_DELETECOLORSPACE = 101;
export const EMR_GLSRECORD = 102;
export const EMR_GLSBOUNDEDRECORD = 103;
export const EMR_PIXELFORMAT = 104;
export const EMR_DRAWESCAPE = 105;
export const EMR_EXTESCAPE = 106;
export const EMR_SMALLTEXTOUT = 108;
export const EMR_FORCEUFIMAPPING = 109;
export const EMR_NAMEDESCAPE = 110;
export const EMR_COLORCORRECTPALETTE = 111;
export const EMR_SETICMPROFILEA = 112;
export const EMR_SETICMPROFILEW = 113;
export const EMR_ALPHABLEND = 114;
export const EMR_TRANSPARENTBLT = 116;
export const EMR_GRADIENTFILL = 118;
export const EMR_SETLINKEDUFIS = 119;
export const EMR_SETTEXTJUSTIFICATION = 120;
export const EMR_COLORMATCHTOTARGETW = 121;
export const EMR_CREATECOLORSPACEW = 122;

/** Stock object index of `DEFAULT_PALETTE` (selected as `STOCK_OBJECT_BASE | 15`). */
export const DEFAULT_PALETTE_STOCK_INDEX = 15;

/**
 * Base index for GDI stock objects. Object handles >= this value refer to
 * built-in stock objects (WHITE_BRUSH, BLACK_PEN, etc.) rather than
 * user-created objects in the metafile's object table.
 */
export const STOCK_OBJECT_BASE = 0x80000000;

/**
 * Magic signature found at the start of EMF+ data inside an EMR_COMMENT
 * record payload. The bytes spell "EMF+" in ASCII (little-endian: 0x2B464D45).
 */
export const EMFPLUS_SIGNATURE = 0x2b464d45;

/** Signature for EMR_COMMENT_PUBLIC records. */
export const EMR_COMMENT_PUBLIC_SIGNATURE = 0x43494447; // "GDIC" in ASCII

/** Signature found in EMR_COMMENT_EMFSPOOL records. */
export const EMR_COMMENT_EMFSPOOL_SIGNATURE = 0x00000000;

/** Identifier for EMR_COMMENT_WINDOWS_METAFILE records. */
export const EMR_COMMENT_BEGINGROUP = 0x00000002;
export const EMR_COMMENT_ENDGROUP = 0x00000003;
export const EMR_COMMENT_MULTIFORMATS = 0x40000004;
export const EMR_COMMENT_UNICODE_STRING = 0x00000040;
export const EMR_COMMENT_UNICODE_END = 0x00000080;

// ---------------------------------------------------------------------------
// EMF+ record type constants
// ---------------------------------------------------------------------------

export const EMFPLUS_HEADER = 0x4001;
export const EMFPLUS_ENDOFFILE = 0x4002;
export const EMFPLUS_GETDC = 0x4004;
/** EmfPlusClear: fills the drawing surface (within the clip) with an ARGB colour. */
export const EMFPLUS_CLEAR = 0x4009;
export const EMFPLUS_OBJECT = 0x4008;
export const EMFPLUS_FILLRECTS = 0x400a;
export const EMFPLUS_DRAWRECTS = 0x400b;
export const EMFPLUS_FILLPOLYGON = 0x400c;
export const EMFPLUS_DRAWLINES = 0x400d;
export const EMFPLUS_FILLELLIPSE = 0x400e;
export const EMFPLUS_DRAWELLIPSE = 0x400f;
export const EMFPLUS_FILLPIE = 0x4010;
export const EMFPLUS_DRAWPIE = 0x4011;
export const EMFPLUS_DRAWARC = 0x4012;
export const EMFPLUS_FILLPATH = 0x4014;
export const EMFPLUS_DRAWPATH = 0x4015;
export const EMFPLUS_DRAWIMAGE = 0x401a;
export const EMFPLUS_DRAWIMAGEPOINTS = 0x401b;
export const EMFPLUS_DRAWSTRING = 0x401c;
export const EMFPLUS_SETANTIALIASMODE = 0x401e;
export const EMFPLUS_SETTEXTRENDERINGHINT = 0x401f;
export const EMFPLUS_SETINTERPOLATIONMODE = 0x4021;
export const EMFPLUS_SETPIXELOFFSETMODE = 0x4022;
export const EMFPLUS_SETCOMPOSITINGQUALITY = 0x4024;
export const EMFPLUS_SAVE = 0x4025;
export const EMFPLUS_RESTORE = 0x4026;
export const EMFPLUS_BEGINCONTAINERNOPARAMS = 0x4028;
export const EMFPLUS_ENDCONTAINER = 0x4029;
export const EMFPLUS_SETWORLDTRANSFORM = 0x402a;
export const EMFPLUS_RESETWORLDTRANSFORM = 0x402b;
export const EMFPLUS_MULTIPLYWORLDTRANSFORM = 0x402c;
export const EMFPLUS_TRANSLATEWORLDTRANSFORM = 0x402d;
export const EMFPLUS_SCALEWORLDTRANSFORM = 0x402e;
export const EMFPLUS_ROTATEWORLDTRANSFORM = 0x402f;
export const EMFPLUS_SETPAGETRANSFORM = 0x4030;
export const EMFPLUS_RESETCLIP = 0x4031;
export const EMFPLUS_SETCLIPRECT = 0x4032;
export const EMFPLUS_SETCLIPPATH = 0x4033;
export const EMFPLUS_SETCLIPREGION = 0x4034;
export const EMFPLUS_DRAWDRIVERSTRING = 0x4036;
export const EMFPLUS_OFFSETCLIP = 0x4035;
export const EMFPLUS_FILLCLOSEDCURVE = 0x4016;
export const EMFPLUS_DRAWCLOSEDCURVE = 0x4017;
export const EMFPLUS_DRAWCURVE = 0x4018;
export const EMFPLUS_DRAWBEZIERS = 0x4019;
export const EMFPLUS_BEGINCONTAINER = 0x4027;
export const EMFPLUS_COMMENT = 0x4003;
export const EMFPLUS_MULTIFORMATSTART = 0x4005;
export const EMFPLUS_MULTIFORMATSECTION = 0x4006;
export const EMFPLUS_MULTIFORMATEND = 0x4007;
export const EMFPLUS_FILLREGION = 0x4013;
export const EMFPLUS_SETRENDERINGORIGIN = 0x401d;
export const EMFPLUS_SETTEXTCONTRAST = 0x4020;
export const EMFPLUS_SETCOMPOSITINGMODE = 0x4023;
export const EMFPLUS_STROKEFILLPATH = 0x4037;
export const EMFPLUS_SERIALIZABLEOBJECT = 0x4038;
export const EMFPLUS_SETTSGRAPHICS = 0x4039;
export const EMFPLUS_SETTSCLIP = 0x403a;

// EMF+ object types (used in EMFPLUS_OBJECT record)
export const EMFPLUS_OBJECTTYPE_BRUSH = 0x01;
export const EMFPLUS_OBJECTTYPE_PEN = 0x02;
export const EMFPLUS_OBJECTTYPE_PATH = 0x03;
export const EMFPLUS_OBJECTTYPE_REGION = 0x04;
export const EMFPLUS_OBJECTTYPE_IMAGE = 0x05;
export const EMFPLUS_OBJECTTYPE_FONT = 0x06;
export const EMFPLUS_OBJECTTYPE_STRINGFORMAT = 0x07;
export const EMFPLUS_OBJECTTYPE_IMAGEATTRIBUTES = 0x08;
export const EMFPLUS_OBJECTTYPE_CUSTOMLINECAP = 0x09;

// EMF+ brush types
export const EMFPLUS_BRUSHTYPE_SOLID = 0;
export const EMFPLUS_BRUSHTYPE_HATCHFILL = 1;
export const EMFPLUS_BRUSHTYPE_TEXTUREFILL = 2;
export const EMFPLUS_BRUSHTYPE_PATHGRADIENT = 3;
export const EMFPLUS_BRUSHTYPE_LINEARGRADIENT = 4;

// ---------------------------------------------------------------------------
// WMF record type constants (16-bit)
// ---------------------------------------------------------------------------

export const META_EOF = 0x0000;
export const META_SETBKCOLOR = 0x0201;
export const META_SETBKMODE = 0x0102;
export const META_SETROP2 = 0x0104;
export const META_SETPOLYFILLMODE = 0x0106;
export const META_SETTEXTCOLOR = 0x0209;
export const META_SETTEXTALIGN = 0x012e;
export const META_SETWINDOWORG = 0x020b;
export const META_SETWINDOWEXT = 0x020c;
export const META_MOVETO = 0x0214;
export const META_LINETO = 0x0213;
export const META_RECTANGLE = 0x041b;
export const META_ROUNDRECT = 0x061c;
export const META_ELLIPSE = 0x0418;
export const META_ARC = 0x0817;
export const META_PIE = 0x081a;
export const META_CHORD = 0x0830;
export const META_POLYGON = 0x0324;
export const META_POLYLINE = 0x0325;
export const META_SELECTOBJECT = 0x012d;
export const META_DELETEOBJECT = 0x01f0;
export const META_CREATEPENINDIRECT = 0x02fa;
export const META_CREATEBRUSHINDIRECT = 0x02fc;
export const META_CREATEFONTINDIRECT = 0x02fb;
export const META_TEXTOUT = 0x0521;
export const META_PATBLT = 0x061d;
export const META_EXTTEXTOUT = 0x0a32;
export const META_SAVEDC = 0x001e;
export const META_RESTOREDC = 0x0127;
export const META_POLYPOLYGON = 0x0538;
// The rest of MS-WMF 2.1.1.1 RecordType.
export const META_REALIZEPALETTE = 0x0035;
export const META_SETPALENTRIES = 0x0037;
export const META_SETMAPMODE = 0x0103;
export const META_SETRELABS = 0x0105;
export const META_SETSTRETCHBLTMODE = 0x0107;
export const META_SETTEXTCHAREXTRA = 0x0108;
export const META_RESIZEPALETTE = 0x0139;
export const META_DIBCREATEPATTERNBRUSH = 0x0142;
export const META_SETLAYOUT = 0x0149;
export const META_SETTEXTJUSTIFICATION = 0x020a;
export const META_SETVIEWPORTORG = 0x020d;
export const META_SETVIEWPORTEXT = 0x020e;
export const META_OFFSETWINDOWORG = 0x020f;
export const META_OFFSETVIEWPORTORG = 0x0211;
export const META_OFFSETCLIPRGN = 0x0220;
export const META_FILLREGION = 0x0228;
export const META_SETMAPPERFLAGS = 0x0231;
export const META_SELECTPALETTE = 0x0234;
export const META_SCALEWINDOWEXT = 0x0410;
export const META_SCALEVIEWPORTEXT = 0x0412;
export const META_EXCLUDECLIPRECT = 0x0415;
export const META_INTERSECTCLIPRECT = 0x0416;
export const META_FLOODFILL = 0x0419;
export const META_SETPIXEL = 0x041f;
export const META_FRAMEREGION = 0x0429;
export const META_ANIMATEPALETTE = 0x0436;
export const META_EXTFLOODFILL = 0x0548;
export const META_ESCAPE = 0x0626;
export const META_INVERTREGION = 0x012a;
export const META_PAINTREGION = 0x012b;
export const META_SELECTCLIPREGION = 0x012c;
export const META_BITBLT = 0x0922;
export const META_STRETCHBLT = 0x0b23;
export const META_DIBBITBLT = 0x0940;
export const META_DIBSTRETCHBLT = 0x0b41;
export const META_STRETCHDIB = 0x0f43;
export const META_SETDIBTODEV = 0x0d33;
export const META_CREATEPALETTE = 0x00f7;
export const META_CREATEBRUSH = 0x00f8;
export const META_CREATEPATTERNBRUSH = 0x01f9;
export const META_CREATEBITMAPINDIRECT = 0x02fd;
export const META_CREATEBITMAP = 0x06fe;
export const META_CREATEREGION = 0x06ff;
