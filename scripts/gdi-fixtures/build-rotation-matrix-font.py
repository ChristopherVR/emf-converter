"""Build the private fonts used by RotationMatrixProbe.cs (fontTools).

Most variants have unitsPerEm 64 and glyph E000 as the triangle (0,0), (L,0), (0,L) with L = 30000 font units (468 em),
E001 its mirror (0,0), (-L,0), (0,-L) and E002 the point set (0,0), (20000,0), (20000,20000): points hundreds of ems from
the origin, so that GetGlyphOutline(GGO_NATIVE) under a rotation exposes the scaling matrix to a relative precision of
about 1e-5, where an ordinary glyph (a few hundred 1/64 pixel) pins it to 1e-3.

Variants: plain (no programs and head.flags without bit 3), prep / glyph / both / fpgm / all (the same with one harmless
SVTCA[0] in the named programs), intppem / intall (head.flags bit 3, "force ppem to integer values"), and the
2048-unit-em fonts axisint (glyph E004: the points 1700 to 1938 units along the x axis, bit 3 set), axisfree,
randint / randfree (240 random points per glyph) and bigint. The fonts are generated test inputs with no
installed-font dependency (CC0).
"""
import array
import os
import random
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

L = 30000
SHAPES = [
    [(0, 0), (L, 0), (0, L)],
    [(0, 0), (-L, 0), (0, -L)],
    [(0, 0), (20000, 0), (20000, 20000)],
]

# name: (glyph program, prep program, fpgm program)
VARIANTS = {
    'plain': (None, None, None),
    'prep': (None, 'SVTCA[0]', None),
    'glyph': ('SVTCA[0]', None, None),
    'both': ('SVTCA[0]', 'SVTCA[0]', None),
    'fpgm': (None, None, 'SVTCA[0]'),
    'all': ('SVTCA[0]', 'SVTCA[0]', 'SVTCA[0]'),
    # head.flags bit 3: force ppem to integer values
    'intppem': (None, None, None),
    'intall': ('SVTCA[0]', 'SVTCA[0]', 'SVTCA[0]'),
    # 2048-unit em with random points: the pipeline's rounding stages (int = head.flags bit 3)
    'randfree': (None, None, None),
    'randint': (None, None, None),
    # 2048-unit em with the far points of the 64-unit font (30000 units = 14.6 em)
    'bigint': (None, None, None),
    # points along the axes (2048-unit em), with and without integer ppem
    'axisint': (None, None, None),
    'axisfree': (None, None, None),
}


def program(asm):
    prog = Program()
    prog.fromAssembly([asm])
    return prog


def random_shapes():
    """Eight glyphs of 240 random on-curve points (font units of a 2048-unit em), seeded."""
    rnd = random.Random(20261016)
    # The origin is a point of every glyph so that xMin equals the left side bearing 0 and the scaler does not shift it.
    return [[(0, 0)] + [(rnd.randint(0, 2000), rnd.randint(-400, 2000)) for _ in range(239)] for _ in range(8)]


def axis_shapes():
    """Points on the two axes: coarse (every 8 units), fine (every unit) and far (1700 units out)."""
    return [
        [(8 * j, 0) for j in range(240)],
        [(j, 0) for j in range(240)],
        [(0, 8 * j) for j in range(240)],
        [(0, j) for j in range(240)],
        [(0, 0)] + [(1700 + j, 0) for j in range(239)],
        [(0, 0)] + [(0, 1700 + j) for j in range(239)],
    ]


def make(directory, name, glyph_asm, prep_asm, fpgm_asm):
    family = 'Parity Rotation Matrix ' + name
    upem, shapes = (2048, random_shapes()) if name.startswith('rand') else (2048, axis_shapes()) if name.startswith('axis') else (2048, SHAPES) if name == 'bigint' else (64, SHAPES)
    fb = FontBuilder(upem, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(shapes))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: n for i, n in enumerate(order[1:])})
    glyphs = {}
    for i, n in enumerate(order):
        pen = TTGlyphPen(None)
        pts = [(0, 0), (0, 32), (32, 32), (32, 0)] if i == 0 else shapes[i - 1]
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
        g = pen.glyph()
        if glyph_asm:
            g.program = program(glyph_asm)
        glyphs[n] = g
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (upem, 0) for n in order})
    fb.setupHorizontalHeader(ascent=upem * 7 // 8, descent=-upem // 8)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1',
                       'fullName': family, 'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=upem * 7 // 8, sTypoDescender=-upem // 8, usWinAscent=upem * 7 // 8, usWinDescent=upem // 8)
    fb.setupPost()
    fb.setupMaxp()
    mp = fb.font['maxp']
    mp.maxZones = 2
    mp.maxTwilightPoints = 0
    mp.maxStorage = 1
    mp.maxFunctionDefs = 1
    mp.maxInstructionDefs = 0
    mp.maxStackElements = 16
    mp.maxSizeOfInstructions = 16
    fb.font['cvt '] = newTable('cvt ')
    fb.font['cvt '].values = array.array('h', [0])
    if prep_asm:
        fb.font['prep'] = newTable('prep')
        fb.font['prep'].program = program(prep_asm)
    if fpgm_asm:
        fb.font['fpgm'] = newTable('fpgm')
        fb.font['fpgm'].program = program(fpgm_asm)
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    if name.startswith("int") or name in ("randint", "bigint", "axisint"):
        fb.font['head'].flags |= 8
    fb.save(Path(directory) / ('rotation-matrix-%s.ttf' % name))


def main(directory):
    # The committed capture needs plain and axisint; ROT_ALL_FONTS=1 builds every variant (the experiments in the notes).
    names = VARIANTS.keys() if os.environ.get('ROT_ALL_FONTS') == '1' else ['plain', 'axisint']
    for name in names:
        g, p, f = VARIANTS[name]
        make(directory, name, g, p, f)


if __name__ == '__main__':
    main(sys.argv[1])
