import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyRedEyeCorrection } from './emf-plus-image-effects';

interface Capture { size: number; pattern: number; blue: number; source: string; output: string }
const captures = (name: string): Capture[] => JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());
/** The 192 independent scenes, each run alone in a fresh Windows process (`generate.ps1 redeye-fresh`), in the order of `redeye-independent`. */
const freshCaptures = (): Capture[] => (JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/redeye-fresh.json.gz', import.meta.url))).toString()) as Array<{ spec: string; runs: Array<Array<{ source: string; output: string }>> }>).map((r) => {
	const [size, pattern, blue] = r.spec.slice(1).split(':').map(Number);
	return { size, pattern, blue, source: r.runs[0][0].source, output: r.runs[0][0].output };
});
// Per-capture ceilings retain every unresolved pixel. Each triplet is [pixels, max, channel sum], the model's
// measured residual against the fresh-process captures. 170 of the 192 are exact. What remains:
//  - symmetric 31 x 31 scenes whose weights are not exactly representable (a pupil of luma 1, a ring weight 197 / 3 or
//    68 / 6: blue 3 and 32 of patterns 1, 4 and 5), the half-and-half pattern 2 and the uniform pattern 0, which keep the
//    previous centroid weights: native float noise in the centroid decides their axis pixels (see
//    `emf-plus-redeye-nudge.fixture.test.ts`);
//  - a few noise-field scenes (pattern 3) with one to 28 pixels one or more levels off in one sector.
// Against the earlier in-process capture (all 192 scenes in one process, `redeye-independent`) no ceiling was raised:
// 13 scenes differ between the two captures because the earlier calls of a process leak into a call that holds red of
// luma 0 (see `emf-plus-redeye-state.fixture.test.ts`), and the model follows the fresh outputs.
const measuredLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[2,1,6],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[2,1,2],[0,0,0],[0,0,0],[69,23,1174],[0,0,0],[0,0,0],[0,0,0],[29,54,1030],[29,80,1199],[4,1,4],[0,0,0],[4,1,6],[16,1,31],[5,1,9],[59,39,331],[53,1,74],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[2,1,2],[0,0,0],[0,0,0],[70,53,2647],[0,0,0],[0,0,0],[0,0,0],[82,49,2606],[2,1,2],[0,0,0],[0,0,0],[7,54,120],[0,0,0],[0,0,0],[0,0,0],[47,54,1016],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[1,1,3],[0,0,0],[0,0,0],[1,1,1],[1,1,1],[0,0,0],[0,0,0],[28,70,261],[0,0,0],[11,11,38],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const heldOutLimits: number[][] = [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[4,13,38],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];

describe('native red-eye sector darkness controls', () => {
 for (const [name, limits, count, exactNonzero] of [
  ['redeye-fresh', measuredLimits, 192, 152],
  ['redeye-heldout', heldOutLimits, 72, 71],
 ] as const) {
  it(`matches closed ${name} controls exactly and retains per-capture residual ceilings`, () => {
   const cases = name === 'redeye-fresh' ? freshCaptures() : captures(name);
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
    if (!limits[c][0] && capture.blue > 0) {
     expect(actual, label).toEqual(new Uint8ClampedArray(expected));
     exact++;
    }
   }
   expect(exact).toBe(exactNonzero);
  });
 }

 it('differs from the in-process capture in 13 of 192 scenes, all holding red of luma 0 or an even half of pure red', () => {
  const inProcess = captures('redeye-independent');
  const fresh = freshCaptures();
  expect(inProcess).toHaveLength(192);
  const differing = fresh.filter((f, k) => f.output !== inProcess[k].output);
  expect(differing).toHaveLength(13);
  for (const f of differing) {
   const px = Buffer.from(f.source, 'base64');
   let luma0Red = 0;
   for (let i = 0; i < px.length; i += 4) if (px[i] - Math.max(px[i + 1], px[i + 2]) > 0 && Math.floor((9 * px[i + 1] + 2 * px[i + 2] + 5) / 11) === 0) luma0Red++;
   expect(luma0Red, `size ${f.size} pattern ${f.pattern} blue ${f.blue}`).toBeGreaterThan(0);
  }
 });

 it('weights red pixels of luma 0 like the others, from a few to all of them (redeye-zero-fraction, one fresh process per scene)', () => {
  const records = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/redeye-zero-fraction.json.gz', import.meta.url))).toString()) as Array<{ spec: string; runs: Array<Array<{ width: number; source: string; output: string }>> }>;
  expect(records).toHaveLength(40);
  let exact = 0;
  const inexact: string[] = [];
  for (const r of records) {
   const step = r.runs[0][0];
   const actual = applyRedEyeCorrection(new Uint8ClampedArray(Buffer.from(step.source, 'base64')), step.width, step.width, [{ left: 0, top: 0, right: step.width, bottom: step.width }]);
   const expected = Buffer.from(step.output, 'base64');
   let pixels = 0;
   for (let i = 0; i < actual.length; i += 4) if (actual[i] !== expected[i] || actual[i + 1] !== expected[i + 1] || actual[i + 2] !== expected[i + 2]) pixels++;
   if (!pixels) exact++; else inexact.push(`${r.spec}:${pixels}`);
  }
  expect({ exact, inexact }).toEqual({ exact: 30, inexact: ["Z24:288:0:6", "Z24:432:0:75", "Z30:2:0:8", "Z30:12:0:1", "Z30:48:0:1", "Z30:64:0:3", "Z30:96:0:2", "Z30:128:0:3", "Z30:192:0:1", "Z30:288:0:13"] });
 });
});
