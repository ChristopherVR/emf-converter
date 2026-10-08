"""Generate a CC0 private font that isolates when native ClearType honours the distance of a MSIRP.

Every glyph is the same tall stem (points 0 bottom left, 1 top left, 2 top right, 3 bottom right). Its program moves
the top left point (in y, from the baseline point) or the top right point (in x, from the top left point) with MSIRP
to the outline distance plus a literal amount, at the default CVT cut-in (17/16 pixel) or at a cut-in the program sets
with SCVTCI. The stem grows by the amount when native honours the distance and keeps its shape when it falls back to the
outline distance. No installed font or native implementation is consulted.
"""
from array import array
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

PUSHB, PUSHW = 0xB0, 0xB8
SVTCA_Y, SVTCA_X, SRP0, MSIRP0, SCVTCI = 0x00, 0x01, 0x10, 0x3A, 0x1D
PPEM = 16
TOP = 1100          # top edge in font units: 8.59 px at 16 ppem
ORG_Y = 550         # outline distance of point 1 from point 0 at 16 ppem, in 26.6
ORG_X = 64          # outline distance of point 2 from point 1 at 16 ppem, in 26.6


def push(*values):
    assert all(0 <= v < 256 for v in values)
    return [PUSHB + len(values) - 1, *values]


def pushw(*values):
    out = [PUSHW + len(values) - 1]
    for v in values:
        out += [(v >> 8) & 255, v & 255]
    return out


def msirp_y(delta, cutin=None):
    code = []
    if cutin is not None:
        code += pushw(cutin) + [SCVTCI]
    return code + [SVTCA_Y, *push(0), SRP0, *push(1), *pushw(ORG_Y + delta), MSIRP0]


def msirp_x(delta, cutin=None):
    code = []
    if cutin is not None:
        code += pushw(cutin) + [SCVTCI]
    return code + [SVTCA_X, *push(1), SRP0, *push(2), *pushw(ORG_X + delta), MSIRP0]


KINDS = {'control': None}
for d in (0, 16, 32, 48, 64, 68, 72, 80, 96, 128, 192, 256):
    KINDS[f'y+{d}'] = msirp_y(d)
for d in (-16, -48, -128):
    KINDS[f'y{d}'] = msirp_y(d)
for d in (16, 64, 256):
    KINDS[f'y+{d} cutin0'] = msirp_y(d, 0)
for d in (128, 256, 512):
    KINDS[f'y+{d} cutin512'] = msirp_y(d, 512)
for d in (16, 32, 64, 128, 256):
    KINDS[f'x+{d}'] = msirp_x(d)
for d in (32, 128):
    KINDS[f'x+{d} cutin0'] = msirp_x(d, 0)
for d, c in ((16, 512), (32, 512), (64, 512), (64, 1024), (128, 1024), (256, 1024)):
    KINDS[f'x+{d} cutin{c}'] = msirp_x(d, c)
NAMES = list(KINDS)


def build(directory):
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
    family = 'Parity Msirp A'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    maxp = fb.font['maxp']
    maxp.maxZones, maxp.maxStorage, maxp.maxFunctionDefs, maxp.maxStackElements, maxp.maxSizeOfInstructions = 2, 4, 4, 64, 256
    cvt = newTable('cvt ')
    cvt.values = array('h', [1152])
    fb.font['cvt '] = cvt
    prep = newTable('prep')
    prep.program = Program()
    prep.program.fromBytecode([])
    fb.font['prep'] = prep
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = gasp
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / 'msirp-a.ttf')


if __name__ == '__main__':
    build(Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi')
    print(len(NAMES), 'kinds')
