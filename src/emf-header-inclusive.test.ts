import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { convertMetafileToDataUrl, convertMetafileToSvgTree } from './index';

// Original synthetic records. The fill crosses the declared viewport boundary so
// a missing final output row/column is observable; primitive edge rules are not tested here.
function record(type: number, words: number[] = []): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(8 + words.length * 4),
		view = new DataView(bytes.buffer);
	view.setUint32(0, type, true);
	view.setUint32(4, bytes.length, true);
	words.forEach((word, i) => view.setUint32(8 + i * 4, word, true));
	return bytes;
}
function rectangle(left = 0, top = 0, width = 20, height = 12): ArrayBuffer {
	const records = [
		record(39, [1, 0, 0xff, 0]),
		record(37, [1]),
		record(37, [0x80000008]),
		record(43, [left, top, left + width, top + height]),
		record(14, [0, 16, 20]),
	];
	const bytes = new Uint8Array(108 + records.reduce((n, r) => n + r.length, 0)),
		view = new DataView(bytes.buffer);
	for (const [at, value] of [
		[0, 1],
		[4, 108],
		[8, left],
		[12, top],
		[16, left + width - 1],
		[20, top + height - 1],
		[32, Math.round((width * 2540) / 96)],
		[36, Math.round((height * 2540) / 96)],
		[40, 0x464d4520],
		[44, 0x10000],
		[48, bytes.length],
		[52, records.length + 1],
		[56, 2],
		[72, 96],
		[76, 96],
		[80, 25],
		[84, 25],
		[100, 25000],
		[104, 25000],
	])
		view.setUint32(at, value, true);
	let offset = 108;
	for (const item of records) {
		bytes.set(item, offset);
		offset += item.length;
	}
	return bytes.buffer;
}
describe('inclusive EMF header reaches public output dimensions', () => {
	it.each([
		[0, 0, 20, 12],
		[-4, 6, 20, 12],
		[0, 0, 1, 1],
	])(
		'preserves every source pixel for origin(%i,%i) size%i×%i',
		async (left, top, width, height) => {
			const input = rectangle(left, top, width, height),
				saved = new Uint8Array(input).slice();
			const svg = await convertMetafileToSvgTree(input, {
				gdiAntialias: true,
				exactRasterOps: false,
				dpiScale: 1,
			});
			expect(svg?.attrs.width).toBe(width);
			expect(svg?.attrs.height).toBe(height);
			const url = await convertMetafileToDataUrl(input, { gdiAntialias: true, dpiScale: 1 });
			expect(url).toBeTruthy();
			const image = await loadImage(url!);
			expect(image.width).toBe(width);
			expect(image.height).toBe(height);
			const context = createCanvas(width, height).getContext('2d');
			context.drawImage(image, 0, 0);
			const pixels = context.getImageData(0, 0, width, height).data;
			for (let i = 0; i < pixels.length; i += 4)
				expect(Array.from(pixels.subarray(i, i + 4))).toEqual([255, 0, 0, 255]);
			expect(new Uint8Array(input)).toEqual(saved);
		},
	);
	it('normalizes inclusive dimensions before bounded output scaling', async () => {
		const svg = await convertMetafileToSvgTree(rectangle(), {
			maxWidth: 10,
			gdiAntialias: true,
			exactRasterOps: false,
		});
		expect(svg?.attrs.width).toBe(10);
		expect(svg?.attrs.height).toBe(6);
	});
});
