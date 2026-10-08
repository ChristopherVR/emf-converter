import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { GdiFontCollection } from './gdi-font-engine';
import { handleEmfPlusTextImageRecord } from './emf-plus-text-image-handlers';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { EMFPLUS_DRAWSTRING } from './emf-constants';
import type { EmfPlusReplayCtx } from './emf-types';

interface Capture { face: string; size: number; style: number; hint: number; typo: boolean; phase: number; code: number; rgba: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-drawstring-placement.json.gz', import.meta.url))).toString());

function renderCapture(c: Capture, fonts: GdiFontCollection): Uint8ClampedArray {
 const canvas = createCanvas(64, 64), ctx = canvas.getContext('2d');
 ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 64, 64);
 const view = new DataView(new ArrayBuffer(30));
 view.setUint32(0, 0xff000000, true); view.setUint32(4, 1, true); view.setUint32(8, 1, true);
 view.setFloat32(12, 8 + c.phase, true); view.setFloat32(16, 16 + c.phase, true);
 view.setFloat32(20, 1000, true); view.setFloat32(24, 1000, true); view.setUint16(28, c.code, true);
 const rCtx: EmfPlusReplayCtx = {
  ctx: ctx as unknown as CanvasRenderingContext2D, view,
  objectTable: new Map([
   [0, { kind: 'plus-font', family: c.face, emSize: c.size, flags: c.style, unit: 2 }],
   [1, { kind: 'plus-stringformat', flags: c.typo ? 0x6004 : 0, alignment: 0, lineAlignment: 0,
    leadingMargin: c.typo ? 0 : 1 / 6, trailingMargin: c.typo ? 0 : 1 / 6, tracking: c.typo ? 1 : 1.03 }],
  ]),
  worldTransform: [1, 0, 0, 1, 0, 0], deferredImages: [], saveStack: [], saveIdMap: new Map(),
  totalImageObjects: 0, totalDrawImageCalls: 0, clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1,
  continuationBuffer: null, continuationObjectId: 0, continuationObjectType: 0,
  continuationTotalSize: 0, continuationOffset: 0, fonts, textRenderingHint: c.hint, ext: { textContrast: 0 },
 };
 handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWSTRING, 0x8000, 0, 30);
 return ctx.getImageData(0, 0, 64, 64).data;
}

describe.skipIf(!windowsFonts())('native DrawString placement: what the unclosed captures are', () => {
 it('96 of 144 are exact; the 48 others are the W and g glyph shapes, and no whole-pixel shift of our output reduces any of them', async () => {
  await ensureNodeCanvasModule();
  const fonts = new GdiFontCollection(windowsFonts()!);
  let exact = 0;
  const inexact = new Map<string, number>();
  for (const c of captures) {
   const actual = renderCapture(c, fonts), native = Buffer.from(c.rgba, 'base64');
   const differs = (dx: number, dy: number): number => {
    let n = 0;
    for (let y = 2; y < 62; y++) for (let x = 2; x < 62; x++) {
     const i = (y * 64 + x) * 4, j = ((y + dy) * 64 + x + dx) * 4;
     if (actual[j] !== native[i] || actual[j + 1] !== native[i + 1] || actual[j + 2] !== native[i + 2]) n++;
    }
    return n;
   };
   const home = differs(0, 0);
   if (Buffer.from(actual).equals(native)) { exact++; continue; }
   const key = `${c.face} ${c.size} ${String.fromCharCode(c.code)}`;
   inexact.set(key, (inexact.get(key) ?? 0) + 1);
   for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    expect(differs(dx, dy), key).toBeGreaterThanOrEqual(home);
   }
  }
  expect(exact).toBe(96);
  expect(Object.fromEntries(inexact)).toEqual({
   'Arial 16 W': 8, 'Arial 40 W': 12, 'Arial 40 g': 4, 'Times New Roman 22 W': 12, 'Times New Roman 22 g': 12,
  });
 });
});

describe.skipIf(!windowsFonts())('native DrawString placement', () => {
 it('matches closed glyphs at integer and quarter-pixel layout positions in both formats', async () => {
  await ensureNodeCanvasModule();
  expect(captures).toHaveLength(144);
  const fonts = new GdiFontCollection(windowsFonts()!);
  let compared = 0;
  for (const c of captures) {
   const char = String.fromCharCode(c.code);
   const closed = c.hint === 5
    ? c.face === 'Segoe UI' || char === 'I' && c.face !== 'Arial' || char === 'I' && c.size === 40
    : c.face === 'Segoe UI' || c.face === 'Times New Roman' && char === 'I' ||
      c.size === 40 && 'Ig'.includes(char) || c.size === 16 && (c.hint === 3 || 'Ig'.includes(char));
      if (!closed) continue;
   const canvas = createCanvas(64, 64), ctx = canvas.getContext('2d');
   ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 64, 64);
   const view = new DataView(new ArrayBuffer(30));
   view.setUint32(0, 0xff000000, true); view.setUint32(4, 1, true); view.setUint32(8, 1, true);
   view.setFloat32(12, 8 + c.phase, true); view.setFloat32(16, 16 + c.phase, true);
   view.setFloat32(20, 1000, true); view.setFloat32(24, 1000, true); view.setUint16(28, c.code, true);
   const rCtx: EmfPlusReplayCtx = {
    ctx: ctx as unknown as CanvasRenderingContext2D, view,
    objectTable: new Map([
     [0, { kind: 'plus-font', family: c.face, emSize: c.size, flags: c.style, unit: 2 }],
     [1, { kind: 'plus-stringformat', flags: c.typo ? 0x6004 : 0, alignment: 0, lineAlignment: 0,
      leadingMargin: c.typo ? 0 : 1 / 6, trailingMargin: c.typo ? 0 : 1 / 6, tracking: c.typo ? 1 : 1.03 }],
    ]),
    worldTransform: [1, 0, 0, 1, 0, 0], deferredImages: [], saveStack: [], saveIdMap: new Map(),
    totalImageObjects: 0, totalDrawImageCalls: 0, clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1,
    continuationBuffer: null, continuationObjectId: 0, continuationObjectType: 0,
    continuationTotalSize: 0, continuationOffset: 0, fonts, textRenderingHint: c.hint, ext: { textContrast: 0 },
   };
   expect(handleEmfPlusTextImageRecord(rCtx, EMFPLUS_DRAWSTRING, 0x8000, 0, 30)).toBe(true);
   const actual = ctx.getImageData(0, 0, 64, 64).data, native = Buffer.from(c.rgba, 'base64');
   expect(Buffer.from(actual).equals(native),
    JSON.stringify({ ...c, rgba: undefined })).toBe(true);
   compared++;
  }
  expect(compared).toBe(88);
 });
});
