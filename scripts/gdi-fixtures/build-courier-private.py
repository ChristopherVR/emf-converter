"""Rename an installed Courier New for a private native comparison.

The generated font stays in the requested scratch directory. No Windows font
data is bundled; only its native rendered measurements are committed.
"""
import argparse
from pathlib import Path
from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
font = TTFont(args.source)
for record in font["name"].names:
    if record.nameID in (1, 4, 6, 16):
        name = "ParityCourier" if record.nameID == 6 else "Parity Courier"
        record.string = name.encode(record.getEncoding())
args.output.parent.mkdir(parents=True, exist_ok=True)
font.save(args.output)
