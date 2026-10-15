"""Generate a CC0 private font whose glyph programs report what native GETINFO returns.

Every glyph is the same tall stem. Its program touches the top point in y, runs GETINFO for one selector, ANDs the
result with one mask (or compares the version) and, when the answer is non-zero, moves the top point up by a pixel with
SHPIX. A row of ink at the top of the stem therefore means "this GETINFO bit is set". Which rasterizer and
quality draws the glyph (GDI at qualities 0, 3, 4, 5, 6, GDI+ ClearType and grayscale grid-fit) decides the answers; no
installed font or native implementation is consulted.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables.ttProgram import Program

PUSHB, PUSHW = 0xB0, 0xB8
SVTCA_Y, MDAP0, SHPIX, GETINFO, AND, IF, EIF, GTEQ = 0x00, 0x2E, 0x38, 0x88, 0x5A, 0x58, 0x59, 0x53
TOP = 1100


def push(*values):
    assert all(0 <= v < 256 for v in values)
    return [PUSHB + len(values) - 1, *values]


def pushw(*values):
    out = [PUSHW + len(values) - 1]
    for v in values:
        out += [(v >> 8) & 255, v & 255]
    return out


touch = [SVTCA_Y, *push(1), MDAP0]
move = [*push(1, 64), SHPIX]
# (name, GETINFO selector, test): a mask to AND with, or a minimum version to compare against
TESTS = [('always', 1, ('ge', 0)), ('never', 1, ('ge', 255))]
TESTS += [('version>=%d' % v, 1, ('ge', v)) for v in (35, 36, 37, 38, 39, 40, 41)]
TESTS += [('rotated', 2, ('and', 8)), ('stretched', 4, ('and', 9)), ('variations', 8, ('and', 10)),
          ('vertical-phantom', 16, ('and', 11)), ('grayscale', 32, ('and', 12)), ('cleartype', 64, ('and', 13)),
          ('compat-widths', 128, ('and', 14)), ('vertical-lcd', 256, ('and', 15)), ('bgr', 512, ('and', 16)),
          ('subpixel-positioned', 1024, ('and', 17)), ('symmetric-smoothing', 2048, ('and', 18)),
          ('gray-cleartype', 4096, ('and', 19))]


MUL = 0x63


def mask(bit):
    """Push 1 << bit: PUSHW holds 16 signed bits, so the high bits are made as 2^14 * 2^(bit - 8) / 64 with MUL."""
    if bit <= 14:
        return pushw(1 << bit)
    return [*pushw(1 << 14, 1 << (bit - 8)), MUL]


def program(sel, test):
    kind, arg = test
    body = [*(push(sel) if sel < 256 else pushw(sel)), GETINFO]
    if kind == 'ge':
        body += [*push(arg), GTEQ]
    else:
        body += [*mask(arg), AND]
    return [*touch, *body, IF, *move, EIF]


def build(directory):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(TESTS))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: name for i, name in enumerate(order[1:])})
    glyphs, metrics = {}, {}
    for i, name in enumerate(order):
        pen = TTGlyphPen(None)
        for operation, point in ((pen.moveTo, (512, 0)), (pen.lineTo, (512, TOP)), (pen.lineTo, (640, TOP)), (pen.lineTo, (640, 0))):
            operation(point)
        pen.closePath()
        glyph = pen.glyph()
        prog = Program()
        prog.fromBytecode(program(TESTS[i - 1][1], TESTS[i - 1][2]) if i else [])
        glyph.program = prog
        glyphs[name], metrics[name] = glyph, (1024, 512)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = 'Parity GetInfo A'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1', 'fullName': family,
                       'psName': family.replace(' ', ''), 'version': 'Version 1.0', 'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    fb.font['maxp'].maxStackElements = 16
    fb.font['maxp'].maxZones = 2
    fb.font['maxp'].maxSizeOfInstructions = 64
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / 'getinfo-a.ttf')


if __name__ == '__main__':
    build(Path(__file__).resolve().parents[2] / 'src' / '__fixtures__' / 'gdi')
    print(len(TESTS), 'tests')
    for i, t in enumerate(TESTS):
        print(i, t[0])
