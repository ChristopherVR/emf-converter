"""Build a CC0 diagnostic font mapping BMP and supplementary characters to identical glyphs.

No installed font data is used. The three rectangles have distinct widths and
advances so a surrogate pair split into two .notdef glyphs is unambiguous.
Requires fontTools; run before generate-text-supplementary.ps1.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable

dest = Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
fb = FontBuilder(2048, isTTF=True)
order = ['.notdef', 'space', 'a', 'mark', 'wide']
fb.setupGlyphOrder(order)
fb.setupCharacterMap({32: 'space', 65: 'a', 0xe000: 'mark', 0xe001: 'wide',
                      0xf0000: 'mark', 0xf0001: 'wide', 0x1f642: 'mark'})
glyphs, metrics = {}, {}
rectangles = {'a': (128, 512, 1536), 'mark': (256, 896, 1024),
              'wide': (128, 1408, 1280), '.notdef': (0, 256, 512)}
for name in order:
    pen = TTGlyphPen(None)
    if name != 'space':
        x0, x1, top = rectangles[name]
        pen.moveTo((x0, 0))
        pen.lineTo((x0, top))
        pen.lineTo((x1, top))
        pen.lineTo((x1, 0))
        pen.closePath()
    glyphs[name] = pen.glyph()
    metrics[name] = (1536 if name == 'wide' else 1024, 0 if name == 'space' else x0)
fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=1536, descent=-512)
family = 'Parity Supplementary'
fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1',
                   'fullName': family, 'psName': 'ParitySupplementary', 'version': 'Version 1.0',
                   'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
fb.setupOS2(sTypoAscender=1536, sTypoDescender=-512, usWinAscent=1536, usWinDescent=512)
fb.setupPost()
fb.setupMaxp()
gasp = newTable('gasp')
gasp.version = 1
gasp.gaspRange = {0xffff: 15}
fb.font['gasp'] = gasp
fb.font['head'].created = fb.font['head'].modified = 3500000000
fb.save(dest / 'supplementary.ttf')
