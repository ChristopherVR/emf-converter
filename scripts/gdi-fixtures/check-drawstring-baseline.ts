/** Replay frozen native controls against a saved prior handler module.
 * bun scripts/gdi-fixtures/check-drawstring-baseline.ts --baseline /absolute/path/handler.ts
 * Optional --write-bounds /absolute/path/bounds.json saves only a comparison with no regressions.
 * The supplied baseline must export handleEmfPlusTextImageRecord and resolve its imports.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { windowsFonts } from '../../src/__fixtures__/gdi-parity-harness';
import { ensureNodeCanvasModule } from '../../src/emf-canvas-helpers';
import { EMFPLUS_DRAWSTRING } from '../../src/emf-constants';
import { handleEmfPlusTextImageRecord } from '../../src/emf-plus-text-image-handlers';
import { GdiFontCollection } from '../../src/gdi-font-engine';
import type { CanvasContext, EmfPlusReplayCtx } from '../../src/emf-types';

interface Capture {
 face: string; style: number; size: number; typo: boolean; heldout: boolean; text: string;
 width: number; height: number; rgba: string;
}
const bytes = readFileSync(new URL('../../src/__fixtures__/gdi/text-drawstring-baseline.json.gz', import.meta.url));
const captures: Capture[] = JSON.parse(gunzipSync(bytes).toString());
const bounds: { baseline: string; sha256: string; before: number[]; ceilings: number[];
 minimumExact: number; minimumImproved: number } = JSON.parse(readFileSync(
 new URL('../../src/__fixtures__/gdi/text-drawstring-baseline-bounds.json', import.meta.url), 'utf8',
));
const fontBytes = windowsFonts();

type Handler = typeof handleEmfPlusTextImageRecord;
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
 const index = args.indexOf(name);
 if (index < 0) return undefined;
 if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
 return args[index + 1];
};
const baselinePath = arg('--baseline'), destination = arg('--write-bounds');
if (destination && !baselinePath) throw new Error('--write-bounds requires an explicit prior handler');
const baseline: Handler | undefined = baselinePath
 ? (await import(pathToFileURL(resolve(baselinePath)).href)).handleEmfPlusTextImageRecord : undefined;
if (baselinePath && typeof baseline !== 'function') throw new Error('Baseline module does not export handleEmfPlusTextImageRecord');
if (!fontBytes) throw new Error('Captured Windows fonts unavailable; cannot produce complete bounds');
if (createHash('sha256').update(bytes).digest('hex') !== bounds.sha256) throw new Error('Frozen native capture hash changed');
await ensureNodeCanvasModule();
const fonts = new GdiFontCollection(fontBytes);
function render(c: Capture, handler: Handler): Uint8ClampedArray {
   const canvas = createCanvas(c.width, c.height), ctx = canvas.getContext('2d');
   ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
   const view = new DataView(new ArrayBuffer(28 + 2 * c.text.length));
   view.setUint32(0, 0xff000000, true); view.setUint32(4, 1, true); view.setUint32(8, c.text.length, true);
   [8, 8, 2000, 2000].forEach((value, i) => view.setFloat32(12 + 4 * i, value, true));
   for (let i = 0; i < c.text.length; i++) view.setUint16(28 + 2 * i, c.text.charCodeAt(i), true);
   const replay: EmfPlusReplayCtx = {
    ctx: ctx as unknown as CanvasContext, view,
    objectTable: new Map([
     [0, { kind: 'plus-font', family: c.face, emSize: c.size, flags: c.style, unit: 2 }],
     [1, { kind: 'plus-stringformat', flags: c.typo ? 0x6004 : 0, alignment: 0, lineAlignment: 0,
      leadingMargin: c.typo ? 0 : 1 / 6, trailingMargin: c.typo ? 0 : 1 / 6, tracking: c.typo ? 1 : 1.03 }],
    ]),
    worldTransform: [1,0,0,1,0,0], deferredImages: [], saveStack: [], saveIdMap: new Map(),
    totalImageObjects: 0, totalDrawImageCalls: 0, clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1,
    continuationBuffer: null, continuationObjectId: 0, continuationObjectType: 0, continuationTotalSize: 0,
    continuationOffset: 0, fonts, textRenderingHint: 5, ext: { textContrast: 0 },
   };
   if (!handler(replay, EMFPLUS_DRAWSTRING, 0x8000, 0, view.byteLength)) throw new Error('DrawString record rejected');
   return ctx.getImageData(0, 0, c.width, c.height).data;
}
const difference = (actual: Uint8ClampedArray, native: Buffer): number => {
 let count = 0;
 for (let p = 0; p < actual.length; p += 4) if (actual[p] !== native[p] || actual[p + 1] !== native[p + 1] ||
  actual[p + 2] !== native[p + 2] || actual[p + 3] !== native[p + 3]) count++;
 return count;
};
const before = baseline ? captures.map((c) => difference(render(c, baseline), Buffer.from(c.rgba, 'base64'))) : bounds.before;
const after = captures.map((c) => difference(render(c, handleEmfPlusTextImageRecord), Buffer.from(c.rgba, 'base64')));
const regressions = after.flatMap((count, i) => count > before[i] || (!baseline && count > bounds.ceilings[i])
 ? [`${captures[i].face} ${captures[i].size}px style ${captures[i].style}: ${before[i]} -> ${count}`] : []);
if (regressions.length) throw new Error(`Per-case native regressions: ${regressions.join(', ')}`);
const minimumExact = after.filter((count) => count === 0).length;
const minimumImproved = after.filter((count, i) => count < before[i]).length;
const heldoutImproved = after.filter((count, i) => captures[i].heldout && count < before[i]).length;
console.log(`${captures.length} controls; ${minimumExact} exact; ${minimumImproved} improve (${heldoutImproved} heldout); 0 worsen`);
if (destination) writeFileSync(resolve(destination), JSON.stringify({schemaVersion: 1, baseline: bounds.baseline,
 sha256: bounds.sha256, before, ceilings: after, minimumExact, minimumImproved}, null, 2) + '\n');
