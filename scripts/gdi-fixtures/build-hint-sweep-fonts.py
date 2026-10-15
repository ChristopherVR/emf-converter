"""Build the private TrueType fonts used by HintSweepProbe.cs (fontTools).

Each font holds glyphs whose program executes ONE instruction of interest many
times on controlled points: a projection vector is set with SPVTL / SDPVTL on
two chosen points (a seeded sweep of angles and lengths; optionally those two
points are first rounded to the grid so that original and current vectors
differ), RP0 is point 0, and each of the other points is then moved by a single
MIRP / MDRP / MSIRP / MDAP / ALIGNRP with a chosen CVT value or distance. No
IUP, no other instruction. unitsPerEm is 1024 so that at 16 ppem one font unit
is exactly one 1/64 pixel (scaled coordinates equal font units). The result of
each instruction is read back through GetGlyphOutline(GGO_NATIVE).

The fonts are generated test inputs with no installed-font dependency (CC0).
"""
import array
import math
import os
import random
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.ttProgram import Program

ONLY = [k for k in os.environ.get('HINT_SWEEP_ONLY', '').split(',') if k]
TRIALS = 48          # moved points per glyph
GLYPHS = 250         # projection vectors per font
SEED = 20261015
FIRST = 4            # first moved point


def push(*values):
    return 'NPUSHW[] ' + ' '.join(str(v) for v in values)


