"""Build two program-free private TrueType fonts for measuring how GDI turns a design advance into an integer advance
(fontTools; generated CC0 diagnostic input). Glyph i (character U+E000 + i, i = 1..2047) is a small box with the
advance width i font units (2048 units per em), so one font covers every advance of a 2048-unit em. The fonts differ
only in head.flags bit 4 ("instructions may alter advance width"): `Parity Advance Linear` clears it and
`Parity Advance Hinted` sets it. Neither has instructions, an hdmx or a VDMX. `Parity Advance Program` also sets it and gives
every glyph a one-instruction program (SVTCA[y]), which makes GDI run the interpreter without moving any point.

  python build-advance-fonts.py [output-directory]
"""
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables.ttProgram import Program


def build(directory, family, flags, program_bytes=None):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(1, 2048)]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: 'g%d' % i for i in range(1, 2048)})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        pen.moveTo((100, 0)); pen.lineTo((100, 700)); pen.lineTo((600, 700)); pen.lineTo((600, 0)); pen.closePath()
        glyph = pen.glyph()
        program = Program()
        program.fromBytecode(program_bytes or [])
        glyph.program = program
        glyphs[name] = glyph
        metrics[name] = (i if i else 1000, 100)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1',
                       'fullName': family, 'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxTwilightPoints = 0
    fb.font['maxp'].maxStorage = 0
    fb.font['maxp'].maxStackElements = 8
    fb.font['maxp'].maxSizeOfInstructions = len(program_bytes or [])
    fb.font['head'].flags = flags
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / (family.lower().replace(' ', '-') + '.ttf'))


if __name__ == '__main__':
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    destination.mkdir(parents=True, exist_ok=True)
    build(destination, 'Parity Advance Linear', 0x0B)
    build(destination, 'Parity Advance Hinted', 0x1B)
    # the same with a glyph program that only sets the vectors: does running the interpreter change the phantom rounding?
    build(destination, 'Parity Advance Program', 0x1B, [0x00])
