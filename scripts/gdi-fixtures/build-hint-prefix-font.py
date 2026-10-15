"""Build a private TrueType font whose glyphs are instruction-prefix variants of glyphs
of an installed font (fontTools; the output is a derived test input and is not committed
when the source font is a Microsoft font).

Every variant keeps the source glyph's points and the source font's `fpgm`, `prep` and
`cvt `, but its glyph program stops after the first k instructions (an IF block open at
the cut is closed with EIF). GetGlyphOutline(GGO_NATIVE) of variant k is therefore
native's grid-fitted state after exactly k instructions. Variant 0 has no program.
Glyph j (in the order of <characters>) variant k is character U+E000 + 256 * j + k;
a program with more than 255 instruction boundaries is sampled evenly.

  python build-hint-prefix-font.py <source.ttf> <characters> <out.ttf> [Family] [--replace]

--replace overwrites glyphs from the end of the font instead of appending new ones, which keeps every other
table (hdmx, LTSH, VDMX, OS/2) intact, as GDI derives tmAveCharWidth (the natural width an lfWidth is compared
with) from them.

Writes <out>.json: for every character the byte offset of each variant's cut.
"""
import copy
import json
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import ttProgram

MAX_VARIANTS = 256


def instruction_offsets(code):
    """Byte offset and IF nesting depth before each instruction of `code`."""
    offsets = []
    i = 0
    depth = 0
    n = len(code)
    while i < n:
        op = code[i]
        offsets.append((i, depth))
        size = 1
        if op == 0x40:  # NPUSHB
            size = 2 + (code[i + 1] if i + 1 < n else 0)
        elif op == 0x41:  # NPUSHW
            size = 2 + 2 * (code[i + 1] if i + 1 < n else 0)
        elif 0xB0 <= op <= 0xB7:
            size = 1 + (op - 0xB0 + 1)
        elif 0xB8 <= op <= 0xBF:
            size = 1 + 2 * (op - 0xB8 + 1)
        if op == 0x58:  # IF
            depth += 1
        elif op == 0x59:  # EIF
            depth -= 1
        i += size
    return offsets, n


def main():
    replace = '--replace' in sys.argv
    argv = [a for a in sys.argv[1:] if a != '--replace']
    source, characters, out = argv[0], argv[1], argv[2]
    family = argv[3] if len(argv) > 3 else 'Parity Prefix'
    font = TTFont(source, fontNumber=0)
    cmap = font.getBestCmap()
    glyf = font['glyf']
    hmtx = font['hmtx']
    order = list(font.getGlyphOrder())
    original_order = list(order)
    slot = 0
    meta = {'source': source, 'glyphs': []}
    unicode_tables = [t for t in font['cmap'].tables if t.isUnicode()]
    for j, char in enumerate(characters):
        name = cmap[ord(char)]
        src = glyf[name]
        if src.isComposite():
            raise SystemExit('composite glyph %r is not supported' % char)
        code = bytes(src.program.getBytecode())
        offsets, total = instruction_offsets(code)
        depth_at = {off: depth for off, depth in offsets}
        depth_at[total] = 0
        cuts = sorted(set([0] + [off for off, _ in offsets[1:]] + [total]))
        if len(cuts) > MAX_VARIANTS:
            step = (len(cuts) - 1) / (MAX_VARIANTS - 1)
            cuts = sorted(set(cuts[round(i * step)] for i in range(MAX_VARIANTS)))
        meta['glyphs'].append({'char': char, 'glyph': name, 'cuts': cuts, 'length': total})
        for k, cut in enumerate(cuts):
            g = copy.deepcopy(src)
            p = ttProgram.Program()
            p.fromBytecode(code[:cut] + bytes([0x59]) * max(0, depth_at.get(cut, 0)))
            g.program = p
            if replace:
                gname = original_order[-1 - slot]
                slot += 1
                glyf.glyphs[gname] = g
                hmtx.metrics[gname] = hmtx.metrics[name]
            else:
                gname = 'prefix%d_%d' % (j, k)
                glyf.glyphs[gname] = g
                order.append(gname)
                hmtx.metrics[gname] = hmtx.metrics[name]
            for table in unicode_tables:
                table.cmap[0xE000 + 256 * j + k] = gname
    font.setGlyphOrder(order)
    glyf.glyphOrder = order
    for tag in ('DSIG', 'GSUB', 'GPOS', 'GDEF', 'kern', 'post'):
        if tag in font:
            del font[tag]
    font['maxp'].numGlyphs = len(order)
    for record in list(font['name'].names):
        if record.nameID in (1, 4, 16):
            record.string = family
        elif record.nameID == 6:
            record.string = family.replace(' ', '')
        elif record.nameID == 3:
            record.string = family + ' 1'
        elif record.nameID in (2, 17):
            record.string = 'Regular'
    # keep the source font's xAvgCharWidth: GDI derives the natural tmAveCharWidth (and so lfWidth stretching) from it
    if 'OS/2' in font:
        font['OS/2'].recalcAvgCharWidth = False
    font.save(out)
    Path(out + '.json').write_text(json.dumps(meta))
    print(sum(len(g['cuts']) for g in meta['glyphs']), 'variants over', len(meta['glyphs']), 'glyphs')


main()
