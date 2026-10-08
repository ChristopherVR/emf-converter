"""Generate CC0 private fonts that isolate which x SHPIX shifts native ClearType applies.

Every glyph is the same stem; its program shifts the four stem points by half a pixel with
SHPIX, issued from a different kind of code: a function that reads the rendering mode stored
by `prep` (storage 2) before an MPPEM range test, the same function without the mode test,
functions with only the mode test, only an exact MPPEM test or no test, nested calls, and
inline code. The function numbers vary between the four fonts, so a rule keyed on the number
is told apart from one keyed on the code. No installed font or native implementation is
consulted.
"""
from array import array
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

SHIFT = 32          # SHPIX amount: half a pixel
LO, HI = 8, 40      # ppem range of the tweaks
POINTS = (3, 2, 1, 0)

PUSHB, PUSHW = 0xB0, 0xB8
SVTCA_X, SLOOP, CALL, FDEF, ENDF, RS, EQ, IF, ELSE, EIF = 0x01, 0x17, 0x2B, 0x2C, 0x2D, 0x43, 0x54, 0x58, 0x1B, 0x59
MPPEM, GTEQ, LTEQ, SWAP, AND, POP, SHPIX = 0x4B, 0x53, 0x51, 0x23, 0x5A, 0x21, 0x38

def push(*values):
    assert all(0 <= v < 256 for v in values)
    return [PUSHB + len(values) - 1, *values]

def mppem_range():  # stack: lo hi -> bool
    return [MPPEM, GTEQ, SWAP, MPPEM, LTEQ, AND]

BODIES = {
    # mode-selected ClearType tweak: pt amt lo hi mode
    'gated': push(2) + [RS, EQ, IF] + mppem_range() + [IF, SHPIX, ELSE, POP, POP, EIF, ELSE, POP, POP, POP, POP, EIF],
    # generic per-size helper: pt amt lo hi
    'plain': mppem_range() + [IF, SHPIX, ELSE, POP, POP, EIF],
    # mode test only: pt amt mode
    'rsonly': push(2) + [RS, EQ, IF, SHPIX, ELSE, POP, POP, EIF],
    # exact ppem: pt amt ppem
    'exact': [MPPEM, EQ, IF, SHPIX, ELSE, POP, POP, EIF],
    # no test: pt amt
    'bare': [SHPIX],
    # range test and an unrelated storage read: pt amt lo hi
    'mixed': mppem_range() + [IF] + push(5) + [RS, POP, SHPIX, ELSE, POP, POP, EIF],
    # the generic helper behind two harmless instructions: pt amt lo hi
    'prefixed': push(0) + [POP] + mppem_range() + [IF, SHPIX, ELSE, POP, POP, EIF],
    # the generic helper followed by an unrelated storage read: pt amt lo hi
    'tailrs': mppem_range() + [IF, SHPIX, ELSE, POP, POP, EIF] + push(5) + [RS, POP],
    # strict comparisons instead of GTEQ/LTEQ: pt amt lo-1 hi+1
    'strict': [MPPEM, 0x52, SWAP, MPPEM, 0x50, AND, IF, SHPIX, ELSE, POP, POP, EIF],
    # MPPEM read and dropped, then an unconditional shift: pt amt
    'barempp': [MPPEM, POP, SHPIX],
    # the generic helper without an ELSE branch: pt amt lo hi
    'noelse': mppem_range() + [IF, SHPIX, EIF],
    # the generic helper followed by two harmless instructions: pt amt lo hi
    'tailpop': mppem_range() + [IF, SHPIX, ELSE, POP, POP, EIF] + push(0) + [POP],
    # the exact-ppem helper followed by two harmless instructions: pt amt ppem
    'exacttail': [MPPEM, EQ, IF, SHPIX, ELSE, POP, POP, EIF] + push(0) + [POP],
}

def call(fn):
    return push(fn) + [CALL]