# name: (vector instruction, premove, freedom vector, body, cutin, round state)
# body: mirp | mdrp | msirp | mdap | alignrp | mirp0 (MIRP[00000]) ...
KINDS = {
    # Vector from current points (SPVTL), the original-vs-current difference absent.
    'mirp-fvd':     dict(vec=None,      premove=False, fv='svtl', body='mirp'),
    'mdrp-fvd':     dict(vec=None,      premove=False, fv='svtl', body='mdrp'),
    'mirp-x':       dict(vec='SPVTL[0]', premove=False, fv='x', body='mirp'),
    'mirp-y':       dict(vec='SPVTL[0]', premove=False, fv='y', body='mirp'),
    'mirp-pv':      dict(vec='SPVTL[0]', premove=False, fv='pv', body='mirp'),
    'mirpr-x':      dict(vec='SPVTL[0]', premove=False, fv='x', body='mirp', rnd='RTG[]', flags='00100'),
    'mdrp-x':       dict(vec='SPVTL[0]', premove=False, fv='x', body='mdrp'),
    'mdrp-pv':      dict(vec='SPVTL[0]', premove=False, fv='pv', body='mdrp'),
    'msirp-x':      dict(vec='SPVTL[0]', premove=False, fv='x', body='msirp'),
    'alignrp-x':    dict(vec='SPVTL[0]', premove=False, fv='x', body='alignrp'),
    # Original and current vector differ: the two end points are rounded to the grid first.
    'mirp-sd-x':    dict(vec='SDPVTL[0]', premove=False, fv='x', body='mirp'),
    'mdrp-sd-x':    dict(vec='SDPVTL[0]', premove=False, fv='x', body='mdrp'),
    'mdrp-sdm-x':   dict(vec='SDPVTL[0]', premove=True, fv='x', body='mdrp'),
    'mdrp-sdm-y':   dict(vec='SDPVTL[0]', premove=True, fv='y', body='mdrp'),
    'mdrp-sdm-pv':  dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mdrp'),
    'mdrp-sdm1-x':  dict(vec='SDPVTL[1]', premove=True, fv='x', body='mdrp'),
    'mdrpr-sdm-x':  dict(vec='SDPVTL[0]', premove=True, fv='x', body='mdrp', rnd='RTG[]', flags='00100'),
    'mirp-sdm-x':   dict(vec='SDPVTL[0]', premove=True, fv='x', body='mirp'),
    'mirp-sdm-fo':  dict(vec='SDPVTL[0]', premove=True, fv='other', body='mirp'),
    'mdrp-sdm-fo':  dict(vec='SDPVTL[0]', premove=True, fv='other', body='mdrp'),
    'mirpr-sdm-fo': dict(vec='SDPVTL[0]', premove=True, fv='other', body='mirp', rnd='RTG[]', flags='00100'),
    'mirp-sdm-pv':  dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mirp'),
    'mirpc-sdm-x':  dict(vec='SDPVTL[0]', premove=True, fv='x', body='mirp', rnd='RTG[]', flags='00100', cutin=20, cvtnear=True),
    'mirpc-sdm-pv': dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mirp', rnd='RTG[]', flags='00100', cutin=20, cvtnear=True),
    # RP0 itself is a random point that is rounded to the grid first.
    'mdrp-sdm0-pv': dict(vec='SDPVTL[0]', premove=True, move0=True, fv='pv', body='mdrp'),
    'mdrp-sdm0-x':  dict(vec='SDPVTL[0]', premove=True, move0=True, fv='x', body='mdrp'),
    'mdrpr-sdm0-pv': dict(vec='SDPVTL[0]', premove=True, move0=True, fv='pv', body='mdrp', rnd='RTG[]', flags='00100'),
    'mirp-sdm0-pv': dict(vec='SDPVTL[0]', premove=True, move0=True, fv='pv', body='mirp'),
    'mirp-sdm0-x':  dict(vec='SDPVTL[0]', premove=True, move0=True, fv='x', body='mirp'),
    'mdrp-sdm1-pv': dict(vec='SDPVTL[1]', premove=True, fv='pv', body='mdrp'),
    'mdrpd-sdm1-pv': dict(vec='SDPVTL[1]', premove=True, fv='pv', body='mdrp', rnd='RDTG[]', flags='00100'),
    'mdrpr-sdm1-pv': dict(vec='SDPVTL[1]', premove=True, fv='pv', body='mdrp', rnd='RTG[]', flags='00100'),
    'mdrpu-sdm1-pv': dict(vec='SDPVTL[1]', premove=True, fv='pv', body='mdrp', rnd='RUTG[]', flags='00100'),
    'mdrph-sdm1-pv': dict(vec='SDPVTL[1]', premove=True, fv='pv', body='mdrp', rnd='RTHG[]', flags='00100'),
    # IUP after the move: which flags the move leaves on the point decides what IUP interpolates.
    'mdrp-iupxy-pv': dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mdrp', iup='xy', half=True),
    'mdrp-iupx-pv':  dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mdrp', iup='x', half=True),
    'mdrp-iupy-pv':  dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mdrp', iup='y', half=True),
    'mdrp-iupxy-x':  dict(vec='SDPVTL[0]', premove=True, fv='x', body='mdrp', iup='xy', half=True),
    'mdrp-iupxy-y':  dict(vec='SDPVTL[0]', premove=True, fv='y', body='mdrp', iup='xy', half=True),
    'mirp-iupxy-pv': dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mirp', iup='xy', half=True),
    'mirp-iupxy-x':  dict(vec='SDPVTL[0]', premove=True, fv='x', body='mirp', iup='xy', half=True),
    'alignrp-iupxy-pv': dict(vec='SDPVTL[0]', premove=True, fv='pv', body='alignrp', iup='xy', half=True),
    'mdap-iupxy-pv': dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mdap', iup='xy', half=True),
    'mirp-iupxy-ax': dict(vec=None, premove=False, fv='x', body='mirp', iup='xy', half=True),
    'mirp-iupxy-ay': dict(vec=None, premove=False, fv='y', body='mirp', iup='xy', half=True),
    # Near-perpendicular projection and freedom vectors (|dot| below 1024): the clamp.
    'mirp-xsteep':  dict(vec='SPVTL[0]', premove=False, fv='x', body='mirp', steep='x'),
    'mirp-ysteep':  dict(vec='SPVTL[0]', premove=False, fv='y', body='mirp', steep='y'),
    'mdrp-xsteep-sdm': dict(vec='SDPVTL[0]', premove=True, fv='x', body='mdrp', steep='x'),
    'mirp-fvdsteep': dict(vec=None, premove=False, fv='svtl', body='mirp', steep='x'),
    'mirp-negx':    dict(vec='SPVTL[0]', premove=False, fv='x', body='mirp', steep='negx'),
    'mirp-negy':    dict(vec='SPVTL[0]', premove=False, fv='y', body='mirp', steep='negy'),
    'mirp-posy-fx': dict(vec='SPVTL[0]', premove=False, fv='x', body='mirp', steep='posy'),
    'mirp-negy-fx': dict(vec='SPVTL[0]', premove=False, fv='x', body='mirp', steep='negy'),
    'mirp-negx-fy': dict(vec='SPVTL[0]', premove=False, fv='y', body='mirp', steep='negx'),
    'mdap-sdm-x':   dict(vec='SDPVTL[0]', premove=True, fv='x', body='mdap'),
    'mdap-sdm-pv':  dict(vec='SDPVTL[0]', premove=True, fv='pv', body='mdap'),
    'mdap-sdm-y':   dict(vec='SDPVTL[0]', premove=True, fv='y', body='mdap'),
    'alignrp-sdm-x': dict(vec='SDPVTL[0]', premove=True, fv='x', body='alignrp'),
    'alignrp-sdm-pv': dict(vec='SDPVTL[0]', premove=True, fv='pv', body='alignrp'),
    'msirp-sdm-x':  dict(vec='SDPVTL[0]', premove=True, fv='x', body='msirp'),
}


