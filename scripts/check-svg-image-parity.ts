// Export a self-contained Chromium SVG pixel check:
// bun scripts/check-svg-image-parity.ts [output.html]
// Open the page and inspect window.svgImageParity for PNG and native RGB results.
import { readFileSync } from 'node:fs';
import { convertMetafileToSvg } from '../src';
import { renderFixture, loadReference } from '../src/__fixtures__/gdi-parity-harness';

const names = [
 'gpx-image-bicubic', 'gpx-image-rotated-bilinear',
 'gpx-image-rotated-highqualitybicubic', 'gpx-image-clip-zorder',
 'gpx-image-attr-clamp-bilinear', 'plus-effect-blur-r3-rotate30',
 'gpx-image-pom-half-nearestneighbor',
];
const cases = [];
for (const name of names) {
 const bytes = readFileSync(`src/__fixtures__/gdi/${name}.emf`);
 const svg = await convertMetafileToSvg(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  { dpiScale: 1, imageResampling: 'exact' },
 );
 const png = (await renderFixture(`${name}.emf`))!;
 const native = await loadReference(name);
 const encoded = (image: typeof png) => ({
  width: image.width, height: image.height,
  data: Buffer.from(image.data).toString('base64'),
 });
 cases.push({ name, svg: Buffer.from(svg!).toString('base64'), png: encoded(png), native: encoded(native) });
}
const html = `<!doctype html><title>Exact SVG image parity</title><body><script>
const cases = ${JSON.stringify(cases)};
window.results = [];
window.done = false;
(async () => {
 for (const c of cases) {
  const image = new Image();
  image.src = 'data:image/svg+xml;base64,' + c.svg;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const result = { name: c.name };
  for (const key of ['png', 'native']) {
   const reference = c[key];
   const bytes = Uint8Array.from(atob(reference.data), c => c.charCodeAt(0));
   let n = 0, n8 = 0, max = 0;
   for (let y = 0; y < Math.min(canvas.height, reference.height); y++) {
    for (let x = 0; x < Math.min(canvas.width, reference.width); x++) {
     let difference = 0;
     for (let channel = 0; channel < 3; channel++) {
      difference = Math.max(difference, Math.abs(
       data[(y * canvas.width + x) * 4 + channel] - bytes[(y * reference.width + x) * 4 + channel],
      ));
     }
     if (difference) n++;
     if (difference > 8) n8++;
     max = Math.max(max, difference);
    }
   }
   result[key] = { n, n8, max };
  }
  window.results.push(result);
 }
 window.svgImageParity = {
  browser: navigator.userAgent,
  pass: window.results.every(r => r.png.n === 0),
  results: window.results,
 };
 document.body.append(Object.assign(document.createElement('pre'), {
  textContent: JSON.stringify(window.svgImageParity, null, 2),
 }));
 window.done = true;
})();
</script>`;
const output = process.argv[2] ?? `${process.env.TEMP}/emf-svg-image-parity.html`;
await Bun.write(output, html);
console.log(output);
