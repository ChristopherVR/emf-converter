import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { convertMetafileToPdf, svgTreeToPdf } from './index';
import { encodeJpeg } from './jpeg-encoder';
import { encodePng } from './png-encoder';
import { bytesToBase64, svgTreeToDataUrl, type SvgNode } from './svg-tree';
import { svgPathToPdf } from './pdf-svg';
import { buildTestFont } from './__fixtures__/test-font';

const latin1 = (b: Uint8Array): string => Array.from(b, (c) => String.fromCharCode(c)).join('');

/** Parses the cross-reference table back out of a PDF and checks every offset and stream length. */
function validatePdf(bytes: Uint8Array): { text: string; objects: Map<number, string> } {
	const text = latin1(bytes);
	expect(text.startsWith('%PDF-1.7\n')).toBe(true);
	expect(text.endsWith('%%EOF\n')).toBe(true);
	const sx = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
	expect(sx).not.toBeNull();
	const xrefAt = Number(sx![1]);
	expect(text.slice(xrefAt, xrefAt + 5)).toBe('xref\n');
	const head = /^xref\n0 (\d+)\n/.exec(text.slice(xrefAt))!;
	const size = Number(head[1]);
	let p = xrefAt + head[0].length;
	const objects = new Map<number, string>();
	for (let n = 0; n < size; n++) {
		const row = text.slice(p, p + 20);
		expect(row).toMatch(/^\d{10} \d{5} [nf] \n$/);
		p += 20;
		if (n === 0) {
			continue;
		}
		const off = Number(row.slice(0, 10));
		expect(text.slice(off, off + `${n} 0 obj\n`.length)).toBe(`${n} 0 obj\n`);
		const end = text.indexOf('\nendobj\n', off);
		expect(end).toBeGreaterThan(off);
		const body = text.slice(off + `${n} 0 obj\n`.length, end);
		const len = /\/Length (\d+) >>\nstream\n/.exec(body);
		if (len) {
			const start = body.indexOf('stream\n') + 7;
			expect(body.slice(start + Number(len[1]), start + Number(len[1]) + 10)).toBe('\nendstream');
		}
		objects.set(n, body);
	}
	const trailer = /trailer\n<< \/Size (\d+) \/Root (\d+) 0 R/.exec(text.slice(p))!;
	expect(Number(trailer[1])).toBe(size);
	expect(objects.get(Number(trailer[2]))).toContain('/Type /Catalog');
	return { text, objects };
}

const svg = (children: SvgNode[], w = 100, h = 50): SvgNode => ({
	tag: 'svg',
	attrs: { xmlns: 'http://www.w3.org/2000/svg', width: w, height: h, viewBox: `0 0 ${w} ${h}` },
	children,
});

/** The first page's decoded content stream (call with `compress: false`). */
function pageContent(text: string): string {
	const page = /\/Contents (\d+) 0 R/.exec(text)!;
	const m = new RegExp(`\\n${page[1]} 0 obj\\n<<[^]*?>>\\nstream\\n([^]*?)\\nendstream`).exec(text)!;
	return m[1];
}

async function rgbaDataUrl(w: number, h: number, fill: (x: number, y: number) => number[]): Promise<string> {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			data.set(fill(x, y), (y * w + x) * 4);
		}
	}
	return `data:image/png;base64,${bytesToBase64(await encodePng(data, w, h))}`;
}

describe('svgPathToPdf', () => {
	it('converts relative, implicit and closing commands', () => {
		expect(svgPathToPdf('M10 20l5 0 0 5-5 0z')).toBe('10 20 m 15 20 l 15 25 l 10 25 l h');
		expect(svgPathToPdf('M0 0h10v10H0Z')).toBe('0 0 m 10 0 l 10 10 l 0 10 l h');
	});
	it('promotes quadratics to cubics and restarts after close', () => {
		expect(svgPathToPdf('M0 0Q3 3 6 0z l1 1')).toBe('0 0 m 2 2 4 2 6 0 c h 0 0 m 1 1 l');
	});
});

