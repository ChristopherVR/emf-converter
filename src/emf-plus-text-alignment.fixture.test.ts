/** Native Windows single-line DrawString alignment. Regenerate captures with generate-text-alignment.ps1. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { beforeAll, describe, expect, it } from 'vitest';
import { windowsFonts } from './__fixtures__/gdi-parity-harness';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { EMFPLUS_DRAWSTRING } from './emf-constants';
import { handleEmfPlusTextImageRecord } from './emf-plus-text-image-handlers';
import { GdiFontCollection } from './gdi-font-engine';
import { SvgContext } from './svg-context';
import type { SvgNode } from './svg-tree';
import type { CanvasContext, EmfPlusReplayCtx } from './emf-types';

interface Capture {
	family: string; style: number; size: number; heldout: boolean; typo: boolean; flags: number;
	align: number; line: number; text: string; x: number; y: number; width: number; height: number; bgra: string;
}
interface Bounds {
	sha256: string; before: number[]; ceilings: number[]; minimumExact: number; minimumImproved: number;
}
const limits: { schemaVersion: number; baseline: string; groups: Record<string, Bounds> } = JSON.parse(readFileSync(
	new URL('./__fixtures__/gdi/text-alignment-bounds.json', import.meta.url), 'utf8',
));
const privateFont = readFileSync(new URL('./__fixtures__/gdi/supplementary.ttf', import.meta.url));
const privateFonts = new GdiFontCollection([privateFont]);
const systemFontBytes = windowsFonts();
const W = 256, H = 160;

function load(group: string): Capture[] {
	const bytes = readFileSync(new URL(`./__fixtures__/gdi/text-alignment-${group}.json.gz`, import.meta.url));
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(limits.groups[group].sha256);
	return JSON.parse(gunzipSync(bytes).toString());
}

function replay(ctx: CanvasContext, c: Capture, fonts: GdiFontCollection): void {
	const view = new DataView(new ArrayBuffer(28 + 2 * c.text.length));
	view.setUint32(0, 0xff000000, true); view.setUint32(4, 1, true); view.setUint32(8, c.text.length, true);
	[c.x, c.y, c.width, c.height].forEach((value, i) => view.setFloat32(12 + 4 * i, value, true));
	for (let i = 0; i < c.text.length; i++) view.setUint16(28 + 2 * i, c.text.charCodeAt(i), true);
	const r: EmfPlusReplayCtx = {
		ctx, view, objectTable: new Map([
			[0, { kind: 'plus-font', family: c.family, emSize: c.size, flags: c.style, unit: 2 }],
			[1, { kind: 'plus-stringformat', flags: c.flags, alignment: c.align, lineAlignment: c.line,
				leadingMargin: c.typo ? 0 : 1 / 6, trailingMargin: c.typo ? 0 : 1 / 6, tracking: c.typo ? 1 : 1.03 }],
		]),
		worldTransform: [1, 0, 0, 1, 0, 0], deferredImages: [], saveStack: [], saveIdMap: new Map(),
		totalImageObjects: 0, totalDrawImageCalls: 0, clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1,
		continuationBuffer: null, continuationObjectId: 0, continuationObjectType: 0, continuationTotalSize: 0,
		continuationOffset: 0, fonts, textRenderingHint: 4, ext: { textContrast: 0 },
	};
	expect(handleEmfPlusTextImageRecord(r, EMFPLUS_DRAWSTRING, 0x8000, 0, view.byteLength)).toBe(true);
}

function differentPixels(actual: Uint8ClampedArray, native: Buffer): number {
	let count = 0;
	for (let p = 0; p < actual.length; p += 4) {
		if (actual[p] !== native[p + 2] || actual[p + 1] !== native[p + 1] || actual[p + 2] !== native[p] ||
			actual[p + 3] !== native[p + 3]) count++;
	}
	return count;
}

beforeAll(async () => {
	await ensureNodeCanvasModule();
	// Unsupported controls retain the canvas fallback, including the existing near/near behavior.
	// Register the generated CC0 face so that path remains portable outside Windows.
	GlobalFonts.register(privateFont);
});

describe.skipIf(!systemFontBytes)('native DrawString shaping fallback', () => {
	it('preserves legacy full RGBA for all declined mark, Arabic and format-control strings', () => {
		const captures = load('shaping'), bounds = limits.groups.shaping;
		const fonts = new GdiFontCollection(systemFontBytes!);
		const legacyFonts = new GdiFontCollection(systemFontBytes!);
		const realize = legacyFonts.realize.bind(legacyFonts);
		// The optional design-width capability enables only the new aligned layout.
		// Removing it reproduces the prior path with the same current glyph engine,
		// without freezing unrelated raster defects into converter-generated pixels.
		legacyFonts.realize = (...args) => {
			const font = realize(...args);
			return font && new Proxy(font, {
				get(target, key) {
					if (key === 'designAdvance') return undefined;
					const value = Reflect.get(target, key);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		};
		expect(captures).toHaveLength(36);
		expect(limits.baseline).toBe('1aac5a6 handler, current font engine');
		for (const [index, c] of captures.entries()) {
			const render = (collection: GdiFontCollection): Uint8ClampedArray => {
				const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
				ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
				replay(ctx as unknown as CanvasContext, c, collection);
				return ctx.getImageData(0, 0, W, H).data;
			};
			const actual = render(fonts), legacy = render(legacyFonts);
			const label = `${c.align}/${c.line}: ${c.text}`;
			expect(Buffer.from(actual).equals(Buffer.from(legacy)), label).toBe(true);
			expect(bounds.ceilings[index], label).toBe(bounds.before[index]);
			expect(differentPixels(actual, Buffer.from(c.bgra, 'base64')), label).toBeLessThanOrEqual(bounds.ceilings[index]);
		}
	});
});

for (const group of ['private', 'arial', 'segoe', 'arial-italic', 'courier-italic', 'times-italic']) {
	describe.skipIf(group !== 'private' && !systemFontBytes)(`native DrawString alignment: ${group}`, () => {
		it('preserves all baseline ceilings and pins every native RGBA control individually', () => {
			const captures = load(group), bounds = limits.groups[group];
			expect(captures).toHaveLength(432);
			expect(bounds.ceilings).toHaveLength(captures.length);
			expect(bounds.before).toHaveLength(captures.length);
			const fonts = group === 'private' ? privateFonts : new GdiFontCollection(systemFontBytes!);
			let exact = 0, improved = 0, unchangedNear = 0;
			for (const [index, c] of captures.entries()) {
				const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
				ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
				replay(ctx as unknown as CanvasContext, c, fonts);
				const count = differentPixels(ctx.getImageData(0, 0, W, H).data, Buffer.from(c.bgra, 'base64'));
				const label = `${c.family} ${c.size}px style ${c.style}, flags ${c.flags}, ${c.align}/${c.line}, ${c.text}`;
				expect(bounds.ceilings[index], label).toBeLessThanOrEqual(bounds.before[index]);
				expect(count, label).toBeLessThanOrEqual(bounds.ceilings[index]);
				exact += Number(count === 0);
				improved += Number(count < bounds.before[index]);
				if (c.align === 0 && c.line === 0) {
					expect(bounds.ceilings[index], label).toBe(bounds.before[index]);
					unchangedNear++;
				}
				// Default italic black-box fitting is deliberately outside the aligned engine path, except for the
				// vertical-only alignments (near horizontally), which it does not move (round 8).
				if ((c.style & 2) && !(c.flags & 4) && c.align !== 0) expect(bounds.ceilings[index], label).toBe(bounds.before[index]);
			}
			expect(unchangedNear).toBe(48);
			expect(exact).toBeGreaterThanOrEqual(bounds.minimumExact);
			expect(improved).toBeGreaterThanOrEqual(bounds.minimumImproved);
		});
	});
}

/** The CC0 A glyph is a rectangle from x=128..512 and y=0..1536 in a 2048-unit em. */
function nativeInkBounds(c: Capture): number[] {
	const pixels = Buffer.from(c.bgra, 'base64');
	let left = W, top = H, right = -1, bottom = -1;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const p = (y * W + x) * 4;
		if (pixels[p] === 255 && pixels[p + 1] === 255 && pixels[p + 2] === 255) continue;
		left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
	}
	return [left, top, right, bottom];
}

