import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

interface Capture { size: number; pattern: number; blue: number; source: string; output: string }
const captures = (name: string): Capture[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());
// Per-capture ceilings retain every unresolved pixel, including pure-red centre
// sensitivity and near-black split fields. Each triplet is [pixels, max, channel sum].
const measuredLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[74,23,890],[2,1,2],[0,0,0],[4,1,6],[8,1,10],[2,1,4],[12,7,44],[20,1,28],[49,51,890],[13,16,132],[36,71,738],[67,68,1540],[82,65,2250],[32,54,680],[14,10,109],[3,1,5],[0,0,0],[8,1,8],[0,0,0],[8,1,16],[8,1,24],[0,0,0],[0,0,0],[8,1,8],[0,0,0],[76,28,1324],[76,27,1304],[24,1,24],[24,1,48],[0,0,0],[0,0,0],[0,0,0],[360,61,9076],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[20,1,20],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[174,28,1969],[0,0,0],[2,1,2],[0,0,0],[10,1,12],[8,1,10],[34,9,150],[42,1,70],[138,112,1363],[29,19,198],[75,15,630],[192,95,2708],[188,51,2063],[115,89,1446],[46,29,466],[26,28,204],[0,0,0],[64,1,128],[0,0,0],[0,0,0],[40,1,40],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[160,34,2360],[160,34,2308],[16,1,32],[40,1,96],[0,0,0],[0,0,0],[40,1,40],[2,1,6],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[68,21,801],[93,27,1559],[63,27,992],[89,23,1174],[62,27,1003],[82,27,1544],[59,26,968],[29,54,1030],[239,81,4069],[4,1,4],[6,1,6],[4,1,6],[16,1,31],[5,1,9],[59,39,331],[53,1,74],[208,48,1202],[249,60,1742],[106,59,702],[358,70,3021],[382,77,4182],[192,72,1745],[39,16,190],[118,58,805],[59,34,1263],[109,70,3994],[61,59,2374],[184,53,2811],[117,58,2421],[173,68,4084],[165,56,2477],[82,49,2606],[35,42,429],[243,40,4256],[244,46,4356],[15,54,136],[65,52,1545],[61,52,1502],[33,42,578],[51,54,1016],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[112,1,112],[0,0,0],[0,0,0],[446,76,5132],[4,1,4],[2,1,4],[4,1,6],[28,1,38],[15,1,27],[80,6,236],[100,3,144],[386,46,2069],[206,37,872],[324,47,1896],[695,99,6833],[708,71,5427],[441,56,2813],[118,68,499],[48,1,66],[0,0,0],[96,1,192],[0,0,0],[0,0,0],[192,1,192],[0,0,0],[56,1,112],[0,0,0],[0,0,0],[392,41,5980],[384,40,5864],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const heldOutLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[44,1,44],[0,0,0],[28,1,56],[0,0,0],[8,1,10],[2,1,2],[0,0,0],[16,1,20],[31,21,355],[25,17,250],[18,30,224],[1,1,2],[32,1,32],[16,1,16],[32,1,80],[0,0,0],[40,1,40],[16,1,16],[40,1,96],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[10,1,14],[26,11,246],[22,4,58],[26,1,30],[83,32,701],[68,38,399],[25,1,39],[19,9,82],[64,1,64],[16,1,16],[16,1,48],[0,0,0],[64,1,64],[64,1,64],[96,1,256],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[36,1,50],[40,3,102],[42,2,82],[36,1,56],[204,21,878],[231,46,1164],[123,28,611],[69,19,192],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[152,1,152],[184,1,184],[176,1,480],[104,1,160]];

describe('native red-eye sector darkness controls', () => {
 for (const [name, limits, count, exactNonzero] of [
  ['redeye-independent', measuredLimits, 192, 72],
  ['redeye-heldout', heldOutLimits, 72, 31],
 ] as const) {
  it(`matches closed ${name} controls exactly and retains per-capture residual ceilings`, () => {
   const cases = captures(name);
   expect(cases).toHaveLength(count);
   expect(limits).toHaveLength(count);
   let exact = 0;
   for (let c = 0; c < cases.length; c++) {
    const capture = cases[c];
    const source = new Uint8ClampedArray(Buffer.from(capture.source, 'base64'));
    const expected = Buffer.from(capture.output, 'base64');
    const { size } = capture;
    const actual = applyRedEyeCorrection(source, size, size, [{ left: 0, top: 0, right: size, bottom: size }]);
    let pixels = 0, maximum = 0, sum = 0;
    for (let i = 0; i < actual.length; i += 4) {
     let difference = 0;
     for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(actual[i + channel] - expected[i + channel]);
      difference = Math.max(difference, delta);
      sum += delta;
     }
     if (difference) pixels++;
     maximum = Math.max(maximum, difference);
    }
    const label = `${name}: size ${size}, pattern ${capture.pattern}, blue ${capture.blue}`;
    expect(pixels, label).toBeLessThanOrEqual(limits[c][0]);
    expect(maximum, label).toBeLessThanOrEqual(limits[c][1]);
    expect(sum, label).toBeLessThanOrEqual(limits[c][2]);
    // Pure-red fields have order-sensitive native outputs; they are
    // retained above but excluded from the nonzero-darkness exactness count.
    if (!limits[c][0] && capture.blue > 0) {
     expect(actual, label).toEqual(new Uint8ClampedArray(expected));
     exact++;
    }
   }
   expect(exact).toBe(exactNonzero);
  });
 }
});
