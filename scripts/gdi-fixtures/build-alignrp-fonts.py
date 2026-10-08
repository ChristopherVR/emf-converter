"""Generate CC0 private fonts that isolate when native ClearType honours ALIGNRP around the IUPs.

Four table layouts: a has `prep` and `gasp`, b only `gasp`, c only `prep`, d neither.

Every glyph is the same tall stem (points 0 bottom left, 1 top left, 2 top right, 3 bottom right). Its program
optionally touches points in x or y, optionally runs IUP[x] and/or IUP[y], and then aligns the top left point to a
reference point with ALIGNRP (in y to the baseline point, in x to the top right point). The ink drops to a triangle when
the move is honoured and stays a rectangle when native ignores it. No installed font or native implementation is
consulted.
"""
from array import array
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

PUSHB, PUSHW = 0xB0, 0xB8
SVTCA_Y, SVTCA_X, SRP0, MDAP0, MDAP1, DELTAP1, SHPIX, MSIRP0, IUPY, IUPX, MIRP0, SCVTCI = 0x00, 0x01, 0x10, 0x2E, 0x2F, 0x5D, 0x38, 0x3A, 0x30, 0x31, 0xE0, 0x1D
SRP1, SRP2, IP = 0x11, 0x12, 0x39
PPEM = 16
# DELTAP1 argument for ppem 16 (delta base 9: high nibble 7) and +8 steps of 1/8 pixel (low nibble 15).
DELTA_ARG = ((PPEM - 9) << 4) | 15
TOP = 1100          # top edge in font units: 8.59 px at 16 ppem; a full pixel more crosses the centre of the next row up

def push(*values):
    assert all(0 <= v < 256 for v in values)
    return [PUSHB + len(values) - 1, *values]

def pushw(*values):
    out = [PUSHW + len(values) - 1]
    for v in values:
        out += [(v >> 8) & 255, v & 255]
    return out

def touch_y(*points):
    return [SVTCA_Y, *[x for p in points for x in (*push(p), MDAP0)]]

def touch_x(*points):
    return [SVTCA_X, *[x for p in points for x in (*push(p), MDAP0)]]

iups = [IUPX, IUPY]
ALIGNRP = 0x3C
# reference point 0 (baseline) for y, point 2 (top right) for x; the aligned point is 1 (top left)
align_y = [SVTCA_Y, *push(0), SRP0, *push(1), ALIGNRP]
align_x = [SVTCA_X, *push(2), SRP0, *push(1), ALIGNRP]
KINDS = {
    'control': None,
    'y-pre-untouched-ref': [*touch_y(1), *align_y],
    'y-pre-touched-ref': [*touch_y(1, 0), *align_y],
    'y-post-both': [*touch_y(1, 0), *iups, *align_y],
    'y-post-iupy': [*touch_y(1, 0), IUPY, *align_y],
    'y-post-iupx': [*touch_y(1, 0), IUPX, *align_y],
    'y-post-both-untouched-ref': [*touch_y(1), *iups, *align_y],
    'x-pre': [*touch_x(1, 2), *align_x],
    'x-post-both': [*touch_x(1, 2), *iups, *align_x],
    'x-post-iupx': [*touch_x(1, 2), IUPX, *align_x],
    'x-post-iupy': [*touch_x(1, 2), IUPY, *align_x],
    'x-post-both-untouched-ref': [*touch_x(1), *iups, *align_x],
    'xy-post-both': [*touch_y(1, 0), *iups, *align_x, *align_y],
    'y-post-both-point-untouched': [*touch_y(0), *iups, *align_y],
    'x-post-both-point-untouched': [*touch_x(2), *iups, *align_x],
}
NAMES = list(KINDS)

def build(directory, layout='a'):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(NAMES))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        for operation, point in ((pen.moveTo, (512, 0)), (pen.lineTo, (512, TOP)), (pen.lineTo, (640, TOP)), (pen.lineTo, (640, 0))):
            operation(point)
        pen.closePath()
        glyph = pen.glyph()
        prog = Program()
        code = KINDS[NAMES[i - 1]] if i else None
        prog.fromBytecode(code or [])
        glyph.program = prog
        glyphs[name], metrics[name] = glyph, (1024, 512)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Align ' + layout.upper()
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    maxp = fb.font['maxp']
    maxp.maxZones, maxp.maxStorage, maxp.maxFunctionDefs, maxp.maxStackElements, maxp.maxSizeOfInstructions = 2, 4, 4, 64, 256
    cvt = newTable('cvt ')
    cvt.values = array('h', [1152])          # 9 px at 16 ppem
    fb.font['cvt '] = cvt
    if layout in 'ac':
        prep = newTable('prep')
        prep.program = Program()
        prep.program.fromBytecode([])
        fb.font['prep'] = prep
    if layout in 'ab':
        gasp = newTable('gasp')
        gasp.version = 1
        gasp.gaspRange = {0xFFFF: 0x000F}
        fb.font['gasp'] = gasp
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('alignrp-' + layout + '.ttf'))

if __name__ == '__main__':
    for layout in 'abcd':
        build(Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi', layout)