def vectors(rng, n, steep=None):
    out = []
    for _ in range(n):
        a = rng.uniform(0, 2 * math.pi)
        if steep == 'x':      # nearly vertical: |pvx| < 1024 of 16384
            a = rng.choice([math.pi / 2, 3 * math.pi / 2]) + rng.uniform(-0.0625, 0.0625)
        elif steep == 'negx':
            a = math.pi
        elif steep == 'negy':
            a = 3 * math.pi / 2
        elif steep == 'posy':
            a = math.pi / 2
        elif steep == 'y':    # nearly horizontal
            a = rng.choice([0, math.pi]) + rng.uniform(-0.0625, 0.0625)
        r = rng.uniform(200, 3000)
        v = (round(r * math.cos(a)), round(r * math.sin(a)))
        out.append(v if v != (0, 0) else (1, 1))
    return out


def iup_tail(spec):
    iup = spec.get('iup', '')
    return (['IUP[0]'] if 'y' in iup else []) + (['IUP[1]'] if 'x' in iup else [])


def program(spec, dists):
    lines = ['SVTCA[1]', push(spec.get('cutin', 0x3000)), 'SCVTCI[]']
    if spec['premove']:
        lines += ['RTG[]']
        for axis in ('SVTCA[1]', 'SVTCA[0]'):
            lines += [axis, push(3), 'MDAP[1]', push(2), 'MDAP[1]']
            if spec.get('move0'):
                lines += [push(0), 'MDAP[1]']
    lines += ['SVTCA[1]']
    if spec['vec']:
        lines += [push(2, 3), spec['vec']]
    fv = spec['fv']
    if fv == 'x':
        lines += ['SFVTCA[1]']
    elif fv == 'y':
        lines += ['SFVTCA[0]']
    elif fv == 'pv':
        lines += ['SFVTPV[]']
    elif fv == 'other':
        lines += [push(1, 0), 'SFVTL[0]']
    elif fv == 'svtl':
        lines += [push(3, 2), 'SFVTL[0]']
    lines += [spec.get('rnd', 'ROFF[]')]
    body = spec['body']
    idx = list(range(0, TRIALS, 2)) if spec.get('half') else list(range(TRIALS))
    if body == 'mdap':
        for i in reversed(idx):
            lines.append(push(FIRST + i))
        lines += ['MDAP[1]'] * len(idx)
        lines += iup_tail(spec)
        return lines
    lines += [push(0), 'SRP0[]']
    if body == 'mirp':
        for i in reversed(idx):
            lines.append(push(FIRST + i, i))
        lines += ['MIRP[%s]' % spec.get('flags', '00000')] * len(idx)
    elif body == 'mdrp':
        for i in reversed(idx):
            lines.append(push(FIRST + i))
        lines += ['MDRP[%s]' % spec.get('flags', '00000')] * len(idx)
    elif body == 'msirp':
        for i in reversed(idx):
            lines.append(push(FIRST + i, dists[i]))
        lines += ['MSIRP[0]'] * len(idx)
    elif body == 'alignrp':
        for i in reversed(idx):
            lines.append(push(FIRST + i))
        lines += ['ALIGNRP[]'] * len(idx)
    lines += iup_tail(spec)
    return lines


