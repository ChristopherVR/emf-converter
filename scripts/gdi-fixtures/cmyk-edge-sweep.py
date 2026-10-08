"""
Edge sweep of the Windows ICM CMYK module (RSWOP.icm to sRGB, perceptual intent, best mode).

  python cmyk-edge-sweep.py inputs <dir>            writes <dir>/edges.cmyk16: every 16-bit word 0..65535 along the 32 edges
                                                    of the ink hypercube (one ink sweeps, the other three are 0 or 65535)
  (run `generate.ps1 icm-cmyk-translate16 -TablesDir <dir>` in 64-bit PowerShell: it writes <dir>/edges.rgb16t)
  python cmyk-edge-sweep.py pack <dir> <out.bin.gz> keeps what src/icm-cmyk-edges.fixture.test.ts reads: the 256 lattice words
                                                    257 v of the 32 edges, and words 0..4399 of two edges in full

Edge e = ink * 8 + mask: the swept ink is `ink`, the other three inks in increasing order take 65535 where the mask bit is set.
The full sweep is 16 MB of input and 12 MB of output and is regenerable; only the packed subset (about 0.5 MB) is committed.
"""
import gzip
import os
import struct
import sys

import numpy as np

EDGE_WORDS = 4400
FULL_EDGES = ((0, 3), (3, 7))  # (ink, mask) kept in full for the first 4400 words


def inputs(directory: str) -> None:
    out = bytearray()
    for ink in range(4):
        others = [d for d in range(4) if d != ink]
        for mask in range(8):
            for w in range(65536):
                c = [0, 0, 0, 0]
                for i, o in enumerate(others):
                    c[o] = 65535 if (mask >> i) & 1 else 0
                c[ink] = w
                out += struct.pack('<4H', *c)
    with open(os.path.join(directory, 'edges.cmyk16'), 'wb') as f:
        f.write(out)


def pack(directory: str, target: str) -> None:
    r = np.fromfile(os.path.join(directory, 'edges.rgb16t'), dtype='<u2').reshape(4, 8, 65536, 3)
    parts = [r[:, :, 257 * np.arange(256), :].astype('<u2').tobytes()]
    for ink, mask in FULL_EDGES:
        parts.append(r[ink, mask, :EDGE_WORDS, :].astype('<u2').tobytes())
    with gzip.open(target, 'wb', 9) as f:
        f.write(b''.join(parts))


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'inputs':
        inputs(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == 'pack':
        pack(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
