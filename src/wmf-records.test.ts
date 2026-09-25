/**
 * Unit tests for the WMF player: the playback device and map modes
 * (`wmf-mapping.ts`), the object table, palettes and colour references
 * (`wmf-objects.ts`), the embedded-EMF reassembly (`wmf-embedded-emf.ts`),
 * the EMF record writer (`wmf-emf-bridge.ts`), ANSI decoding (`wmf-text.ts`)
 * and whole records played onto the pure-JavaScript raster
 * (`wmf-replay.ts`). Pixel exactness against Windows itself is proven by the
 * `wmf-*` fixtures in `gdi-parity.fixture.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import { parseWmfHeader } from './emf-header-parser';
import { SoftwareRasterCanvas } from './software-raster';
import { EmfRecordWriter } from './wmf-emf-bridge';
import { extractEmbeddedEmf } from './wmf-embedded-emf';
import {
	MM_ANISOTROPIC,
	MM_ISOTROPIC,
	MM_LOMETRIC,
	MM_TEXT,
	MM_TWIPS,
	scaleWindowExt,
	setMapMode,
	setViewportExt,
	setWindowExt,
	wmfPlayback,
	type WmfMapping,
} from './wmf-mapping';
import { DEFAULT_PALETTE, resolveColorRef } from './wmf-objects';
import { replayWmfRecords } from './wmf-replay';
import { ansiToCode } from './wmf-text';

// ---------------------------------------------------------------------------
// WMF builder
// ---------------------------------------------------------------------------

/** One record: its function number and 16-bit parameters in file order (or raw bytes). */
type Rec = [number, number[] | Uint8Array];

/** Builds a WMF (placeable when `bounds` is given) from records; META_EOF is appended. */
function buildWmf(records: Rec[], bounds?: [number, number, number, number], inch = 96): ArrayBuffer {
	const parts: number[] = [];
	const u16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
	const u32 = (v: number) => {
		u16(v & 0xffff);
		u16((v >>> 16) & 0xffff);
	};
	if (bounds) {
		u32(0x9ac6cdd7);
		u16(0);
		bounds.forEach((b) => u16(b));
		u16(inch);
		u32(0);
		let sum = 0;
		for (let i = 0; i < 20; i += 2) {
			sum ^= parts[i] | (parts[i + 1] << 8);
		}
		u16(sum);
	}
	u16(1);
	u16(9);
	u16(0x300);
	u32(0);
	u16(8);
	u32(0);
	u16(0);
	for (const [fn, params] of [...records, [0, []] as Rec]) {
		const bytes = params instanceof Uint8Array ? Array.from(params) : params.flatMap((w) => [w & 0xff, (w >> 8) & 0xff]);
		if (bytes.length % 2) {
			bytes.push(0);
		}
		u32(3 + bytes.length / 2);
		u16(fn);
		parts.push(...bytes);
	}
	return new Uint8Array(parts).buffer;
}

/** Plays `records` on a `w` x `h` placeable picture at 96 dpi; returns the RGBA pixels. */
function play(records: Rec[], w = 20, h = 20, bounds?: [number, number, number, number]): Uint8ClampedArray {
	const buf = buildWmf(records, bounds ?? [0, 0, w, h]);
	const view = new DataView(buf);
	const header = parseWmfHeader(view)!;
	const canvas = new SoftwareRasterCanvas(w, h);
	replayWmfRecords(view, canvas.ctx as never, header, w, h, { gdiAntialias: false });
	return canvas.ctx.getImageData(0, 0, w, h).data;
}

/** `0xRRGGBB` of pixel (`x`, `y`), or -1 when unpainted. */
function px(data: Uint8ClampedArray, w: number, x: number, y: number): number {
	const i = (y * w + x) * 4;
	return data[i + 3] === 0 ? -1 : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
}

/** COLORREF words (low, high) for `0xRRGGBB`. */
function cref(rgb: number): [number, number] {
	const r = (rgb >> 16) & 0xff;
	const g = (rgb >> 8) & 0xff;
	const b = rgb & 0xff;
	const v = r | (g << 8) | (b << 16);
	return [v & 0xffff, v >>> 16];
}

