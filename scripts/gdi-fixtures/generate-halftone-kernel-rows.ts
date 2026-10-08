/**
 * Rebuilds `src/__fixtures__/gdi/halftone-kernel-rows.json.gz` (and its environment manifest): the integer weight rows
 * Windows' HALFTONE uses to enlarge one axis of a mixed enlarge-and-reduce stretch by a fractional or whole factor,
 * measured for 78 source/destination length pairs (ratios 1.02x to 16x). They fixed the closed form of
 * `enlargeKernel` in `src/emf-gdi-stretch.ts`.
 *
 * The probe stretches a 4-column image of `n` rows to 2 columns by `N` rows (a reduction by 2x on the other axis, which
 * takes the reduce, sharpen, enlarge engine whatever the source). Every row of an image is one constant colour per
 * channel, so each destination row is a plain weighted sum of the 1-D sharpened source levels
 * (`v + floor((2v - l - r) / 4)`, clamped). Over 1,200 random images (3,600 equations per destination row) the shares of
 * 8192 of the five nearest source samples are the least squares solution refined by an integer search that
 * reproduces every equation with one rounding half up. Rows that touch the image edges are not solved.
 *
 *   bun scripts/gdi-fixtures/generate-halftone-kernel-rows.ts
 *
 * Needs Windows PowerShell 5.1 (it calls `generate.ps1 halftone-boundary -TablesDir <temporary directory>`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { KERNEL_ROW_PAIRS, KERNEL_ROW_IMAGES, kernelRowLevels } from '../../src/halftone-kernel-rows.fixture-helper';

const here = resolve(import.meta.dir, '.');
const output = resolve(here, '../../src/__fixtures__/gdi');

function inputFile(n: number, N: number, levels: number[][][]): Buffer {
	const parts: Buffer[] = [];
	const head = Buffer.alloc(8); head.writeInt32LE(-levels.length, 0); head.writeInt32LE(1, 4); parts.push(head);
	for (const channels of levels) {
		const h = Buffer.alloc(36);
		[4, n, 0, 0, 4, n, 2, N, 0].forEach((v, i) => h.writeInt32LE(v, i * 4));
		const bgra = new Uint8Array(4 * n * 4);
		for (let y = 0; y < n; y++) for (let x = 0; x < 4; x++) bgra.set([channels[2][y], channels[1][y], channels[0][y], 255], (y * 4 + x) * 4);
		parts.push(h, Buffer.from(bgra));
	}
	return Buffer.concat(parts);
}

/** Destination column 0 of every image of `<name>.hout`: out[image][row * 3 + channel]. */
function readColumns(file: string, count: number, N: number): number[][] {
	const data = readFileSync(file);
	let p = 0;
	if (data.readInt32LE(p) !== count) throw new Error('result count');
	p += 4;
	const result: number[][] = [];
	for (let i = 0; i < count; i++) {
		const sw = data.readInt32LE(p), sh = data.readInt32LE(p + 4); p += 16 + 4 * (sw + sh);
		const column: number[] = [];
		for (let y = 0; y < N; y++) column.push(data[p + y * 2 * 4 + 2], data[p + y * 2 * 4 + 1], data[p + y * 2 * 4]);
		p += 2 * N * 4;
		result.push(column);
	}
	return result;
}

function solve(A: number[][], b: number[]): number[] {
	const n = b.length;
	const M = A.map((r, i) => [...r, b[i]]);
	for (let i = 0; i < n; i++) {
		let m = i;
		for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[m][i])) m = r;
		[M[i], M[m]] = [M[m], M[i]];
		for (let r = 0; r < n; r++) if (r !== i) { const k = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= k * M[i][c]; }
	}
	return M.map((row, i) => row[n] / row[i]);
}

