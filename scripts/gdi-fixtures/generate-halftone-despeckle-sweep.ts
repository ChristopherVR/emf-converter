/**
 * Rebuilds `src/__fixtures__/gdi/halftone-despeckle-sweep.json.gz` (and its environment manifest): native HALFTONE
 * 2x enlargements of small sources (always the replicated branch, so the output is the despeckled source), behind
 * `halftoneDespeckle` in `src/emf-gdi-stretch.ts`. Two sets, both deterministic:
 *
 *  - `blocks`: 6,400 isolated two-by-two checker blocks (colours P on the top-left/bottom-right diagonal, Q on the
 *    other) on a mid-grey field. Each records which diagonal Windows pulled toward its surroundings. Half of them
 *    differ by colours that are exactly equal under 4R + 8G + B and unequal under any other weighting, to pin the
 *    brightness weights and the tie side.
 *  - `images`: 500 checker-dense random images from 3 x 3 to 48 pixels (ties, two colours with flipped cells, three
 *    colours, sparse flips) with the whole despeckled source Windows produced.
 *
 *   bun scripts/gdi-fixtures/generate-halftone-despeckle-sweep.ts
 *
 * Needs Windows PowerShell 5.1 (it calls `generate.ps1 halftone-boundary -TablesDir <temporary directory>`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const here = resolve(import.meta.dir, '.');
const output = resolve(here, '../../src/__fixtures__/gdi');
const work = mkdtempSync(join(tmpdir(), 'halftone-despeckle-'));

interface Job { w: number; h: number; rgb: Uint8Array }
let seed = 1;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));

function inputFile(jobs: Job[]): Buffer {
	const parts: Buffer[] = [];
	const head = Buffer.alloc(8); head.writeInt32LE(-jobs.length, 0); head.writeInt32LE(1, 4); parts.push(head);
	for (const job of jobs) {
		const h = Buffer.alloc(36);
		[job.w, job.h, 0, 0, job.w, job.h, job.w * 2, job.h * 2, 0].forEach((v, i) => h.writeInt32LE(v, i * 4));
		const bgra = new Uint8Array(job.w * job.h * 4);
		for (let i = 0; i < job.w * job.h; i++) bgra.set([job.rgb[i * 3 + 2], job.rgb[i * 3 + 1], job.rgb[i * 3], 255], i * 4);
		parts.push(h, Buffer.from(bgra));
	}
	return Buffer.concat(parts);
}

/** Runs the jobs through the probe; the despeckled source is every second pixel of every second row of the 2x output. */
function run(jobs: Job[]): Uint8Array[] {
	const BATCH = 16;
	const names: { name: string; jobs: Job[] }[] = [];
	for (let first = 0; first < jobs.length; first += BATCH) {
		const slice = jobs.slice(first, first + BATCH);
		const name = `b-${String(first).padStart(6, '0')}`;
		writeFileSync(join(work, name + '.hbin'), inputFile(slice));
		names.push({ name, jobs: slice });
	}
	execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'generate.ps1'), 'halftone-boundary', '-TablesDir', work], { stdio: 'inherit' });
	const out: Uint8Array[] = [];
	for (const { name, jobs: slice } of names) {
		const data = readFileSync(join(work, name + '.hout'));
		let p = 0;
		if (data.readInt32LE(p) !== slice.length) throw new Error(name + ': result count');
		p += 4;
		for (const job of slice) {
			const sw = data.readInt32LE(p), sh = data.readInt32LE(p + 4); p += 16 + 4 * (sw + sh);
			const dw = job.w * 2;
			const rgb = new Uint8Array(job.w * job.h * 3);
			for (let y = 0; y < job.h; y++) for (let x = 0; x < job.w; x++) {
				const from = p + (y * 2 * dw + x * 2) * 4;
				rgb.set([data[from + 2], data[from + 1], data[from]], (y * job.w + x) * 3);
			}
			p += dw * job.h * 2 * 4;
			out.push(rgb);
		}
	}
	return out;
}

