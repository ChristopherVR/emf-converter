/**
 * Rebuilds `src/__fixtures__/gdi/halftone-kernel-sides.json.gz` (and its environment manifest): for the destination rows of
 * HALFTONE's mixed enlarge-and-reduce enlargement whose unrounded cumulative share (`halftoneEnlargeCumulative`) lies within
 * 0.004 of a whole share, on which side of the integer the native engine's cumulative share lies. The native output of a row is
 * `floor((sum of share_j * s_j + 4096) / 8192)` over the sharpened source levels `s_j`, with the shares the differences of the
 * rounded-up cumulative shares, so for each candidate rounding of the near boundaries (each free to be the integer or one above)
 * the output of 2,000 random images accepts exactly one (a share moves a pixel by up to 255 / 8192 levels, enough to be seen in
 * dozens of the 6,000 values). Rows touching the tie condition `(2 x + 1) n` divisible by `N` are skipped.
 *
 *   bun scripts/gdi-fixtures/generate-halftone-kernel-sides.ts
 *
 * Needs Windows PowerShell 5.1 (it calls `generate.ps1 halftone-boundary -TablesDir <temporary directory>` three times).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { halftoneEnlargeCumulative } from '../../src/emf-gdi-stretch';
import { KERNEL_SIDE_IMAGES, KERNEL_SIDE_PAIRS, KERNEL_SIDE_SEEDS, KERNEL_SIDE_THRESHOLD, kernelSideLevels, kernelSidePairs } from '../../src/halftone-kernel-sides.fixture-helper';
import { inputFile, readColumns } from './halftone-kernel-io';

const here = resolve(import.meta.dir, '.');
const output = resolve(here, '../../src/__fixtures__/gdi');

/** Rows of boundaries: [n, N, x, source index j, whole share c, 1 when the native cumulative share is above c]. */
const boundaries: number[][] = [];
let unresolved = 0;
for (const seed of KERNEL_SIDE_SEEDS) {
	const pairs = kernelSidePairs(seed);
	const near = pairs.map(([n, N]) => {
		const rows: { x: number; js: number[]; cums: number[]; b: { j: number; c: number }[] }[] = [];
		halftoneEnlargeCumulative(n, N).forEach((row, x) => {
			if (((2 * x + 1) * n) % N === 0) return;
			const b = row.slice(0, -1).filter(([, m]) => Math.abs(m - Math.round(m)) < KERNEL_SIDE_THRESHOLD).map(([j, m]) => ({ j, c: Math.round(m) }));
			if (b.length) rows.push({ x, js: row.map(e => e[0]), cums: row.map(e => e[1]), b });
		});
		return rows;
	});
	const work = mkdtempSync(join(tmpdir(), 'halftone-kernel-sides-'));
	const items = pairs.map(([n, N], k) => ({ n, N, levels: kernelSideLevels(seed, k, n), name: `pair-${String(k).padStart(3, '0')}` }));
	items.forEach((p, i) => { if (near[i].length) writeFileSync(join(work, p.name + '.hbin'), inputFile(p.n, p.N, p.levels)); });
	execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'generate.ps1'), 'halftone-boundary', '-TablesDir', work], { stdio: 'inherit' });
	items.forEach((p, i) => {
		if (!near[i].length) return;
		const columns = readColumns(readFileSync(join(work, p.name + '.hout')), p.levels.length, p.N);
		const sharp = p.levels.map(ch => ch.map(seq => seq.map((v, y) => {
			const o = v + Math.floor((2 * v - seq[Math.max(0, y - 1)] - seq[Math.min(p.n - 1, y + 1)]) / 4);
			return o < 0 ? 0 : o > 255 ? 255 : o;
		})));
		for (const r of near[i]) {
			const good: number[] = [];
			for (let mask = 0; mask < 1 << r.b.length; mask++) {
				const cum = r.cums.map(m => Math.ceil(m - 1e-7));
				cum[cum.length - 1] = 8192;
				r.b.forEach((bb, q) => { cum[r.js.indexOf(bb.j)] = bb.c + ((mask >> q) & 1); });
				let bad = 0;
				outer: for (let im = 0; im < p.levels.length; im++) for (let ch = 0; ch < 3; ch++) {
					let sum = 0, prev = 0;
					for (let t = 0; t < r.js.length; t++) { sum += (cum[t] - prev) * sharp[im][ch][r.js[t]]; prev = cum[t]; }
					if (Math.floor((sum + 4096) / 8192) !== columns[im][r.x * 3 + ch]) { bad++; if (bad > 3) break outer; }
				}
				if (bad === 0) good.push(mask);
			}
			if (good.length !== 1) { unresolved++; continue; }
			r.b.forEach((bb, q) => boundaries.push([p.n, p.N, r.x, bb.j, bb.c, (good[0] >> q) & 1]));
		}
	});
	console.log(`seed ${seed}: ${boundaries.length} boundaries so far, ${unresolved} rows without a unique reading`);
}
const file = join(output, 'halftone-kernel-sides.json.gz');
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify({ version: 1, seeds: KERNEL_SIDE_SEEDS, pairs: KERNEL_SIDE_PAIRS, images: KERNEL_SIDE_IMAGES, threshold: KERNEL_SIDE_THRESHOLD, boundaries })), { level: 9 }));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'capture-environment.ps1'), '-OutputPath', join(output, 'environment-halftone-kernel-sides.json'), '-Groups', 'halftone-kernel-sides', '-Files', file], { stdio: 'inherit' });
console.log('wrote', file, boundaries.length, 'boundaries');