def program(kind, ids):
    code = [SVTCA_X] + push(len(POINTS), ) + [SLOOP]
    pts = push(*POINTS)
    if kind == 'gated':
        return code + pts + push(SHIFT, LO, HI, 2) + call(ids['gated'])
    if kind == 'gated-mismatch':
        return code + pts + push(SHIFT, LO, HI, 5) + call(ids['gated'])
    if kind == 'plain':
        return code + pts + push(SHIFT, LO, HI) + call(ids['plain'])
    if kind == 'rsonly':
        return code + pts + push(SHIFT, 2) + call(ids['rsonly'])
    if kind == 'exact':
        return code + pts + push(SHIFT, 16) + call(ids['exact'])
    if kind == 'bare':
        return code + pts + push(SHIFT) + call(ids['bare'])
    if kind == 'mixed':
        return code + pts + push(SHIFT, LO, HI) + call(ids['mixed'])
    if kind == 'wrap-plain':   # a wrapper function that calls the plain helper
        return code + pts + push(SHIFT, LO, HI) + call(ids['wrap-plain'])
    if kind == 'wrap-gated':
        return code + pts + push(SHIFT, LO, HI, 2) + call(ids['wrap-gated'])
    if kind == 'prefixed':
        return code + pts + push(SHIFT, LO, HI) + call(ids['prefixed'])
    if kind == 'tailrs':
        return code + pts + push(SHIFT, LO, HI) + call(ids['tailrs'])
    if kind == 'strict':
        return code + pts + push(SHIFT, LO - 1, HI + 1) + call(ids['strict'])
    if kind == 'barempp':
        return code + pts + push(SHIFT) + call(ids['barempp'])
    if kind == 'noelse':
        return code + pts + push(SHIFT, LO, HI) + call(ids['noelse'])
    if kind == 'tailpop':
        return code + pts + push(SHIFT, LO, HI) + call(ids['tailpop'])
    if kind == 'exacttail':
        return code + pts + push(SHIFT, 16) + call(ids['exacttail'])
    if kind == 'inline-range':
        return code + [MPPEM, *push(LO), GTEQ, MPPEM, *push(HI), LTEQ, AND, IF, *pts, *push(SHIFT), SHPIX, EIF]
    if kind == 'inline':
        return code + pts + push(SHIFT) + [SHPIX]
    return []   # control: no instructions

KINDS = ['control', 'gated', 'gated-mismatch', 'plain', 'rsonly', 'exact', 'bare', 'mixed', 'wrap-plain', 'wrap-gated', 'inline-range', 'inline',
         'prefixed', 'tailrs', 'strict', 'barempp', 'noelse', 'tailpop', 'exacttail']

# Four function-number layouts.
LAYOUTS = {
    'a': dict(gated=1, plain=2, rsonly=3, exact=4, bare=5, mixed=6, prefixed=9, tailrs=10, strict=11, barempp=12, noelse=13, tailpop=14, exacttail=15, **{'wrap-plain': 7, 'wrap-gated': 8}),
    'b': dict(gated=2, plain=1, rsonly=4, exact=3, bare=6, mixed=5, prefixed=12, tailrs=11, strict=10, barempp=9, noelse=15, tailpop=13, exacttail=14, **{'wrap-plain': 8, 'wrap-gated': 7}),
    'c': dict(gated=85, plain=52, rsonly=60, exact=53, bare=70, mixed=86, prefixed=92, tailrs=93, strict=94, barempp=95, noelse=96, tailpop=97, exacttail=98, **{'wrap-plain': 90, 'wrap-gated': 91}),
    'd': dict(gated=52, plain=85, rsonly=53, exact=60, bare=86, mixed=70, prefixed=95, tailrs=94, strict=93, barempp=92, noelse=98, tailpop=96, exacttail=97, **{'wrap-plain': 91, 'wrap-gated': 90}),
}

def fpgm(ids):
    code = []
    for name in ('gated', 'plain', 'rsonly', 'exact', 'bare', 'mixed', 'prefixed', 'tailrs', 'strict', 'barempp', 'noelse', 'tailpop', 'exacttail'):
        code += push(ids[name]) + [FDEF, *BODIES[name], ENDF]
    code += push(ids['wrap-plain']) + [FDEF, *call(ids['plain']), ENDF]
    code += push(ids['wrap-gated']) + [FDEF, *call(ids['gated']), ENDF]
    return code

def build(layout, directory):
    ids = LAYOUTS[layout]
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(KINDS))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        for operation, point in ((pen.moveTo, (512, 0)), (pen.lineTo, (512, 1024)), (pen.lineTo, (640, 1024)), (pen.lineTo, (640, 0))):
            operation(point)
        pen.closePath()
        glyph = pen.glyph()
        prog = Program()
        prog.fromBytecode(program(KINDS[i - 1], ids) if i else [])
        glyph.program = prog
        glyphs[name], metrics[name] = glyph, (1024, 512)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity Shpix ' + layout.upper()
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    maxp = fb.font['maxp']
    maxp.maxZones, maxp.maxStorage, maxp.maxFunctionDefs, maxp.maxStackElements, maxp.maxSizeOfInstructions = 2, 8, 100, 64, 256
    cvt = newTable('cvt ')
    cvt.values = array('h', [64])
    fb.font['cvt '] = cvt
    for tag, code in (('fpgm', fpgm(ids)), ('prep', push(2, 2) + [0x42])):   # prep: storage[2] = 2
        table = newTable(tag)
        table.program = Program()
        table.program.fromBytecode(code)
        fb.font[tag] = table
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    fb.font['gasp'] = gasp
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('shpix-%s.ttf' % layout))

if __name__ == '__main__':
    destination = Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    for layout in LAYOUTS:
        build(layout, destination)
