"""Build the CC0 private font that shows where native GDI puts the phantom points under ClearType (fontTools).

Every glyph is one bar (left edge `l`, 1.5 px wide, advance `a`) at 16 ppem (128 font units per pixel), with a gasp table
that sets every flag. The variant decides which edges the glyph program moves onto a phantom point with ALIGNRP:
  0  no program (control)
  1  left edge onto the origin phantom point (pp1), right edge onto the advance phantom point (pp2)
  2  left edge onto pp1, right edge untouched
  3  right edge onto pp2, left edge untouched
  4  left edge onto pp2, right edge untouched
  5  left edge placed by MDRP[no round] from pp1 (keeps the original distance), right edge untouched
  6  right edge placed by MDRP[no round] from pp2, left edge untouched
No IUP is run. The drawn bar then shows the position the interpreter holds for each phantom point (after whatever
rounding and translation the rasterizer applies) in the chosen width mode.
"""
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

UPX = 128
ADV = [3.0 + k / 8 for k in range(17)]
LEFT = [0.5, 1.0, 1.5]
WIDTH = 1.5
VARIANTS = [0, 1, 2, 3, 4, 5, 6]
SVTCA_X, MDAP0, ALIGNRP, PUSHB, SRP0, MDRP0 = 0x01, 0x2E, 0x3C, 0xB0, 0x10, 0xC0


def push(*v):
    return [PUSHB + len(v) - 1, *v]


def align(rp, points):
    body = [*push(rp), MDAP0]
    for p in points:
        body += [*push(p), ALIGNRP]
    return body


def mdrp(rp, points):
    body = [*push(rp), SRP0]
    for p in points:
        body += [*push(p), MDRP0]
    return body


def program(variant):
    if variant == 0:
        return []
    body = [SVTCA_X]
    if variant in (1, 2):
        body += align(4, [0, 1])
    if variant in (1, 3):
        body += align(5, [2, 3])
    if variant == 4:
        body += align(5, [0, 1])
    if variant == 5:
        body += mdrp(4, [0, 1])
    if variant == 6:
        body += mdrp(5, [2, 3])
    return body


def specs():
    return [(v, l, a) for v in VARIANTS for l in LEFT for a in ADV]


def build(path):
    sp = specs()
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            v, l, a = sp[i - 1]
            x0, x1, adv = round(l * UPX), round((l + WIDTH) * UPX), round(a * UPX)
        else:
            v, x0, x1, adv = 0, 0, 64, 2 * UPX
        for k, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if k == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes(program(v)))
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CT Phantom'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)


if __name__ == '__main__':
    d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src' / '__fixtures__' / 'gdi'
    print(build(d / 'ct-phantom.ttf'), 'glyphs')
