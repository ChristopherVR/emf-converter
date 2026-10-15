"""Build the CC0 private fonts of the GDI ClearType compatible-width experiments (fontTools).

GDI draws default-quality ClearType text with the black-and-white advance widths. These fonts hold bars, stems and an H
(one glyph each, a gasp table that sets every flag, 16 ppem = 128 font units per pixel) whose glyph programs place edges
with one known instruction, so that a capture of each glyph at default (compatible widths) and natural ClearType quality
shows exactly what the width mode does to the instruction (see `GdiClearTypeStemProbe.cs`, mode
`text-gdi-cleartype-width`, and `src/gdi-cleartype-width.fixture.test.ts`). Sets (font file `ctw-<set>.ttf`):
  phantom   a bar whose edges are ALIGNRP'd or MDRP'd onto the origin and advance phantom points (build-cleartype-phantom-font.py)
  types     stems placed by MIRP/MDAP/MDRP chains at fractional advances
  sweep     one MIRP stem swept in 1/128 px steps to read edge positions exactly
  kinds     which instruction sequences shift a stem
  corners   which of the four corners one instruction moves
  rects     two rectangular stems (chain and anchored)
  centre    the shift as a function of the stem's position
  h         a single-contour H with chained stems
  follow    points placed before the stem's MIRP by ALIGNRP, MDRP, MSIRP, MIAP, MIRP or MDAP
  pp2       a right edge placed by MIRP from the advance phantom point
  flags     every MIRP flag combination from the advance phantom point, plus MDRP, MSIRP and ALIGNRP
The fonts are generated test inputs, CC0 1.0.
"""
import importlib.util
import json
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

UPX = 128
SVTCA_X, MDAP0, ALIGNRP, PUSHB = 0x01, 0x2E, 0x3C, 0xB0
SRP0, MDRP0, MSIRP1, MIAP1, MDAP1b = 0x10, 0xC0, 0x3B, 0x3F, 0x2F
MDAP0_ = MDAP0


def push(*v):
    return [PUSHB + len(v) - 1, *v]



# Second font: stems placed by MIRP, at advances that are not whole pixels (the width mode only matters then).
#   type 0: left edge by MIRP from pp1 (CVT D), right edge by MIRP from the left edge (CVT W)  [the Monotype stem]
#   type 1: left edge by MIRP from pp1 only
#   type 2: right edge by MIRP from pp1 (CVT D + W), left edge untouched
#   type 3: left edge by MIRP from pp1, right edge by MDRP from the left edge (no CVT)
#   type 4: left edge by MDAP[round] (no CVT), right edge by MIRP from it
# The outline already holds both edges at their CVT distances, so no cut-in applies.
WS = [1.0, 1.5, 2.0]
DS2 = [1.0 + k / 8 for k in range(13)]
ADVS = [4.25, 4.5, 4.75]
TYPES = [0, 1, 2, 3, 4]
MDAP1, MDRP = 0x2F, 0xC0 | 0x04


def program2(t, dc, wc, dwc):
    if t == 0:
        return [SVTCA_X, *push(4), SRP0, *push(0, dc), 0xF4, *push(1), ALIGNRP, *push(3, wc), 0xFD, *push(2), ALIGNRP]
    if t == 1:
        return [SVTCA_X, *push(4), SRP0, *push(0, dc), 0xF4, *push(1), ALIGNRP]
    if t == 2:
        return [SVTCA_X, *push(4), SRP0, *push(3, dwc), 0xFD, *push(2), ALIGNRP]
    if t == 3:
        return [SVTCA_X, *push(4), SRP0, *push(0, dc), 0xF4, *push(1), ALIGNRP, *push(3), MDRP, *push(2), ALIGNRP]
    return [SVTCA_X, *push(0), MDAP1, *push(1), ALIGNRP, *push(3, wc), 0xFD, *push(2), ALIGNRP]


