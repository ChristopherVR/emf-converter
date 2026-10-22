"""Build the CC0 private font of the GDI ClearType zigzag-chain experiment (fontTools).

Round 10 (R10-A) asks which MIRP pairs of a chain the compatible-width mode treats as stems. Arial's W, V and X place the
vertices of their diagonal arms with a chain of MIRPs along x (top-left corner, first crotch, inverted crotch, second crotch,
top-right corner, each from the one before with `set rp0`), and native shifts only some of the pairs of such a chain (see
`src/gdi-cleartype-chain.fixture.test.ts`). The glyphs here are zigzag ribbons of N arms (V: 2 arms, W: 4 arms) of horizontal
thickness `w` and vertex pitch `p`, drawn at 32 ppem (64 font units per pixel), whose program is only that chain: MIRP of the
first corner from the origin phantom point, MIRP of each next vertex from the one before, optionally a MIRP from the last
vertex to the advance phantom point, and IUP[x] / IUP[y]. The advances are not whole pixels, so the black-and-white
width differs from the natural one and the width mode has something to do. Captured at default quality (compatible widths) and
natural ClearType quality by `GdiClearTypeWidthProbe.cs` (mode `text-gdi-cleartype-chain`).
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

UPX = 64
PUSHB, PUSHW, SVTCA_X, SRP0, IUP_Y, IUP_X = 0xB0, 0xB8, 0x01, 0x10, 0x30, 0x31
H = 23.0

ARMS = [2, 4]
PITCH = [7.0, 8.5]
WIDTH = [2.5, 3.5]
ADV_FRAC = [0.3, 0.5, 0.7]
FLAGS = [0xFD, 0xF4, 0xF1]
PP2 = [0, 1]
CVT_MODE = [0, 1]
IUP = [1]
LSB = [0.0, 3.0]


def push(*v):
    if max(v) > 255:
        out = [PUSHW + len(v) - 1]
        for x in v:
            out += [(x >> 8) & 0xFF, x & 0xFF]
        return out
    return [PUSHB + len(v) - 1, *v]


def ribbon(arms, p, w, lsb):
    """Zigzag ribbon outline (clockwise) and the point numbers of the left-to-right chain of vertices."""
    h = H
    c = w * h / (2 * p)
    v = lambda i: i * p
    if arms == 2:
        pts = [(v(0), h), (v(0) + w, h), (v(1) + w / 2, c), (v(2), h), (v(2) + w, h), (v(1) + w, 0), (v(1), 0)]
        chain = [0, 2, 4]
    else:
        pts = [(v(0), h), (v(0) + w, h), (v(1) + w / 2, c), (v(2), h), (v(2) + w, h), (v(3) + w / 2, c), (v(4), h), (v(4) + w, h),
               (v(3) + w, 0), (v(3), 0), (v(2) + w / 2, h - c), (v(1) + w, 0), (v(1), 0)]
        chain = [0, 2, 10, 5, 7]
    return [(round((x + lsb) * UPX), round(y * UPX)) for x, y in pts], chain


def program(chain, n, flags, pp2, cvt_base, iup):
    code = [SVTCA_X, *push(n), SRP0]
    code += push(chain[0], cvt_base) + [0xF4]
    for k, point in enumerate(chain[1:]):
        code += push(point, cvt_base + 1 + k) + [flags]
    if pp2:
        code += push(n + 1, cvt_base + len(chain)) + [0xE6]
    if iup:
        code += [IUP_X, IUP_Y]
    return code


def glyphs(ARMS=ARMS, PITCH=PITCH, WIDTH=WIDTH, ADV_FRAC=ADV_FRAC, FLAGS=FLAGS, PP2=PP2, CVT_MODE=CVT_MODE, IUP=IUP, LSB=LSB):
    out = []
    for arms in ARMS:
        for p in PITCH:
            for w in WIDTH:
                for a in ADV_FRAC:
                    for flags in FLAGS:
                        for pp2 in PP2:
                            for cm in CVT_MODE:
                                for iup in IUP:
                                    for lsb in LSB:
                                        pts, chain = ribbon(arms, p, w, lsb)
                                        adv = round((-(-(arms * p + w + lsb) // 1) + 1 + a) * UPX)
                                        out.append((pts, adv, chain, flags, pp2, cm, iup, (arms, p, w, a, flags, pp2, cm, iup, lsb)))
    return out


def build(path, family, items):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(items))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    table, metrics = {}, {}
    cvt_values = []
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            pts, adv, chain, flags, pp2, cm, iup, _ = items[i - 1]
        else:
            pts, adv, chain, flags, pp2, cm, iup = [(0, 0), (0, 64), (64, 64), (64, 0)], 5 * UPX, None, 0, 0, 0, 0
        for k, pt in enumerate(pts):
            (pen.moveTo if k == 0 else pen.lineTo)(pt)
        pen.closePath()
        glyph = pen.glyph()
        program_ = Program()
        if chain is not None:
            base = len(cvt_values)
            xs = [pts[j][0] for j in chain]
            dists = [xs[0]] + [xs[k + 1] - xs[k] for k in range(len(xs) - 1)]
            if pp2:
                dists.append(adv - xs[-1])
            for d in dists:
                cvt_values.append(round(d / UPX) * UPX if cm else d)
            program_.fromBytecode(bytes(program(chain, len(pts), flags, pp2, base, iup)))
        else:
            program_.fromBytecode(b'')
        glyph.program = program_
        table[name] = glyph
        metrics[name] = (adv, min(p[0] for p in pts))
    fb.setupGlyf(table)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 128
    cvt = newTable('cvt ')
    cvt.values = array('h', cvt_values)
    fb.font['cvt '] = cvt
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = gasp
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(path)
    return len(items)


if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src' / '__fixtures__' / 'gdi'
    items = glyphs()
    count = build(out / 'ctc-chain.ttf', 'Parity CTC Chain', items)
    sets = [{'set': 'chain', 'file': 'ctc-chain.ttf', 'family': 'Parity CTC Chain', 'count': count, 'sizes': [32], 'qualities': [5, 6],
             'meta': {'arms': ARMS, 'pitch': PITCH, 'width': WIDTH, 'advFrac': ADV_FRAC, 'flags': FLAGS, 'pp2': PP2, 'cvtMode': CVT_MODE, 'iup': IUP, 'lsb': LSB},
             'params': [g[7] for g in items]}]
    (out / 'ctc-sets.json').write_text(json.dumps(sets) + '\n')
    print('chain', count, 'glyphs')
