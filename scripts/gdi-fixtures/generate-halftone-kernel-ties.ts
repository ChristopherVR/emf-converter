/**
 * Rebuilds `src/__fixtures__/gdi/halftone-kernel-ties.json.gz` (and its environment manifest): the raw native output of the
 * destination rows of HALFTONE's mixed enlarge-and-reduce enlargement whose centre lies exactly on a source pixel's edge or
 * centre (`(2 x + 1) n` divisible by `N`), for the cases of `src/halftone-kernel-ties.fixture-helper.ts`. The weights of such
 * a row cannot be solved from outputs (the two halves weigh exactly 4096 shares, so the output depends on the sign of the
 * tail term alone), which is why `halftone-kernel-rows.json.gz` shows tie "misses" that are not converter defects.
 *
 *   bun scripts/gdi-fixtures/generate-halftone-kernel-ties.ts
 *
 * Needs Windows PowerShell 5.1 (it calls `generate.ps1 halftone-boundary -TablesDir <temporary directory>`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { KERNEL_TIE_CASES, KERNEL_TIE_IMAGES, kernelTieLevels } from '../../src/halftone-kernel-ties.fixture-helper';
import { inputFile, readColumns } from './halftone-kernel-io';

const here = resolve(import.meta.dir, '.');
const output = resolve(here, '../../src/__fixtures__/gdi');

const work = mkdtempSync(join(tmpdir(), 'halftone-kernel-ties-'));
const cases = KERNEL_TIE_CASES.map(([n, N, rows], k) => ({ n, N, rows, levels: kernelTieLevels(k, n), name: `pair-${String(k).padStart(3, '0')}` }));
for (const c of cases) writeFileSync(join(work, c.name + '.hbin'), inputFile(c.n, c.N, c.levels));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'generate.ps1'), 'halftone-boundary', '-TablesDir', work], { stdio: 'inherit' });

const captured = {
	version: 1,
	images: KERNEL_TIE_IMAGES,
	cases: cases.map(c => {
		const columns = readColumns(readFileSync(join(work, c.name + '.hout')), c.levels.length, c.N);
		// Per row, then per image, the three channels of the destination pixel.
		const bytes = Buffer.alloc(c.rows.length * c.levels.length * 3);
		c.rows.forEach((x, r) => columns.forEach((column, i) => { for (let ch = 0; ch < 3; ch++) bytes[(r * c.levels.length + i) * 3 + ch] = column[x * 3 + ch]; }));
		return { n: c.n, N: c.N, rows: c.rows, output: bytes.toString('base64') };
	}),
};
const file = join(output, 'halftone-kernel-ties.json.gz');
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(captured)), { level: 9 }));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'capture-environment.ps1'), '-OutputPath', join(output, 'environment-halftone-kernel-ties.json'), '-Groups', 'halftone-kernel-ties', '-Files', file], { stdio: 'inherit' });
console.log('wrote', file);
