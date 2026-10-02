/**
 * End-to-end replay regressions built from metafiles assembled in memory:
 *
 * - An EMF+ dual-mode metafile (`EmfPlusHeader` flags bit 0) carries the
 *   picture twice; only the EMF+ stream is played, as GDI+ does, unless an
 *   EmfPlusGetDC hands drawing back to the EMF records.
 * - A window/viewport mapping yields device units, which are placed on the
 *   canvas by the bounds mapping (bounds origin to canvas origin, scaled by
 *   dpiScale) exactly as unmapped records are.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { canvasGetImageData, createTempCanvas, ensureNodeCanvasModule } from './emf-canvas-helpers';
import { getRenderableEmfBounds, parseEmfHeader } from './emf-header-parser';
import { replayEmfRecords } from './emf-record-replay';

beforeAll(async () => {
	await ensureNodeCanvasModule();
});

// ---------------------------------------------------------------------------
// Metafile builders
// ---------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function pad4(bytes: Uint8Array): Uint8Array {
	return concat([bytes, new Uint8Array((4 - (bytes.length % 4)) % 4)]);
}

/** A classic EMF record whose payload is `fields` as int32s. */
function record(type: number, fields: number[]): Uint8Array {
	const b = new Uint8Array(8 + fields.length * 4);
	const v = new DataView(b.buffer);
	v.setUint32(0, type, true);
	v.setUint32(4, b.length, true);
	fields.forEach((f, i) => v.setInt32(8 + i * 4, f, true));
	return b;
}

/** One EMF+ record wrapped in its own EMR_COMMENT_EMFPLUS. */
function plusComment(type: number, flags: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
	const d = pad4(data);
	const plus = new Uint8Array(12 + d.length);
	const pv = new DataView(plus.buffer);
	pv.setUint16(0, type, true);
	pv.setUint16(2, flags, true);
	pv.setUint32(4, plus.length, true);
	pv.setUint32(8, d.length, true);
	plus.set(d, 12);
	const body = pad4(concat([new Uint8Array([0x45, 0x4d, 0x46, 0x2b]), plus]));
	const b = new Uint8Array(12 + body.length);
	const v = new DataView(b.buffer);
	v.setUint32(0, 70, true);
	v.setUint32(4, b.length, true);
	v.setUint32(8, body.length, true);
	b.set(body, 12);
	return b;
}

function buildEmf(bounds: [number, number, number, number], records: Uint8Array[]): ArrayBuffer {
	const body = concat([...records, record(14, [0, 16, 20])]);
	const h = new Uint8Array(108);
	const v = new DataView(h.buffer);
	const ints = [1, 108, ...bounds, 0, 0, 5291, 5291, 0x464d4520, 0x00010000, 108 + body.length, records.length + 2];
	ints.forEach((n, i) => v.setUint32(i * 4, n >>> 0, true));
	v.setUint16(56, 2, true);
	[1024, 768, 320, 240].forEach((n, i) => v.setInt32(72 + i * 4, n, true));
	[320000, 240000].forEach((n, i) => v.setInt32(100 + i * 4, n, true));
	return concat([h, body]).buffer as ArrayBuffer;
}

const redRect = (l: number, t: number, r: number, b: number) => [
	record(39, [1, 0, 0x000000ff, 0]), // EMR_CREATEBRUSHINDIRECT, red
	record(37, [1]), // EMR_SELECTOBJECT
	record(43, [l, t, r, b]), // EMR_RECTANGLE
];

/** EmfPlusHeader; `dual` sets record flags bit 0 (EmfPlusDual). */
function plusHeader(dual: boolean): Uint8Array {
	const d = new Uint8Array(16);
	const v = new DataView(d.buffer);
	v.setUint32(0, 0xdbc01002, true);
	v.setUint32(8, 96, true);
	v.setUint32(12, 96, true);
	return plusComment(0x4001, dual ? 1 : 0, d);
}

/** EmfPlusFillRects with an inline ARGB colour, one rectangle. */
function plusFillRect(argb: number, x: number, y: number, w: number, h: number): Uint8Array {
	const d = new Uint8Array(24);
	const v = new DataView(d.buffer);
	v.setUint32(0, argb, true);
	v.setUint32(4, 1, true);
	[x, y, w, h].forEach((n, i) => v.setFloat32(8 + i * 4, n, true));
	return plusComment(0x400a, 0x8000, d);
}

// ---------------------------------------------------------------------------
// Rendering and measurement
// ---------------------------------------------------------------------------

