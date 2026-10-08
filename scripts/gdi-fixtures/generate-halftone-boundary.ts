/**
 * Rebuilds `src/__fixtures__/gdi/halftone-boundary.json.gz` (and its environment manifest): the native
 * labels of the boundary sweeps behind `src/emf-gdi-halftone-branch.ts`. The sweep sources are generated
 * by `src/halftone-boundary.fixture-helper.ts`; `HalftoneBoundaryProbe.cs` stretches each one 2x with
 * HALFTONE and reports whether any 2x2 block of the output is not uniform (the filtered branch).
 *
 *   bun scripts/gdi-fixtures/generate-halftone-boundary.ts
 *
 * Needs Windows PowerShell 5.1 (it calls `generate.ps1 halftone-boundary -TablesDir <temporary directory>`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
	EDGE_ROW_HEIGHT, EDGE_ROW_TRIPLES, EDGE_ROW_WIDTH, boundaryGroups, edgeRowImage, rectangleBitmap, rectangleCases,
} from '../../src/halftone-boundary.fixture-helper';

const here = resolve(import.meta.dir, '.');
const output = resolve(here, '../../src/__fixtures__/gdi');
const work = mkdtempSync(join(tmpdir(), 'halftone-boundary-'));

function bgra(rgb: Uint8Array): Uint8Array {
	const out = new Uint8Array((rgb.length / 3) * 4);
	for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
		out[o] = rgb[i + 2]; out[o + 1] = rgb[i + 1]; out[o + 2] = rgb[i]; out[o + 3] = 255;
	}
	return out;
}

/** Version 1 input: whole-bitmap 2x StretchBlt. */
function inputV1(images: { w: number; h: number; rgb: () => Uint8Array }[], keep: boolean): Buffer {
	const parts: Buffer[] = [];
	const head = Buffer.alloc(8); head.writeInt32LE(images.length, 0); head.writeInt32LE(keep ? 1 : 0, 4); parts.push(head);
	for (const image of images) {
		const h = Buffer.alloc(12); h.writeInt32LE(image.w, 0); h.writeInt32LE(image.h, 4); h.writeInt32LE(2, 8); parts.push(h, Buffer.from(bgra(image.rgb())));
	}
	return Buffer.concat(parts);
}

interface V2 { bw: number; bh: number; sx: number; sy: number; sw: number; sh: number; dw: number; dh: number; flags: number; rgb: Uint8Array }
function inputV2(images: V2[], keep: boolean): Buffer {
	const parts: Buffer[] = [];
	const head = Buffer.alloc(8); head.writeInt32LE(-images.length, 0); head.writeInt32LE(keep ? 1 : 0, 4); parts.push(head);
	for (const image of images) {
		const h = Buffer.alloc(36);
		[image.bw, image.bh, image.sx, image.sy, image.sw, image.sh, image.dw, image.dh, image.flags].forEach((v, i) => h.writeInt32LE(v, i * 4));
		parts.push(h, Buffer.from(bgra(image.rgb)));
	}
	return Buffer.concat(parts);
}

interface Result { sw: number; sh: number; scale: number; bad: number; out?: Buffer }
function readOutput(file: string, sizes: { dw: number; dh: number }[], keep: boolean): Result[] {
	const data = readFileSync(file);
	let p = 0; const count = data.readInt32LE(p); p += 4;
	const results: Result[] = [];
	for (let k = 0; k < count; k++) {
		const sw = data.readInt32LE(p), sh = data.readInt32LE(p + 4), scale = data.readInt32LE(p + 8), bad = data.readInt32LE(p + 12); p += 16 + 4 * (sw + sh);
		let out: Buffer | undefined;
		if (keep) { const length = sizes[k].dw * sizes[k].dh * 4; out = data.subarray(p, p + length); p += length; }
		results.push({ sw, sh, scale, bad, out });
	}
	return results;
}

