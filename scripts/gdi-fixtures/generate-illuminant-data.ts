/**
 * Rebuilds `src/emf-gdi-illuminant-data.ts` from the cubes captured by
 * `generate.ps1 illuminant-cubes <dir>` (HalftoneColorProbe.cs):
 *
 *   bun scripts/gdi-fixtures/generate-illuminant-data.ts <dir>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const dir = process.argv[2];
if (!dir) {
	throw new Error('Pass the directory holding illuminant-cube-N.bin');
}
let out = `/**
 * Native halftone colour cubes for \`COLORADJUSTMENT.caIlluminantIndex\` 1..5, 7
 * and 8 (A, B, C, D50, D55, D75, F2): the colour Windows draws for each of the
 * 32 x 32 x 32 palette colours, captured with
 * \`scripts/gdi-fixtures\` (\`illuminant-cubes\`). Each cube is the R, G and B
 * planes (index \`(r * 32 + g) * 32 + b\`), each plane delta-coded along b,
 * zlib-compressed and base64 encoded.
 *
 * @module emf-gdi-illuminant-data
 */

export const ILLUMINANT_CUBE_DATA: Readonly<Record<number, string>> = {
`;
for (const illuminant of [1, 2, 3, 4, 5, 7, 8]) {
	const cube = readFileSync(join(dir, `illuminant-cube-${illuminant}.bin`));
	const planes = new Uint8Array(cube.length);
	for (let c = 0; c < 3; c++) {
		for (let i = 0; i < 32768; i++) {
			const previous = i & 31 ? cube[(i - 1) * 3 + c] : 0;
			planes[c * 32768 + i] = (cube[i * 3 + c] - previous) & 255;
		}
	}
	out += `\t${illuminant}: '${deflateSync(planes, { level: 9 }).toString('base64')}',\n`;
}
out += '};\n';
writeFileSync(new URL('../../src/emf-gdi-illuminant-data.ts', import.meta.url), out);
