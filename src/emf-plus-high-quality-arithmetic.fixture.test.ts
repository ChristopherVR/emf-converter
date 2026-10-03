import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import type { TransformMatrix } from './emf-types';

interface Capture {
	kernel: number;
	srcBgra: string;
	bgra: string;
	sx?: number; sy?: number; origin?: number;
	srcX?: number; srcY?: number; srcW?: number; srcH?: number;
	m?: TransformMatrix;
}

const bounds: Record<string, [number, number, number][]> = JSON.parse(readFileSync(
	new URL('./__fixtures__/gdi/hq-arithmetic-bounds.json', import.meta.url), 'utf8',
));

function compare(c: Capture, independent: boolean): [number, number, number] {
	const width = independent ? 13 : 8, height = independent ? 11 : 8, extent = independent ? 64 : 48;
	const source = Buffer.from(c.srcBgra, 'base64');
	const rgba = new Uint8ClampedArray(source.length);
	for (let p = 0; p < source.length; p += 4) {
		rgba[p] = source[p + 2]; rgba[p + 1] = source[p + 1]; rgba[p + 2] = source[p]; rgba[p + 3] = source[p + 3];
	}
	const block = resampleImage(rgba, width, height, {
		srcX: c.srcX ?? 0, srcY: c.srcY ?? 0, srcW: c.srcW ?? 8, srcH: c.srcH ?? 8,
		toDevice: c.m ?? [c.sx!, 0, 0, c.sy!, 4 + c.origin!, 4 + c.origin!],
		kernel: c.kernel === 6 ? 'hq-bilinear' : 'hq-bicubic', halfPixelOffset: false,
	}, { w: extent, h: extent })!;
	const native = Buffer.from(c.bgra, 'base64');
	let count = 0, sum = 0, maximum = 0;
	for (let y = 0; y < extent; y++) for (let x = 0; x < extent; x++) {
		const inside = x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
		const offset = ((y - block.y) * block.w + x - block.x) * 4;
		let difference = 0;
		for (let channel = 0; channel < 4; channel++) {
			const actual = inside ? channel === 3 ? block.rgba[offset + 3]
				: Math.round(block.rgba[offset + channel] * block.rgba[offset + 3] / 255) : 0;
			difference = Math.max(difference, Math.abs(actual - native[(y * extent + x) * 4 + (channel === 3 ? 3 : 2 - channel)]));
		}
		if (difference) count++;
		sum += difference;
		maximum = Math.max(maximum, difference);
	}
	return [count, sum, maximum];
}

for (const [name, length] of [['arithmetic', 288], ['independent', 192]] as const) {
	it(`preserves per-case native high-quality interpolation bounds for ${length} ${name} captures`, () => {
		const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(
			new URL(`./__fixtures__/gdi/hq-${name}.json.gz`, import.meta.url),
		)).toString());
		expect(captures).toHaveLength(length);
		expect(bounds[name]).toHaveLength(length);
		// Every ceiling is the minimum of the old and corrected path's native
		// metrics. Both-upscaled, fractional, mirror and complete unit copies
		// remain controls; anisotropic draws must improve without masking them.
		for (const [i, capture] of captures.entries()) {
			const metrics = compare(capture, name === 'independent');
			for (let metric = 0; metric < 3; metric++) {
				expect(metrics[metric], `${name} capture ${i}, metric ${metric}`).toBeLessThanOrEqual(bounds[name][i][metric]);
			}
		}
	});
}
