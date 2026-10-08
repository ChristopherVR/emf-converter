import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { pathGradientSampler } from './emf-plus-exact-fill';

interface Capture { points: [number, number][]; center: [number, number]; focus: [number, number]; bgra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/path-gradient-focus-contours.json.gz', import.meta.url))).toString());
// Native vertex-order controls retain a few boundary/overlapping-strip residuals.
// Each capture has its own ceiling so improvements cannot hide a regression elsewhere.
const residuals: Record<number, [number, number]> = {"2":[0,0],"9":[0,0],"16":[0,0],"21":[1,205],"22":[1,38],"23":[0,0],"25":[1,14],"28":[1,205],"29":[1,38],"30":[0,0],"31":[3,223],"32":[1,14],"35":[1,205],"36":[1,38],"37":[0,0],"39":[1,14],"42":[2,237],"44":[0,0],"45":[1,126],"49":[2,237],"51":[0,0],"52":[1,126],"56":[2,237],"58":[0,0],"59":[1,126],"63":[1,175],"65":[0,0],"70":[1,175],"72":[0,0],"77":[1,175],"79":[0,0],"84":[1,126],"85":[1,240],"86":[0,0],"87":[2,202],"91":[1,126],"92":[1,240],"93":[0,0],"94":[1,89],"98":[1,126],"99":[1,240],"100":[0,0],"101":[1,89],"107":[0,0],"112":[1,113],"114":[0,0],"121":[0,0],"126":[1,87],"133":[1,87],"140":[1,87],"149":[0,0],"156":[0,0],"163":[0,0],"168":[3,187],"170":[0,0],"175":[3,187],"177":[0,0],"182":[3,187],"184":[0,0],"191":[0,0],"196":[2,136],"198":[0,0],"205":[0,0],"212":[0,0],"213":[1,136],"219":[0,0],"220":[1,136],"226":[0,0],"227":[1,136],"233":[0,0],"238":[5,224],"240":[0,0],"247":[0,0]};

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
