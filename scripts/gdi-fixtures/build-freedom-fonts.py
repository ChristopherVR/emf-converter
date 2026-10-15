"""Build private TrueType fonts whose glyph programs move a point along the x axis while
projecting on a diagonal vector (freedom vector != projection vector), the case the
diagonal fonts of build-diagonal-fonts.py (SFVTPV) do not reach (fontTools; generated
CC0 diagnostic inputs, no installed-font dependency).

Glyph i has points p0 = (320, 320), p1 = (320 + dx, 320 + dy), p2 = (1400, 1200),
p3 = (1400, 320) for the same 36 vectors (dx, dy) as build-diagonal-fonts.py.

  movement  SDPVTL[0] p0->p1 (pv and dv diagonal, fv stays the x axis); SCFS p2 := 1000
  mdrp      SDPVTL[0] p0->p1; MDRP[rp0, round] p3 (rp0 = p0): moves p3 along x to the rounded
            original distance of p3 from p0 projected on the diagonal
  mirp      SDPVTL[0] p0->p1; MIRP[rp0] p3 with cvt entry 0 (= 600) unrounded
  mdrpmin   as mdrp with the minimum-distance flag, unrounded: MDRP[rp0, min, no round]
  gcset     SDPVTL[0] p0->p1; SCFS p2 := 1000; GC[cur] p2 -> SCFS p3 := the returned value
            (the program's own result is only visible through the moved point)

Usage: python build-freedom-fonts.py [output-directory]
"""
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables.ttProgram import Program

VECTORS = [(x, y) for x in (17, 71, 137, 251, 511, 777) for y in (31, 89, 193, 317, 613, 901)]
# PUSHB[1] 0 1 ; SDPVTL[0]
SETUP = [0xB1, 0, 1, 0x86]
# SDPVTL[0] p0->p1 then SFVTPV: freedom vector copied from the projection vector
SETUP_EQ = [0xB1, 0, 1, 0x86, 0x0E]
def read_vector(op, get):
    """Set a vector with `op` from p0->p1, read it back with `get` (GPV 0x0C / GFV 0x0D) and write its two words into
    the x coordinates of points 2 (y word) and 3 (x word) with SCFS along the x axis."""
    return [0xB1, 0, 1, op, get, 0x01, 0xB0, 2, 0x23, 0x48, 0xB0, 3, 0x23, 0x48]


PROGRAMS = {
    "vec06": read_vector(0x06, 0x0C), "vec07": read_vector(0x07, 0x0C), "vec86": read_vector(0x86, 0x0C), "vec87": read_vector(0x87, 0x0C),
    "vec08": read_vector(0x08, 0x0D), "vec09": read_vector(0x09, 0x0D),
    "eqmdrp": SETUP_EQ + [0xB0, 0, 0x10, 0xB0, 3, 0xC4],
    "eqmirp": SETUP_EQ + [0xB0, 0, 0x10, 0xB1, 3, 0, 0xE0],
    # SPVTL[0] p0->p1 (0x06) and SFVTL[0] p0->p1 (0x08) separately: the same numbers if both normalise alike
    "sepmdrp": [0xB1, 0, 1, 0x06, 0xB1, 0, 1, 0x08, 0xB0, 0, 0x10, 0xB0, 3, 0xC4],
    # perpendicular, as the Arial '&' function does (SDPVTL[1] then SFVTPV)
    "perpmirp": [0xB1, 0, 1, 0x87, 0x0E, 0xB0, 0, 0x10, 0xB1, 3, 0, 0xE0],
    "movement": SETUP + [0xB9, 0, 2, 3, 232, 0x48],
    # SRP0 p0 ; MDRP[rp0, round, grey] p3  (0xC0 | 4: round) with rp0 = p0
    "mdrp": SETUP + [0xB0, 0, 0x10, 0xB0, 3, 0xC4],
    # MIRP[rp0] with cvt 0 ; stack: p3 cvt0 (cvt index pushed last) -> push point, then cvt index
    "mirp": SETUP + [0xB0, 0, 0x10, 0xB1, 3, 0, 0xE0],
    "mdrpmin": SETUP + [0xB0, 0, 0x10, 0xB0, 3, 0xC8],
}


def build(kind, instructions, directory):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(VECTORS))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs = {}
    for i, name in enumerate(order):
        dx, dy = VECTORS[max(0, i - 1)]
        pen = TTGlyphPen(None)
        pen.moveTo((320, 320))
        pen.lineTo((320 + dx, 320 + dy))
        pen.lineTo((1400, 1200))
        pen.lineTo((1400, 320))
        pen.closePath()
        glyph = pen.glyph()
        program = Program()
        program.fromBytecode(instructions if i else [])
        glyph.program = program
        glyphs[name] = glyph
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (2048, 320) for name in order})
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Freedom ' + kind.title()
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular',
                       'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxTwilightPoints = 0
    fb.font['maxp'].maxStorage = 2
    fb.font['maxp'].maxStackElements = 16
    # cvt entry 0 = 600 font units, read by the MIRP program
    from fontTools.ttLib import newTable
    cvt = newTable('cvt ')
    from array import array
    cvt.values = array('h', [600])
    fb.font['cvt '] = cvt
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('freedom-' + kind + '.ttf'))


def build_intersect(directory, count=240, seed=7, family_name='Parity Freedom Isect', file_name='freedom-isect.ttf', structured=False):
    """ISECT controls: glyph k has points a0, a1, b0, b1 and p (all random font-unit positions); the program moves p
    to the intersection of the lines a0-a1 and b0-b1, so the hinted outline shows the interpreter's arithmetic."""
    import random
    rng = random.Random(seed)
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(count)]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs = {}
    layout = []
    lsbs = {}
    program_bytes = [0xB4, 4, 0, 1, 2, 3, 0x0F]
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        pts = [(rng.randint(200, 1800), rng.randint(200, 1800)) for _ in range(5)]
        if structured and i:
            # families of 60: A horizontal, A vertical, B horizontal, B vertical (the other line random)
            family = (i - 1) // 60
            if family == 0:
                pts[1] = (pts[1][0], pts[0][1])
            elif family == 1:
                pts[1] = (pts[0][0], pts[1][1])
            elif family == 2:
                pts[3] = (pts[3][0], pts[2][1])
            else:
                pts[3] = (pts[2][0], pts[3][1])
        if i:
            layout.append(pts)
        lsbs[name] = min(q[0] for q in pts)
        pen.moveTo(pts[0])
        for q in pts[1:]:
            pen.lineTo(q)
        pen.closePath()
        glyph = pen.glyph()
        program = Program()
        program.fromBytecode(program_bytes if i else [])
        glyph.program = program
        glyphs[name] = glyph
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (2048, lsbs[name]) for name in order})
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = family_name
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1',
                       'fullName': family, 'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxTwilightPoints = 0
    fb.font['maxp'].maxStorage = 2
    fb.font['maxp'].maxStackElements = 16
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / file_name)


if __name__ == '__main__':
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    destination.mkdir(parents=True, exist_ok=True)
    for name, program in PROGRAMS.items():
        build(name, program, destination)
    build_intersect(destination)
    build_intersect(destination, 240, 9, 'Parity Freedom Isect Axis', 'freedom-isectaxis.ttf', True)
