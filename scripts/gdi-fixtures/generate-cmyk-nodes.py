"""
Rebuilds `src/jpeg-cmyk-data.ts`, the 16^4 node table of Windows' CMYK -> sRGB conversion for CMYK JPEG (see the module
comment of `src/jpeg-cmyk.ts` for what the native module does). Needs numpy and a Windows machine (the native steps run
`generate.ps1 icm-cmyk-translate16` / `icm-cmyk-srgb16` in 64-bit PowerShell, the same modes as before).

  python generate-cmyk-nodes.py nodes   <dir>   writes <dir>/nodes.cmyk16: one 16-bit probe exactly on each of the 65,536 nodes
  powershell ... generate.ps1 icm-cmyk-translate16 -TablesDir <dir>             -> <dir>/nodes.rgb16t
  python generate-cmyk-nodes.py read    <dir>   reads the nodes back (<dir>/nodes_direct.npy, nodes_flag.npy) and writes the
                                                sample sets (*.ink) the refinement uses
  powershell ... generate.ps1 icm-cmyk-srgb16 -TablesDir <dir>                  -> <dir>/*.srgb16, *.srgb8
  python generate-cmyk-nodes.py solve   <dir>   refines the nodes against the samples (<dir>/nodes.npy)
  python generate-cmyk-nodes.py check   <dir>   counts 8-bit mismatches on the held-out sets (val, val2)
  python generate-cmyk-nodes.py encode  <dir> <out.ts>

Native facts the script relies on (all pinned by src/jpeg-cmyk.test.ts):
  - a 16-bit ink word lands at x = w - (w >> 8) - 2; the 8-bit lattice position of ink v is `positions()` below, in 1/4096 cell;
    the word that puts an ink on node j (j <= 14) is found by searching `positions()` of every word, so a probe sits exactly on a node;
  - a node probe reads back as 16 bits through the output table K[m] = (65599 m + 511) >> 10 of `finish()`, which is
    (almost) invertible, so the node value is the table input that gives the read-back (clipped read-backs are unknown nodes);
  - the 8-bit result is (S + 4096) >> 20 with S the weighted node sum (weights are integers summing to 4096), so every native 8-bit
    conversion is an exact interval constraint on the nodes it touches. `solve` snaps nodes to maximise the number of satisfied
    constraints (heaviest weights first), then breaks the ties that 8 bits cannot (clipped nodes) with the 16-bit conversions.
"""
import sys, os, zlib
import numpy as np

CMD, DIR = sys.argv[1], sys.argv[2]
P = lambda *a: os.path.join(DIR, *a)


