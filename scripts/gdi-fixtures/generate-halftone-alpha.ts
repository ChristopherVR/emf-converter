/**
 * Rebuilds `src/__fixtures__/gdi/halftone-alpha.json.gz` (and its environment manifest): what HALFTONE `StretchBlt` and
 * `StretchDIBits` do with the alpha byte of a 32-bit source, for the cases of `src/halftone-alpha.fixture-helper.ts` (every
 * engine: replicated, filtered, reduced, same size, with a colour adjustment, and COLORONCOLOR for contrast) and four alpha
 * plans per source. Drives `HalftoneBoundaryProbe` (`halftone-boundary` mode) with version-2 inputs and flag bit 7, which
 * pre-fills the destination with BGRA 20 7F 40 55.
 *
 *   bun scripts/gdi-fixtures/generate-halftone-alpha.ts
 *
 * Needs Windows PowerShell 5.1.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { ALPHA_PLANS, alphaCases, alphaSource } from '../../src/halftone-alpha.fixture-helper';

const here = resolve(import.meta.dir, '.');
const output = resolve(here, '../../src/__fixtures__/gdi');

const runs = alphaCases().flatMap(c => ALPHA_PLANS.map(plan => ({ c, plan })));
const parts: Buffer[] = [];
const head = Buffer.alloc(8); head.writeInt32LE(-runs.length, 0); head.writeInt32LE(1, 4); parts.push(head);
for (const { c, plan } of runs) {
	const h = Buffer.alloc(36);
	[c.bw, c.bh, 0, 0, c.bw, c.bh, c.dw, c.dh, c.flags | 128].forEach((v, i) => h.writeInt32LE(v, i * 4));
	parts.push(h, Buffer.from(alphaSource(c, plan)));
}
const work = mkdtempSync(join(tmpdir(), 'halftone-alpha-'));
writeFileSync(join(work, 'alpha.hbin'), Buffer.concat(parts));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'generate.ps1'), 'halftone-boundary', '-TablesDir', work], { stdio: 'inherit' });

const data = readFileSync(join(work, 'alpha.hout'));
let p = 4;
const results = runs.map(({ c, plan }) => {
	const sw = data.readInt32LE(p), sh = data.readInt32LE(p + 4); p += 16 + 4 * (sw + sh);
	const out = data.subarray(p, p + c.dw * c.dh * 4); p += c.dw * c.dh * 4;
	const alphas = new Map<number, number>();
	const rgb = Buffer.alloc(c.dw * c.dh * 3);
	for (let i = 0; i < c.dw * c.dh; i++) { alphas.set(out[i * 4 + 3], (alphas.get(out[i * 4 + 3]) ?? 0) + 1); rgb[i * 3] = out[i * 4 + 2]; rgb[i * 3 + 1] = out[i * 4 + 1]; rgb[i * 3 + 2] = out[i * 4]; }
	// COLORONCOLOR picks the nearest source pixel: count the destination alphas that equal the source alpha under their centre.
	const source = alphaSource(c, plan);
	let nearest = 0;
	for (let y = 0; y < c.dh; y++) for (let x = 0; x < c.dw; x++) {
		const sx = Math.min(c.bw - 1, Math.floor(((x + 0.5) * c.bw) / c.dw)), sy = Math.min(c.bh - 1, Math.floor(((y + 0.5) * c.bh) / c.dh));
		if (out[(y * c.dw + x) * 4 + 3] === source[(sy * c.bw + sx) * 4 + 3]) nearest++;
	}
	return { id: c.id, plan, distinctAlpha: alphas.size, alphas: [...alphas.keys()].sort((a, b) => a - b).slice(0, 8), nearestAlpha: nearest, rgbSha256: createHash('sha256').update(rgb).digest('hex') };
});
const file = join(output, 'halftone-alpha.json.gz');
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify({ version: 1, prefill: [0x20, 0x7f, 0x40, 0x55], plans: ALPHA_PLANS, results })), { level: 9 }));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'capture-environment.ps1'), '-OutputPath', join(output, 'environment-halftone-alpha.json'), '-Groups', 'halftone-alpha', '-Files', file], { stdio: 'inherit' });
console.log('wrote', file, results.length, 'runs');
