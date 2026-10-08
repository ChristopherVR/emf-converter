"""Build the private TrueType font used by RasterPolygonProbe.cs (fontTools).

Every glyph is a program-free polygon (triangles and convex quadrilaterals with
vertices on a 1/64-pixel lattice at 32 ppem, i.e. one font unit is one 26.6
unit), so nothing is grid-fitted and a mismatch between the native GDI+
grayscale bitmap and ours can only come from scan conversion. The vertices come
from a fixed-seed generator and are stored in the font itself, no sidecar.
The font is a generated test input, CC0 1.0.
"""
import math
import random
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

COUNT = 256


def polygons():
    rng = random.Random(20261008)
    out = []
    for i in range(COUNT):
        n = 3 if i % 2 == 0 else 4
        while True:
            pts = [(rng.randrange(0, 1280), rng.randrange(0, 1280)) for _ in range(n)]
            cx = sum(p[0] for p in pts) / n
            cy = sum(p[1] for p in pts) / n
            pts.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
            area = 0
            for k in range(n):
                x0, y0 = pts[k]
                x1, y1 = pts[(k + 1) % n]
                area += x0 * y1 - x1 * y0
            if abs(area) > 40000 and len(set(pts)) == n:
                # Clockwise (negative shoelace area) is the TrueType outer direction.
                out.append(pts if area < 0 else pts[::-1])
                break
    return out


def build(directory, scan_type=None):
    """The polygon font. With `scan_type` the font also carries a `prep` program that turns dropout control on
    at every size (SCANCTRL 0x1ff) and selects that SCANTYPE, the way stock fonts do."""
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['p%d' % i for i in range(COUNT)]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    shapes = polygons()
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        pts = shapes[i - 1] if i else [(0, 0), (0, 64), (64, 64), (64, 0)]
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
        glyphs[name] = pen.glyph()
        metrics[name] = (2048, min(p[0] for p in pts))
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Raster Polygons' + ('' if scan_type is None else ' ST%d' % scan_type)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular',
                       'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    if scan_type is not None:
        prep = newTable('prep')
        prep.program = Program()
        # PUSHW[0] 0x01ff, SCANCTRL; PUSHB[0] n, SCANTYPE
        prep.program.fromBytecode([0xB8, 0x01, 0xFF, 0x85, 0xB0, scan_type, 0x8D])
        fb.font['prep'] = prep
        fb.font['maxp'].maxStackElements = 8
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('raster-polygons.ttf' if scan_type is None else 'raster-polygons-st%d.ttf' % scan_type))


def bar_shapes():
    """Thin bars lying between two adjacent oversampling rows (or columns) that straddle a pixel boundary.

    At 32 ppem one font unit is a 26.6 unit and the 4x4 oversampling centres sit at 16 * k + 8 units, so rows 3
    and 4 (centres 56 and 72) are the last sample of one pixel and the first of the next. A bar whose edges lie
    in 56..72 contains no sample centre: the scan converter sees a pure dropout whose two crossings are known."""
    out = []
    for lo in range(56, 72):
        for hi in range(lo + 1, 73):
            out.append([(128, lo), (128, hi), (1024, hi), (1024, lo)])
    for lo in range(56, 72):
        for hi in range(lo + 1, 73):
            out.append([(lo, 128), (lo, 1024), (hi, 1024), (hi, 128)])
    return out


def build_bars(directory):
    shapes = bar_shapes()
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['b%d' % i for i in range(len(shapes))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        pts = shapes[i - 1] if i else [(0, 0), (0, 64), (64, 64), (64, 0)]
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
        glyphs[name] = pen.glyph()
        metrics[name] = (2048, min(p[0] for p in pts))
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Raster Bars'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular',
                       'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / 'raster-bars.ttf')


if __name__ == '__main__':
    destination = Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    build(destination)
    for scan_type in (0, 1, 4, 5):
        build(destination, scan_type)
    build_bars(destination)
