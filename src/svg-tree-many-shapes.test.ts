import { describe, expect, it } from 'vitest';
import { convertMetafileToSvg, convertMetafileToSvgTree } from './index';

// Original synthetic records: a drawing made of far more top-level shapes than fit in a spread call.
function record(type: number, words: number[] = []): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(8 + words.length * 4),
		view = new DataView(bytes.buffer);
	view.setUint32(0, type, true);
	view.setUint32(4, bytes.length, true);
	words.forEach((word, i) => view.setUint32(8 + i * 4, word, true));
	return bytes;
}

/** `count` small triangles (EMR_POLYGON16) filled with one brush and no pen, on a `size` x `size` canvas. */
function triangles(count: number, size: number): ArrayBuffer {
	const records = [record(39, [1, 0, 0xff, 0]), record(37, [1]), record(37, [0x80000008])];
	for (let i = 0; i < count; i++) {
		const x = i % (size - 3);
		const y = Math.floor(i / (size - 3)) % (size - 3);
		const point = (px: number, py: number): number => ((py & 0xffff) << 16) | (px & 0xffff);
		// bounds (left, top, right, bottom), point count, three 16-bit points
		records.push(record(86, [x, y, x + 2, y + 2, 3, point(x, y), point(x + 2, y), point(x + 2, y + 2)]));
	}
	records.push(record(14, [0, 16, 20]));
	const bytes = new Uint8Array(108 + records.reduce((n, r) => n + r.length, 0)),
		view = new DataView(bytes.buffer);
	for (const [at, value] of [
		[0, 1],
		[4, 108],
		[16, size - 1],
		[20, size - 1],
		[32, Math.round((size * 2540) / 96)],
		[36, Math.round((size * 2540) / 96)],
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

describe('SVG output of drawings with a very large number of shapes', () => {
	// Real CAD exports reach hundreds of thousands of top-level shapes; spreading that many
	// arguments into Array.prototype.push overflows the call stack (around 120k in V8).
	const COUNT = 200_000;

	it('builds the tree without overflowing the call stack', async () => {
		const tree = await convertMetafileToSvgTree(triangles(COUNT, 400), { maxRecords: COUNT + 100 });
		expect(tree?.tag).toBe('svg');
		expect(tree!.children!.length).toBeGreaterThan(130_000);
	}, 60_000);

	it('serialises it to SVG markup', async () => {
		const svg = await convertMetafileToSvg(triangles(COUNT, 400), { maxRecords: COUNT + 100 });
		expect(svg).toMatch(/^<svg /);
		expect(svg!.match(/<path /g)!.length).toBeGreaterThan(130_000);
	}, 60_000);
});
