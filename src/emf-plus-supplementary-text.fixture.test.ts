import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EMFPLUS_DRAWSTRING } from './emf-constants';
import { handleEmfPlusTextImageRecord } from './emf-plus-text-image-handlers';
import type { CanvasContext, EmfPlusReplayCtx } from './emf-types';
import { GdiFontCollection } from './gdi-font-engine';
import { SoftwareRasterCanvas } from './software-raster';
import { SvgContext } from './svg-context';
import type { SvgNode } from './svg-tree';

// CC0 font: each BMP/non-BMP pair maps to the same deliberately distinct rectangle.
// Native Windows DrawString produces identical pixels for those aliases in every hint.
const texts = ['A\ue000A', 'A\u{f0000}A', 'A\u{1f642}A', '\ue000\ue001', '\u{f0000}\u{f0001}'];
interface Capture { hint: number; size: number; text: number; bgra: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(
	new URL('./__fixtures__/gdi/text-supplementary.json.gz', import.meta.url),
)).toString());
const fonts = new GdiFontCollection([readFileSync(new URL('./__fixtures__/gdi/supplementary.ttf', import.meta.url))]);

function replay(ctx: CanvasContext, capture: Capture): void {
	const text = texts[capture.text];
	const view = new DataView(new ArrayBuffer(28 + 2 * text.length));
	view.setUint32(0, 0xff000000, true);
	view.setUint32(4, 1, true);
	view.setUint32(8, text.length, true); // The record length is UTF-16 units, not glyphs.
	view.setFloat32(12, 8, true); view.setFloat32(16, 8, true);
	view.setFloat32(20, 1000, true); view.setFloat32(24, 1000, true);
	for (let i = 0; i < text.length; i++) view.setUint16(28 + i * 2, text.charCodeAt(i), true);
	const r: EmfPlusReplayCtx = {
		ctx, view, objectTable: new Map([
			[0, { kind: 'plus-font', family: 'Parity Supplementary', emSize: capture.size, flags: 0, unit: 2 }],
			[1, { kind: 'plus-stringformat', flags: 0x6404, alignment: 0, lineAlignment: 0,
				leadingMargin: 0, trailingMargin: 0, tracking: 1 }],
		]),
		worldTransform: [1, 0, 0, 1, 0, 0], deferredImages: [], saveStack: [], saveIdMap: new Map(),
		totalImageObjects: 0, totalDrawImageCalls: 0, clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1,
		continuationBuffer: null, continuationObjectId: 0, continuationObjectType: 0,
		continuationTotalSize: 0, continuationOffset: 0, fonts, textRenderingHint: capture.hint, ext: { textContrast: 0 },
	};
	expect(handleEmfPlusTextImageRecord(r, EMFPLUS_DRAWSTRING, 0x8000, 0, view.byteLength)).toBe(true);
}

describe('native DrawString supplementary Unicode with a supplied font', () => {
	it('captures 75 controls with identical BMP and supplementary glyphs across five hints and three sizes', () => {
		expect(captures).toHaveLength(75);
		for (const size of [16, 32, 48]) for (const hint of [1, 2, 3, 4, 5]) {
			const group = captures.filter((c) => c.size === size && c.hint === hint);
			for (const [bmp, supplementary] of [[0, 1], [0, 2], [3, 4]]) {
				expect(group.find((c) => c.text === supplementary)!.bgra).toBe(group.find((c) => c.text === bmp)!.bgra);
			}
		}
	});

	for (const capture of captures) {
		it(`matches native RGBA at ${capture.size}px, hint ${capture.hint}, text ${capture.text}`, () => {
			const canvas = new SoftwareRasterCanvas(200, 64);
			canvas.ctx.fillStyle = '#ffffff'; canvas.ctx.fillRect(0, 0, 200, 64);
			replay(canvas.ctx as unknown as CanvasContext, capture);
			const native = Buffer.from(capture.bgra, 'base64');
			for (let p = 0; p < native.length; p += 4) {
				[native[p], native[p + 2]] = [native[p + 2], native[p]];
			}
			const actual = canvas.ctx.getImageData(0, 0, 200, 64).data;
			expect(Buffer.from(actual).equals(native)).toBe(true);
		});
	}

	it('keeps supplementary Unicode and one position per glyph in vector SVG text', async () => {
		const svg = new SvgContext(200, 64);
		replay(svg as unknown as CanvasContext, { hint: 1, size: 32, text: 1, bgra: '' });
		const nodes: SvgNode[] = [];
		const visit = (n: SvgNode) => { if (n.tag === 'text') nodes.push(n); n.children?.forEach(visit); };
		visit(await svg.toTree());
		expect(nodes).toHaveLength(1);
		expect(nodes[0].text).toBe(texts[1]);
		expect(String(nodes[0].attrs.x).split(/[ ,]+/)).toHaveLength(3);
	});
});
