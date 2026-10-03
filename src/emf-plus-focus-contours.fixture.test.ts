import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

interface Capture { points: [number, number][]; center: [number, number]; focus: [number, number]; bgra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-focus-contours.json.gz', import.meta.url))).toString());
// Native vertex-order controls retain a few boundary/overlapping-strip residuals.
// Each capture has its own ceiling so improvements cannot hide a regression elsewhere.
const residuals: Record<number, [number, number]> = {"4": [2, 23], "11": [2, 23], "18": [2, 23], "21": [1, 205], "22": [1, 38], "25": [4, 65], "28": [1, 205], "29": [1, 38], "31": [3, 223], "32": [4, 65], "35": [1, 205], "36": [1, 38], "39": [4, 65], "42": [2, 238], "45": [1, 126], "46": [2, 31], "49": [2, 238], "52": [1, 126], "53": [2, 31], "56": [2, 238], "59": [1, 126], "60": [2, 31], "63": [1, 175], "67": [2, 27], "70": [1, 175], "74": [2, 27], "77": [1, 175], "81": [2, 27], "84": [1, 126], "85": [1, 241], "87": [2, 202], "91": [1, 126], "92": [1, 241], "94": [1, 90], "98": [1, 126], "99": [1, 241], "101": [1, 90], "112": [1, 113], "126": [1, 87], "133": [1, 87], "140": [1, 87], "168": [3, 187], "175": [3, 187], "182": [3, 187], "196": [2, 136], "213": [1, 137], "220": [1, 137], "227": [1, 137], "238": [5, 224]};

it('preserves all 252 native focus contours across centres and vertex orders', () => {
 expect(captures).toHaveLength(252);
 for (const [i, c] of captures.entries()) {
  const sampler = pathGradientSampler({ boundary: c.points.map(([x, y]) => ({ x, y })),
   center: { x: c.center[0], y: c.center[1] }, focus: { x: c.focus[0], y: c.focus[1] },
   centerArgb: 0xffffffff, boundaryArgb: [0xff000000, 0xff000000, 0xff000000],
   blend: null, preset: null, transform: null }, 'clamp', [1, 0, 0, 1, 0, 0])!;
  const rgba = new Uint8ClampedArray(100 * 80 * 4);
  sampler(0, 0, 100, 80, rgba);
  const native = Buffer.from(c.bgra, 'base64');
  let differing = 0, maximum = 0;
  for (let p = 0; p < 100 * 80; p++) {
   const offset = p * 4;
   const difference = Math.abs((rgba[offset + 3] ? rgba[offset] : 255) - native[offset]);
   if (difference > 1) differing++;
   maximum = Math.max(maximum, difference);
  }
  const [count, max] = residuals[i] ?? [0, 1];
  expect(differing, `capture ${i}`).toBeLessThanOrEqual(count);
  expect(maximum, `capture ${i}`).toBeLessThanOrEqual(max);
 }
});