def make_font(name, glyph_specs, cvt, directory):
    family = 'Parity Hint Sweep ' + name
    fb = FontBuilder(1024, isTTF=True)
    order = ['.notdef'] + ['g%d' % i for i in range(len(glyph_specs))]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({0xE000 + i: n for i, n in enumerate(order[1:])})
    glyphs = {}
    for i, n in enumerate(order):
        pen = TTGlyphPen(None)
        if i == 0:
            pen.moveTo((0, 0)); pen.lineTo((0, 500)); pen.lineTo((500, 500)); pen.lineTo((500, 0)); pen.closePath()
            g = pen.glyph()
        else:
            pts, asm = glyph_specs[i - 1]
            pen.moveTo(pts[0])
            for p in pts[1:]:
                pen.lineTo(p)
            pen.closePath()
            g = pen.glyph()
            prog = Program()
            prog.fromAssembly(asm)
            g.program = prog
        glyphs[n] = g
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (1024, glyphs[n].xMin if hasattr(glyphs[n], 'xMin') else 0) for n in order})
    fb.setupHorizontalHeader(ascent=900, descent=-200)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family + ' 1',
                       'fullName': family, 'psName': family.replace(' ', ''), 'version': 'Version 1.0',
                       'licenseDescription': 'Generated diagnostic font; CC0 1.0.'})
    fb.setupOS2(sTypoAscender=900, sTypoDescender=-200, usWinAscent=900, usWinDescent=200)
    fb.setupPost()
    fb.setupMaxp()
    mp = fb.font['maxp']
    mp.maxZones = 2
    mp.maxTwilightPoints = 0
    mp.maxStorage = 2
    mp.maxFunctionDefs = 0
    mp.maxInstructionDefs = 0
    mp.maxStackElements = 400
    mp.maxSizeOfInstructions = 4000
    fb.font['cvt '] = newTable('cvt ')
    fb.font['cvt '].values = array.array('h', cvt)
    fb.font['head'].created = fb.font['head'].modified = 3500000000
    fb.save(directory / ('hint-sweep-%s.ttf' % name))


def main(directory):
    for name, spec in KINDS.items():
        if ONLY and name not in ONLY:
            continue
        # One generator per font so that adding a font never changes another.
        rng = random.Random('%d/%s' % (SEED, name))
        vecs = vectors(rng, GLYPHS, spec.get('steep'))
        specs = []
        cvt = []
        for g, (a, b) in enumerate(vecs):
            pts = [(rng.randint(-300, 300), rng.randint(-300, 300)) if spec.get('move0') else (0, 0), (rng.randint(-900, 900), rng.randint(-900, 900)),
                   (-400 + rng.randint(-30, 30), 100 + rng.randint(-30, 30)), (-400 + a + rng.randint(-30, 30), 100 + b + rng.randint(-30, 30))]
            for _ in range(TRIALS):
                pts.append((rng.randint(-1500, 1500), rng.randint(-1500, 1500)))
            seen = set(); fixed = []
            for p in pts:
                while p in seen:
                    p = (p[0] + 1, p[1])
                seen.add(p); fixed.append(p)
            dists = [rng.randint(-600, 600) for _ in range(TRIALS)]
            specs.append((fixed, program(spec, dists)))
        if spec.get('cvtnear'):
            # CVT values near the original distance of each point so the cut-in decides: one cvt per trial slot,
            # shared across glyphs, so use the same small spread for every glyph.
            cvt = [rng.randint(-1800, 1800) for _ in range(TRIALS)]
        else:
            cvt = [rng.randint(-600, 600) for _ in range(TRIALS)]
        make_font(name, specs, cvt, directory)


if __name__ == '__main__':
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'src/__fixtures__/gdi'
    main(dest)
