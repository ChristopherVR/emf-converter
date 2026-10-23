/**
 * `signal` / `timeoutMs`: cancellation of a conversion, on a synthetic
 * metafile that is slow to replay (wide-pen zigzag polylines).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { convertMetafile, convertMetafileToImageData } from './emf-converter';
import { convertMetafileToPdf } from './pdf-convert';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';

beforeAll(async () => {
	await ensureNodeCanvasModule();
});

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function record(type: number, fields: number[]): Uint8Array {
	const b = new Uint8Array(8 + fields.length * 4);
	const v = new DataView(b.buffer);
	v.setUint32(0, type, true);
	v.setUint32(4, b.length, true);
	fields.forEach((f, i) => v.setInt32(8 + i * 4, f, true));
	return b;
}

/** EMR_POLYLINE16 of `points` int16 pairs. */
function polyline16(points: Array<[number, number]>): Uint8Array {
	const size = 8 + 16 + 4 + points.length * 4;
	const b = new Uint8Array(size);
	const v = new DataView(b.buffer);
	v.setUint32(0, 87, true);
	v.setUint32(4, size, true);
	[0, 0, 8000, 8000].forEach((n, i) => v.setInt32(8 + i * 4, n, true));
	v.setUint32(24, points.length, true);
	points.forEach(([x, y], i) => {
		v.setInt16(28 + i * 4, x, true);
		v.setInt16(30 + i * 4, y, true);
	});
	return b;
}

function buildEmf(size: number, records: Uint8Array[]): ArrayBuffer {
	const body = concat([...records, record(14, [0, 16, 20])]);
	const h = new Uint8Array(108);
	const v = new DataView(h.buffer);
	const ints = [1, 108, 0, 0, size, size, 0, 0, size, size, 0x464d4520, 0x00010000, 108 + body.length, records.length + 2];
	ints.forEach((n, i) => v.setUint32(i * 4, n >>> 0, true));
	v.setUint16(56, 2, true);
	[1024, 768, 320, 240].forEach((n, i) => v.setInt32(72 + i * 4, n, true));
	[320000, 240000].forEach((n, i) => v.setInt32(100 + i * 4, n, true));
	return concat([h, body]).buffer as ArrayBuffer;
}

/** `count` zigzag polylines of `points` points drawn with a `penWidth` pen. */
function slowMetafile(count: number, points = 600, penWidth = 24): ArrayBuffer {
	const zig = (k: number): Array<[number, number]> =>
		Array.from({ length: points }, (_, i) => [(i * 7 + k * 13) % 1000, i % 2 ? 80 + ((k * 37) % 900) : 40 + ((i * 11) % 900)]);
	const records = [record(38, [1, 0, penWidth, 0, 0x00402010]), record(37, [1])];
	for (let k = 0; k < count; k++) {
		records.push(polyline16(zig(k)));
	}
	return buildEmf(1000, records);
}

const SLOW = slowMetafile(100); // about 5 s of replay when left alone
const FAST = slowMetafile(1, 40);

/** Awaits a promise that must reject; returns the rejection and how long it took. */
async function rejection(promise: Promise<unknown>): Promise<{ reason: unknown; ms: number }> {
	const start = performance.now();
	try {
		await promise;
	} catch (reason) {
		return { reason, ms: performance.now() - start };
	}
	throw new Error('expected the conversion to reject');
}

const FORMATS = ['png', 'jpeg', 'svg'] as const;

/** SVG only does the slow raster work when edges are rasterised the Windows way. */
const slow = <F extends (typeof FORMATS)[number]>(format: F, extra: object = {}) => ({ format, gdiAntialias: false, ...extra }) as { format: F };

describe('signal / timeoutMs', () => {
	it.each(FORMATS)('%s: timeoutMs rejects with a TimeoutError near the budget', async (format) => {
		const { reason, ms } = await rejection(convertMetafile(SLOW, slow(format, { timeoutMs: 100 })));
		expect(reason).toBeInstanceOf(DOMException);
		expect((reason as DOMException).name).toBe('TimeoutError');
		expect(ms).toBeLessThan(1500);
	});

	it.each(FORMATS)('%s: AbortSignal.timeout rejects mid-replay', async (format) => {
		const { reason, ms } = await rejection(convertMetafile(SLOW, slow(format, { signal: AbortSignal.timeout(80) })));
		expect((reason as DOMException).name).toBe('TimeoutError');
		expect(ms).toBeLessThan(1500);
	});

	it('pdf and webp share the same budget', async () => {
		const pdf = await rejection(convertMetafileToPdf(SLOW, { gdiAntialias: false, timeoutMs: 100 }));
		expect((pdf.reason as DOMException).name).toBe('TimeoutError');
		const webp = await rejection(convertMetafile(SLOW, { format: 'webp', timeoutMs: 100 }));
		expect((webp.reason as DOMException).name).toBe('TimeoutError');
	});

	it('abort() from another task rejects with the given reason', async () => {
		const controller = new AbortController();
		const why = new Error('user cancelled');
		setTimeout(() => controller.abort(why), 60);
		const { reason, ms } = await rejection(convertMetafileToImageData(SLOW, { signal: controller.signal }));
		expect(reason).toBe(why);
		expect(ms).toBeLessThan(1500);
	});

	it('abort() without a reason rejects with an AbortError', async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 60);
		const { reason } = await rejection(convertMetafile(SLOW, { signal: controller.signal }));
		expect((reason as DOMException).name).toBe('AbortError');
	});

	it.each(FORMATS)('%s: an already-aborted signal rejects immediately with its reason', async (format) => {
		const why = new Error('too late');
		const { reason, ms } = await rejection(convertMetafile(SLOW, { format, signal: AbortSignal.abort(why) }));
		expect(reason).toBe(why);
		expect(ms).toBeLessThan(100);
	});

	it('a signal that never aborts gives byte-identical output', async () => {
		const controller = new AbortController();
		for (const format of FORMATS) {
			const plain = await convertMetafile(FAST, { format });
			const guarded = await convertMetafile(FAST, { format, signal: controller.signal, timeoutMs: 60_000 });
			expect(plain).not.toBeNull();
			expect(Array.from(guarded!.data)).toEqual(Array.from(plain!.data));
		}
	});

	it('invalid input is still null, not a rejection, under a live signal', async () => {
		const junk = new Uint8Array(64).buffer;
		await expect(convertMetafile(junk, { signal: new AbortController().signal })).resolves.toBeNull();
	});

	it('an abort leaves no shared state dirty: later output is unchanged', async () => {
		const before = await convertMetafile(FAST, { format: 'png' });
		const svgBefore = await convertMetafile(FAST, { format: 'svg' });
		await rejection(convertMetafile(SLOW, slow('png', { timeoutMs: 60 })));
		await rejection(convertMetafile(SLOW, slow('svg', { signal: AbortSignal.timeout(60) })));
		const after = await convertMetafile(FAST, { format: 'png' });
		expect(Array.from(after!.data)).toEqual(Array.from(before!.data));
		// The aborted SVG conversions handed their auto-numbered id prefixes back.
		const numberOf = (image: { data: Uint8Array } | null) => Number(/emf(\d+)-/.exec(new TextDecoder().decode(image!.data))?.[1] ?? NaN);
		const svgAfter = await convertMetafile(FAST, { format: 'svg' });
		expect(numberOf(svgAfter)).toBe(numberOf(svgBefore) + 1);
	});
});
