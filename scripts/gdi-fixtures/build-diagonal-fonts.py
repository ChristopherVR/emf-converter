"""Build the private TrueType fonts used by DiagonalHintProbe.cs (fontTools).

These four-point diagnostic glyphs expose SDPVTL normalization (GPV), current
projection (GC), and movement (SCFS) through the public GetGlyphOutline API.
The fonts are generated test inputs, with no installed-font dependency.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables.ttProgram import Program

VECTORS = [(x, y) for x in (17, 71, 137, 251, 511, 777)
           for y in (31, 89, 193, 317, 613, 901)]
PROGRAMS = {
    "movement": [0xB1, 0, 1, 0x86, 0x0E, 0xB9, 0, 2, 3, 232, 0x48],
    "projection": [0xB1, 0, 1, 0x86, 0xB0, 2, 0x46, 0xB0, 0, 0x23, 0x42,
                   0x01, 0x05, 0xB0, 3, 0xB0, 0, 0x43, 0x48],
    "vectors": [0xB1, 0, 1, 0x86, 0x0C, 0xB0, 0, 0x23, 0x42,
                0xB0, 1, 0x23, 0x42, 0x01, 0x05,
                0xB0, 2, 0xB0, 1, 0x43, 0x48, 0xB0, 3, 0xB0, 0, 0x43, 0x48],
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
    family = 'Parity Diagonal ' + kind.title()
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular',
                       'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448,
               usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxTwilightPoints = 0
    fb.font['maxp'].maxStorage = 2
    fb.font['maxp'].maxStackElements = 16
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('diagonal-' + kind + '.ttf'))

if __name__ == '__main__':
    destination = Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    for name, program in PROGRAMS.items():
        build(name, program, destination)