// Isolated blocks.
const W = 40, SPACING = 5, PER = 64;
const blocks: { p: number[]; q: number[] }[] = [];
while (blocks.length < 6400) {
	const p = [ri(30, 225), ri(30, 225), ri(30, 225)];
	let d: number[];
	const k = blocks.length % 8;
	if (k < 4) { const a = ri(-8, 8), b = ri(-4, 4); d = [a, b, -4 * a - 8 * b]; }
	else if (k === 4) d = [ri(-3, 3), ri(-3, 3), ri(-3, 3)];
	else if (k === 5) d = [ri(-12, 12), ri(-6, 6), ri(-40, 40)];
	else if (k === 6) { const a = ri(-8, 8), b = ri(-4, 4); d = [a, b, -4 * a - 8 * b + ri(-2, 2)]; }
	else d = [ri(-40, 40), ri(-40, 40), ri(-40, 40)];
	if (d.every(v => v === 0)) continue;
	const q = p.map((v, i) => v + d[i]);
	if (q.some(v => v < 0 || v > 255) || q.every(v => v === 128) || p.every(v => v === 128)) continue;
	blocks.push({ p, q });
}
const blockJobs: Job[] = [];
for (let s = 0; s < blocks.length; s += PER) {
	const rgb = new Uint8Array(W * W * 3).fill(128);
	for (let i = 0; i < PER; i++) {
		const bx = 2 + (i % 8) * SPACING, by = 2 + Math.floor(i / 8) * SPACING, { p, q } = blocks[s + i];
		const put = (x: number, y: number, c: number[]): void => { rgb.set(c, (y * W + x) * 3); };
		put(bx, by, p); put(bx + 1, by + 1, p); put(bx + 1, by, q); put(bx, by + 1, q);
	}
	blockJobs.push({ w: W, h: W, rgb });
}

// Checker-dense images.
seed = 777;
const imageJobs: Job[] = [];
for (let n = 0; n < 500; n++) {
	const w = ri(3, 48), h = ri(3, Math.min(48, Math.floor(2304 / w))), rgb = new Uint8Array(w * h * 3);
	const kind = n % 5; // 0 tie, 1 two colours, 2 three colours, 3 sparse flips, 4 tie with a third colour
	const pick = (): number[] => [ri(0, 255), ri(0, 255), ri(0, 255)];
	const p = pick();
	let q = pick();
	if (kind === 0 || kind === 4) {
		const a = ri(-30, 30), b = ri(-15, 15), c = -4 * a - 8 * b;
		q = [p[0] + a, p[1] + b, p[2] + c];
		if (q.some(v => v < 0 || v > 255)) q = [(p[0] + 4) & 255, p[1], p[2]];
	}
	const r = pick(), flip = kind === 3 ? 0.05 : kind === 2 ? 0.3 : 0.12;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let c = (x + y) & 1 ? q : p;
		if (rnd() < flip) c = kind === 2 || kind === 4 ? (rnd() < 0.5 ? r : (rnd() < 0.5 ? p : q)) : ((x + y) & 1 ? p : q);
		rgb.set(c, (y * w + x) * 3);
	}
	imageJobs.push({ w, h, rgb });
}

const outputs = run([...blockJobs, ...imageJobs]);
const hex = (a: ArrayLike<number>): string => Buffer.from(Uint8Array.from(a as number[])).toString('hex');
const captured = {
	version: 1,
	blockField: { size: W, spacing: SPACING, perImage: PER },
	blocks: blocks.map((b, s) => {
		const j = Math.floor(s / PER), i = s % PER, o = outputs[j], bx = 2 + (i % 8) * SPACING, by = 2 + Math.floor(i / 8) * SPACING;
		// 1: the top-left/bottom-right pair changed, 0: the other pair did, 2: neither (the mean equalled the colour).
		const topLeftChanged = [0, 1, 2].some(c => o[(by * W + bx) * 3 + c] !== b.p[c]);
		const topRightChanged = [0, 1, 2].some(c => o[(by * W + bx + 1) * 3 + c] !== b.q[c]);
		return [...b.p, ...b.q, topLeftChanged ? 1 : topRightChanged ? 0 : 2];
	}),
	images: imageJobs.map((j, i) => ({ w: j.w, h: j.h, input: hex(j.rgb), output: hex(outputs[blockJobs.length + i]) })),
};
const file = join(output, 'halftone-despeckle-sweep.json.gz');
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(captured)), { level: 9 }));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'capture-environment.ps1'), '-OutputPath', join(output, 'environment-halftone-despeckle-sweep.json'), '-Groups', 'halftone-despeckle-sweep', '-Files', file], { stdio: 'inherit' });
console.log('wrote', file, `${blocks.length} blocks, ${imageJobs.length} images`);
