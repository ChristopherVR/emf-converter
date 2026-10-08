/**
 * Writes `src/__fixtures__/gdi/curve-end-reversal-cases.txt` (the Beziers `PathProbe.CurveEndReversal` widens) and runs the
 * native probe, which writes `curve-end-reversal.json.gz` and its environment manifest next to it:
 *
 *   bun scripts/gdi-fixtures/generate-curve-end-reversal.ts
 *
 * Each case is a Bezier whose end tangent (P3 - P2) is exactly opposite to its last flattened segment (the curve runs past its end
 * point and returns), vertical or horizontal, 60 of each direction. The flattening is the converter's own (`GdiRasterPath.addBeziers`,
 * which matches native `GetPath` for Beziers). Needs Windows PowerShell 5.1.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GdiRasterPath } from '../../src/gdi-raster';

const here = resolve(import.meta.dir, '.');
const output = resolve(here, '../../src/__fixtures__/gdi');

let seed = 4242;
const rnd = (): number => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};
const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));

const lines: string[] = [];
const have: Record<string, number> = {};
for (let tries = 0; lines.length < 240 && tries < 20_000_000; tries++) {
	const vertical = rnd() < 0.5;
	const x = ri(40, 220);
	const y = ri(40, 220);
	const k = ri(1, 70) * (rnd() < 0.5 ? 1 : -1);
	const p3 = [x, y];
	const p2 = vertical ? [x, y - k] : [x - k, y];
	const p0 = [ri(30, 230), ri(30, 230)];
	const p1 = [ri(30, 230), ri(30, 230)];
	const pts = [...p0, ...p1, ...p2, ...p3];
	const path = new GdiRasterPath();
	path.addBeziers(pts.map((v) => v * 16), true);
	const f = path.figures[0].pts;
	const m = f.length / 2;
	const last = [f[2 * m - 2] - f[2 * m - 4], f[2 * m - 1] - f[2 * m - 3]];
	const tan = [p3[0] - p2[0], p3[1] - p2[1]];
	if (tan[0] * last[1] - tan[1] * last[0] !== 0 || tan[0] * last[0] + tan[1] * last[1] >= 0) continue;
	const key = (vertical ? 'v' : 'h') + Math.sign(last[vertical ? 1 : 0]);
	if ((have[key] ?? 0) >= 60) continue;
	have[key] = (have[key] ?? 0) + 1;
	lines.push(pts.join(' '));
}
if (lines.length !== 240) throw new Error(`found ${lines.length} cases`);
writeFileSync(resolve(output, 'curve-end-reversal-cases.txt'), lines.join('\n') + '\n');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(here, 'generate.ps1'), 'curve-end-reversal-probe'], { stdio: 'inherit' });
