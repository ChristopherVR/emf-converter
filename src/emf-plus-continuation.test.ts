import { describe, it, expect } from 'vitest';

import { createContinuationAccumulator, feedEmfPlusObjectRecord } from './emf-plus-continuation';

/** Object type 1 (Brush), id 7: the flags every record below shares. */
const FLAGS = (1 << 8) | 7;
const CONTINUED = 0x8000 | FLAGS;

/**
 * Lays out EMF+ object records' data blocks back to back in one buffer and
 * returns their offsets. Each block is `[prefix?, ...payload]`, where the
 * optional prefix is a 4-byte TotalObjectSize.
 */
function layout(blocks: Array<{ prefix?: number; payload: number[] }>): { view: DataView; offsets: number[]; sizes: number[] } {
	const sizes = blocks.map((b) => (b.prefix !== undefined ? 4 : 0) + b.payload.length);
	const view = new DataView(new ArrayBuffer(sizes.reduce((a, b) => a + b, 0) + 64));
	const offsets: number[] = [];
	let off = 16; // leave room so offsets are distinct from 0
	blocks.forEach((b, i) => {
		offsets.push(off);
		let o = off;
		if (b.prefix !== undefined) {
			view.setUint32(o, b.prefix, true);
			o += 4;
		}
		b.payload.forEach((v, k) => view.setUint8(o + k, v));
		off += sizes[i];
	});
	return { view, offsets, sizes };
}

function bytesOf(obj: { view: DataView; dataOff: number; dataSize: number }): number[] {
	return Array.from(new Uint8Array(obj.view.buffer, obj.view.byteOffset + obj.dataOff, obj.dataSize));
}

describe('feedEmfPlusObjectRecord', () => {
	it('passes a self-contained object straight through, keyed by its own dataOff', () => {
		const { view, offsets, sizes } = layout([{ payload: [1, 2, 3, 4, 5, 6, 7, 8] }]);
		const acc = createContinuationAccumulator();
		const obj = feedEmfPlusObjectRecord(acc, view, FLAGS, offsets[0], sizes[0]);
		expect(obj).not.toBeNull();
		expect(obj!.view).toBe(view);
		expect(obj!.dataOff).toBe(offsets[0]);
		expect(obj!.cacheKey).toBe(offsets[0]);
		expect(obj!.flags).toBe(FLAGS);
	});

	it('assembles a run whose every continued chunk carries TotalObjectSize ([MS-EMFPLUS] 2.3.5.1)', () => {
		const { view, offsets, sizes } = layout([
			{ prefix: 10, payload: [1, 2, 3, 4] },
			{ prefix: 10, payload: [5, 6, 7] },
			{ payload: [8, 9, 10] }, // final chunk, continuation bit clear, no prefix
		]);
		const acc = createContinuationAccumulator();
		expect(feedEmfPlusObjectRecord(acc, view, CONTINUED, offsets[0], sizes[0])).toBeNull();
		expect(feedEmfPlusObjectRecord(acc, view, CONTINUED, offsets[1], sizes[1])).toBeNull();
		const obj = feedEmfPlusObjectRecord(acc, view, FLAGS, offsets[2], sizes[2]);
		expect(obj).not.toBeNull();
		expect(bytesOf(obj!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(obj!.flags).toBe(FLAGS);
		// Keyed by the FIRST record of the run, the key the pre-decode pass uses too.
		expect(obj!.cacheKey).toBe(offsets[0]);
		expect(acc.continuationBuffer).toBeNull();
	});

	it('assembles a run where only the first chunk carries TotalObjectSize', () => {
		const { view, offsets, sizes } = layout([
			{ prefix: 6, payload: [1, 2, 3] },
			{ payload: [4, 5, 6] },
		]);
		const acc = createContinuationAccumulator();
		expect(feedEmfPlusObjectRecord(acc, view, CONTINUED, offsets[0], sizes[0])).toBeNull();
		const obj = feedEmfPlusObjectRecord(acc, view, FLAGS, offsets[1], sizes[1]);
		expect(bytesOf(obj!)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('completes as soon as TotalObjectSize bytes arrive, even with the continuation bit still set', () => {
		const { view, offsets, sizes } = layout([
			{ prefix: 4, payload: [1, 2] },
			{ prefix: 4, payload: [3, 4] },
		]);
		const acc = createContinuationAccumulator();
		expect(feedEmfPlusObjectRecord(acc, view, CONTINUED, offsets[0], sizes[0])).toBeNull();
		const obj = feedEmfPlusObjectRecord(acc, view, CONTINUED, offsets[1], sizes[1]);
		expect(bytesOf(obj!)).toEqual([1, 2, 3, 4]);
	});

	it('lets an unrelated object through mid-run without disturbing the run', () => {
		const { view, offsets, sizes } = layout([
			{ prefix: 4, payload: [1, 2] },
			{ payload: [9, 9, 9, 9, 9, 9, 9, 9] },
			{ payload: [3, 4] },
		]);
		const acc = createContinuationAccumulator();
		feedEmfPlusObjectRecord(acc, view, CONTINUED, offsets[0], sizes[0]);
		const other = feedEmfPlusObjectRecord(acc, view, (2 << 8) | 3, offsets[1], sizes[1]);
		expect(other!.cacheKey).toBe(offsets[1]);
		const obj = feedEmfPlusObjectRecord(acc, view, FLAGS, offsets[2], sizes[2]);
		expect(bytesOf(obj!)).toEqual([1, 2, 3, 4]);
	});

	it('rejects an implausible TotalObjectSize', () => {
		const { view, offsets, sizes } = layout([{ prefix: 0x7fffffff, payload: [1, 2, 3, 4] }]);
		const acc = createContinuationAccumulator();
		expect(feedEmfPlusObjectRecord(acc, view, CONTINUED, offsets[0], sizes[0])).toBeNull();
		expect(acc.continuationBuffer).toBeNull();
	});
});
