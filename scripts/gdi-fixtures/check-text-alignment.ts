/**
 * Replay frozen native controls and optionally compare a prior handler module.
 * bun scripts/gdi-fixtures/check-text-alignment.ts --baseline /absolute/path/baseline-handlers.ts
 * Add --write-bounds /absolute/path/bounds.json only to save a reviewed comparison.
 * A saved baseline handler must export handleEmfPlusTextImageRecord and resolve its imports.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { windowsFonts } from '../../src/__fixtures__/gdi-parity-harness';
import { ensureNodeCanvasModule } from '../../src/emf-canvas-helpers';
import { EMFPLUS_DRAWSTRING } from '../../src/emf-constants';
import { handleEmfPlusTextImageRecord } from '../../src/emf-plus-text-image-handlers';
import { GdiFontCollection } from '../../src/gdi-font-engine';
import type { CanvasContext, EmfPlusReplayCtx } from '../../src/emf-types';

interface Capture {
	family: string; style: number; size: number; typo: boolean; flags: number; align: number; line: number;
	text: string; x: number; y: number; width: number; height: number; bgra: string;
}
interface Bounds { sha256: string; before: number[]; ceilings: number[]; minimumExact: number; minimumImproved: number }
type Handler = typeof handleEmfPlusTextImageRecord;
const args = process.argv.slice(2);
const argument = (flag: string): string | undefined => {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
	return args[index + 1];
};
const baselinePath = argument('--baseline'), boundsPath = argument('--write-bounds');
if (boundsPath && !baselinePath) throw new Error('--write-bounds requires an explicit --baseline handler');
const baseline: Handler | undefined = baselinePath
	? (await import(pathToFileURL(resolve(baselinePath)).href)).handleEmfPlusTextImageRecord : undefined;
if (baselinePath && typeof baseline !== 'function') throw new Error('Baseline does not export handleEmfPlusTextImageRecord');
const limits: { schemaVersion: number; baseline: string; groups: Record<string, Bounds> } = JSON.parse(readFileSync(
	new URL('../../src/__fixtures__/gdi/text-alignment-bounds.json', import.meta.url), 'utf8',
));
await ensureNodeCanvasModule();
const privateBytes = readFileSync(new URL('../../src/__fixtures__/gdi/supplementary.ttf', import.meta.url));
GlobalFonts.register(privateBytes);
const privateFonts = new GdiFontCollection([privateBytes]), systemBytes = windowsFonts();

function compare(c: Capture, fonts: GdiFontCollection, handler: Handler): number {
	const canvas = createCanvas(256, 160), ctx = canvas.getContext('2d');
	ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 160);
	const view = new DataView(new ArrayBuffer(28 + 2 * c.text.length));
	view.setUint32(0, 0xff000000, true); view.setUint32(4, 1, true); view.setUint32(8, c.text.length, true);
	[c.x, c.y, c.width, c.height].forEach((value, i) => view.setFloat32(12 + 4 * i, value, true));
	for (let i = 0; i < c.text.length; i++) view.setUint16(28 + 2 * i, c.text.charCodeAt(i), true);
	const r: EmfPlusReplayCtx = {
		ctx: ctx as unknown as CanvasContext, view, objectTable: new Map([
			[0, { kind: 'plus-font', family: c.family, emSize: c.size, flags: c.style, unit: 2 }],
			[1, { kind: 'plus-stringformat', flags: c.flags, alignment: c.align, lineAlignment: c.line,
				leadingMargin: c.typo ? 0 : 1 / 6, trailingMargin: c.typo ? 0 : 1 / 6, tracking: c.typo ? 1 : 1.03 }],
		]),
		worldTransform: [1,0,0,1,0,0], deferredImages: [], saveStack: [], saveIdMap: new Map(), totalImageObjects: 0,
		totalDrawImageCalls: 0, clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1, continuationBuffer: null,
		continuationObjectId: 0, continuationObjectType: 0, continuationTotalSize: 0, continuationOffset: 0,
		fonts, textRenderingHint: 4, ext: { textContrast: 0 },
	};
	if (!handler(r, EMFPLUS_DRAWSTRING, 0x8000, 0, view.byteLength)) throw new Error('DrawString record rejected');
	const actual = ctx.getImageData(0, 0, 256, 160).data, native = Buffer.from(c.bgra, 'base64');
	let different = 0;
	for (let p = 0; p < actual.length; p += 4) if (actual[p] !== native[p + 2] || actual[p + 1] !== native[p + 1] ||
		actual[p + 2] !== native[p] || actual[p + 3] !== native[p + 3]) different++;
	return different;
}

const output: typeof limits = { schemaVersion: 1, baseline: '1aac5a6 handler, current font engine', groups: {} };
const regressions: string[] = [];
for (const [group, saved] of Object.entries(limits.groups)) {
	if (group !== 'private' && !systemBytes) { console.log(`${group}: skipped; captured Windows fonts unavailable`); continue; }
	const bytes = readFileSync(new URL(`../../src/__fixtures__/gdi/text-alignment-${group}.json.gz`, import.meta.url));
	const hash = createHash('sha256').update(bytes).digest('hex');
	if (hash !== saved.sha256) throw new Error(`Native capture changed for ${group}; retain frozen references before reviewing new bounds`);
	const captures: Capture[] = JSON.parse(gunzipSync(bytes).toString());
	const fonts = group === 'private' ? privateFonts : new GdiFontCollection(systemBytes!);
	const before = baseline ? captures.map((c) => compare(c, fonts, baseline)) : saved.before;
	const after = captures.map((c) => compare(c, fonts, handleEmfPlusTextImageRecord));
	for (let i = 0; i < after.length; i++) {
		if (after[i] > before[i] || (!baseline && after[i] > saved.ceilings[i])) regressions.push(`${group}[${i}] ${before[i]} -> ${after[i]}`);
	}
	const minimumExact = after.filter((count) => count === 0).length;
	const minimumImproved = after.filter((count, i) => count < before[i]).length;
	output.groups[group] = { sha256: hash, before, ceilings: after, minimumExact, minimumImproved };
	console.log(`${group}: ${minimumExact}/${after.length} exact; ${minimumImproved} improved; ${after.filter((count, i) => count > before[i]).length} worse`);
}
if (regressions.length) throw new Error(`Per-case native regressions: ${regressions.join(', ')}`);
if (boundsPath) {
	if (Object.keys(output.groups).length !== Object.keys(limits.groups).length) throw new Error('Cannot write incomplete bounds without every captured font');
	writeFileSync(resolve(boundsPath), JSON.stringify(output, null, 2) + '\n');
	console.log(`Saved ${resolve(boundsPath)}`);
}