interface Measure {
	/** Fraction of the region's pixels matching the colour. */
	area: number;
	cx: number;
	cy: number;
}

function render(emf: ArrayBuffer, dpiScale = 1): { data: Uint8ClampedArray; w: number; h: number } {
	const view = new DataView(emf);
	const bounds = getRenderableEmfBounds(parseEmfHeader(view)!)!;
	const w = Math.round((bounds.right - bounds.left) * dpiScale);
	const h = Math.round((bounds.bottom - bounds.top) * dpiScale);
	const c = createTempCanvas(w, h);
	expect(c).not.toBeNull();
	replayEmfRecords(view, c!.ctx, bounds, w, h, dpiScale, { gdiAntialias: false });
	return { data: canvasGetImageData(c!.ctx, 0, 0, w, h).data, w, h };
}

function measure(
	img: { data: Uint8ClampedArray; w: number; h: number },
	match: (r: number, g: number, b: number, a: number) => boolean,
	from = 0,
	to = img.w,
): Measure {
	const x0 = Math.round(from);
	const x1 = Math.round(to);
	let n = 0;
	let sx = 0;
	let sy = 0;
	for (let y = 0; y < img.h; y++) {
		for (let x = x0; x < x1; x++) {
			const p = (y * img.w + x) * 4;
			if (match(img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3])) {
				n++;
				sx += x;
				sy += y;
			}
		}
	}
	return { area: n / ((x1 - x0) * img.h), cx: n ? sx / n / img.w : NaN, cy: n ? sy / n / img.h : NaN };
}

const isRed = (r: number, g: number, b: number, a: number) => a > 128 && r > 160 && g < 90 && b < 90;
const isBlue = (r: number, g: number, b: number, a: number) => a > 128 && b > 160 && r < 90 && g < 90;

// ---------------------------------------------------------------------------
// EMF+ dual mode
// ---------------------------------------------------------------------------

describe('EMF+ dual-mode metafiles', () => {
	// EMF+ fills the left half blue; the classic records fill the right half
	// red. A dual-mode reader must play only the EMF+ stream.
	const records = (dual: boolean, getDc = false) => [
		plusHeader(dual),
		plusFillRect(0xff0000ff, 0, 0, 100, 200),
		...(getDc ? [plusComment(0x4004, 0)] : []),
		...redRect(100, 0, 200, 200),
		plusComment(0x4002, 0),
	];

	it('skips the classic EMF fallback when EmfPlusDual is set', () => {
		const img = render(buildEmf([0, 0, 199, 199], records(true)));
		expect(measure(img, isBlue, 0, img.w / 2).area).toBeGreaterThan(0.95);
		expect(measure(img, isRed, img.w / 2).area).toBe(0);
	});

	it('still plays the EMF records of an EMF+-only metafile', () => {
		const img = render(buildEmf([0, 0, 199, 199], records(false)));
		expect(measure(img, isBlue, 0, img.w / 2).area).toBeGreaterThan(0.95);
		expect(measure(img, isRed, img.w / 2).area).toBeGreaterThan(0.95);
	});

	it('plays the EMF records that follow an EmfPlusGetDC in a dual-mode metafile', () => {
		const img = render(buildEmf([0, 0, 199, 199], records(true, true)));
		expect(measure(img, isRed, img.w / 2).area).toBeGreaterThan(0.95);
	});

	it('keeps the object and state records of the skipped fallback for a later GetDC run', () => {
		// The brush is created and selected by skipped fallback records; the
		// rectangle after the GetDC still paints with it.
		const [create, select, rect] = redRect(100, 0, 200, 200);
		const img = render(
			buildEmf(
				[0, 0, 199, 199],
				[plusHeader(true), create, select, plusComment(0x4004, 0), rect, plusComment(0x4002, 0)],
			),
		);
		expect(measure(img, isRed, img.w / 2).area).toBeGreaterThan(0.95);
	});
});

// ---------------------------------------------------------------------------
// Window/viewport mapping with a non-zero bounds origin
// ---------------------------------------------------------------------------