def build2(path):
    sp = [(t, a, w, d) for t in TYPES for a in range(len(ADVS)) for w in range(len(WS)) for d in range(len(DS2))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cvt_values = [round(d * UPX) for d in DS2] + [round(w * UPX) for w in WS] + [round((d + w) * UPX) for d in DS2 for w in WS]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            t, ai, wi, di = sp[i - 1]
            x0, x1 = round(DS2[di] * UPX), round((DS2[di] + WS[wi]) * UPX)
            adv = round(ADVS[ai] * UPX)
        else:
            t, di, wi, x0, x1, adv = 0, 0, 0, 0, 64, 5 * UPX
        for k, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if k == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        if i:
            prog.fromBytecode(bytes(program2(t, di, len(DS2) + wi, len(DS2) + len(WS) + di * len(WS) + wi)))
        else:
            prog.fromBytecode(b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Types'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Third font: the same stem (left edge by MIRP from pp1, right edge by MIRP from the left edge, width 1.5 px) at advances
# 4 to 5 px in steps of 1/16 and left edges D = 154..170 font units (1/128 px at 16 ppem) around a sample threshold, so the
# sample at which the left edge flips gives the position of the edge to 1/128 px.
ADV3 = [4 + k / 16 for k in range(17)]
D3 = list(range(120, 216))


def build3(path):
    sp = [(a, d) for a in range(len(ADV3)) for d in range(len(D3))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    w = round(1.5 * UPX)
    cvt_values = D3 + [w]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            ai, di = sp[i - 1]
            x0, x1 = D3[di], D3[di] + w
            adv = round(ADV3[ai] * UPX)
        else:
            x0, x1, adv, di = 0, 64, 5 * UPX, 0
        for k, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if k == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes([SVTCA_X, *push(4), SRP0, *push(0, di), 0xF4, *push(1), ALIGNRP, *push(3, len(D3)), 0xFD, *push(2), ALIGNRP]) if i else b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Sweep'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Fourth font: which instruction sequences make the compatible-width mode shift a stem by half the difference between
# the black-and-white and the natural advance. One stem (left edge D, width W) at advances 4.25, 4.5 and 4.75 px, 16 ppem.
MDAP0, MDAP1b, MSIRP1, MIAP1, MIAP0 = 0x2E, 0x2F, 0x3B, 0x3F, 0x3E
KINDS = ['mdap-only', 'mdap0-mirp', 'srp-mirp', 'mirp-rev', 'miap-only', 'miap-mirp', 'mirp-mdrp-pp', 'mdrp-mirp', 'mdap-msirp', 'mdap-mdrp', 'mirp-mirp-pp2', 'mirp2']
ADV4 = [4.25, 4.5, 4.75]
D4 = [1.0 + k / 8 for k in range(9)]
W4 = 1.5


def program4(kind, dc, wc, dwc):
    X = SVTCA_X
    if kind == 'mdap-only':
        return [X, *push(0), MDAP1b, *push(1), ALIGNRP]
    if kind == 'mdap0-mirp':
        return [X, *push(0), MDAP0, *push(3, wc), 0xFD, *push(2), ALIGNRP, *push(1), ALIGNRP]
    if kind == 'srp-mirp':
        return [X, *push(0), SRP0, *push(3, wc), 0xFD, *push(2), ALIGNRP]
    if kind == 'mirp-rev':
        return [X, *push(4), SRP0, *push(3, dwc), 0xF4, *push(2), ALIGNRP, *push(0, wc), 0xFD, *push(1), ALIGNRP]
    if kind == 'miap-only':
        return [X, *push(0, dc), MIAP1, *push(1), ALIGNRP]
    if kind == 'miap-mirp':
        return [X, *push(0, dc), MIAP1, *push(1), ALIGNRP, *push(3, wc), 0xFD, *push(2), ALIGNRP]
    if kind == 'mirp-mdrp-pp':
        return [X, *push(4), SRP0, *push(0, dc), 0xF4, *push(1), ALIGNRP, *push(5), SRP0, *push(3), MDRP, *push(2), ALIGNRP]
    if kind == 'mdrp-mirp':
        return [X, *push(4), SRP0, *push(0), 0xC0 | 0x14, *push(1), ALIGNRP, *push(3, wc), 0xFD, *push(2), ALIGNRP]
    if kind == 'mdap-msirp':
        return [X, *push(0), MDAP1b, *push(1), ALIGNRP, *push(3, 128 * 3 // 2 - 0), MSIRP1, *push(2), ALIGNRP]
    if kind == 'mdap-mdrp':
        return [X, *push(0), MDAP1b, *push(1), ALIGNRP, *push(3), MDRP, *push(2), ALIGNRP]
    if kind == 'mirp-mirp-pp2':
        return [X, *push(5), SRP0, *push(3, dwc), 0xFD, *push(2), ALIGNRP, *push(4), SRP0, *push(0, wc), 0xFD, *push(1), ALIGNRP]
    return [X, *push(4), SRP0, *push(0, dc), 0xF4, *push(1), ALIGNRP, *push(3, wc), 0xFD, *push(2), ALIGNRP]


def build4(path):
    sp = [(k, a, d) for k in range(len(KINDS)) for a in range(len(ADV4)) for d in range(len(D4))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cvt_values = [round(d * UPX) for d in D4] + [round(W4 * UPX)] + [round((d + W4) * UPX) for d in D4]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            k, ai, di = sp[i - 1]
            x0, x1 = round(D4[di] * UPX), round((D4[di] + W4) * UPX)
            adv = round(ADV4[ai] * UPX)
        else:
            k, di, x0, x1, adv = 0, 0, 0, 64, 5 * UPX
        for n, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if n == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes(program4(KINDS[k], di, len(D4), len(D4) + 1 + di)) if i else b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Kinds'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Fifth font: which of the four corners a single instruction moves in the compatible-width mode (every corner is readable
# from the top and bottom sample rows). Rectangle left edge D, width 1.5 px, advances 4.25 and 4.5 px at 16 ppem.
KINDS5 = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'mirp-a1', 'mirp-a0', 'mdrp', 'mdrp-round', 'msirp', 'mirp-from-pt1', 'mirp-rev', 'alignrp', 'miap-pt3', 'mdap-pt3', 'mirp-pt1-from-pt3', 'mdrp-pt1']
ADV5 = [4.25, 4.5]
D5 = [1.0 + k / 32 for k in range(8)]


def program5(kind, wc, dc):
    X = SVTCA_X
    if kind == 'B1':
        return [X, *push(4), SRP0, *push(0, dc), 0xF4, *push(3, wc), 0xFD, *push(0), SRP0, *push(1), ALIGNRP, *push(3), SRP0, *push(2), ALIGNRP]
    if kind == 'B2':
        return [X, *push(4), SRP0, *push(0, dc), 0xF4, *push(1), ALIGNRP, *push(3, wc), 0xFD, *push(2), ALIGNRP]
    if kind == 'B3':
        return [X, *push(4), SRP0, *push(0, dc), 0xF4, *push(3, wc), 0xFD]
    if kind == 'B4':
        return [X, *push(3, wc), 0xFD, *push(2), ALIGNRP]
    if kind == 'B5':
        return [X, *push(3, wc), 0xFD, *push(1), 0xC0]
    if kind == 'B6':
        return [X, *push(4), SRP0, *push(0, dc), 0xF4, *push(1), ALIGNRP]
    if kind == 'mirp-a1':
        return [X, *push(3, wc), 0xFD]
    if kind == 'mirp-a0':
        return [X, *push(3, wc), 0xED]
    if kind == 'mdrp':
        return [X, *push(3), 0xC0]
    if kind == 'mdrp-round':
        return [X, *push(3), 0xC4]
    if kind == 'msirp':
        return [X, *push(3, 96), MSIRP1]
    if kind == 'mirp-from-pt1':
        return [X, *push(1), SRP0, *push(2, wc), 0xFD]
    if kind == 'mirp-rev':
        return [X, *push(3), SRP0, *push(0, wc), 0xFD]
    if kind == 'alignrp':
        return [X, *push(3), ALIGNRP]
    if kind == 'miap-pt3':
        return [X, *push(3, dc), MIAP1]
    if kind == 'mdap-pt3':
        return [X, *push(3), MDAP1b]
    if kind == 'mirp-pt1-from-pt3':
        return [X, *push(3), SRP0, *push(1, wc), 0xFD]
    return [X, *push(1), 0xC0]


def build5(path):
    sp = [(k, a, d) for k in range(len(KINDS5)) for a in range(len(ADV5)) for d in range(len(D5))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cvt_values = [round(W4 * UPX)] + [round((D + W4) * UPX) for D in D5]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            k, ai, di = sp[i - 1]
            x0, x1 = round(D5[di] * UPX), round((D5[di] + W4) * UPX)
            adv = round(ADV5[ai] * UPX)
        else:
            k, di, x0, x1, adv = 0, 0, 0, 64, 5 * UPX
        for n, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if n == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes(program5(KINDS5[k], 0, 1 + di)) if i else b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Corners'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Sixth font: two stems (an H without the crossbar) to see how the width-mode shift accumulates over several MIRPs.
# Stem 1 [1.0, 2.25] and stem 2 [3.25, 4.5] px at 16 ppem, advances 5.0 to 6.0 px.
#   chain: stem 1 left from pp1, its right from its left, stem 2 left from stem 1 right, stem 2 right from its left
#   anchor: both stems' left edges from pp1 (cvt D1, D2), rights from their lefts
#   right-anchor: stem 2 from pp2 (right edge), stem 1 from pp1
KINDS6 = ['chain', 'anchor', 'right-anchor', 'chain-nogap']
ADV6 = [5.0 + k / 8 for k in range(9)]
CVT6 = [round(v * UPX) for v in (1.0, 1.25, 1.0, 1.25, 3.25, 5.0 - 4.5)]  # D1, W1, G, W2, D2, rsb2


def program6(kind):
    X = SVTCA_X
    D1, W1, G, W2, D2, R2 = range(6)
    st1 = [*push(8), SRP0, *push(0, D1), 0xF4, *push(1), ALIGNRP, *push(3, W1), 0xFD, *push(2), ALIGNRP]
    if kind == 'chain':
        return [X, *st1, *push(4, G), 0xFD, *push(5), ALIGNRP, *push(7, W2), 0xFD, *push(6), ALIGNRP]
    if kind == 'anchor':
        return [X, *st1, *push(8), SRP0, *push(4, D2), 0xF4, *push(5), ALIGNRP, *push(7, W2), 0xFD, *push(6), ALIGNRP]
    if kind == 'right-anchor':
        return [X, *st1, *push(9), SRP0, *push(7, R2), 0xFD, *push(6), ALIGNRP]
    return [X, *st1, *push(4, G), 0xFD, *push(5), ALIGNRP]


def build6(path):
    sp = [(k, a) for k in range(len(KINDS6)) for a in range(len(ADV6))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    stems = [(1.0, 2.25), (3.25, 4.5)]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        adv = round(ADV6[sp[i - 1][1]] * UPX) if i else 5 * UPX
        shapes = stems if i else [(0, 0.5)]
        for l, r in shapes:
            x0, x1 = round(l * UPX), round(r * UPX)
            for n, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
                (pen.moveTo if n == 0 else pen.lineTo)(pt)
            pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes(program6(KINDS6[sp[i - 1][0]])) if i else b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, round(shapes[0][0] * UPX))
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Rects'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 128
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', CVT6)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Seventh font: one stem [D, D + 1] px by the MIRP pair (left from pp1, right from the left), left edges D = 0.5 to 3.5 px in
# steps of 1/16, at the advances where the black-and-white width differs from the natural one by 1/4 px both ways. The shift
# of the stem against the natural-quality drawing as a function of D separates "half the difference" from "a scale".
ADV7 = [5.25, 5.5, 5.75, 6.5]
D7 = [0.5 + k / 16 for k in range(49)]


def build7(path):
    sp = [(a, d) for a in range(len(ADV7)) for d in range(len(D7))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cvt_values = [round(d * UPX) for d in D7] + [UPX]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            ai, di = sp[i - 1]
            x0, x1 = round(D7[di] * UPX), round((D7[di] + 1.0) * UPX)
            adv = round(ADV7[ai] * UPX)
        else:
            di, x0, x1, adv = 0, 0, 64, 5 * UPX
        for n, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if n == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes([SVTCA_X, *push(4), SRP0, *push(0, di), 0xF4, *push(1), ALIGNRP, *push(3, len(D7)), 0xFD, *push(2), ALIGNRP]) if i else b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Centre'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Eighth font: a single-contour H (stems [1.0, 2.25] and [3.25, 4.5] px, crossbar 0.4 to 0.6 of the height) hinted the way the
# Monotype fonts do it, to see whether the compatible-width shift belongs to a stem pair, a contour or the glyph.
H_PTS = [(1.0, 0), (1.0, 1000), (2.25, 1000), (2.25, 600), (3.25, 600), (3.25, 1000), (4.5, 1000), (4.5, 0), (3.25, 0), (3.25, 400), (2.25, 400), (2.25, 0)]
KINDS8 = ['chain', 'anchor', 'chain-noalign']
ADV8 = [5.0 + k / 8 for k in range(9)]
CVT8 = [round(v * UPX) for v in (1.0, 1.25, 1.0, 1.25, 3.25)]  # D1, W1, G, W2, D2


def program8(kind):
    X = SVTCA_X
    D1, W1, G, W2, D2 = range(5)
    pp1 = 12
    a1 = [*push(0, D1)] + [0xF4]
    if kind == 'chain-noalign':
        return [X, *push(pp1), SRP0, *push(0, D1), 0xF4, *push(11, W1), 0xFD, *push(8, G), 0xFD, *push(7, W2), 0xFD]
    s1 = [*push(pp1), SRP0, *push(0, D1), 0xF4, *push(1), ALIGNRP, *push(11, W1), 0xFD, *push(2), ALIGNRP, *push(3), ALIGNRP, *push(10), ALIGNRP]
    if kind == 'chain':
        return [X, *s1, *push(8, G), 0xFD, *push(4), ALIGNRP, *push(5), ALIGNRP, *push(9), ALIGNRP, *push(7, W2), 0xFD, *push(6), ALIGNRP]
    return [X, *s1, *push(pp1), SRP0, *push(8, D2), 0xF4, *push(4), ALIGNRP, *push(5), ALIGNRP, *push(9), ALIGNRP, *push(7, W2), 0xFD, *push(6), ALIGNRP]


def build8(path):
    sp = [(k, a) for k in range(len(KINDS8)) for a in range(len(ADV8))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        adv = round(ADV8[sp[i - 1][1]] * UPX) if i else 5 * UPX
        pts = [(round(x * UPX), y) for x, y in H_PTS] if i else [(0, 0), (0, 64), (64, 64), (64, 0)]
        pen.moveTo(pts[0])
        for pt in pts[1:]:
            pen.lineTo(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes(program8(KINDS8[sp[i - 1][0]])) if i else b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, pts[0][0])
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW H'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 128
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', CVT8)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Ninth font: does a point positioned before the stem pair's MIRP follow the pair's shift? MIRP pt0 from pp1, then pt1 by
# one instruction X relative to pt0, then MIRP pt3 from pt0 and ALIGNRP pt2. Advance 4.25 and 4.5 px, D = 1 to 1.75 px.
KINDS9 = ['none', 'alignrp', 'mdrp', 'mdrp-round', 'msirp0', 'miap', 'mirp', 'mdap']
ADV9 = [4.25, 4.5]
D9 = [1.0 + k / 8 for k in range(7)]


def program9(kind, dc, wc):
    X = SVTCA_X
    head = [X, *push(4), SRP0, *push(0, dc), 0xF4]
    tail = [*push(3, wc), 0xFD, *push(2), ALIGNRP]
    mid = {
        'none': [],
        'alignrp': [*push(1), ALIGNRP],
        'mdrp': [*push(1), 0xC0],
        'mdrp-round': [*push(1), 0xC4],
        'msirp0': [*push(1, 0), MSIRP1 - 1],
        'miap': [*push(1, dc), MIAP1],
        'mirp': [*push(1, 0), 0xE4],
        'mdap': [*push(1), MDAP1b],
    }[kind]
    return head + mid + tail


def build9(path):
    sp = [(k, a, d) for k in range(len(KINDS9)) for a in range(len(ADV9)) for d in range(len(D9))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cvt_values = [round(d * UPX) for d in D9] + [round(1.5 * UPX)]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            k, ai, di = sp[i - 1]
            x0, x1 = round(D9[di] * UPX), round((D9[di] + 1.5) * UPX)
            adv = round(ADV9[ai] * UPX)
        else:
            k, di, x0, x1, adv = 0, 0, 0, 64, 5 * UPX
        for n, pt in enumerate([(x0, 0), (x0 + 16, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if n == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes(program9(KINDS9[k], di, len(D9))) if i else b'')
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Follow'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 128
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Tenth font: the right edge of a bar placed by MIRP from the advance phantom point (pp2) with the CVT entry holding the
# outline distance (adv - x1), the way the Monotype fonts anchor right-hand stems. Advances 5 to 6 px in 1/16 steps and
# right edges x1 = 3.5 px + j/128 px; no pair, the left edge stays where the outline put it.
ADV10 = [5 + k / 16 for k in range(17)]
X10 = [448 + j for j in range(32)]


def build10(path):
    sp = [(a, j) for a in range(len(ADV10)) for j in range(len(X10))]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cvt_values = [round(ADV10[a] * UPX) - X10[j] for a in range(len(ADV10)) for j in range(len(X10))]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            ai, j = sp[i - 1]
            x0, x1 = UPX, X10[j]
            adv = round(ADV10[ai] * UPX)
        else:
            ai, j, x0, x1, adv = 0, 0, 0, 64, 5 * UPX
        for n, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if n == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        prog.fromBytecode(bytes([SVTCA_X, *push(5), SRP0, 0xB9, 0, 3, (i - 1) >> 8, (i - 1) & 255, 0xFD, *push(2), ALIGNRP]) if i else b"")
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW PP2'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



# Eleventh font: MIRP from the advance phantom point with every flag combination (a rp0, b minimum distance, c round, de
# distance type), the right edge x1 = 4 px, advances 5.25 and 5.5 px; plus MDRP and MSIRP from pp2 for comparison.
ADV11 = [5.25, 5.5, 5.75]
FLAGS11 = list(range(0xE0, 0x100))


def build11(path):
    sp = [(a, f) for a in range(len(ADV11)) for f in FLAGS11] + [(a, 0x100 + m) for a in range(len(ADV11)) for m in range(4)]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(sp))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    cvt_values = [round(ADV11[a] * UPX) - 4 * UPX for a in range(len(ADV11))]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            ai, f = sp[i - 1]
            x0, x1 = UPX, 4 * UPX
            adv = round(ADV11[ai] * UPX)
        else:
            ai, f, x0, x1, adv = 0, 0xE0, 0, 64, 5 * UPX
        for n, pt in enumerate([(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]):
            (pen.moveTo if n == 0 else pen.lineTo)(pt)
        pen.closePath()
        g = pen.glyph()
        prog = Program()
        if not i:
            body = b''
        elif f < 0x100:
            body = bytes([SVTCA_X, *push(5), SRP0, *push(3, ai), f, *push(2), ALIGNRP])
        else:
            m = f - 0x100
            if m == 0:
                body = bytes([SVTCA_X, *push(5), SRP0, *push(3), 0xC0, *push(2), ALIGNRP])
            elif m == 1:
                body = bytes([SVTCA_X, *push(5), SRP0, *push(3), 0xC4 | 0x10, *push(2), ALIGNRP])
            elif m == 2:
                body = bytes([SVTCA_X, *push(5), SRP0, *push(3, (round(ADV11[ai] * UPX) - 4 * UPX) * 64 // UPX * -1 & 255), MSIRP1 - 1, *push(2), ALIGNRP])
            else:
                body = bytes([SVTCA_X, *push(5), SRP0, *push(3), ALIGNRP, *push(2), ALIGNRP])
        prog.fromBytecode(body)
        g.program = prog
        glyphs[name] = g
        metrics[name] = (adv, x0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CTW Flags'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    t = newTable('gasp')
    t.version = 1
    t.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = t
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(sp)



def load_phantom():
    path = Path(__file__).resolve().parent / 'build-cleartype-phantom-font.py'
    spec = importlib.util.spec_from_file_location('ctw_phantom', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sets():
    phantom = load_phantom()
    return [
        ('phantom', phantom.build, 'Parity CT Phantom'),
        ('types', build2, 'Parity CTW Types'),
        ('sweep', build3, 'Parity CTW Sweep'),
        ('kinds', build4, 'Parity CTW Kinds'),
        ('corners', build5, 'Parity CTW Corners'),
        ('rects', build6, 'Parity CTW Rects'),
        ('centre', build7, 'Parity CTW Centre'),
        ('h', build8, 'Parity CTW H'),
        ('follow', build9, 'Parity CTW Follow'),
        ('pp2', build10, 'Parity CTW PP2'),
        ('flags', build11, 'Parity CTW Flags'),
    ]


if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src' / '__fixtures__' / 'gdi'
    manifest = []
    for name, build, family in sets():
        count = build(out / ('ctw-%s.ttf' % name))
        manifest.append({'set': name, 'file': 'ctw-%s.ttf' % name, 'family': family, 'count': count, 'sizes': [16], 'qualities': [5, 6]})
        print(name, count, 'glyphs')
    (out / 'ctw-sets.json').write_text(json.dumps(manifest, indent=1) + '\n')
