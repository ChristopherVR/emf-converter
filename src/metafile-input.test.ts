import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
	convertMetafile,
	convertMetafileToDataUrl,
	convertMetafileToImageData,
	convertMetafileToJpegDataUrl,
	convertMetafileToSvg,
} from './emf-converter';
import { readMetafileInput } from './metafile-input';
import { bytesToBase64 } from './svg-tree';

const emf = readFileSync(new URL('./__fixtures__/sample-gradient-clip.emf', import.meta.url));
const wmf = readFileSync(new URL('./__fixtures__/sample-crown.wmf', import.meta.url));

function plain(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesOf(buffer: ArrayBuffer | null): number[] {
	return buffer ? [...new Uint8Array(buffer)] : [];
}

describe('readMetafileInput', () => {
	it('uses an ArrayBuffer as is', async () => {
		const buffer = plain(emf);
		expect(await readMetafileInput(buffer)).toBe(buffer);
	});

	it('copies only the viewed bytes of a typed array or DataView', async () => {
		const backing = new Uint8Array(emf.length + 20).fill(0xee);
		backing.set(emf, 7);
		const view = backing.subarray(7, 7 + emf.length);
		expect(bytesOf(await readMetafileInput(view))).toEqual([...emf]);
		expect(bytesOf(await readMetafileInput(new DataView(backing.buffer, 7, emf.length)))).toEqual([...emf]);
	});

	it('reads a pooled Node Buffer without the bytes around it', async () => {
		const small = Buffer.from(wmf.subarray(0, 64));
		expect(small.buffer.byteLength).toBeGreaterThan(64);
		expect(bytesOf(await readMetafileInput(small))).toEqual([...wmf.subarray(0, 64)]);
	});

	it('reads a Blob', async () => {
		expect(bytesOf(await readMetafileInput(new Blob([emf])))).toEqual([...emf]);
	});

	it('inflates gzip (.emz / .wmz)', async () => {
		expect(bytesOf(await readMetafileInput(gzipSync(emf)))).toEqual([...emf]);
	});

	it('returns null for corrupt gzip and for unsupported inputs', async () => {
		const corrupt = gzipSync(emf);
		corrupt.fill(0, 20, 60);
		expect(await readMetafileInput(corrupt)).toBeNull();
		expect(await readMetafileInput('not bytes' as unknown as ArrayBuffer)).toBeNull();
	});
});

describe('convertMetafile', () => {
	it('returns PNG bytes matching the data URL and the RGBA rendering', async () => {
		const png = await convertMetafile(emf);
		expect(png).not.toBeNull();
		expect(png!.format).toBe('png');
		expect(png!.mimeType).toBe('image/png');
		expect([...png!.data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(await convertMetafileToDataUrl(emf)).toBe(`data:image/png;base64,${bytesToBase64(png!.data)}`);
		const rgba = await convertMetafileToImageData(emf);
		expect(rgba).not.toBeNull();
		expect([rgba!.width, rgba!.height]).toEqual([png!.width, png!.height]);
		expect(rgba!.data.length).toBe(rgba!.width * rgba!.height * 4);
	});

	it('returns JPEG bytes matching the JPEG data URL', async () => {
		const jpeg = await convertMetafile(wmf, { format: 'jpeg', quality: 0.8 });
		expect(jpeg!.mimeType).toBe('image/jpeg');
		expect([...jpeg!.data.subarray(0, 2)]).toEqual([0xff, 0xd8]);
		expect(await convertMetafileToJpegDataUrl(wmf, { quality: 0.8 })).toBe(`data:image/jpeg;base64,${bytesToBase64(jpeg!.data)}`);
	});

	it('returns SVG markup bytes with the SVG size', async () => {
		const svg = await convertMetafile(emf, { format: 'svg', idPrefix: 'a-' });
		expect(svg!.mimeType).toBe('image/svg+xml');
		const markup = new TextDecoder().decode(svg!.data);
		expect(markup).toBe(await convertMetafileToSvg(emf, { idPrefix: 'a-' }));
		expect(markup).toContain(`width="${svg!.width}"`);
	});

	it('renders .emz input exactly like the uncompressed file', async () => {
		const raw = await convertMetafile(emf);
		const emz = await convertMetafile(gzipSync(emf));
		expect(emz && [...emz.data]).toEqual(raw && [...raw.data]);
	});

	it('returns null for a non-metafile', async () => {
		expect(await convertMetafile(new Uint8Array(64))).toBeNull();
		expect(await convertMetafile(new Uint8Array(64), { format: 'svg' })).toBeNull();
	});
});
