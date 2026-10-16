"""Build the CC0 private fonts of the GDI ClearType diagonal-stem experiments (fontTools).

Round 9 (W1) follows `build-cleartype-width-fonts.py`: it asks what the compatible-width mode does when a glyph program
continues past the stem, the way the diagonal letters of Arial, Tahoma and Segoe UI (V W X x A) do. Every font has a gasp
table that sets every flag and is captured at 16 ppem (128 font units per pixel) at default (compatible widths) and at
natural ClearType quality; the two qualities differ only in the width mode (see `GdiClearTypeWidthProbe.cs`, mode
`text-gdi-cleartype-arm`, `src/gdi-cleartype-arm.fixture.test.ts`). Sets (font file `cta-<set>.ttf`):
  arm      a slanted arm (points 0 bottom-left, 1 top-left, 2 top-right, 3 bottom-right). The top edge is a stem set by MIRP
           (point 1 from the origin phantom point, point 2 from point 1); `kind` then places the bottom-left point 0 or runs
           another instruction, with the projection vector set by SVTCA, SPVTL, SDPVTL or SPVFS and the freedom vector x
           or the projection vector.
  height   the same arm with a fifth point on the left edge at a fraction of the height (drawn between points 0 and 2, so
           the program numbers are 0 bottom-left, 1 follower, 2 top-left, 3 top-right, 4 bottom-right); the follower is
           placed by MDRP from the stem point with the projection vector perpendicular to the arm.
  postiup  a bar whose edges are placed by MIRP (as in `types`), with IUP[x] / IUP[y] run before, between or after the pair.
The fonts are generated test inputs, CC0 1.0.
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
PUSHB, SVTCA_X, SRP0, ALIGNRP, MDRP_NR = 0xB0, 0x01, 0x10, 0x3C, 0xC0
SDPVTL_PERP, SDPVTL_PAR, SPVTL_PERP, SPVTL_PAR, SFVTCA_X, SFVTPV, SFVTL = 0x87, 0x86, 0x07, 0x06, 0x05, 0x0E, 0x08
SRP1, SRP2, IP, SHP_RP1, MSIRP0, IUP_Y, IUP_X = 0x11, 0x12, 0x39, 0x33, 0x3A, 0x30, 0x31
PUSHW2 = 0xB9
W = 1.5
Y = 768


def push(*v):
    return [PUSHB + len(v) - 1, *v]


def stem_head(first, second, pp1, cvt_d, cvt_w):
    """MIRP `first` from pp1 (CVT cvt_d, sets rp0) then `second` from it (CVT cvt_w), then rp0 back to `first`."""
    return [SVTCA_X, *push(pp1), SRP0, *push(first, cvt_d), 0xF4, *push(second, cvt_w), 0xFD, *push(first), SRP0]


# --- set arm -----------------------------------------------------------------------------------------------------
ARM_KINDS = [
    'none',            # nothing moves the bottom-left point
    'axis',            # MDRP of point 0 from point 1, projection vector x (SVTCA)
    'sdpvtl-perp',     # SDPVTL[perpendicular] on the left edge, freedom vector x, MDRP of point 0
    'sdpvtl-perp-pv',  # the same with the freedom vector set to the projection vector
    'sdpvtl-par',      # SDPVTL[parallel] on the left edge, freedom vector x
    'spvtl-perp',      # SPVTL[perpendicular] on the left edge, freedom vector x
    'spvtl-par',       # SPVTL[parallel]
    'spvfs-x',         # SPVFS to the exact x axis
    'sdpvtl-svtca',    # SDPVTL then SVTCA x (axis again)
    'alignrp-perp',    # ALIGNRP under SDPVTL[perpendicular] with the freedom vector set to the projection vector
    'edge-perp',       # SDPVTL on the left edge, MDRP of point 0 from the top-right stem point
    'shp',             # SHP[rp1 = point 1] of point 0
    'ip',              # IP of point 0 between points 1 and 2
    'msirp',           # MSIRP of point 0 from point 1 by distance 0
]
ARM_SLOPES = [0.0, 0.2, 0.4, 0.7]
ARM_SIGNS = [1, -1]
ARM_DC = [5.0]
ARM_ADV = [12.25, 12.75]


def arm_program(kind, dci):
    head = stem_head(1, 2, 4, dci, len(ARM_DC))
    tail = {
        'none': [],
        'axis': [*push(0), MDRP_NR],
        'sdpvtl-perp': [*push(1, 0), SDPVTL_PERP, SFVTCA_X, *push(0), MDRP_NR],
        'sdpvtl-perp-pv': [*push(1, 0), SDPVTL_PERP, SFVTPV, *push(0), MDRP_NR],
        'sdpvtl-par': [*push(1, 0), SDPVTL_PAR, SFVTCA_X, *push(0), MDRP_NR],
        'spvtl-perp': [*push(1, 0), SPVTL_PERP, SFVTCA_X, *push(0), MDRP_NR],
        'spvtl-par': [*push(1, 0), SPVTL_PAR, SFVTCA_X, *push(0), MDRP_NR],
        'spvfs-x': [PUSHW2, 0x40, 0x00, 0x00, 0x00, 0x0A, SFVTCA_X, *push(0), MDRP_NR],
        'sdpvtl-svtca': [*push(1, 0), SDPVTL_PERP, SVTCA_X, *push(0), MDRP_NR],
        'alignrp-perp': [*push(1, 0), SDPVTL_PERP, SFVTPV, *push(0), ALIGNRP],
        'edge-perp': [*push(2), SRP0, *push(1, 0), SDPVTL_PERP, SFVTCA_X, *push(0), MDRP_NR],
        'shp': [*push(1), SRP1, *push(0), SHP_RP1],
        'ip': [*push(1), SRP1, *push(2), SRP2, *push(0), IP],
        'msirp': [*push(0, 0), MSIRP0],
    }[kind]
    return head + tail


def arm_glyphs():
    out = []
    for k in range(len(ARM_KINDS)):
        for s in range(len(ARM_SLOPES)):
            for g in range(len(ARM_SIGNS)):
                for d in range(len(ARM_DC)):
                    for a in range(len(ARM_ADV)):
                        xt = round(ARM_DC[d] * UPX)
                        xt1 = xt + round(W * UPX)
                        off = round(ARM_SLOPES[s] * ARM_SIGNS[g] * Y)
                        pts = [(xt + off, 0), (xt, Y), (xt1, Y), (xt1 + off, 0)]
                        out.append((pts, round(ARM_ADV[a] * UPX), arm_program(ARM_KINDS[k], d), (k, s, g, d, a)))
    return out


# --- set height --------------------------------------------------------------------------------------------------
HEIGHT_KINDS = ['none', 'axis', 'perp-x', 'perp-pv']
HEIGHTS = [0, 0.125, 0.25, 0.5, 0.75, 0.9]
HEIGHT_SLOPES = [0.2, 0.4]
HEIGHT_DC = [5.0, 6.0]
HEIGHT_ADV = [12.25, 12.5, 12.75]


def height_program(kind, dci):
    head = stem_head(2, 3, 5, dci, len(HEIGHT_DC))
    tail = {
        'none': [],
        'axis': [*push(1), MDRP_NR],
        'perp-x': [*push(2, 0), SDPVTL_PERP, SFVTCA_X, *push(1), MDRP_NR],
        'perp-pv': [*push(2, 0), SDPVTL_PERP, SFVTPV, *push(1), MDRP_NR],
    }[kind]
    return head + tail


def height_glyphs():
    out = []
    for k in range(len(HEIGHT_KINDS)):
        for h in range(len(HEIGHTS)):
            for s in range(len(HEIGHT_SLOPES)):
                for d in range(len(HEIGHT_DC)):
                    for a in range(len(HEIGHT_ADV)):
                        xt = round(HEIGHT_DC[d] * UPX)
                        xt1 = xt + round(W * UPX)
                        off = round(HEIGHT_SLOPES[s] * Y)
                        fy = round(HEIGHTS[h] * Y)
                        fx = round(xt + off * (1 - HEIGHTS[h]))
                        pts = [(xt + off, 0), (fx, fy), (xt, Y), (xt1, Y), (xt1 + off, 0)]
                        out.append((pts, round(HEIGHT_ADV[a] * UPX), height_program(HEIGHT_KINDS[k], d), (k, h, s, d, a)))
    return out


# --- set postiup -------------------------------------------------------------------------------------------------
POST_KINDS = ['none', 'iupy', 'iupx', 'iupxy', 'iupyx', 'after', 'x-pair-y']
POST_D = [1.0 + k / 4 for k in range(9)]
POST_ADV = [4.25, 4.5, 4.75]


def post_program(kind, dci):
    pair = stem_head(0, 3, 4, dci, len(POST_D))
    return {
        'none': pair,
        'iupy': [IUP_Y, *pair],
        'iupx': [IUP_X, *pair],
        'iupxy': [IUP_X, IUP_Y, *pair],
        'iupyx': [IUP_Y, IUP_X, *pair],
        'after': [*pair, IUP_X, IUP_Y],
        'x-pair-y': [IUP_X, *pair, IUP_Y],
    }[kind]


def post_glyphs():
    out = []
    for k in range(len(POST_KINDS)):
        for d in range(len(POST_D)):
            for a in range(len(POST_ADV)):
                x0 = round(POST_D[d] * UPX)
                x1 = x0 + round(W * UPX)
                pts = [(x0, 0), (x0, 1000), (x1, 1000), (x1, 0)]
                out.append((pts, round(POST_ADV[a] * UPX), post_program(POST_KINDS[k], d), (k, d, a)))
    return out


def build(path, family, glyphs, cvt_values):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(glyphs))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    table, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        if i:
            pts, adv, code, _ = glyphs[i - 1]
        else:
            pts, adv, code = [(0, 0), (0, 64), (64, 64), (64, 0)], 5 * UPX, b''
        for n, pt in enumerate(pts):
            (pen.moveTo if n == 0 else pen.lineTo)(pt)
        pen.closePath()
        glyph = pen.glyph()
        program = Program()
        program.fromBytecode(bytes(code))
        glyph.program = program
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
    return len(glyphs)


def sets():
    return [
        ('arm', 'Parity CTA Arm', arm_glyphs(), [round(d * UPX) for d in ARM_DC] + [round(W * UPX)],
         {'kinds': ARM_KINDS, 'slopes': ARM_SLOPES, 'signs': ARM_SIGNS, 'dc': ARM_DC, 'adv': ARM_ADV}),
        ('height', 'Parity CTA Height', height_glyphs(), [round(d * UPX) for d in HEIGHT_DC] + [round(W * UPX)],
         {'kinds': HEIGHT_KINDS, 'heights': HEIGHTS, 'slopes': HEIGHT_SLOPES, 'dc': HEIGHT_DC, 'adv': HEIGHT_ADV}),
        ('postiup', 'Parity CTA PostIup', post_glyphs(), [round(d * UPX) for d in POST_D] + [round(W * UPX)],
         {'kinds': POST_KINDS, 'd': POST_D, 'adv': POST_ADV}),
    ]


if __name__ == '__main__':
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src' / '__fixtures__' / 'gdi'
    manifest = []
    for name, family, glyphs, cvt_values, meta in sets():
        count = build(out / ('cta-%s.ttf' % name), family, glyphs, cvt_values)
        manifest.append({'set': name, 'file': 'cta-%s.ttf' % name, 'family': family, 'count': count, 'sizes': [16], 'qualities': [5, 6],
                         'meta': meta, 'params': [g[3] for g in glyphs]})
        print(name, count, 'glyphs')
    (out / 'cta-sets.json').write_text(json.dumps(manifest) + '\n')
