"""Build the CC0 private font of the GDI ClearType outer/inner contour stem experiment (fontTools).

Default-quality GDI ClearType keeps the black-and-white advance, and the width mode shifts the two edges of a stem that a
MIRP sets. Arial 12 and 13 px `a`, `e`, `o`, `s` are the stems that the converter does not reproduce: the stem pairs an outer
contour point with an inner contour point, and the glyph program first moves the outer point with an x SHPIX. This font holds
one glyph per case so that a capture at default and at natural quality isolates the pieces (see `GdiClearTypeWidthProbe.cs`,
mode `text-gdi-cleartype-width`, set `contour` in `ctk-sets.json`, `src/gdi-cleartype-contour.fixture.test.ts`).

Glyphs (16 ppem, 128 font units per pixel, no hdmx table, so the black-and-white advance is the rounded linear advance):
  ring   an outer box and an inner box (two contours); left edge outer point set by MIRP from pp1, the inner left edge by a
         black MIRP from it, the same on the right from pp2; IUP[x]
  bar    one box, the two stems being the sides of a single contour; left edge by MIRP from pp1, right edge by a black MIRP
         from the left edge (the same-contour control)
Each with an optional x SHPIX on the outer edge points before the MIRPs (amounts in 1/64 px, one for the left and one for the
right edge). Swept: advance 6 to 7 px in 1/16 steps, stem width 1, 1.1875 and 1.5 px, left edge 1 and 1.25 px.
The font is a generated test input, CC0 1.0.
"""
import json
import sys
from array import array
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

UPX = 128
ADVS = [6 + k / 16 for k in range(17)]
WIDTHS = [1.0, 1.1875, 1.5]
LEFTS = [1.0, 1.25]
RING_SHPIX = [(0, 0), (14, -16), (22, -16), (8, -8)]
BAR_SHPIX = [(0, 0), (14, -16)]
SVTCA_X, SRP0, SLOOP, SHPIX, ALIGNRP, IUPX = 0x01, 0x10, 0x17, 0x38, 0x3C, 0x31


def pushb(*v):
    return [0xB0 + len(v) - 1, *v]


def pushw(*v):
    out = [0xB8 + len(v) - 1]
    for x in v:
        out += [(x >> 8) & 0xFF, x & 0xFF]
    return out


def shpix(points, amount):
    # SLOOP count, then the points and the amount; SHPIX pops the amount first.
    return [*pushb(len(points)), SLOOP, *pushw(*points, amount), SHPIX] if amount else []


def ring_program(cvt_d, cvt_w, cvt_r, left_amt, right_amt, ring):
    # points: ring 0 (xl,0) 1 (xl,1000) 2 (xr,1000) 3 (xr,0), inner 4 (il,150) 5 (ir,150) 6 (ir,850) 7 (il,850); pp1 = 8, pp2 = 9
    p = [SVTCA_X]
    p += shpix([0, 1], left_amt)
    p += shpix([2, 3], right_amt)
    p += [*pushb(8), SRP0, *pushb(0, cvt_d), 0xF4, *pushb(1), ALIGNRP]
    if ring:
        p += [*pushb(4, cvt_w), 0xFD, *pushb(7), ALIGNRP]
    p += [*pushb(9), SRP0, *pushb(3, cvt_r), 0xF4, *pushb(2), ALIGNRP]
    if ring:
        p += [*pushb(5, cvt_w), 0xFD, *pushb(6), ALIGNRP]
    p += [IUPX]
    return p


def oval_program(cvt_d, cvt_w, cvt_r, left_amt, right_amt):
    # eight-point outer (0 left, 4 right) and inner (8 left, 12 right) polygons: only the four extremes are touched, the
    # rest is interpolated by IUP[x] (the structure of Arial's o); pp1 = 16, pp2 = 17
    p = [SVTCA_X]
    p += shpix([0], left_amt)
    p += shpix([4], right_amt)
    p += [*pushb(16), SRP0, *pushb(0, cvt_d), 0xF4]
    p += [*pushb(8, cvt_w), 0xFD]
    p += [*pushb(17), SRP0, *pushb(4, cvt_r), 0xF4]
    p += [*pushb(12, cvt_w), 0xFD]
    p += [IUPX]
    return p