def curve(v):
    return 0 if v <= 0 else (256 * v - 1 if v <= 224 else 57343 + ((v - 224) * 8192) // 31)


def step_entry(i):
    return 0 if i == 0 else curve(i) + 1


def positions():
    """Grid position (1/4096 cell) of each 8-bit ink; identical to cmykInputPositions in src/jpeg-cmyk.ts."""
    p = np.zeros(256, np.int64)
    for v in range(1, 255):
        a, b = step_entry(v - 1), step_entry(v)
        low = a + (((b - a) * 15) >> 4)
        p[v] = (15 * low + (b - low) * 14 + 2) >> 4
    p[255] = 15 * 4096
    return p


def word_position(w):
    """Position of a 16-bit word; exact for positions below cell 13 (the tail needs more than this)."""
    if w >= 65535:
        return 15 * 4096
    x = max(w - (w >> 8) - 2, 0)
    i, q, r = min(x >> 8, 254), (x >> 4) & 15, x & 15
    a, b = step_entry(i), step_entry(i + 1)
    lo = a + (((b - a) * q) >> 4)
    hi = a + (((b - a) * (q + 1)) >> 4)
    return (15 * lo + (hi - lo) * r + 2) >> 4


P4 = positions()
MI = np.arange(1027, dtype=np.int64)
K = ((MI * 65599 + 511) >> 10).astype(np.float64)
ALPHA, C0 = 65472 / 65535, 511 / 1024


def finish(n):
    y = n * ALPHA + C0
    p = np.clip(y / 64.0, 0, 1023.999999)
    m = np.floor(p).astype(np.int64)
    return K[m] + (K[m + 1] - K[m]) * (p - m)


def nid(a):
    return ((a[:, 0] * 16 + a[:, 1]) * 16 + a[:, 2]) * 16 + a[:, 3]


def simplex(ink):
    n = len(ink)
    g = P4[ink]
    j = np.minimum(g >> 12, 14)
    f = g - (j << 12)
    order = np.argsort(-f, axis=1, kind='stable')
    fs = np.take_along_axis(f, order, axis=1)
    w = np.stack([4096 - fs[:, 0]] + [fs[:, s] - (fs[:, s + 1] if s < 3 else 0) for s in range(4)])
    cur = j.copy()
    idx = [cur.copy()]
    for s in range(4):
        cur[np.arange(n), order[:, s]] += 1
        idx.append(cur.copy())
    return idx, w


def load(name):
    ink = np.fromfile(P(name + '.ink'), np.uint8).reshape(-1, 4).astype(np.int64)
    s16 = np.fromfile(P(name + '.srgb16'), '<u2').reshape(-1, 3).astype(np.int64)[:, ::-1]
    s8 = np.fromfile(P(name + '.srgb8'), np.uint8).reshape(-1, 4).astype(np.int64)[:, 2::-1]
    return ink, s16, s8


def node_words():
    best = []
    for j in range(16):
        target = 4096 * j
        cand = min(range(65536), key=lambda w: abs(word_position(w) - target))
        best.append(cand)
    return best


def cmd_nodes():
    os.makedirs(DIR, exist_ok=True)
    words = np.array(node_words(), '<u2')
    idx = np.indices((16, 16, 16, 16)).reshape(4, -1).T
    words[idx].astype('<u2').tofile(P('nodes.cmyk16'))
    print('node words', words.tolist())


def cmd_read():
    raw = np.fromfile(P('nodes.rgb16t'), '<u2').reshape(16, 16, 16, 16, 3).astype(np.int64)
    n_all = np.arange(-2000, 67536, dtype=np.int64)
    out = np.floor(finish(n_all.astype(np.float64)) + 0.5)
    inv = {}
    for n, o in zip(n_all, out):
        inv.setdefault(int(o), []).append(int(n))
    nodes = np.zeros(raw.shape, np.float64)
    flag = np.zeros(raw.shape, np.int8)       # 1 clipped, 2 not producible, 3 two candidates
    for ix in np.ndindex(raw.shape):
        o = int(raw[ix])
        if o in (0, 65535):
            flag[ix] = 1
            nodes[ix] = o
            continue
        c = inv.get(o)
        if not c:
            flag[ix] = 2
            nodes[ix] = o
            continue
        flag[ix] = 3 if len(c) > 1 else 0
        nodes[ix] = c[0]
    np.save(P('nodes_direct.npy'), nodes)
    np.save(P('nodes_flag.npy'), flag)
    print('flagged nodes', int((flag != 0).any(axis=4).sum()))
    # sample sets
    rng = np.random.default_rng(777)
    save = lambda name, a: a.astype(np.uint8).tofile(P(name + '.ink'))

    def near(j):
        below = np.where(P4 <= 4096 * j)[0]
        above = np.where(P4 >= 4096 * j)[0]
        return sorted({int(below.max()) if len(below) else 0, int(above.min()) if len(above) else 255})
    lists = [np.array(near(j)) for j in range(16)]
    ix = np.indices((16, 16, 16, 16)).reshape(4, -1).T
    rows = []
    for combo in np.indices((2, 2, 2, 2)).reshape(4, -1).T:
        rows.append(np.stack([np.array([lists[j][min(c, len(lists[j]) - 1)] for j in ix[:, d]]) for d, c in enumerate(combo)], 1))
    save('nearall', np.unique(np.concatenate(rows), axis=0))
    save('uniform', rng.integers(0, 256, size=(3_000_000, 4)))
    save('train2', rng.integers(0, 256, size=(6_000_000, 4)))
    nv = np.array(sorted({v for j in range(16) for v in near(j)}))
    a = rng.integers(0, 256, size=(4_000_000, 4))
    mode = rng.integers(0, 4, size=a.shape)
    a = np.where(mode == 0, 0, np.where(mode == 1, 255, np.where(mode == 2, np.clip(nv[rng.integers(0, len(nv), a.shape)] + rng.integers(-2, 3, a.shape), 0, 255), a)))
    save('train3', a)
    low = np.zeros((2_000_000, 4), np.int64)
    low[:, 3] = rng.integers(0, 256, 2_000_000)
    low[:, :3] = rng.integers(0, 64, (2_000_000, 3))
    save('train4', low)
    rng2 = np.random.default_rng(99991)
    save('val', rng2.integers(0, 256, size=(1_000_000, 4)))
    save('val2', rng2.integers(0, 256, size=(2_000_000, 4)))
    # near-node samples of the flagged nodes with a wider ring
    coords = np.argwhere((flag != 0).any(axis=4))
    import itertools
    def ring(j):
        below = np.where(P4 <= 4096 * j)[0]
        above = np.where(P4 >= 4096 * j)[0]
        vb = int(below.max()) if len(below) else 0
        va = int(above.min()) if len(above) else 255
        return sorted({min(max(v, 0), 255) for v in (vb - 1, vb, va, va + 1)})
    near_rows = np.unique(np.array([c for node in coords for c in itertools.product(*[ring(int(j)) for j in node])], np.uint8), axis=0)
    save('near', near_rows)
    print('samples written; now run generate.ps1 icm-cmyk-srgb16 -TablesDir', DIR)


def best_int(a, b, cur):
    s, e = np.ceil(a - 1e-9), np.ceil(b - 1e-9)
    pts = np.concatenate([s, e])
    vals = np.concatenate([np.ones(len(s)), -np.ones(len(e))])
    order = np.argsort(pts, kind='stable')
    pts, vals = pts[order], vals[order]
    cov = np.cumsum(vals)
    best = cov.max()
    if ((s <= cur) & (e > cur)).sum() >= best:
        return cur
    pick = None
    for ci in np.where(cov == best)[0]:
        lo = pts[ci]
        hi = pts[ci + 1] - 1 if ci + 1 < len(pts) else lo
        if hi < lo:
            continue
        nn = min(max(cur, lo), hi)
        if pick is None or abs(nn - cur) < abs(pick - cur):
            pick = nn
    return cur if pick is None else pick


class Solver:
    def __init__(self, names, start, wmin):
        nodes, wts, s8, s16 = [], [], [], []
        for nm in names:
            ink, a16, a8 = load(nm)
            for a in range(0, len(ink), 1_000_000):
                idx, w = simplex(ink[a:a + 1_000_000])
                nodes.append(np.stack([nid(i) for i in idx], 1).astype(np.int32))
                wts.append(w.T.astype(np.int16))
                s8.append(a8[a:a + 1_000_000].astype(np.uint8))
                s16.append(a16[a:a + 1_000_000].astype(np.uint16))
        self.nodes, self.w, self.s8, self.s16 = map(np.concatenate, (nodes, wts, s8, s16))
        self.n = start.reshape(-1, 3).copy()
        flat = self.w.ravel()
        keep = np.where(flat >= wmin)[0].astype(np.int64)
        kn = self.nodes.ravel()[keep]
        o = np.argsort(kn, kind='stable')
        self.keep, kn = keep[o], kn[o]
        self.starts = np.searchsorted(kn, np.arange(65536))
        self.ends = np.searchsorted(kn, np.arange(65536), side='right')

    def parts(self, u):
        fl = self.keep[self.starts[u]:self.ends[u]]
        samp, slot = fl // 5, fl % 5
        nodes = self.nodes[samp]
        w = self.w[samp].astype(np.float64)
        wu = w[np.arange(len(samp)), slot]
        return samp, nodes, w, wu

    def snap(self):
        """One sweep of 8-bit exact snapping; returns the number of changes."""
        changed = 0
        for u in range(65536):
            if self.starts[u] == self.ends[u]:
                continue
            samp, nodes, w, wu = self.parts(u)
            for c in range(3):
                rest = (w * self.n[nodes, c]).sum(1) / 4096.0 - wu * self.n[u, c] / 4096.0
                s = self.s8[samp, c].astype(np.float64)
                lo = np.where(s == 0, -1e9, 256 * s - 1)
                hi = np.where(s == 255, 1e9, 256 * (s + 1) - 1)
                new = best_int((lo - rest) * 4096 / wu, (hi - rest) * 4096 / wu, self.n[u, c])
                if new != self.n[u, c]:
                    self.n[u, c] = new
                    changed += 1
        return changed

    def tie_break(self, wmin8, wmin16):
        """Among the integers every heavy 8-bit constraint allows, pick the one most 16-bit conversions agree with."""
        changed = 0
        mi = MI.astype(np.float64)
        inv = lambda lo, hi: ((64 * np.interp(lo, K, mi) - C0) / ALPHA, (64 * np.interp(hi, K, mi) - C0) / ALPHA)
        for u in range(65536):
            if self.starts[u] == self.ends[u]:
                continue
            samp, nodes, w, wu = self.parts(u)
            for c in range(3):
                cur = self.n[u, c]
                rest = (w * self.n[nodes, c]).sum(1) / 4096.0 - wu * cur / 4096.0
                s = self.s8[samp, c].astype(np.float64)
                lo = np.where(s == 0, -1e9, 256 * s - 1)
                hi = np.where(s == 255, 1e9, 256 * (s + 1) - 1)
                m8 = wu >= wmin8
                a8, b8 = ((lo - rest) * 4096 / wu)[m8], ((hi - rest) * 4096 / wu)[m8]
                lo_i = np.ceil(a8.max() - 1e-9) if len(a8) else -1e9
                hi_i = np.ceil(b8.min() - 1e-9) - 1 if len(a8) else 1e9
                if lo_i > hi_i or hi_i - lo_i < 1:
                    continue
                m16 = wu >= wmin16
                if not m16.any():
                    continue
                o = self.s16[samp, c][m16].astype(np.float64)
                a16, b16 = inv(o - 0.5, o + 0.5)
                a16 = np.where(o == 0, -1e9, a16)
                b16 = np.where(o == 0, inv(np.array([0.0]), np.array([0.5]))[1][0], b16)
                b16 = np.where(o == 65535, 1e9, b16)
                a16 = np.where(o == 65535, inv(np.array([65534.5]), np.array([65535.5]))[0][0], a16)
                r = rest[m16]
                a = (a16 - r) * 4096 / wu[m16]
                b = (b16 - r) * 4096 / wu[m16]
                lo_s, hi_s = max(lo_i, cur - 3000), min(hi_i, cur + 3000)
                s_, e_ = np.ceil(a - 1e-9), np.ceil(b - 1e-9)
                cands = np.unique(np.concatenate([[lo_s, hi_s, min(max(cur, lo_s), hi_s)], np.clip(s_, lo_s, hi_s), np.clip(e_ - 1, lo_s, hi_s)]))
                cov = ((s_[None, :] <= cands[:, None]) & (e_[None, :] > cands[:, None])).sum(1)
                ok = cands[cov == cov.max()]
                new = ok[np.argmin(np.abs(ok - cur))]
                if new != cur:
                    self.n[u, c] = new
                    changed += 1
        return changed


def cmd_solve():
    nodes = np.load(P('nodes_direct.npy'))
    sets = ['nearall', 'near', 'uniform', 'train2', 'train3', 'train4']
    for wmin in (1000, 400, 100):
        solver = Solver(sets, nodes, wmin)
        for sweep in range(4):
            ch = solver.snap()
            print('snap weight >=', wmin, 'sweep', sweep, 'changed', ch, flush=True)
            if ch == 0:
                break
        nodes = solver.n.reshape(16, 16, 16, 16, 3)
    for rnd in range(3):
        solver = Solver(sets, nodes, 400)
        print('tie-break round', rnd, 'changed', solver.tie_break(400, 800), flush=True)
        nodes = solver.n.reshape(16, 16, 16, 16, 3)
    np.save(P('nodes.npy'), nodes)


def cmd_check():
    nodes = np.load(P('nodes.npy')).astype(np.int64)
    for name in ('val', 'val2'):
        ink, _, s8 = load(name)
        bad = 0
        for a in range(0, len(ink), 250_000):
            idx, w = simplex(ink[a:a + 250_000])
            acc = sum(w[i][:, None] * nodes[idx[i][:, 0], idx[i][:, 1], idx[i][:, 2], idx[i][:, 3]] for i in range(5))
            bad += int((np.clip((acc + 4096) >> 20, 0, 255) != s8[a:a + 250_000]).sum())
        print(name, 'mismatched channels', bad, 'of', s8.size)


def cmd_encode():
    nodes = np.load(P('nodes.npy')).astype(np.int64)
    m = nodes.copy()
    for ax in range(4):
        m = np.concatenate([np.take(m, [0], axis=ax), np.diff(m, axis=ax)], axis=ax)
    flat = m.reshape(-1)
    zig = np.where(flat >= 0, 2 * flat, -2 * flat - 1)
    buf = bytearray()
    for v in zig.tolist():
        if v < 255:
            buf.append(v)
        else:
            buf.append(255)
            buf += int(v).to_bytes(3, 'little')
    data = zlib.compress(bytes(buf), 9)
    alphabet = [chr(35 + i) for i in range(90) if chr(35 + i) not in ("'", '\\', '`')][:85]
    padded = data + b'\0' * (-len(data) % 4)
    chars = []
    for i in range(0, len(padded), 4):
        g = int.from_bytes(padded[i:i + 4], 'big')
        d = []
        for _ in range(5):
            d.append(g % 85)
            g //= 85
        chars.extend(alphabet[x] for x in reversed(d))
    text = ''.join(chars)[:(len(data) * 5 + 3) // 4]
    out = sys.argv[3]
    with open(out, 'w', encoding='utf8') as f:
        f.write('/**\n * The Windows ICM CMYK -> sRGB node table for CMYK JPEG (16^4 nodes of signed 16-bit R, G, B; see jpeg-cmyk.ts),\n'
                ' * read from mscms.dll and refined by scripts/gdi-fixtures/generate-cmyk-nodes.py against 19 million native\n'
                ' * conversions. 4-D difference, zigzag, zlib, base 85.\n *\n * @module jpeg-cmyk-data\n */\n\n'
                "export const CMYK_LUT_DATA =\n\t'" + text + "';\n")
    print('wrote', out, len(text), 'characters')


{'nodes': cmd_nodes, 'read': cmd_read, 'solve': cmd_solve, 'check': cmd_check, 'encode': cmd_encode}[CMD]()