describe('window/viewport mapping and the bounds origin', () => {
	const W = 200;
	const mapping = (factor: number) => [
		record(17, [8]), // EMR_SETMAPMODE MM_ANISOTROPIC
		record(10, [0, 0]), // EMR_SETWINDOWORGEX
		record(12, [0, 0]), // EMR_SETVIEWPORTORGEX
		record(9, [W * factor, W * factor]), // EMR_SETWINDOWEXTEX
		record(11, [W, W]), // EMR_SETVIEWPORTEXTEX
	];
	// All three describe a 100x100 square centred in a 200x200 picture.
	const cases: Array<[string, [number, number, number, number], Uint8Array[]]> = [
		['origin (100,100), no mapping mode', [100, 100, 299, 299], redRect(150, 150, 250, 250)],
		['origin (100,100), MM_ANISOTROPIC', [100, 100, 299, 299], [...mapping(3), ...redRect(450, 450, 750, 750)]],
		['origin (0,0), MM_ANISOTROPIC', [0, 0, 199, 199], [...mapping(3), ...redRect(150, 150, 450, 450)]],
	];

	for (const dpiScale of [1, 2]) {
		for (const [name, bounds, recs] of cases) {
			it(`centres the square: ${name}, dpiScale ${dpiScale}`, () => {
				const m = measure(render(buildEmf(bounds, recs), dpiScale), isRed);
				expect(m.area).toBeGreaterThan(0.23);
				expect(m.area).toBeLessThan(0.27);
				expect(m.cx).toBeCloseTo(0.5, 1);
				expect(m.cy).toBeCloseTo(0.5, 1);
			});
		}
	}
});

// ---------------------------------------------------------------------------
// Window/viewport extents outside MM_ISOTROPIC / MM_ANISOTROPIC
// ---------------------------------------------------------------------------

describe('window/viewport extents and the map mode', () => {
	// A 900x600 window on a 300x200 viewport would shrink the picture to a
	// third, but only once a scalable map mode lets the extents take effect.
	const extents = [record(9, [900, 600]), record(11, [300, 200])];

	it('ignores the extents in MM_TEXT, the mode a DC starts in', () => {
		const img = render(buildEmf([0, 0, 299, 199], [...extents, ...redRect(0, 0, 300, 200)]));
		expect(measure(img, isRed).area).toBeGreaterThan(0.95);
	});

	it('applies the extents after SetMapMode(MM_ANISOTROPIC)', () => {
		const img = render(buildEmf([0, 0, 299, 199], [record(17, [8]), ...extents, ...redRect(0, 0, 300, 200)]));
		const m = measure(img, isRed);
		expect(m.area).toBeGreaterThan(0.09);
		expect(m.area).toBeLessThan(0.13);
	});

	it('drops extents set earlier when SetMapMode(MM_TEXT) follows', () => {
		const img = render(
			buildEmf([0, 0, 299, 199], [record(17, [8]), ...extents, record(17, [1]), ...redRect(0, 0, 300, 200)]),
		);
		expect(measure(img, isRed).area).toBeGreaterThan(0.95);
	});
});

// ---------------------------------------------------------------------------
// EMF+ clip replacement
// ---------------------------------------------------------------------------

describe('EMF+ SetClipRegion', () => {
	/** EmfPlusSetClipRect with CombineMode `mode`. */
	const setClipRect = (x: number, y: number, w: number, h: number, mode = 0) => {
		const d = new Uint8Array(16);
		const v = new DataView(d.buffer);
		[x, y, w, h].forEach((n, i) => v.setFloat32(i * 4, n, true));
		return plusComment(0x4032, (mode & 0xf) << 8, d);
	};
	/** EmfPlusObject: a region of one rectangle node, stored in slot `id`. */
	const rectRegion = (id: number, x: number, y: number, w: number, h: number) => {
		const d = new Uint8Array(28);
		const v = new DataView(d.buffer);
		v.setUint32(0, 0xdbc01002, true);
		v.setUint32(8, 0x10000000, true);
		[x, y, w, h].forEach((n, i) => v.setFloat32(12 + i * 4, n, true));
		return plusComment(0x4008, id | (4 << 8), d);
	};
	const setClipRegion = (id: number, mode = 0) => plusComment(0x4034, (id & 0xff) | ((mode & 0xf) << 8));

	it('replaces a clip set earlier (CombineMode Replace)', () => {
		const img = render(
			buildEmf(
				[0, 0, 299, 199],
				[
					plusHeader(false),
					setClipRect(0, 0, 75, 200),
					rectRegion(3, 0, 0, 300, 200),
					setClipRegion(3),
					plusFillRect(0xffff0000, 0, 0, 300, 200),
					plusComment(0x4002, 0),
				],
			),
		);
		expect(measure(img, isRed, 0, 75).area).toBeGreaterThan(0.95);
		expect(measure(img, isRed, 75).area).toBeGreaterThan(0.95);
	});
});