it('positions vector SVG glyphs within the independently captured native private-font ink bounds', async () => {
	const captures = load('private');
	let compared = 0;
	for (const [index, c] of captures.entries()) {
		if (c.text !== 'AA' || (!c.align && !c.line) || limits.groups.private.ceilings[index] !== 0) continue;
		const svg = new SvgContext(W, H);
		replay(svg as unknown as CanvasContext, c, privateFonts);
		const nodes: SvgNode[] = [];
		const visit = (node: SvgNode): void => { if (node.tag === 'text') nodes.push(node); node.children?.forEach(visit); };
		visit(await svg.toTree());
		expect(nodes).toHaveLength(1);
		expect(nodes[0].text).toBe('AA');
		const xs = String(nodes[0].attrs.x).split(/[ ,]+/).map(Number);
		const ys = String(nodes[0].attrs.y).split(/[ ,]+/).map(Number);
		expect(xs).toHaveLength(2); expect([1, 2]).toContain(ys.length);
		// Infer device ink extent from the font's actual rectangle and the emitted glyph origins,
		// then compare it with native pixels. No alignment-width formula is repeated here.
		// Native grayscale samples at 1/8, 3/8, 5/8 and 7/8 of each pixel. A tiny
		// continuous overlap containing none of those samples produces no ink pixel.
		const emittedInk = [
			Math.ceil(Math.min(...xs) + c.size / 16 - 7 / 8), Math.ceil(Math.min(...ys) - c.size * 3 / 4 - 7 / 8),
			Math.ceil(Math.max(...xs) + c.size / 4 - 1 / 8) - 1, Math.ceil(Math.max(...ys) - 1 / 8) - 1,
		];
		expect(emittedInk, `${c.size}px, ${c.align}/${c.line}, ${c.typo ? 'typographic' : 'default'}`).toEqual(nativeInkBounds(c));
		compared++;
	}
	expect(compared).toBe(90);
});
