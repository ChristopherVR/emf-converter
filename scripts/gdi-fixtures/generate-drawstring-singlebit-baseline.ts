/**
 * Native SingleBitPerPixelGridFit DrawString baselines: Arial "HHH" drawn
 * from a point (0 x 0 layout rectangle) at em 8..40 and 44..80 by 4, each in
 * its own EMF+ metafile played back by GDI+ (`System.Drawing`
 * `Graphics.DrawImage` of the `Metafile` onto a 200 x 160 white bitmap). The
 * destination is the metafile's own `Bounds` (201 x 161 here, one pixel past
 * the picture), which plays it one device pixel per pixel; a 200 x 160
 * destination would shrink it by 200/201 and move hinted text. Writes
 * the metafiles and the native ink masks (red below 128 green) to
 * `src/__fixtures__/gdi/text-drawstring-singlebit-baseline.json.gz`.
 *
 * Usage (Windows): bun scripts/gdi-fixtures/generate-drawstring-singlebit-baseline.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const W = 200;
const H = 160;
const SIZES = [...Array.from({ length: 33 }, (_, i) => 8 + i), 44, 48, 52, 56, 60, 64, 68, 72, 76, 80];

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
const pad4 = (b: Uint8Array) => concat([b, new Uint8Array((4 - (b.length % 4)) % 4)]);
function plusRec(type: number, flags: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
	const d = pad4(data);
	const r = new Uint8Array(12 + d.length);
	const v = new DataView(r.buffer);
	v.setUint16(0, type, true);
	v.setUint16(2, flags, true);
	v.setUint32(4, r.length, true);
	v.setUint32(8, d.length, true);
	r.set(d, 12);
	return r;
}
function metafile(em: number): Uint8Array {
	const header = new Uint8Array(16);
	const hv = new DataView(header.buffer);
	hv.setUint32(0, 0xdbc01002, true);
	hv.setUint32(4, 1, true); // video display
	hv.setUint32(8, 96, true);
	hv.setUint32(12, 96, true);
	const family = 'Arial';
	const font = new Uint8Array(24 + family.length * 2);
	const fv = new DataView(font.buffer);
	fv.setUint32(0, 0xdbc01002, true);
	fv.setFloat32(4, em, true);
	fv.setUint32(8, 2, true); // Pixel
	fv.setUint32(20, family.length, true);
	for (let i = 0; i < family.length; i++) fv.setUint16(24 + i * 2, family.charCodeAt(i), true);
	const text = 'HHH';
	const str = new Uint8Array(28 + text.length * 2);
	const sv = new DataView(str.buffer);
	sv.setUint32(0, 0xffff0000, true);
	sv.setUint32(4, 0xffffffff, true); // no StringFormat object
	sv.setUint32(8, text.length, true);
	[10, 20, 0, 0].forEach((n, i) => sv.setFloat32(12 + i * 4, n, true));
	for (let i = 0; i < text.length; i++) sv.setUint16(28 + i * 2, text.charCodeAt(i), true);
	const plus = concat([
		plusRec(0x4001, 0, header),
		plusRec(0x401f, 1), // TextRenderingHint SingleBitPerPixelGridFit
		plusRec(0x4008, (6 << 8) | 0, font),
		plusRec(0x401c, 0x8000, str),
		plusRec(0x4002, 0),
	]);
	const body = pad4(concat([new Uint8Array([0x45, 0x4d, 0x46, 0x2b]), plus]));
	const comment = new Uint8Array(12 + body.length);
	const cv = new DataView(comment.buffer);
	cv.setUint32(0, 70, true);
	cv.setUint32(4, comment.length, true);
	cv.setUint32(8, body.length, true);
	comment.set(body, 12);
	const eof = new Uint8Array(20);
	const ev = new DataView(eof.buffer);
	[14, 20, 0, 16, 20].forEach((n, i) => ev.setUint32(i * 4, n, true));
	const h = new Uint8Array(108);
	const v = new DataView(h.buffer);
	const frame = [0, 0, Math.round((W / 96) * 2540), Math.round((H / 96) * 2540)];
	[1, 108, 0, 0, W - 1, H - 1, ...frame, 0x464d4520, 0x00010000, 108 + comment.length + eof.length, 3].forEach((n, i) => v.setUint32(i * 4, n >>> 0, true));
	v.setUint16(56, 2, true);
	[1920, 960, 508, 254].forEach((n, i) => v.setInt32(72 + i * 4, n, true));
	[508000, 254000].forEach((n, i) => v.setInt32(100 + i * 4, n, true));
	return concat([h, comment, eof]);
}

const dir = mkdtempSync(join(tmpdir(), 'singlebit-baseline-'));
try {
	for (const em of SIZES) writeFileSync(join(dir, `${em}.emf`), metafile(em));
	const ps = `Add-Type -AssemblyName System.Drawing
Get-ChildItem '${dir}\\*.emf' | ForEach-Object {
	$mf = New-Object System.Drawing.Imaging.Metafile($_.FullName)
	$b = $mf.GetMetafileHeader().Bounds
	$bmp = New-Object System.Drawing.Bitmap(${W}, ${H})
	$g = [System.Drawing.Graphics]::FromImage($bmp)
	$g.Clear([System.Drawing.Color]::White)
	$g.DrawImage($mf, $b.X, $b.Y, $b.Width, $b.Height)
	$g.Dispose()
	$bmp.Save(($_.FullName -replace '\\.emf$', '.png'), [System.Drawing.Imaging.ImageFormat]::Png)
	$bmp.Dispose(); $mf.Dispose()
}`;
	execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
	const captures = [];
	for (const em of SIZES) {
		const img = await loadImage(readFileSync(join(dir, `${em}.png`)));
		const c = createCanvas(W, H);
		const g = c.getContext('2d');
		g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, W, H).data;
		const bits = new Uint8Array((W * H) / 8);
		for (let i = 0; i < W * H; i++) if (d[i * 4] > 128 && d[i * 4 + 1] < 128) bits[i >> 3] |= 1 << (i & 7);
		captures.push({ em, emf: Buffer.from(readFileSync(join(dir, `${em}.emf`))).toString('base64'), ink: Buffer.from(bits).toString('base64') });
	}
	const out = new URL('../../src/__fixtures__/gdi/text-drawstring-singlebit-baseline.json.gz', import.meta.url);
	writeFileSync(out, gzipSync(JSON.stringify({ width: W, height: H, captures })));
	console.log(`${captures.length} captures written`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
