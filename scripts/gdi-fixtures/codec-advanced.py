"""Encode TIFF variants for native Windows decoding (requires Python + Pillow)."""
import io
import json
from pathlib import Path
import struct
import sys
import zlib

import PIL
from PIL import Image, features

destination = Path(sys.argv[1])
width, height = 37, 19
source = Image.new("RGB", (width, height))
source.putdata([((x * 7 + y * 3) % 256, (y * 13 + x * 2) % 256,
                 (255 - x * 5 + y) % 256)
                for y in range(height) for x in range(width)])


def write_tiff(name, compression, tiled=False, predictor=False, rgb=True):
    block_width, block_height = (16, 16) if tiled else (width, 16 if compression == 7 else 7)
    chunks = []
    for y in range(0, height, block_height):
        for x in range(0, width, block_width):
            bottom = y + block_height if tiled else min(height, y + block_height)
            block = source.crop((x, y, x + block_width, bottom))
            if compression == 7:
                stream = io.BytesIO()
                block.save(stream, format="JPEG", quality=85, keep_rgb=rgb)
                chunks.append(stream.getvalue())
            else:
                data = bytearray(block.tobytes())
                if predictor:
                    for row in range(block.height):
                        start = row * block_width * 3
                        for pixel in range(block_width * 3 - 1, 2, -1):
                            data[start + pixel] = (data[start + pixel] - data[start + pixel - 3]) % 256
                chunks.append(zlib.compress(data) if compression != 1 else bytes(data))

    offsets_tag, lengths_tag = (324, 325) if tiled else (273, 279)
    entries = [(256, 4, 1, width), (257, 4, 1, height), (258, 3, 3, 0),
               (259, 3, 1, compression), (262, 3, 1, 6 if compression == 7 and not rgb else 2),
               (277, 3, 1, 3), (284, 3, 1, 1),
               (offsets_tag, 4, len(chunks), 0), (lengths_tag, 4, len(chunks), 0)]
    entries += [(322, 4, 1, block_width), (323, 4, 1, block_height)] if tiled else [(278, 4, 1, block_height)]
    if predictor:
        entries.append((317, 3, 1, 2))
    entries.sort()
    bits = 8 + 2 + 12 * len(entries) + 4
    offset_array = bits + 6
    length_array = offset_array + 4 * len(chunks)
    start = length_array + 4 * len(chunks)
    offsets = []
    for chunk in chunks:
        offsets.append(start)
        start += len(chunk)
    entries = [(tag, kind, count,
                bits if tag == 258 else offset_array if tag == offsets_tag else
                length_array if tag == lengths_tag else value)
               for tag, kind, count, value in entries]
    encoded = b"II" + struct.pack("<HIH", 42, 8, len(entries))
    encoded += b"".join(struct.pack("<HHII", *entry) for entry in entries)
    encoded += struct.pack("<IHHH", 0, 8, 8, 8)
    encoded += struct.pack("<" + "I" * len(chunks), *offsets)
    encoded += struct.pack("<" + "I" * len(chunks), *(len(chunk) for chunk in chunks))
    encoded += b"".join(chunks)
    (destination / f"codec-tiff-{name}.bin").write_bytes(encoded)


write_tiff("deflate-strips", 8)
write_tiff("deflate-legacy-strips", 32946)
write_tiff("deflate-predictor-strips", 8, predictor=True)
write_tiff("uncompressed-tiles", 1, tiled=True)
write_tiff("deflate-tiles", 8, tiled=True)
write_tiff("deflate-legacy-tiles", 32946, tiled=True)
write_tiff("jpeg-ycbcr-strips", 7, rgb=False)
write_tiff("jpeg-rgb-tiles", 7, tiled=True)
write_tiff("jpeg-ycbcr-tiles", 7, tiled=True, rgb=False)
# libtiff emits abbreviated RGB JPEG strips with a shared JPEGTables tag.
source.save(destination / "codec-tiff-jpeg-rgb-strips.bin", format="TIFF", compression="jpeg")
for name, subsampling, progressive in [("444", 0, False), ("422", 1, False),
                                      ("420", 2, False), ("progressive", 2, True)]:
    source.save(destination / f"codec-jpeg-{name}.bin", format="JPEG", quality=85,
                subsampling=subsampling, progressive=progressive)
source.save(destination / "codec-jpeg-rgb.bin", format="JPEG", quality=85, keep_rgb=True)
source.convert("L").save(destination / "codec-jpeg-grey.bin", format="JPEG", quality=85)
(destination / "codec-advanced-encoder.json").write_text(json.dumps({
    "python": sys.version.split()[0], "pillow": PIL.__version__,
    "libtiff": features.version_codec("libtiff"), "jpeg": features.version_codec("jpg"),
}, indent=2) + "\n", encoding="utf-8")
