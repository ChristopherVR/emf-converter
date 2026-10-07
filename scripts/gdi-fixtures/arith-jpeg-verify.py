"""Proves arith-jpeg-encoder.ts: each arithmetic JPEG must decode (Pillow / libjpeg-turbo) to the same pixels as the
Huffman control file that holds the same quantised coefficients.

    bun scripts/gdi-fixtures/arith-jpeg-encoder.ts <dir> --control <controls>
    python arith-jpeg-verify.py <dir> <controls>
"""
import sys
from pathlib import Path

from PIL import Image

directory, controls = Path(sys.argv[1]), Path(sys.argv[2])
bad = 0
for path in sorted(directory.glob("codec-jpeg-arith-*.bin")):
    if path.stem.endswith("-huffman"):
        continue
    control = controls / (path.stem + ".ctl")
    try:
        with Image.open(path) as a, Image.open(control) as b:
            progressive = a.info.get("progressive") or a.info.get("progression")
            a.load(), b.load()
            same = a.mode == b.mode and a.size == b.size and a.tobytes() == b.tobytes()
        detail = f"{a.mode} {a.size}{' progressive' if progressive else ''}"
    except Exception as error:  # a file Pillow cannot decode is an encoder failure
        same, detail = False, repr(error)
    print("ok  " if same else "FAIL", path.name, detail)
    bad += not same
sys.exit(1 if bad else 0)
