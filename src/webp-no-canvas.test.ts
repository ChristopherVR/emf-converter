/**
 * An EMF+ metafile with an embedded WebP image converted to PNG with no canvas
 * backend (`@napi-rs/canvas` mocked to fail, as in plain Node.js): the bundled
 * WebP decoder supplies the pixels and the software rasteriser draws them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fixtureBuffer } from './__fixtures__/emf-plus-effect-records';
import { decodePng } from './png-decoder';

vi.mock('@napi-rs/canvas', () => {
	throw new Error("Cannot find module '@napi-rs/canvas' (simulated, not installed)");
});

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/webp/${name}`, import.meta.url)));

/** Replaces the compressed image object of `gpx-image-rotated-bilinear.emf`, keeping every record size consistent. */
function embeddedImage(encoded: Uint8Array): ArrayBuffer {
	const bytes = new Uint8Array(fixtureBuffer('gpx-image-rotated-bilinear.emf'));
	const v = new DataView(bytes.buffer);
	for (let off = 0; off + 16 <= bytes.length; off += v.getUint32(off + 4, true)) {
		const size = v.getUint32(off + 4, true);
		if (v.getUint32(off, true) !== 70 || v.getUint32(off + 12, true) !== 0x2b464d45) continue;
		for (let p = off + 16; p + 12 <= off + size; p += v.getUint32(p + 4, true)) {
			if (v.getUint16(p, true) !== 0x4008 || ((v.getUint16(p + 2, true) >> 8) & 0x7f) !== 5) continue;
			const oldSize = v.getUint32(p + 4, true);
			const newSize = (40 + encoded.length + 3) & ~3;
			const delta = newSize - oldSize;
			const out = new Uint8Array(bytes.length + delta);
			out.set(bytes.subarray(0, p + 40));
			out.set(encoded, p + 40);
			out.set(bytes.subarray(p + oldSize), p + newSize);
			const o = new DataView(out.buffer);
			o.setUint32(p + 4, newSize, true);
			o.setUint32(p + 8, 28 + encoded.length, true);
			o.setUint32(p + 12 + 24, 1, true);
			o.setUint32(off + 4, size + delta, true);
			o.setUint32(off + 8, v.getUint32(off + 8, true) + delta, true);
			o.setUint32(48, out.length, true);
			return out.buffer;
		}
	}
	throw new Error('Image object missing');
}

async function renderPng(encoded: Uint8Array) {
	const { convertMetafileToDataUrl } = await import('./index');
	const url = await convertMetafileToDataUrl(embeddedImage(encoded));
	if (!url) return null;
	return decodePng(Buffer.from(url.replace('data:image/png;base64,', ''), 'base64'));
}

describe('EMF+ with an embedded WebP image, PNG output without a canvas backend', () => {
	it.each(['lossless-photo', 'lossless-photo-alpha', 'lossless-pal5-alpha'])('draws lossless %s exactly like the same pixels as PNG', async (name) => {
		const fromWebp = await renderPng(fixture(`${name}.webp`));
		const fromPng = await renderPng(fixture(`${name}.png`));
		expect(fromPng).not.toBeNull();
		expect(fromWebp).not.toBeNull();
		expect([fromWebp!.width, fromWebp!.height]).toEqual([fromPng!.width, fromPng!.height]);
		expect(fromWebp!.data).toEqual(fromPng!.data);
		expect(fromWebp!.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
	});

	it.each(['lossy-q75-m6', 'lossy-alpha-lossy', 'anim-lossy'])('draws lossy %s exactly like its decoded pixels as PNG', async (name) => {
		const fromWebp = await renderPng(fixture(`${name}.webp`));
		const fromPng = await renderPng(fixture(`${name}.png`));
		expect(fromWebp).not.toBeNull();
		expect(fromPng).not.toBeNull();
		expect(fromWebp!.data).toEqual(fromPng!.data);
	});

	it('still refuses a corrupt WebP rather than drawing nothing silently', async () => {
		const bad = fixture('lossy-q75-m6.webp').slice();
		bad.fill(0xff, 30);
		expect(await renderPng(bad)).toBeNull();
	});
});
