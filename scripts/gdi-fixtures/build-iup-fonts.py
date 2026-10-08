"""Generate a CC0 private font that isolates which point moves native ClearType honours around IUP.

Every glyph is the same tall stem. Its program touches the top point in y, optionally runs IUP[x] and/or
IUP[y], then moves the top point up by a pixel with DELTAP, SHPIX or MSIRP. A row of ink appears or not at
the top of the stem, so the capture tells which moves count. No
installed font or native implementation is consulted.
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

touch = push(1) + [MDAP0]                     # touch the top point (1) in y without moving it
iups = [IUPX, IUPY]
deltap = push(DELTA_ARG, 1, 1) + [DELTAP1]
KINDS = {
    'control': None,
    'pre-deltap-touched': [SVTCA_Y, *touch, *deltap],
    'pre-deltap-untouched': [SVTCA_Y, *deltap],
    'post-both-deltap': [SVTCA_Y, *touch, *iups, *deltap],
    'post-iupy-deltap': [SVTCA_Y, *touch, IUPY, *deltap],
    'post-iupx-deltap': [SVTCA_Y, *touch, IUPX, *deltap],
    'post-both-deltap-untouched': [SVTCA_Y, *iups, *deltap],
    'pre-shpix': [SVTCA_Y, *touch, *push(1, 64), SHPIX],
    'post-both-shpix': [SVTCA_Y, *touch, *iups, *push(1, 64), SHPIX],
    'pre-msirp': [SVTCA_Y, *touch, *push(0), SRP0, *push(1), *pushw(614), MSIRP0],
    'post-both-msirp': [SVTCA_Y, *touch, *iups, *push(0), SRP0, *push(1), *pushw(614), MSIRP0],
    # the point was moved before the IUPs: by SHPIX, by interpolation (IP), by rounding (MDAP[1])
    'post-both-deltap-moved': [SVTCA_Y, *touch, *push(1, 16), SHPIX, *iups, *deltap],
    'post-both-deltap-ip': [SVTCA_Y, *push(0), SRP1, *push(3), SRP2, *push(1), IP, *iups, *deltap],
    'post-both-deltap-rounded': [SVTCA_Y, *push(1), MDAP1, *iups, *deltap],
    'post-iupy-only-deltap-ip': [SVTCA_Y, *push(0), SRP1, *push(3), SRP2, *push(1), IP, IUPY, *deltap],
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
    family = 'Parity Iup A'
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
    prep = newTable('prep')
    prep.program = Program()
    prep.program.fromBytecode([])
    fb.font['prep'] = prep
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = gasp
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / 'iup-a.ttf')

if __name__ == '__main__':
    build(Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi')