const brush = (rgb: number): Rec => [0x02fc, [0, ...cref(rgb), 0]];
const nullPen: Rec = [0x02fa, [5, 0, 0, 0, 0]];
const select = (slot: number): Rec => [0x012d, [slot]];
const del = (slot: number): Rec => [0x01f0, [slot]];
/** META_RECTANGLE (params bottom, right, top, left). */
const rect = (l: number, t: number, r: number, b: number): Rec => [0x041b, [b, r, t, l]];

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapping(): WmfMapping {
	return { mode: MM_ANISOTROPIC, winOrg: { x: 0, y: 0 }, winExt: { cx: 1, cy: 1 }, vpOrg: { x: 0, y: 0 }, vpExt: { cx: 1, cy: 1 } };
}

describe('wmf-mapping', () => {
	it('gives the metric modes their 96 dpi extents (y up)', () => {
		const m = mapping();
		setMapMode(m, MM_LOMETRIC);
		expect(m.winExt).toStrictEqual({ cx: 254, cy: 254 });
		expect(m.vpExt).toStrictEqual({ cx: 96, cy: -96 });
		setMapMode(m, MM_TWIPS);
		expect(m.winExt).toStrictEqual({ cx: 1440, cy: 1440 });
	});

	it('ignores extents outside the scalable modes and resets them for MM_TEXT', () => {
		const m = mapping();
		setMapMode(m, MM_TEXT);
		setWindowExt(m, 500, 500);
		expect(m.winExt).toStrictEqual({ cx: 1, cy: 1 });
		setMapMode(m, MM_ANISOTROPIC);
		setWindowExt(m, 500, 0);
		expect(m.winExt).toStrictEqual({ cx: 1, cy: 1 });
		setWindowExt(m, 500, 400);
		expect(m.winExt).toStrictEqual({ cx: 500, cy: 400 });
	});

	it('shrinks the isotropic viewport on the axis with the larger scale', () => {
		const m = mapping();
		setMapMode(m, MM_ISOTROPIC);
		setWindowExt(m, 300, 100);
		setViewportExt(m, 260, 180);
		// x scale 260/300 < y scale 180/100: y shrinks to 100 * 260/300.
		expect(m.vpExt).toStrictEqual({ cx: 260, cy: 87 });
	});

	it('scales extents with truncation', () => {
		const m = mapping();
		setWindowExt(m, 100, 101);
		scaleWindowExt(m, 3, 2, 1, 3);
		expect(m.winExt).toStrictEqual({ cx: 150, cy: 33 });
	});

	it('sizes a placeable picture by its bounds at its units per inch', () => {
		const view = new DataView(buildWmf([], [0, 0, 2880, 1440], 1440));
		const p = wmfPlayback(view, parseWmfHeader(view)!);
		expect([p.width, p.height]).toStrictEqual([192, 96]);
		expect(p.mapping.winExt).toStrictEqual({ cx: 2880, cy: 1440 });
		expect(p.mapping.vpExt).toStrictEqual({ cx: 192, cy: 96 });
	});

	it('sizes a non-placeable picture by its window extent, or its own anisotropic viewport', () => {
		const a = new DataView(buildWmf([[0x020c, [-200, 300]]]));
		expect(wmfPlayback(a, parseWmfHeader(a)!)).toMatchObject({ width: 300, height: 200 });
		const b = new DataView(buildWmf([[0x0103, [8]], [0x020c, [400, 600]], [0x020e, [150, 200]]]));
		expect(wmfPlayback(b, parseWmfHeader(b)!)).toMatchObject({ width: 200, height: 150 });
		expect(parseWmfHeader(b)!.placeable).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Objects, palettes and colours
// ---------------------------------------------------------------------------

describe('wmf-objects', () => {
	it('resolves PALETTEINDEX through the default palette, out-of-range to entry 0', () => {
		expect(resolveColorRef(0x01000000 | 13, null)).toBe(0xff0000);
		expect(resolveColorRef(0x01000000 | 99, null)).toBe(DEFAULT_PALETTE[0]);
		expect(resolveColorRef(0x02102030, null)).toBe(0x302010);
		expect(resolveColorRef(0x00ffeedd, null)).toBe(0xddeeff);
	});

	it('resolves PALETTEINDEX through a selected palette', () => {
		const pal = { kind: 'palette' as const, entries: [0x000000ff, 0x0000ff00] };
		expect(resolveColorRef(0x01000001, pal)).toBe(0x00ff00);
		expect(resolveColorRef(0x01000005, pal)).toBe(0xff0000);
	});

	it('puts each object in the lowest free slot', () => {
		// Brushes 0 (red), 1 (green); delete 0; brush (blue) reuses slot 0.
		const data = play([brush(0xff0000), brush(0x00ff00), del(0), brush(0x0000ff), nullPen, select(2), select(0), rect(0, 0, 10, 10), select(1), rect(10, 0, 20, 10)]);
		expect(px(data, 20, 2, 2)).toBe(0x0000ff);
		expect(px(data, 20, 12, 2)).toBe(0x00ff00);
	});

	it('keeps a deleted selected brush in use', () => {
		const data = play([brush(0x123456), nullPen, select(0), select(1), del(0), rect(0, 0, 10, 10)]);
		expect(px(data, 20, 3, 3)).toBe(0x123456);
	});

	it('re-colours the selected brush when palette entries change', () => {
		const palette = new Uint8Array([0x00, 0x03, 2, 0, 0xff, 0, 0, 1, 0, 0xff, 0, 1]); // version, 2 entries: red, green (PC_RESERVED)
		const entries = new Uint8Array([0, 0, 1, 0, 0, 0, 0xff, 1]); // start 0, 1 entry: blue
		const data = play([
			[0x00f7, palette],
			[0x0234, [0]],
			[0x02fc, [0, 0, 0x0100, 0]], // PALETTEINDEX(0)
			nullPen,
			select(1),
			select(2),
			rect(0, 0, 10, 10),
			[0x0037, entries],
			rect(10, 0, 20, 10),
		]);
		expect(px(data, 20, 3, 3)).toBe(0xff0000);
		expect(px(data, 20, 13, 3)).toBe(0x0000ff);
	});
});

// ---------------------------------------------------------------------------
// Records played onto the raster
// ---------------------------------------------------------------------------

describe('wmf-replay', () => {
	it('excludes the right and bottom device pixel of a Rectangle (GM_COMPATIBLE)', () => {
		const data = play([brush(0x808080), nullPen, select(0), select(1), rect(2, 2, 8, 8)]);
		// A null-pen rectangle fills left..right-2 (one pixel smaller again).
		expect(px(data, 20, 2, 2)).toBe(0x808080);
		expect(px(data, 20, 6, 6)).toBe(0x808080);
		expect(px(data, 20, 7, 7)).toBe(-1);
	});

	it('maps through the placeable bounds and a window origin record', () => {
		const data = play([[0x020b, [-5, -5]], brush(0xff00ff), nullPen, select(0), select(1), rect(0, 0, 5, 5)], 20, 20);
		expect(px(data, 20, 5, 5)).toBe(0xff00ff);
		expect(px(data, 20, 4, 4)).toBe(-1);
	});

	it('clips to IntersectClipRect and a selected region, and restores the clip on RestoreDC', () => {
		const region = new Uint8Array(
			new Uint16Array([0, 6, 0, 0, 0, 1, 2, 0, 0, 10, 10, 2, 0, 10, 0, 10, 2]).buffer,
		);
		const data = play([
			brush(0x00ff00),
			nullPen,
			select(0),
			select(1),
			[0x001e, []],
			[0x0416, [10, 10, 0, 0]], // IntersectClipRect 0,0,10,10 (params b, r, t, l)
			rect(0, 0, 21, 21),
			[0x0127, [-1]],
			[0x06ff, region],
			[0x012c, [2]],
			brush(0x0000ff),
			select(3),
			rect(0, 0, 21, 21),
		]);
		expect(px(data, 20, 5, 5)).toBe(0x0000ff);
		expect(px(data, 20, 15, 5)).toBe(-1);
	});

	it('paints FillRgn with the named brush and inverts InvertRgn', () => {
		const region = new Uint8Array(new Uint16Array([0, 6, 0, 0, 0, 1, 2, 0, 0, 4, 4, 2, 0, 4, 0, 4, 2]).buffer);
		const data = play([[0x06ff, region], brush(0x204060), [0x0228, [0, 1]], [0x012a, [0]]]);
		expect(px(data, 20, 1, 1)).toBe(0xdfbf9f);
		expect(px(data, 20, 5, 5)).toBe(-1);
	});

	it('plays a pattern-only META_PATBLT with the brush', () => {
		const data = play([brush(0x445566), select(0), [0x061d, [0x0021, 0x00f0, 4, 6, 1, 2]]]);
		expect(px(data, 20, 2, 1)).toBe(0x445566);
		expect(px(data, 20, 7, 4)).toBe(0x445566);
		expect(px(data, 20, 8, 1)).toBe(-1);
	});

	it('sets one pixel with META_SETPIXEL', () => {
		const data = play([[0x041f, [...cref(0xabcdef), 3, 4]]]);
		expect(px(data, 20, 4, 3)).toBe(0xabcdef);
	});

	it('mirrors drawing after SETLAYOUT(LAYOUT_RTL)', () => {
		const data = play([[0x0149, [1, 0]], brush(0x111111), nullPen, select(0), select(1), rect(0, 0, 4, 4)]);
		expect(px(data, 20, 18, 1)).toBe(0x111111);
		expect(px(data, 20, 1, 1)).toBe(-1);
	});

	it('ignores the Win16 device-bitmap records Windows no longer plays', () => {
		const pattern = new Uint8Array(48);
		pattern.set([0, 0, 8, 0, 8, 0, 2, 0, 1, 1]);
		const data = play([[0x01f9, pattern], brush(0x010203), select(0), rect(0, 0, 5, 5)]);
		// The pattern brush took no slot: the solid brush is in slot 0.
		expect(px(data, 20, 1, 1)).toBe(0x010203);
	});
});

// ---------------------------------------------------------------------------
// Embedded EMF, record writer, ANSI text
// ---------------------------------------------------------------------------

/** META_ESCAPE MFCOMMENT chunks carrying `emf` in pieces of `chunk` bytes. */
function emfChunks(emf: Uint8Array, chunk: number, mutate?: (i: number, d: DataView) => void): Rec[] {
	const n = Math.ceil(emf.length / chunk);
	const out: Rec[] = [];
	for (let i = 0; i < n; i++) {
		const part = emf.subarray(i * chunk, Math.min(emf.length, (i + 1) * chunk));
		const d = new DataView(new ArrayBuffer(4 + 34 + part.length));
		d.setUint16(0, 0x000f, true);
		d.setUint16(2, 34 + part.length, true);
		d.setUint32(4, 0x43464d57, true);
		d.setUint32(8, 1, true);
		d.setUint32(12, 0x10000, true);
		d.setUint32(22, n, true);
		d.setUint32(26, part.length, true);
		d.setUint32(30, emf.length - (i * chunk + part.length), true);
		d.setUint32(34, emf.length, true);
		new Uint8Array(d.buffer).set(part, 38);
		mutate?.(i, d);
		out.push([0x0626, new Uint8Array(d.buffer)]);
	}
	return out;
}

describe('wmf-embedded-emf', () => {
	const emf = new Uint8Array(100);
	new DataView(emf.buffer).setUint32(0, 1, true); // EMR_HEADER

	it('reassembles the chunks in order', () => {
		const view = new DataView(buildWmf(emfChunks(emf, 30)));
		const got = extractEmbeddedEmf(view, 18);
		expect(got && new Uint8Array(got)).toStrictEqual(emf);
	});

	it('rejects a missing chunk or an inconsistent count', () => {
		const chunks = emfChunks(emf, 30);
		expect(extractEmbeddedEmf(new DataView(buildWmf(chunks.slice(0, 2))), 18)).toBeNull();
		const bad = emfChunks(emf, 30, (i, d) => i === 1 && d.setUint32(30, 0, true));
		expect(extractEmbeddedEmf(new DataView(buildWmf(bad)), 18)).toBeNull();
		expect(extractEmbeddedEmf(new DataView(buildWmf([])), 18)).toBeNull();
	});
});

describe('wmf-emf-bridge', () => {
	it('writes a record with its type and padded size', () => {
		const rec = new EmfRecordWriter(22, 8).u32(5).i16(-1).finish();
		expect(rec.getUint32(0, true)).toBe(22);
		expect(rec.getUint32(4, true)).toBe(16);
		expect(rec.getUint32(8, true)).toBe(5);
		expect(rec.getInt16(12, true)).toBe(-1);
	});
});

describe('wmf-text', () => {
	it('decodes ANSI bytes as Windows-1252, symbol fonts byte for byte', () => {
		expect(ansiToCode(0x41, 0)).toBe(0x41);
		expect(ansiToCode(0x80, 0)).toBe(0x20ac);
		expect(ansiToCode(0x93, 1)).toBe(0x201c);
		expect(ansiToCode(0x80, 2)).toBe(0x80);
		expect(ansiToCode(0xe9, 0)).toBe(0xe9);
	});
});
