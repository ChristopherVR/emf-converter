"""Writes the CMYK JPEG inputs that the native colour-conversion table is fitted from.

    python cmyk-lut-inputs.py <directory>

`grid.jpg` holds the 17^4 grid of ink values 0, 16, ..., 255 (round(255 j / 16)); `rand*.jpg` and `hold*.jpg` hold
random ink values. Every sample is one flat 8 x 8 block at quality 100 (4:4:4), so its decoded components are
exactly the ink values the file stores. Pillow writes Adobe APP14 CMYK with inverted samples.
`generate.ps1 image-codecs-cmyk-lut -TablesDir <directory>` makes GDI+ decode each one to a PNG. These pairs were the
input of the 17^4 grid fitted before the transform was identified as the Windows ICM module; they remain the way to
check any CMYK table against what GDI+ itself draws (738,881 samples: `generate-cmyk-lut.ts` now solves the 16^4 ICM
table from `mscms.dll` instead, see its header). The IcmProbe output matches these PNGs byte for byte.
"""
import random
import sys
from pathlib import Path

from PIL import Image

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
random.seed(11)


def build(name, samples, columns):
    rows = (len(samples) + columns - 1) // columns
    image = Image.new("CMYK", (columns * 8, rows * 8))
    for i, sample in enumerate(samples):
        x, y = (i % columns) * 8, (i // columns) * 8
        image.paste(sample, (x, y, x + 8, y + 8))
    image.save(destination / f"{name}.jpg", quality=100, subsampling=0)


def random_sample(kind):
    if kind == 0:  # uniform
        return tuple(random.randrange(256) for _ in range(4))
    if kind == 1:  # each ink either absent or uniform
        return tuple(random.choice([0, random.randrange(256)]) for _ in range(4))
    if kind == 2:  # light inks
        return tuple(min(255, int(random.random() ** 2 * 256)) for _ in range(4))
    # uniform process inks with a sparse black
    return tuple(random.randrange(256) for _ in range(3)) + (random.choice([0, random.randrange(256)]),)


grid = [round(255 * j / 16) for j in range(17)]
build("grid", [(c, m, y, k) for c in grid for m in grid for y in grid for k in grid], 289)
for n in range(40):
    build(f"rand{n}", [random_sample(n % 4) for _ in range(128 * 128)], 128)
for n in range(2):
    build(f"hold{n}", [random_sample(random.randrange(4)) for _ in range(128 * 128)], 128)
