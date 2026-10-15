"""Build a program-free private TrueType font of random quadratic-curve shapes (fontTools; generated CC0 diagnostic
input) for measuring how GDI's scan converter flattens conic splines.

At 32 ppem and 2048 units per em one font unit is exactly one 26.6 unit, so the outline GDI scan converts is the
outline written here, with no hinting (no instructions) and no scaling rounding. Glyph i (character U+E000 + i) is a
filled oval of four quadratic arcs with random centre and radii.

  python build-curve-fonts.py [output-directory] [glyph-count] [seed] [oval|cap]
"""
import json
import random
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables.ttProgram import Program


def build(directory, count=1024, seed=11, kind='oval'):
    rng = random.Random(seed)
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(count)]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, lsbs, layout = {}, {}, []
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i == 0:
            pen.moveTo((100, 0)); pen.lineTo((100, 700)); pen.lineTo((600, 700)); pen.lineTo((600, 0)); pen.closePath()
            lsbs[name] = 100
        else:
            if kind == 'cap':
                # a box topped by one quadratic arc (random height of the control point): the cap's left and right crossings
                # with each scanline show where the scan converter puts the spline
                x0 = rng.randint(80, 300)
                width = rng.randint(500, 1500)
                x1 = x0 + width
                y0 = rng.randint(80, 250)
                top = rng.randint(y0 + 300, y0 + 600)
                bulge = rng.randint(150, 900)
                pen.moveTo((x0, y0))
                pen.lineTo((x1, y0))
                pen.lineTo((x1, top))
                pen.qCurveTo(((x0 + x1) // 2 + rng.randint(-width // 4, width // 4), top + bulge), (x0, top))
                pen.closePath()
                layout.append({'x0': x0, 'x1': x1, 'y0': y0, 'top': top})
                lsbs[name] = x0
            else:
                # a filled oval of four quadratic arcs (on-curve points at the extremes, off-curve at the corners of the box):
                # no sharp tip, so dropout control never decides a pixel and only the spline's scan conversion shows
                rx = rng.randint(250, 800)
                ry = rng.randint(250, 650)
                cx = rng.randint(rx + 60, 2000 - rx)
                cy = rng.randint(ry + 60, 1540 - ry)  # inside the 1600-unit ascent: GDI clips a bitmap above the ascent
                top, bottom, left, right = (cx, cy + ry), (cx, cy - ry), (cx - rx, cy), (cx + rx, cy)
                pen.moveTo(right)
                pen.qCurveTo((cx + rx, cy + ry), top)
                pen.qCurveTo((cx - rx, cy + ry), left)
                pen.qCurveTo((cx - rx, cy - ry), bottom)
                pen.qCurveTo((cx + rx, cy - ry), right)
                pen.closePath()
                layout.append({'cx': cx, 'cy': cy, 'rx': rx, 'ry': ry})
                lsbs[name] = cx - rx
        glyph = pen.glyph()
        program = Program()
        program.fromBytecode([])
        glyph.program = program
        glyphs[name] = glyph
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (2048, lsbs[name]) for name in order})
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Curves'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1',
                       'fullName': family, 'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxTwilightPoints = 0
    fb.font['maxp'].maxStorage = 0
    fb.font['maxp'].maxStackElements = 8
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / 'curves.ttf')
    (directory / 'curves.json').write_text(json.dumps(layout))


if __name__ == '__main__':
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    destination.mkdir(parents=True, exist_ok=True)
    build(destination, int(sys.argv[2]) if len(sys.argv) > 2 else 1024, int(sys.argv[3]) if len(sys.argv) > 3 else 11,
          sys.argv[4] if len(sys.argv) > 4 else 'oval')
