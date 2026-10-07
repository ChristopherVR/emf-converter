import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { cmykPlanesToRgba } from './jpeg-cmyk';

// icm-cmyk-samples.bin: 8,000 random ink combinations (C, M, Y, K bytes) followed by the sRGB bytes that Windows ICM
// (mscms.dll TranslateBitmapBits, RSWOP.icm to sRGB, perceptual, best mode) returns for them; GDI+ draws CMYK JPEG
// with the same result. They were not used to solve the table (see scripts/gdi-fixtures/generate-cmyk-lut.ts).
it('converts CMYK like the Windows ICM transform GDI+ uses', () => {
	const data = new Uint8Array(readFileSync(new URL('./__fixtures__/gdi/icm-cmyk-samples.bin', import.meta.url)));
	const count = data.length / 7;
	const planes = [0, 1, 2, 3].map(() => new Uint8Array(count));
	for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) planes[c][i] = 255 - data[i * 7 + c];
	const rgba = cmykPlanesToRgba(planes, count, 1, false);
	let exact = 0;
	let max = 0;
	for (let i = 0; i < count; i++) {
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(rgba[i * 4 + c] - data[i * 7 + 4 + c]);
			if (d === 0) exact++;
			max = Math.max(max, d);
		}
	}
	expect(count).toBe(8000);
	expect(exact).toBe(23824);
	expect(max).toBeLessThanOrEqual(1);
});
