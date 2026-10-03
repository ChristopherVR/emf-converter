"""Generate CC0 private fonts isolating public GDI vector setup and movement.

Explicit short and near-unit vectors expose SPVFS/SFVFS via GPV/GFV. Moving
reference point zero before SDPVTL separates current and original projection
vectors; unequal freedom vectors exercise MDRP/MIRP/SCFS. All four quadrants
are represented; no installed font or native implementation is consulted.
"""
from array import array
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

KINDS = ('pv', 'fv', 'dual', 'mdoriginal', 'mdrp', 'mirp', 'scfs')
CASES = [(sx, sy, x, y) for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1))
         for x, y in ((142, -475), (-142, -475), (251, 317), (-251, 317))]

def words(*values):
    return [0xB8 + len(values) - 1] + [b for v in values for b in ((v >> 8) & 255, v & 255)]

def instructions(kind, sx, sy, x, y):
    code = [0x01] + words(0, 3) + [0x48, 0x00] + words(0, 7) + [0x48]
    if kind in ('pv', 'fv'):
        code += words(sx * x, sy * y) + [0x0A if kind == 'pv' else 0x0B]
        code += [0x0C if kind == 'pv' else 0x0D] + words(0) + [0x23, 0x42]
        code += words(1) + [0x23, 0x42, 0x01] + words(2, 1) + [0x43, 0x48]
        code += words(3, 0) + [0x43, 0x48]
        return code
    code += words(0, 1) + [0x86]  # Current p0-p1 differs from original p0-p1.
    code += words(-sx * 4909, -sy * 15631) + [0x0B]
    if kind in ('dual', 'mdoriginal'):
        code += (words(2) + [0x47] if kind == 'dual' else words(2, 0) + [0x4A])
        code += words(0) + [0x23, 0x42, 0x01] + words(3, 0) + [0x43, 0x48]
    elif kind == 'mdrp':
        code += words(2) + [0xC0]
    elif kind == 'mirp':
        code += words(2, 0) + [0xE0]
    else:
        code += words(2, 52) + [0x48]
    return code
def build(kind, directory):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(CASES))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cases = ([(sx, sy, x, y) for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1))
              for x, y in ((17, 31), (137, 193), (4909, 15631), (15513, 5270))]
             if kind in ("pv", "fv") else CASES)
    for i, name in enumerate(order):
        sx, sy, x, y = cases[max(0, i - 1)]
        px, py = (142, -475) if kind in ("pv", "fv") else (x, y)
        pen = TTGlyphPen(None)
        for operation, point in ((pen.moveTo, (0, 0)), (pen.lineTo, (sx * 320, sy * 100)),
                                 (pen.lineTo, (px, py)), (pen.lineTo, (700, 320))):
            operation(point)
        pen.closePath()
        glyph = pen.glyph()
        program = Program()
        program.fromBytecode(instructions(kind, sx, sy, x, y) if i else [])
        glyph.program = program
        glyphs[name], metrics[name] = glyph, (2048, min(0, sx * 320, px))
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Vector Stage ' + kind.capitalize()
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular',
                       'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxStorage = 2
    fb.font['maxp'].maxStackElements = 16
    cvt = newTable('cvt ')
    cvt.values = array('h', [52])
    fb.font['cvt '] = cvt
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('vector-stage-' + kind + '.ttf'))

if __name__ == '__main__':
    destination = Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    for name in KINDS:
        build(name, destination)