def bar_program(cvt_d, cvt_w, left_amt, right_amt):
    # one box: 0 (xl,0) 1 (xl,1000) 2 (xr,1000) 3 (xr,0); the right edge is a black MIRP from the left edge
    p = [SVTCA_X]
    p += shpix([0, 1], left_amt)
    p += [*pushb(4), SRP0, *pushb(0, cvt_d), 0xF4, *pushb(1), ALIGNRP]
    p += [*pushb(3, cvt_w), 0xFD, *pushb(2), ALIGNRP]
    p += [IUPX]
    return p


def build(out_dir):
    cases = []
    for kind, amts in (('ring', RING_SHPIX), ('bar', BAR_SHPIX), ('oval', RING_SHPIX)):
        for amt in amts:
            for adv in ADVS:
                for w in WIDTHS:
                    for d in LEFTS:
                        cases.append({'kind': kind, 'amt': amt, 'adv': adv, 'w': w, 'd': d})
    # CVT: left offsets, stem widths, right offset (1 px), bar widths (2 x stem + gap handled by the outline)
    cvt_values = [round(d * UPX) for d in LEFTS] + [round(w * UPX) for w in WIDTHS] + [UPX] + [round(3 * UPX)]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(cases))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if not i:
            pts = [[(0, 0), (0, 64), (64, 64), (64, 0)]]
            adv, x0 = 5 * UPX, 0
            prog = b''
        else:
            c = cases[i - 1]
            adv = round(c['adv'] * UPX)
            xl = round(c['d'] * UPX)
            xr = adv - UPX
            w = round(c['w'] * UPX)
            if c['kind'] == 'ring':
                pts = [[(xl, 0), (xl, 1000), (xr, 1000), (xr, 0)], [(xl + w, 150), (xr - w, 150), (xr - w, 850), (xl + w, 850)]]
                prog = bytes(ring_program(LEFTS.index(c['d']), len(LEFTS) + WIDTHS.index(c['w']), len(LEFTS) + len(WIDTHS), c['amt'][0], c['amt'][1], True))
            elif c['kind'] == 'oval':
                def poly(x0, x1, y0, y1, ccw):
                    xm, ym = (x0 + x1) // 2, (y0 + y1) // 2
                    q = (x1 - x0) // 4
                    cw = [(x0, ym), (x0 + q, y1 - (y1 - y0) // 8), (xm, y1), (x1 - q, y1 - (y1 - y0) // 8), (x1, ym), (x1 - q, y0 + (y1 - y0) // 8), (xm, y0), (x0 + q, y0 + (y1 - y0) // 8)]
                    return [cw[0]] + cw[:0:-1] if ccw else cw
                pts = [poly(xl, xr, 0, 1000, False), poly(xl + w, xr - w, 150, 850, True)]
                prog = bytes(oval_program(LEFTS.index(c['d']), len(LEFTS) + WIDTHS.index(c['w']), len(LEFTS) + len(WIDTHS), c['amt'][0], c['amt'][1]))
            else:
                # a single stem: the box is as wide as the ring's left stem
                pts = [[(xl, 0), (xl, 1000), (xl + w, 1000), (xl + w, 0)]]
                prog = bytes(bar_program(LEFTS.index(c['d']), len(LEFTS) + WIDTHS.index(c['w']), c['amt'][0], c['amt'][1]))
            x0 = xl
        for contour in pts:
            for k, pt in enumerate(contour):
                (pen.moveTo if k == 0 else pen.lineTo)(pt)
            pen.closePath()
        g = pen.glyph()
        program = Program()
        program.fromBytecode(prog)
        g.program = program
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTK Contour'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 32
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 128
    cvt = newTable('cvt ')
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    out = Path(out_dir)
    fb.save(str(out / 'ctk-contour.ttf'))
    (out / 'ctk-sets.json').write_text(json.dumps([{'set': 'contour', 'file': 'ctk-contour.ttf', 'family': family, 'count': len(cases)}]))
    (out / 'ctk-cases.json').write_text(json.dumps(cases))
    return len(cases)


if __name__ == '__main__':
    print(build(sys.argv[1] if len(sys.argv) > 1 else '.'), 'glyphs')
