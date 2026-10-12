"""CC0 multiple-contour mono controls, independent of the original tip corpus.

Three fresh seeds cover separated, nearby, overlapping, nested, reversed and
curved components. Programs only set SCANCTRL/SCANTYPE; no outline hinting.
"""
import importlib.util
import random
from pathlib import Path
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mono_builder', HERE/'build-mono-stub-fonts.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def shape(rng, kind):
    x, y = rng.randrange(-128, 257), rng.randrange(-128, 257)
    w, h, lean = rng.randrange(12, 257), rng.randrange(64, 961), rng.randrange(-576, 577)
    if kind == 0:
        return [(x, y), (x+lean, y+h), (x+w, y)]
    if kind == 1:
        return [(x, y), (x+lean, y+h), (x+lean+w, y+h), (x+w, y)]
    # Concave straight contour with a re-entrant middle vertex.
    return [(x, y), (x+lean, y+h), (x+lean+w, y+h), (x+w//2, y+h//3), (x+w, y)]


def bounds(points):
    return min(p[0] for p in points), max(p[0] for p in points), min(p[1] for p in points), max(p[1] for p in points)


def shapes(seed):
    rng, result = random.Random(seed), []
    for i in range(512):
        parts = [shape(rng, i % 3), shape(rng, (i+1) % 3)]
        a, b = bounds(parts[0]), bounds(parts[1])
        if i < 256:
            axis, gap = i % 2, rng.choice((1, 7, 31, 63, 64, 65, 128, 256))
            shift = a[axis*2+1] + gap - b[axis*2]
            parts[1] = [(x+shift if axis == 0 else x, y+shift if axis == 1 else y) for x, y in parts[1]]
            if i % 4 == 0:
                third = shape(rng, (i+2) % 3)
                c = bounds(third)
                dx = a[0] - rng.randrange(1, 257) - c[1]
                parts.append([(x+dx, y) for x, y in third])
        elif i >= 448:
            # A reversed inner contour tests holes and coincident ownership.
            x0, x1, y0, y1 = a
            parts = [[(x0, y0), (x0, y1), (x1, y1), (x1, y0)],
                     [(x0+3, y0+3), (x1-3, y0+3), (x1-3, y1-3), (x0+3, y1-3)]]
        pen = TTGlyphPen(None)
        rotation = (i // 8) % 4
        def rotate(p):
            x, y = p
            return ((x, y), (-y, x), (-x, -y), (y, -x))[rotation]
        for j, pts in enumerate(parts):
            pts = [rotate(p) for p in pts]
            if i % 17 == 0:
                pts.insert(1, pts[0])
            pen.moveTo(pts[0])
            if 384 <= i < 448 and j == 0:
                pen.qCurveTo(pts[1], pts[2])
                for p in pts[3:]:
                    pen.lineTo(p)
            else:
                for p in pts[1:]:
                    pen.lineTo(p)
            pen.closePath()
        result.append(pen.glyph())
    return result


if __name__ == '__main__':
    destination = HERE.parents[1]/'src/__fixtures__/gdi'
    builder.shapes = shapes
    builder.COUNT = 512
    for prefix, seed in (('mono-multiple', 20261016), ('mono-multiple-heldout', 20261017), ('mono-multiple-validation', 20261018)):
        for mode in (1, 4, 5):
            builder.build(destination, mode, seed, prefix)
            # Rotated controls reach below the original builder's -448
            # descender. Keep them within the native font cell so clipping
            # does not masquerade as a scan-conversion difference.
            path = destination/f'{prefix}-st{mode}.ttf'
            font = TTFont(path)
            glyphs = [font['glyf'][name] for name in font.getGlyphOrder()]
            font['OS/2'].usWinAscent = max(0, max(g.yMax for g in glyphs))
            font['OS/2'].usWinDescent = max(0, -min(g.yMin for g in glyphs))
            font.save(path)
