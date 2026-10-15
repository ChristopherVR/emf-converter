"""Build the private program-free font used by GdiClearTypeRasterProbe.cs (fontTools).

Rectangles and parallelograms on the 1/64-pixel lattice at 32 ppem (one font unit is one 26.6 unit), so nothing is
grid-fitted and every pixel of a native ClearType capture is the scan converter and the ClearType filter alone:
  set A: vertical bars [x0, x0 + W] x [0, 1024], x0 = 0..191, W in 40, 96, 200 (the horizontal profile)
  set B: horizontal bars [0, 640] x [y0, y0 + H], y0 = 0..63, H in 96, 40 (the vertical profile)
  set C: parallelograms whose left edge leans by s units over 1024 (slanted edges)
  set D: [x0, x0 + 200] x [y0, y0 + 96] with x0, y0 = 0..60 in steps of 4 (both edges fractional)
The font is a generated test input, CC0 1.0.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


def shapes():
    out = []
    for w in (40, 96, 200):
        for x0 in range(192):
            out.append([(x0, 0), (x0, 1024), (x0 + w, 1024), (x0 + w, 0)])
    for h in (96, 40):
        for y0 in range(64):
            out.append([(0, y0), (0, y0 + h), (640, y0 + h), (640, y0)])
    for s in (16, 32, 64, 128, 256):
        for x0 in range(0, 64, 3):
            out.append([(x0, 0), (x0 + s, 1024), (640, 1024), (640, 0)])
    # set D: [x0, x0 + 200] x [y0, y0 + 96] (both edges fractional), x0 and y0 in steps of 4
    for x0 in range(0, 64, 4):
        for y0 in range(0, 64, 4):
            out.append([(x0, y0), (x0, y0 + 96), (x0 + 200, y0 + 96), (x0 + 200, y0)])
    return out


def build(directory):
    sh = shapes()
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sh))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        pts = sh[i - 1] if i else [(0, 0), (0, 64), (64, 64), (64, 0)]
        # Clockwise is the TrueType outer direction.
        area = sum(pts[k][0] * pts[(k + 1) % len(pts)][1] - pts[(k + 1) % len(pts)][0] * pts[k][1] for k in range(len(pts)))
        if area > 0:
            pts = pts[::-1]
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
        glyphs[name] = pen.glyph()
        metrics[name] = (2048, min(p[0] for p in pts))
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity ClearType Geometry'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / 'cleartype-geometry.ttf')
    return len(sh)


if __name__ == '__main__':
    d = Path(__file__).resolve().parents[2] / 'src' / '__fixtures__' / 'gdi'
    print(build(d), 'glyphs')
