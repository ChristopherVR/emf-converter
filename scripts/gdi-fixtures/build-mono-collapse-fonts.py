"""CC0 private-font controls for collapsed monochrome pixel boxes.

Every 26.6 origin phase from -64 to 63, ten thicknesses either side of one
pixel, both axes, rectangles and triangle tips. At 32 ppem a font unit is a
26.6 unit, isolating scan conversion from font scaling and hinting.
"""
import importlib.util
from pathlib import Path
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mono_stub_builder', HERE/'build-mono-stub-fonts.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def shapes(_seed):
    result = []
    for lo in range(-64, 64):
        for thickness in (1, 2, 3, 7, 15, 31, 47, 63, 64, 65):
            hi = lo + thickness
            for kind in range(4):
                pts = [(lo, -73), (lo, 417), (hi, 417), (hi, -73)] if kind < 2 else [(lo, -73), ((lo+hi)//2, 417), (hi, -73)]
                if kind % 2:
                    pts = [(y, x) for x, y in pts[::-1]]
                pen = TTGlyphPen(None)
                pen.moveTo(pts[0])
                for p in pts[1:]:
                    pen.lineTo(p)
                pen.closePath()
                result.append(pen.glyph())
    return result


def unit_stem(_seed):
    # Same unhinted hairline as buildTestFont() glyph 3, captured at 10 ppem.
    # The minimal unit-test font is intentionally not a Windows installable font.
    pen = TTGlyphPen(None)
    pen.moveTo((1000, 0))
    pen.lineTo((1000, 1400))
    pen.lineTo((1040, 1400))
    pen.lineTo((1040, 0))
    pen.closePath()
    return [pen.glyph()]


if __name__ == '__main__':
    destination = HERE.parents[1]/'src/__fixtures__/gdi'
    builder.shapes = shapes
    builder.COUNT = 5120
    for mode in (1, 5):
        builder.build(destination, mode, 20261015, 'mono-collapse')
    builder.shapes = unit_stem
    builder.COUNT = 1
    for mode in (1, 5):
        builder.build(destination, mode, 20261015, 'mono-unit-stem')
