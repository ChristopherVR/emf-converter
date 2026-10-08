import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

interface Capture { size: number; pattern: number; blue: number; source: string; output: string }
const captures = (name: string): Capture[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());
// Per-capture ceilings retain every unresolved pixel, including pure-red centre
// sensitivity and near-black split fields. Each triplet is [pixels, max, channel sum].
const measuredLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[74,23,896],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[76,28,1324],[76,27,1304],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[360,61,9076],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[164,26,1905],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[144,34,2344],[136,34,2284],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[4,1,4],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[47,18,591],[47,23,743],[47,23,746],[58,23,1158],[47,22,759],[47,22,762],[47,22,750],[34,28,620],[233,74,3192],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[2,1,2],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[35,33,983],[35,53,1968],[35,53,1968],[51,53,2471],[35,53,1913],[35,52,1888],[35,51,1841],[63,49,2450],[21,13,181],[235,48,4177],[235,47,4049],[17,54,488],[20,31,324],[20,29,306],[19,27,276],[35,54,900],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[380,27,4558],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[1,1,3],[0,0,0],[0,0,0],[1,1,1],[1,1,1],[0,0,0],[0,0,0],[28,70,261],[0,0,0],[11,11,38],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[392,41,5980],[384,40,5864],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const heldOutLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[4,13,38],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];

describe('native red-eye sector darkness controls', () => {
 for (const [name, limits, count, exactNonzero] of [
  ['redeye-independent', measuredLimits, 192, 136],
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
