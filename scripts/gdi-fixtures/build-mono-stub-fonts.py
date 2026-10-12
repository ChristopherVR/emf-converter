"""Independent CC0 private fonts for native monochrome stub control.

Includes straight and curved tips, concave contours, signed coordinates and
disjoint contours. A fixed seed makes the captured inputs reproducible.
"""
import math
import random
import argparse
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

COUNT = 512


def shapes(seed):
    rng = random.Random(seed)
    result = []
    for i in range(COUNT):
        pen = TTGlyphPen(None)
        if i < 256:
            n = 3 if i % 2 == 0 else 4
            while True:
                pts = [(rng.randrange(-192, 1152), rng.randrange(-128, 1152)) for _ in range(n)]
                cx, cy = sum(p[0] for p in pts)/n, sum(p[1] for p in pts)/n
                pts.sort(key=lambda p: math.atan2(p[1]-cy, p[0]-cx))
                area = sum(pts[k][0]*pts[(k+1) % n][1]-pts[(k+1) % n][0]*pts[k][1] for k in range(n))
                if abs(area) > 40000:
                    if area > 0:
                        pts.reverse()
                    break
            pen.moveTo(pts[0])
            for p in pts[1:]:
                pen.lineTo(p)
            pen.closePath()
        else:
            count = 2 if i >= 448 else 1
            for contour in range(count):
                x, y = rng.randrange(-64, 256), rng.randrange(-64, 256)
                if contour:
                    x += 576
                width, height = rng.randrange(24, 192), rng.randrange(128, 1024)
                shift = rng.randrange(-576, 576)
                pen.moveTo((x, y))
                if i < 320 or i >= 448:
                    pen.lineTo((x+shift, y+height))
                    pen.lineTo((x+width, y))
                elif i < 384:
                    pen.qCurveTo((x+shift, y+height), (x+width, y))
                else:
                    pen.qCurveTo((x+shift-width, y+height), (x+shift, y+height))
                    pen.qCurveTo((x+shift+width, y+height), (x+width, y))
                pen.closePath()
        result.append(pen.glyph())
    return result


def build(destination, scan_type, seed=20261012, prefix='mono-stub'):
    fb = FontBuilder(2048, isTTF=True)
    order = ['.notdef'] + [f'tip{i}' for i in range(COUNT)]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000+i: name for i, name in enumerate(order[1:])})
    glyphs = shapes(seed)
    fb.setupGlyf(dict(zip(order, [glyphs[0]] + glyphs)))
    fb.setupHorizontalMetrics({name: (2048, min(g.coordinates[i][0] for i in range(len(g.coordinates)))) for name, g in zip(order, [glyphs[0]] + glyphs)})
    fb.setupHorizontalHeader(ascent=1600, descent=-448)
    family = f'Parity Mono Stub ST{scan_type}'
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family+f' {seed}',
                       'fullName': family, 'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=1600, sTypoDescender=-448, usWinAscent=1600, usWinDescent=448)
    fb.setupPost()
    fb.setupMaxp()
    prep = newTable('prep')
    prep.program = Program()
    prep.program.fromBytecode([0xB8, 0x01, 0xFF, 0x85, 0xB0, scan_type, 0x8D])
    fb.font['prep'] = prep
    fb.font['maxp'].maxStackElements = 8
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(destination/f'{prefix}-st{scan_type}.ttf')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--seed', type=int, default=20261012)
    parser.add_argument('--out-dir', type=Path, default=Path(__file__).resolve().parents[2]/'src/__fixtures__/gdi')
    parser.add_argument('--prefix', default='mono-stub')
    args = parser.parse_args()
    destination = args.out_dir
    destination.mkdir(parents=True, exist_ok=True)
    for scan_type in (1, 5):
        build(destination, scan_type, args.seed, args.prefix)
