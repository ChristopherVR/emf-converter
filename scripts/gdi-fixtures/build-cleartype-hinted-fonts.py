"""Build the private program-free fonts of the ClearType hinted-outline probe (fontTools).

dump-cleartype-hinted-outlines.ts writes the grid-fitted outlines our interpreter produces for the 1,260 natural
quality ClearType glyphs of gdi-cleartype-compat.json.gz (Arial, Segoe UI and Tahoma, 30 glyphs at 9 to 24 px) to
.scratch/cleartype-hinted-outlines.json. Here every outline becomes a glyph of a font with 2048 units per em, so that at
32 ppem one font unit is one 26.6 unit and nothing is grid-fitted: the glyph carries no program. Native GDI then draws
exactly the outline we rasterize, and what differs is the scan converter and the ClearType filter alone.

The rasterizer settings the real font would give a size are reproduced by the font itself: a `gasp` table with or
without GASP_SYMMETRIC_SMOOTHING (vertical smoothing) and a `prep` that selects the dropout control (SCANCTRL 0x1ff and
SCANTYPE 1 or 5, or SCANCTRL 0x0800 for "off"). One font per combination, 'Parity CT Hinted <scantype> <smooth>'.
The fonts are generated test inputs, CC0 1.0.
"""
import json
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.ttLib import newTable
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
from fontTools.ttLib.tables.ttProgram import Program

ROOT = Path(__file__).resolve().parents[2]


def build(directory, mode, smooth, glyphs_in):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(glyphs_in))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        g = Glyph()
        if i == 0:
            pts, flags, ends = [(0, 0), (0, 64), (64, 64), (64, 0)], [1, 1, 1, 1], [3]
        else:
            src = glyphs_in[i - 1]
            pts = list(zip(src['xs'], src['ys']))
            flags = list(src['on'])
            ends = src['end']
        g.numberOfContours = len(ends)
        g.coordinates = GlyphCoordinates(pts)
        g.flags = bytearray(flags)
        g.endPtsOfContours = ends
        g.program = Program()
        g.program.fromBytecode(b'')
        g.xMin = min(p[0] for p in pts)
        g.xMax = max(p[0] for p in pts)
        g.yMin = min(p[1] for p in pts)
        g.yMax = max(p[1] for p in pts)
        glyphs[name] = g
        metrics[name] = (2048, g.xMin)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity CT Hinted S%s %s' % (mode, 'smooth' if smooth else 'plain')
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular',
                       'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 15 if smooth else 5}
    fb.font['gasp'] = gasp
    if mode != -1:
        prep = newTable('prep')
        prep.program = Program()
        if mode == 0:
            # PUSHW[0] 0x0800 SCANCTRL: dropout control off at every size
            prep.program.fromBytecode([0xB8, 0x08, 0x00, 0x85])
        else:
            # PUSHW[0] 0x01ff SCANCTRL; PUSHB[0] n SCANTYPE
            prep.program.fromBytecode([0xB8, 0x01, 0xFF, 0x85, 0xB0, mode, 0x8D])
        fb.font['prep'] = prep
        fb.font['maxp'].maxStackElements = 8
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('cleartype-hinted-s%s-%s.ttf' % (mode, 'smooth' if smooth else 'plain')))


if __name__ == '__main__':
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.scratch/cleartype-hinted-outlines.json'
    destination = ROOT / 'src/__fixtures__/gdi'
    data = json.loads(source.read_text())
    groups = {}
    for g in data:
        groups.setdefault((g['mode'], g['smooth']), []).append(g)
    index = {}
    for (mode, smooth), glyphs in sorted(groups.items()):
        build(destination, mode, smooth, glyphs)
        index['S%s %s' % (mode, 'smooth' if smooth else 'plain')] = [[g['face'], g['size'], g['code']] for g in glyphs]
    # Which glyph of which font each capture is: written next to the fonts for the probe and the test.
    (destination / 'cleartype-hinted-index.json').write_text(json.dumps(index, separators=(',', ':')))