const groups = boundaryGroups();
const BATCH = 250;
interface Plan { file: string; group?: number; first?: number; count: number }
const plan: Plan[] = [];
groups.forEach((group, g) => {
	for (let first = 0; first < group.images.length; first += BATCH) {
		const slice = group.images.slice(first, first + BATCH);
		const file = `g${g}-${first}`;
		writeFileSync(join(work, file + '.hbin'), inputV1(slice, false));
		plan.push({ file, group: g, first, count: slice.length });
	}
});
const rectangles = rectangleCases();
writeFileSync(join(work, 'rectangles.hbin'), inputV2(rectangles.map(c => ({
	bw: c.bitmapWidth, bh: c.bitmapHeight, sx: c.x, sy: c.y, sw: c.width, sh: c.height, dw: c.width * 2, dh: c.height * 2, flags: c.dib ? 1 : 0, rgb: rectangleBitmap(c),
})), false));
writeFileSync(join(work, 'edge.hbin'), inputV2(EDGE_ROW_TRIPLES.map(([a, b, c]) => ({
	bw: EDGE_ROW_WIDTH, bh: EDGE_ROW_HEIGHT, sx: 0, sy: 0, sw: EDGE_ROW_WIDTH, sh: EDGE_ROW_HEIGHT, dw: EDGE_ROW_WIDTH * 2, dh: EDGE_ROW_HEIGHT * 2, flags: 0, rgb: edgeRowImage(a, b, c),
})), true));

execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'generate.ps1'), 'halftone-boundary', '-TablesDir', work], { stdio: 'inherit' });
console.log('native run finished:', readdirSync(work).filter(f => f.endsWith('.hout')).length, 'result files');

const captured = groups.map(group => ({ name: group.name, description: group.description, labels: '', inputSha256: '' }));
const hashes = groups.map(() => createHash('sha256'));
const labelParts = groups.map(() => [] as string[]);
for (const item of plan) {
	const results = readOutput(join(work, item.file + '.hout'), [], false);
	const slice = groups[item.group!].images.slice(item.first!, item.first! + item.count);
	if (results.length !== slice.length) throw new Error(`${item.file}: ${results.length} results for ${slice.length} images`);
	results.forEach((r, i) => {
		if (r.bad < 0) throw new Error('non-integer scale');
		labelParts[item.group!].push(r.bad > 0 ? 'F' : 'R');
		hashes[item.group!].update(slice[i].rgb());
	});
}
groups.forEach((_, g) => { captured[g].labels = labelParts[g].join(''); captured[g].inputSha256 = hashes[g].digest('hex'); });

const rectResults = readOutput(join(work, 'rectangles.hout'), [], false);
const rectCaptures = rectangles.map((c, i) => ({ ...c, label: rectResults[i].bad > 0 ? 'F' : 'R' }));
const edgeResults = readOutput(join(work, 'edge.hout'), EDGE_ROW_TRIPLES.map(() => ({ dw: EDGE_ROW_WIDTH * 2, dh: EDGE_ROW_HEIGHT * 2 })), true);
const column = 200;
const edgeRows = EDGE_ROW_TRIPLES.map(([a, b, c], i) => {
	const out = edgeResults[i].out!;
	const rows: number[] = [];
	for (let y = 0; y < 4; y++) rows.push(out[(y * EDGE_ROW_WIDTH * 2 + column) * 4 + 2]);
	return { a, b, c, label: edgeResults[i].bad > 0 ? 'F' : 'R', rows };
});

mkdirSync(output, { recursive: true });
const file = join(output, 'halftone-boundary.json.gz');
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify({ version: 1, groups: captured, rectangles: rectCaptures, edgeRows: { width: EDGE_ROW_WIDTH, height: EDGE_ROW_HEIGHT, column, samples: edgeRows } })), { level: 9 }));
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'capture-environment.ps1'), '-OutputPath', join(output, 'environment-halftone-boundary.json'), '-Groups', 'halftone-boundary', '-Files', file], { stdio: 'inherit' });
console.log('wrote', file, groups.map((g, i) => `${g.name}: ${g.images.length} images, ${captured[i].labels.split('F').length - 1} filtered`).join('; '));
