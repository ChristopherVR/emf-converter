"""Generate a CC0 private font that isolates which SHPIX shifts along y native ClearType and grayscale honour.

Every glyph is three thin stems of equal height. Its program (all along y) touches the stems' top points (or not, or
only along x, or by IP), optionally runs IUP[x] and/or IUP[y], and then raises each top point by a pixel with SHPIX:
inline, through an ordinary function, with one SLOOP SHPIX, or through the two generic per-size helper functions whose
bodies Monotype fonts such as Arial define (`MPPEM >= lo and MPPEM <= hi: SHPIX` and `MPPEM == ppem: SHPIX`). A row of ink
appears at the top of a stem when its shift counts. No installed font or native implementation is consulted.
"""
from array import array
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

PUSHB = 0xB0
SVTCA_Y, SVTCA_X, SRP1, SRP2, MDAP0, IUPY, IUPX, SHPIX, SLOOP, IP, CALL, FDEF, ENDF = 0x00, 0x01, 0x11, 0x12, 0x2E, 0x30, 0x31, 0x38, 0x17, 0x39, 0x2B, 0x2C, 0x2D
MPPEM, GTEQ, SWAP, LTEQ, AND, IF, ELSE, POP, EIF, EQ = 0x4B, 0x53, 0x23, 0x51, 0x5A, 0x58, 0x1B, 0x21, 0x59, 0x54
HELPER_RANGE = [MPPEM, GTEQ, SWAP, MPPEM, LTEQ, AND, IF, SHPIX, ELSE, POP, POP, EIF]
HELPER_EQ = [MPPEM, EQ, IF, SHPIX, ELSE, POP, POP, EIF]
TOPS = [1, 5, 9]
TOP = 1100          # 8.59 px at 16 ppem: one more pixel crosses the centre of the next row up
PPEM = 16

def push(*values):
    return [PUSHB + len(values) - 1, *values]

def touch_y():
    return [SVTCA_Y] + [b for t in TOPS for b in push(t) + [MDAP0]]

def touch_x():
    return [SVTCA_X] + [b for t in TOPS for b in push(t) + [MDAP0]]

def ip(axis):
    out = [axis]
    for t in TOPS:
        out += push(t - 1) + [SRP1] + push(t) + [SRP2] + push(t) + [IP]
    return out

iups = [IUPX, IUPY]
inline = [SVTCA_Y] + [b for t in TOPS for b in push(t, 64) + [SHPIX]]
call = [SVTCA_Y] + [b for t in TOPS for b in push(t, 64, 0) + [CALL]]
loop = [SVTCA_Y] + push(*TOPS, 3) + [SLOOP] + push(64) + [SHPIX]
helper = [SVTCA_Y] + [b for t in TOPS for b in push(t, 64, 8, 24, 1) + [CALL]]
helper_eq = [SVTCA_Y] + [b for t in TOPS for b in push(t, 64, PPEM, 2) + [CALL]]

KINDS = {
    'ipy-inline': [*ip(SVTCA_Y), *iups, *inline],
    'mdap-inline': [*touch_y(), *iups, *inline],
    'ipx-ipy-inline': [*ip(SVTCA_X), *ip(SVTCA_Y), *iups, *inline],
    'ipy-call': [*ip(SVTCA_Y), *iups, *call],
    'mdapx-inline': [*touch_x(), *iups, *inline],
    'ipy-loop': [*ip(SVTCA_Y), *iups, *loop],
    'untouched-inline': [*iups, *inline],
    'ipx-only-inline': [*ip(SVTCA_X), *iups, *inline],
    'pre-ipy-inline': [*ip(SVTCA_Y), *inline],
    'ipy-iupx-inline': [*ip(SVTCA_Y), IUPX, *inline],
    'ipy-iupy-inline': [*ip(SVTCA_Y), IUPY, *inline],
    'pre-untouched-inline': [*inline],
    'iupy-untouched-inline': [IUPY, *inline],
    'iupx-untouched-inline': [IUPX, *inline],
    'post-touched-helper': [*touch_y(), *iups, *helper],
    'post-untouched-helper': [*iups, *helper],
    'pre-touched-helper': [*touch_y(), *helper],
    'pre-untouched-helper': [*helper],
    'post-touched-helper-eq': [*touch_y(), *iups, *helper_eq],
    'post-touched-helper-iupy': [*touch_y(), IUPY, *helper],
    'post-touched-helper-iupx': [*touch_y(), IUPX, *helper],
    'call-first-of-three': [*ip(SVTCA_Y), *iups, SVTCA_Y, *push(1, 64, 0), CALL],
}
NAMES = list(KINDS)

def build(directory):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(NAMES))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        for x0 in (256, 768, 1280):
            pen.moveTo((x0, 0))
            pen.lineTo((x0, TOP))
            pen.lineTo((x0 + 128, TOP))
            pen.lineTo((x0 + 128, 0))
            pen.closePath()
        glyph = pen.glyph()
        prog = Program()
        prog.fromBytecode(KINDS[NAMES[i - 1]] if i else [])
        glyph.program = prog
        glyphs[name], metrics[name] = glyph, (1792, 256)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Shpix Order A'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    maxp = fb.font['maxp']
    maxp.maxZones, maxp.maxStorage, maxp.maxFunctionDefs, maxp.maxStackElements, maxp.maxSizeOfInstructions = 2, 4, 4, 64, 512
    cvt = newTable('cvt ')
    cvt.values = array('h', [1152])
    fb.font['cvt '] = cvt
    prep = newTable('prep')
    prep.program = Program()
    prep.program.fromBytecode([])
    fb.font['prep'] = prep
    fpgm = newTable('fpgm')
    fpgm.program = Program()
    # function 0: a lone SHPIX; 1 and 2: the generic per-size helpers
    fpgm.program.fromBytecode([*push(0), FDEF, SHPIX, ENDF, *push(1), FDEF, *HELPER_RANGE, ENDF, *push(2), FDEF, *HELPER_EQ, ENDF])
    fb.font['fpgm'] = fpgm
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = gasp
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / 'shpix-order-a.ttf')

if __name__ == '__main__':
    build(Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi')
    print(len(NAMES), 'kinds')
    for i, n in enumerate(NAMES):
        print(i, n)
