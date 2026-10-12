"""Build CC0 quadratic/concave diagnostic fonts differing only in family names.

No installed font outlines or instructions are used. Seed 2026101203 supplies
signed bounds, quadratic bowls with holes, rectangles and concave polygons.
Requires fontTools at capture time; the portable tests use the saved fonts.
"""
from pathlib import Path
import random
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable

dest = Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
for family, filename in [('Courier New', 'courier-geometry.ttf'),
                         ('Parity Courier', 'courier-geometry-renamed.ttf')]:
    rng = random.Random(2026101203)
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + [str(ord(c)) for c in 'HIDOPR08ay']
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({ord(c): str(ord(c)) for c in 'HIDOPR08ay'})
    glyphs, metrics = {}, {}
    for n, name in enumerate(order):
        pen = TTGlyphPen(None)
        x0, y0 = rng.randrange(30, 280), rng.randrange(-150, 180)
        width, height = rng.randrange(450, 1000), rng.randrange(900, 1500)
        if n % 3 == 0:
            for i, point in enumerate([(x0, y0), (x0, y0 + height),
                                       (x0 + width, y0 + height), (x0 + width, y0)]):
                (pen.moveTo if i == 0 else pen.lineTo)(point)
            pen.closePath()
        elif n % 3 == 1:
            pen.moveTo((x0, y0 + height // 2))
            pen.qCurveTo((x0, y0 + height), (x0 + width // 2, y0 + height))
            pen.qCurveTo((x0 + width, y0 + height), (x0 + width, y0 + height // 2))
            pen.qCurveTo((x0 + width, y0), (x0 + width // 2, y0))
            pen.qCurveTo((x0, y0), (x0, y0 + height // 2))
            pen.closePath()
            thick = rng.randrange(100, 230)
            pen.moveTo((x0 + thick, y0 + height // 2))
            pen.qCurveTo((x0 + thick, y0 + thick), (x0 + width // 2, y0 + thick))
            pen.qCurveTo((x0 + width - thick, y0 + thick), (x0 + width - thick, y0 + height // 2))
            pen.qCurveTo((x0 + width - thick, y0 + height - thick), (x0 + width // 2, y0 + height - thick))
            pen.qCurveTo((x0 + thick, y0 + height - thick), (x0 + thick, y0 + height // 2))
            pen.closePath()
        else:
            points = [(x0, y0), (x0 + width // 3, y0 + height),
                      (x0 + width // 2, y0 + height // 2), (x0 + width, y0 + height),
                      (x0 + width * 2 // 3, y0), (x0 + width // 2, y0 + height // 3)]
            for i, point in enumerate(points):
                (pen.moveTo if i == 0 else pen.lineTo)(point)
            pen.closePath()
        glyphs[name] = pen.glyph()
        metrics[name] = (1200, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1536, descent=-512)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'fullName': family,
                       'psName': family.replace(' ', ''), 'uniqueFontIdentifier': family + ' CC0 CurveDiagnostic',
                       'version': 'Version 1.0', 'licenseDescription': 'CC0 1.0 generated diagnostic outlines.'})
    fb.setupOS2(sTypoAscender=1536, sTypoDescender=-512, usWinAscent=1536,
               usWinDescent=512, usWeightClass=400)
    fb.setupPost()
    fb.setupMaxp()
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xffff: 15}
    fb.font['gasp'] = gasp
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(dest / filename)