describe('svgTreeToPdf structure', () => {
	it('writes a valid single-page PDF with exact xref offsets', async () => {
		const pdf = await svgTreeToPdf(
			svg([
				{ tag: 'path', attrs: { d: 'M0 0l50 0 0 25-50 0z', fill: '#ff0000' } },
				{ tag: 'path', attrs: { d: 'M5 5l40 40', fill: 'none', stroke: '#0000ff', 'stroke-width': 3, 'stroke-dasharray': '4 2', 'stroke-linecap': 'round' } },
			]),
			{ compress: false },
		);
		expect(pdf).not.toBeNull();
		const { text } = validatePdf(pdf!);
		expect(text).toContain('/MediaBox [0 0 75 37.5]');
		const content = pageContent(text);
		expect(content).toContain('1 0 0 rg');
		expect(content).toContain('0 0 1 RG');
		expect(content).toContain('[4 2] 0 d');
		expect(content).toContain('1 J');
	});

	it('compresses content streams by default', async () => {
		const many = Array.from({ length: 200 }, (_, i) => ({ tag: 'path', attrs: { d: `M${i} 0l5 0 0 5-5 0z`, fill: '#123456' } }));
		const pdf = (await svgTreeToPdf(svg(many)))!;
		const { text } = validatePdf(pdf);
		expect(text).toContain('/Filter /FlateDecode');
	});

	it('maps opacity, blend mode, even-odd and clip chains', async () => {
		const tree = svg([
			{ tag: 'defs', attrs: {}, children: [
				{ tag: 'clipPath', attrs: { id: 'c0' }, children: [{ tag: 'path', attrs: { d: 'M0 0l40 0 0 40-40 0z' } }] },
				{ tag: 'clipPath', attrs: { id: 'c1' }, children: [{ tag: 'path', attrs: { d: 'M10 10l40 0 0 40-40 0z', 'clip-path': 'url(#c0)', 'clip-rule': 'evenodd' } }] },
			] },
			{ tag: 'g', attrs: { 'clip-path': 'url(#c1)' }, children: [
				{ tag: 'path', attrs: { d: 'M0 0l50 0 0 50-50 0z', fill: '#00ff00', 'fill-opacity': 0.5, 'fill-rule': 'evenodd', style: 'mix-blend-mode:multiply' } },
			] },
		]);
		const { text } = validatePdf((await svgTreeToPdf(tree, { compress: false }))!);
		expect(text).toContain('/ca 0.5 /CA 0.5 /BM /Multiply');
		const content = pageContent(text);
		expect(content).toContain('W n');
		expect(content).toContain('W* n');
		expect(content).toContain(' f*');
	});

	it('maps gradients (with an alpha soft mask) and tiling patterns', async () => {
		const tile = await rgbaDataUrl(2, 2, (x, y) => ((x + y) % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
		const tree = svg([
			{ tag: 'defs', attrs: {}, children: [
				{ tag: 'linearGradient', attrs: { id: 'g0', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 100, y2: 0 }, children: [
					{ tag: 'stop', attrs: { offset: 0, 'stop-color': '#ff0000' } },
					{ tag: 'stop', attrs: { offset: 0.5, 'stop-color': '#00ff00', 'stop-opacity': 0.5 } },
					{ tag: 'stop', attrs: { offset: 1, 'stop-color': '#0000ff' } },
				] },
				{ tag: 'radialGradient', attrs: { id: 'g1', gradientUnits: 'userSpaceOnUse', fx: 20, fy: 20, fr: 0, cx: 20, cy: 20, r: 20, gradientTransform: 'matrix(2 0 0 1 0 0)' }, children: [
					{ tag: 'stop', attrs: { offset: 0, 'stop-color': '#ffffff' } },
					{ tag: 'stop', attrs: { offset: 1, 'stop-color': '#000000' } },
				] },
				{ tag: 'pattern', attrs: { id: 'p0', patternUnits: 'userSpaceOnUse', width: 2, height: 2, patternTransform: 'matrix(4 0 0 4 0 0)' }, children: [
					{ tag: 'image', attrs: { x: 0, y: 0, width: 2, height: 2, preserveAspectRatio: 'none', href: tile, style: 'image-rendering:pixelated' } },
				] },
			] },
			{ tag: 'path', attrs: { d: 'M0 0l100 0 0 20-100 0z', fill: 'url(#g0)' } },
			{ tag: 'path', attrs: { d: 'M0 20l40 0 0 30-40 0z', fill: 'url(#g1)' } },
			{ tag: 'path', attrs: { d: 'M50 20l50 0 0 30-50 0z', fill: 'url(#p0)' } },
		]);
		const { text } = validatePdf((await svgTreeToPdf(tree, { compress: false }))!);
		expect(text).toContain('/ShadingType 2');
		expect(text).toContain('/ShadingType 3');
		expect(text).toContain('/FunctionType 3');
		expect(text).toContain('/SMask << /Type /Mask /S /Luminosity');
		expect(text).toContain('/PatternType 1');
		expect(text).toContain('/Interpolate false');
	});

	it('embeds JPEG verbatim and PNG as RGB with an SMask', async () => {
		const jpeg = encodeJpeg(new Uint8ClampedArray(16 * 16 * 4).fill(200), 16, 16);
		const jpegUrl = `data:image/jpeg;base64,${bytesToBase64(jpeg)}`;
		const pngUrl = await rgbaDataUrl(4, 4, (x) => [x * 60, 0, 0, x === 0 ? 0 : 255]);
		const tree = svg([
			{ tag: 'image', attrs: { x: 0, y: 0, width: 16, height: 16, href: jpegUrl } },
			{ tag: 'image', attrs: { x: 20, y: 0, width: 16, height: 16, href: pngUrl, opacity: 0.5, transform: 'matrix(1 0 0 1 3 3)' } },
		]);
		const pdf = (await svgTreeToPdf(tree, { compress: false }))!;
		const { text, objects } = validatePdf(pdf);
		expect(text).toContain('/Filter /DCTDecode');
		expect(text).toContain('/SMask ');
		// The JPEG bytes appear unchanged inside the file.
		expect(text).toContain(latin1(jpeg.subarray(0, 64)));
		expect([...objects.values()].some((o) => o.includes('/ColorSpace /DeviceGray'))).toBe(true);
	});

	it('turns an embedded SVG data URL into a form XObject', async () => {
		const inner = svg([{ tag: 'path', attrs: { d: 'M0 0l10 0 0 10-10 0z', fill: '#ff00ff' } }], 10, 10);
		const tree = svg([{ tag: 'image', attrs: { x: 5, y: 5, width: 40, height: 40, href: svgTreeToDataUrl(inner) } }]);
		const { text } = validatePdf((await svgTreeToPdf(tree, { compress: false }))!);
		expect(text).toContain('/Subtype /Form');
		expect(text).toContain('1 0 1 rg');
		expect(pageContent(text)).toContain('4 0 0 4 5 5 cm');
	});

	it('skips undecodable images instead of failing', async () => {
		const tree = svg([
			{ tag: 'image', attrs: { x: 0, y: 0, width: 5, height: 5, href: 'data:image/webp;base64,UklGRg==' } },
			{ tag: 'path', attrs: { d: 'M0 0l5 0 0 5-5 0z', fill: '#000000' } },
		]);
		const pdf = await svgTreeToPdf(tree, { compress: false });
		expect(pdf).not.toBeNull();
		validatePdf(pdf!);
	});

	it('exposes a decodeImage hook for formats without a bundled decoder', async () => {
		let called = '';
		const tree = svg([{ tag: 'image', attrs: { x: 0, y: 0, width: 5, height: 5, href: 'data:image/webp;base64,UklGRg==' } }]);
		const pdf = await svgTreeToPdf(tree, {
			compress: false,
			decodeImage: (_b, mime) => {
				called = mime;
				return { data: new Uint8ClampedArray(2 * 2 * 4).fill(255), width: 2, height: 2 };
			},
		});
		expect(called).toBe('image/webp');
		expect(latin1(pdf!)).toContain('/Width 2 /Height 2');
	});

	it('uses a standard font without fonts, and an embedded subset with them', async () => {
		const tree = svg([
			{ tag: 'text', attrs: { x: '5 15 25', y: 20, 'font-family': 'Test Sans', 'font-size': 12, fill: '#000000' }, text: 'Ilo' },
			{ tag: 'text', attrs: { x: 5, y: 40, 'font-family': 'Times New Roman', 'font-size': 10, 'font-weight': '700', fill: '#000000' }, text: 'Hi' },
		]);
		const plain = latin1((await svgTreeToPdf(tree, { compress: false }))!);
		expect(plain).toContain('/BaseFont /Helvetica');
		expect(plain).toContain('/BaseFont /Times-Bold');
		const withFont = await svgTreeToPdf(tree, { compress: false, fonts: [buildTestFont()] });
		const { text } = validatePdf(withFont!);
		expect(text).toContain('/Subtype /CIDFontType2');
		expect(text).toContain('/Encoding /Identity-H');
		expect(text).toContain('/ToUnicode');
		expect(text).toContain('/FontFile2');
		// Glyph 2 (I) maps back to U+0049 in the ToUnicode CMap.
		expect(text).toMatch(/<0002> <0049>/);
		expect(text).toContain('/BaseFont /Times-Bold');
	});

	it('fits the drawing to a custom page size', async () => {
		const tree = svg([{ tag: 'path', attrs: { d: 'M0 0l100 0 0 50-100 0z', fill: '#000000' } }]);
		const { text } = validatePdf((await svgTreeToPdf(tree, { compress: false, pageSize: { width: 300, height: 300 } }))!);
		expect(text).toContain('/MediaBox [0 0 300 300]');
		// scale 3, centred: (300 - 150) / 2 = 75 down from the top.
		expect(pageContent(text)).toContain('3 0 0 -3 0 225 cm');
	});

	it('returns null for a non-svg root', async () => {
		expect(await svgTreeToPdf({ tag: 'g', attrs: {} })).toBeNull();
	});
});

describe('convertMetafileToPdf', () => {
	it('converts a fixture EMF to a valid PDF', async () => {
		const buf = readFileSync(new URL('./__fixtures__/sample-gradient-clip.emf', import.meta.url));
		const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
		const pdf = await convertMetafileToPdf(ab);
		expect(pdf).not.toBeNull();
		validatePdf(pdf!);
	});

	it('returns null for garbage', async () => {
		expect(await convertMetafileToPdf(new ArrayBuffer(8))).toBeNull();
	});
});

describe('rendered with pdf.js', () => {
	it('paints fills, strokes, clips, gradients and images where the SVG puts them', async () => {
		const pngUrl = await rgbaDataUrl(2, 2, () => [0, 0, 255, 255]);
		const tree = svg(
			[
				{ tag: 'defs', attrs: {}, children: [
					{ tag: 'clipPath', attrs: { id: 'c0' }, children: [{ tag: 'path', attrs: { d: 'M50 0l20 0 0 20-20 0z' } }] },
					{ tag: 'linearGradient', attrs: { id: 'g0', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 20, y2: 0 }, children: [
						{ tag: 'stop', attrs: { offset: 0, 'stop-color': '#000000' } },
						{ tag: 'stop', attrs: { offset: 1, 'stop-color': '#ffffff' } },
					] },
				] },
				{ tag: 'path', attrs: { d: 'M0 0l20 0 0 20-20 0z', fill: '#ff0000' } },
				{ tag: 'path', attrs: { d: 'M25 10l20 0', fill: 'none', stroke: '#00ff00', 'stroke-width': 6 } },
				{ tag: 'g', attrs: { 'clip-path': 'url(#c0)' }, children: [{ tag: 'path', attrs: { d: 'M40 0l60 0 0 60-60 0z', fill: '#ff00ff' } }] },
				{ tag: 'path', attrs: { d: 'M0 30l20 0 0 20-20 0z', fill: 'url(#g0)' } },
				{ tag: 'image', attrs: { x: 80, y: 30, width: 20, height: 20, href: pngUrl } },
				{ tag: 'image', attrs: { x: 50, y: 30, width: 20, height: 20, href: `data:image/jpeg;base64,${bytesToBase64(encodeJpeg(new Uint8ClampedArray(16 * 16 * 4).map((v, i) => (i % 4 === 0 ? 255 : i % 4 === 3 ? 255 : 0)), 16, 16))}` } },
			],
			100,
			60,
		);
		const pdf = (await svgTreeToPdf(tree))!;
		// @ts-expect-error pdfjs-dist ships no typings for the legacy build path here
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const doc = await pdfjs.getDocument({ data: pdf.slice(), verbosity: 0 }).promise;
		const page = await doc.getPage(1);
		const viewport = page.getViewport({ scale: 4 / 3 });
		const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvasContext: ctx as never, viewport, canvas: canvas as never }).promise;
		const at = (x: number, y: number): number[] => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
		expect(at(10, 10)).toEqual([255, 0, 0]);
		expect(at(35, 10)).toEqual([0, 255, 0]);
		expect(at(60, 10)).toEqual([255, 0, 255]);
		expect(at(75, 10)).toEqual([255, 255, 255]); // outside the clip
		expect(at(90, 40)).toEqual([0, 0, 255]);
		const jpegPx = at(60, 40);
		expect(jpegPx[0]).toBeGreaterThan(220);
		expect(jpegPx[1]).toBeLessThan(40);
		const dark = at(2, 40);
		const light = at(18, 40);
		expect(dark[0]).toBeLessThan(40);
		expect(light[0]).toBeGreaterThan(215);
	}, 20000);
});