/** The shares of 8192 of the five source samples around each destination row, or null where they could not be solved. */
function measure(n: number, N: number, levels: number[][][], columns: number[][]): ({ x: number; w: [number, number][] } | null)[] {
	const ratio = N / n;
	const sharp = levels.map(ch => ch.map(seq => seq.map((v, y) => {
		const o = v + Math.floor((2 * v - seq[Math.max(0, y - 1)] - seq[Math.min(n - 1, y + 1)]) / 4);
		return o < 0 ? 0 : o > 255 ? 255 : o;
	})));
	const rows: ({ x: number; w: [number, number][] } | null)[] = [];
	const win = 2;
	for (let x = 0; x < N; x++) {
		const c0 = Math.floor((x + 0.5) / ratio);
		const js: number[] = [];
		for (let j = c0 - win; j <= c0 + win; j++) if (j >= 0 && j < n) js.push(j);
		const m = js.length;
		const A = Array.from({ length: m }, () => new Array(m).fill(0));
		const b = new Array(m).fill(0);
		const equations: { s: number[]; y: number }[] = [];
		for (let i = 0; i < levels.length; i++) for (let ch = 0; ch < 3; ch++) {
			const s = js.map(j => sharp[i][ch][j]);
			const y = columns[i][x * 3 + ch];
			equations.push({ s, y });
			for (let p = 0; p < m; p++) { b[p] += s[p] * y; for (let q = 0; q < m; q++) A[p][q] += s[p] * s[q]; }
		}
		const base = solve(A, b).map(v => Math.round(v * 8192));
		const bad = (wr: number[], list: { s: number[]; y: number }[], stop = Infinity): number => {
			let count = 0;
			for (const e of list) {
				let sum = 0;
				for (let p = 0; p < m; p++) sum += wr[p] * e.s[p];
				if (Math.floor((sum + 4096) / 8192) !== e.y && ++count >= stop) break;
			}
			return count;
		};
		const subset = equations.filter((_, i) => i % Math.max(1, Math.floor(equations.length / 500)) === 0);
		let best: number[] | null = null;
		let bestBad = Infinity;
		const delta = new Array(m).fill(0);
		const search = (p: number): void => {
			if (p === m - 1) {
				const wr = base.map((v, i) => v + delta[i]);
				wr[m - 1] = 8192 - wr.slice(0, m - 1).reduce((a, v) => a + v, 0);
				if (Math.abs(wr[m - 1] - base[m - 1]) > 4 || bad(wr, subset, 3) >= 3) return;
				const full = bad(wr, equations);
				if (full < bestBad) { bestBad = full; best = wr; }
				return;
			}
			for (let d = -3; d <= 3; d++) { delta[p] = d; search(p + 1); }
		};
		search(0);
		// A negative share cannot be a weight of the filter: the equations did not pin that row down.
		if (bestBad !== 0 || m !== 2 * win + 1 || !best || (best as number[]).some(v => v < 0)) { rows.push(null); continue; }
		const w: [number, number][] = [];
		js.forEach((j, p) => { if ((best as number[])[p] !== 0) w.push([j, (best as number[])[p]]); });
		rows.push({ x, w });
	}
	return rows;
}

const work = mkdtempSync(join(tmpdir(), 'halftone-kernel-rows-'));
const pairs = KERNEL_ROW_PAIRS.map(([n, N], k) => ({ n, N, levels: kernelRowLevels(k, n), name: `pair-${String(k).padStart(3, '0')}` }));
for (const p of pairs) writeFileSync(join(work, p.name + '.hbin'), inputFile(p.n, p.N, p.levels));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'generate.ps1'), 'halftone-boundary', '-TablesDir', work], { stdio: 'inherit' });

const captured = {
	version: 1,
	images: KERNEL_ROW_IMAGES,
	pairs: pairs.map(p => {
		const columns = readColumns(join(work, p.name + '.hout'), p.levels.length, p.N);
		const rows = measure(p.n, p.N, p.levels, columns).filter((r): r is { x: number; w: [number, number][] } => r !== null);
		console.log(`n=${p.n} N=${p.N} solved ${rows.length}/${p.N}`);
		return { n: p.n, N: p.N, rows };
	}),
};
const file = join(output, 'halftone-kernel-rows.json.gz');
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(captured)), { level: 9 }));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'capture-environment.ps1'), '-OutputPath', join(output, 'environment-halftone-kernel-rows.json'), '-Groups', 'halftone-kernel-rows', '-Files', file], { stdio: 'inherit' });
console.log('wrote', file);
