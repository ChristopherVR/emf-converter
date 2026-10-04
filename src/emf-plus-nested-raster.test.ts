import { describe, it, expect } from 'vitest';

import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { convertMetafileToDataUrl } from './index';

// An EMF+ file whose only image is an embedded EMF holding one
// EMR_STRETCHDIBITS, drawn with EmfPlusDrawImagePoints at a chosen size.

const pad4 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

function header(w: number, h: number, nBytes: number, nRecords: number): Buffer {
	const b = Buffer.alloc(108);
	let o = 0;
	const u = (v: number): void => void ((b.writeUInt32LE(v >>> 0, o), (o += 4)));
	const i = (v: number): void => void ((b.writeInt32LE(v, o), (o += 4)));
	u(1); u(108);
	i(0); i(0); i(w - 1); i(h - 1);
	i(0); i(0); i(Math.round((w * 2540) / 96)); i(Math.round((h * 2540) / 96));
	u(0x464d4520); u(0x00010000);
	u(nBytes); u(nRecords);
	b.writeUInt16LE(2, o); o += 2;
	b.writeUInt16LE(0, o); o += 2;
	u(0); u(0); u(0);
	i(1920); i(1080); i(508); i(286);
	u(0); u(0); u(0);
	i(508000); i(286000);
	return b;
}
const record = (t: number, size: number, f: number[]): Buffer => {
	const b = Buffer.alloc(size);
	b.writeUInt32LE(t, 0);
	b.writeUInt32LE(size, 4);
	f.forEach((v, k) => b.writeInt32LE(v | 0, 8 + k * 4));
	return b;
};
const eof = record(14, 20, [0, 16, 20]);
const build = (w: number, h: number, rs: Buffer[]): Buffer => {
	const body = Buffer.concat(rs);
	return Buffer.concat([header(w, h, 108 + body.length, rs.length + 1), body]);
};
function plus(type: number, flags: number, data = Buffer.alloc(0)): Buffer {
	const d = pad4(data);
	const h = Buffer.alloc(12);
	h.writeUInt16LE(type, 0);
	h.writeUInt16LE(flags, 2);
	h.writeUInt32LE(12 + d.length, 4);
	h.writeUInt32LE(d.length, 8);
	return Buffer.concat([h, d]);
}
function comment(...records: Buffer[]): Buffer {
	const d = pad4(Buffer.concat([Buffer.from([0x45, 0x4d, 0x46, 0x2b]), ...records]));
	const h = Buffer.alloc(12);
	h.writeUInt32LE(70, 0);
	h.writeUInt32LE(12 + d.length, 4);
	h.writeUInt32LE(d.length, 8);
	return Buffer.concat([h, d]);
}

function stretchDibits(srcW: number, srcH: number): Buffer {
	const stride = Math.ceil((srcW * 3) / 4) * 4;
	const bits = Buffer.alloc(stride * srcH);
	for (let y = 0; y < srcH; y++) for (let x = 0; x < srcW; x++) bits[y * stride + x * 3 + 2] = 0xff;
	const bmi = Buffer.alloc(40);
	bmi.writeUInt32LE(40, 0); bmi.writeInt32LE(srcW, 4); bmi.writeInt32LE(srcH, 8);
	bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(24, 14); bmi.writeUInt32LE(bits.length, 20);
	const r = Buffer.alloc(80);
	r.writeUInt32LE(81, 0);
	r.writeUInt32LE(80 + 40 + bits.length, 4);
	[0, 0, 199, 99].forEach((v, k) => r.writeInt32LE(v, 8 + k * 4));
	r.writeInt32LE(srcW, 40); r.writeInt32LE(srcH, 44);
	r.writeUInt32LE(80, 48); r.writeUInt32LE(40, 52);
	r.writeUInt32LE(120, 56); r.writeUInt32LE(bits.length, 60);
	r.writeUInt32LE(0x00cc0020, 68);
	r.writeInt32LE(200, 72); r.writeInt32LE(100, 76);
	return build(200, 100, [Buffer.concat([r, bmi, bits]), eof]);
}

function outer(inner: Buffer, dw: number, dh: number): ArrayBuffer {
	const hd = Buffer.alloc(16);
	hd.writeUInt32LE(0xdbc01002, 0); hd.writeUInt32LE(96, 8); hd.writeUInt32LE(96, 12);
	const head = Buffer.alloc(8);
	head.writeUInt32LE(0xdbc01002, 0); head.writeUInt32LE(2, 4);
	const m = Buffer.alloc(8);
	m.writeUInt32LE(3, 0); m.writeUInt32LE(inner.length, 4);
	const image = plus(0x4008, 5 << 8, Buffer.concat([head, m, inner]));
	const d = Buffer.alloc(52);
	d.writeUInt32LE(2, 4);
	d.writeFloatLE(200, 16); d.writeFloatLE(100, 20);
	d.writeUInt32LE(3, 24);
	[[0, 0], [dw, 0], [0, dh]].forEach(([x, y], k) => {
		d.writeFloatLE(x, 28 + k * 8);
		d.writeFloatLE(y, 32 + k * 8);
	});
	const file = build(300, 200, [
		comment(plus(0x4001, 1, hd), image, plus(0x401b, 0, d)),
		comment(plus(0x4002, 0)),
		eof,
	]);
	return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

async function redBox(buf: ArrayBuffer): Promise<[number, number]> {
	const { createCanvas, loadImage } = await import('@napi-rs/canvas');
	const url = (await convertMetafileToDataUrl(buf, { dpiScale: 1 }))!;
	const img = await loadImage(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
	const c = createCanvas(img.width, img.height);
	const g = c.getContext('2d');
	g.fillStyle = '#fff';
	g.fillRect(0, 0, img.width, img.height);
	g.drawImage(img, 0, 0);
	const px = g.getImageData(0, 0, img.width, img.height).data;
	let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
	for (let y = 0; y < img.height; y++)
		for (let x = 0; x < img.width; x++) {
			const p = (y * img.width + x) * 4;
			if (px[p] > 160 && px[p + 1] < 90 && px[p + 2] < 90) {
				x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
			}
		}
	return x1 < 0 ? [0, 0] : [x1 - x0 + 1, y1 - y0 + 1];
}

describe('a bitmap inside an embedded EMF', () => {
	it('is scaled once by the DrawImagePoints destination', async () => {
		await ensureNodeCanvasModule();
		const [w, h] = await redBox(outer(stretchDibits(80, 40), 100, 50));
		expect(Math.abs(w - 100)).toBeLessThanOrEqual(2);
		expect(Math.abs(h - 50)).toBeLessThanOrEqual(2);
		const [fw, fh] = await redBox(outer(stretchDibits(80, 40), 200, 100));
		expect(Math.abs(fw - 200)).toBeLessThanOrEqual(2);
		expect(Math.abs(fh - 100)).toBeLessThanOrEqual(2);
	});
});
