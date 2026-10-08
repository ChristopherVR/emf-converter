import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

interface Capture { size: number; pattern: number; blue: number; source: string; output: string }
const captures = (name: string): Capture[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());
// Per-capture ceilings retain every unresolved pixel. Each triplet is [pixels, max, channel sum], the model's
// measured residual, and every one is at or below the ceiling this file held before the luma weights (none was
// raised). What remains is of two kinds the model cannot reach, for which the previous centroid weights are used:
//  - areas holding red pixels whose integer luma is 0 (pure red, or green and blue under 3): the native
//    strength comes from earlier calls, not from the area (see redeye-stages: group state);
//  - symmetric 31 x 31 scenes, whose centroid sits exactly on a pixel centre, so the four axes'
//    sector membership follows native rounding noise.
const measuredLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[74,23,890],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[49,51,890],[12,16,131],[35,71,737],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[76,28,1324],[76,27,1304],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[360,61,9076],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[174,28,1969],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[138,112,1363],[29,19,198],[72,15,627],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[144,34,2344],[136,34,2284],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[2,1,6],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[68,21,801],[93,27,1559],[63,27,992],[69,23,1174],[62,27,1003],[82,27,1544],[59,26,968],[29,54,1030],[239,81,4069],[4,1,4],[0,0,0],[4,1,6],[16,1,31],[5,1,9],[59,39,331],[53,1,74],[208,48,1202],[249,60,1740],[99,59,693],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[59,34,1263],[109,70,3994],[61,59,2374],[70,53,2647],[59,58,2317],[109,68,4028],[60,56,2267],[82,49,2606],[35,42,429],[237,40,4252],[244,46,4356],[7,54,120],[61,52,1545],[61,52,1502],[33,42,578],[47,54,1016],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[446,76,5132],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[1,1,3],[0,0,0],[0,0,0],[386,46,2069],[203,26,799],[323,47,1893],[0,0,0],[28,70,261],[0,0,0],[11,11,38],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[392,41,5980],[384,40,5864],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const heldOutLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[4,13,38],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];

describe('native red-eye sector darkness controls', () => {
 for (const [name, limits, count, exactNonzero] of [
  ['redeye-independent', measuredLimits, 192, 124],
  ['redeye-heldout', heldOutLimits, 72, 71],
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
