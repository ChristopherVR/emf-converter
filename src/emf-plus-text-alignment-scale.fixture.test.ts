/** Native positive uniform scale alignment; generate-text-alignment-scale.ps1 regenerates the references. */
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
	align: number; line: number; text: string; x: number; y: number; width: number; height: number;
	sx: number; sy: number; tx: number; ty: number; bgra: string;
}
interface Bounds {
	sha256: string; before: number[]; ceilings: number[]; minimumExact: number; minimumImproved: number;
}
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/gdi/${name}`, import.meta.url));
const bounds: { baseline: string; groups: Record<string, Bounds> } = JSON.parse(fixture('text-alignment-scale-bounds.json').toString());
const privateBytes = fixture('supplementary.ttf');
const systemBytes = windowsFonts();
const W = 256, H = 160;

function load(group: string): Capture[] {
	const bytes = fixture(`text-alignment-scale-${group}.json.gz`);
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(bounds.groups[group].sha256);
	return JSON.parse(gunzipSync(bytes).toString());
}

function legacyFonts(source: Buffer[]): GdiFontCollection {
	const fonts = new GdiFontCollection(source);
	const realize = fonts.realize.bind(fonts);
	fonts.realize = (...args) => {
		const font = realize(...args);
		return font && new Proxy(font, { get(target, key) {
			if (key === 'designAdvance') return undefined;
			const value = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		} });
	};
	return fonts;
}

function replay(ctx: CanvasContext, c: Capture, fonts: GdiFontCollection): void {
	const view = new DataView(new ArrayBuffer(28 + c.text.length * 2));
	view.setUint32(0, 0xff000000, true); view.setUint32(4, 1, true); view.setUint32(8, c.text.length, true);
	[c.x, c.y, c.width, c.height].forEach((v, i) => view.setFloat32(12 + i * 4, v, true));
	for (let i = 0; i < c.text.length; i++) view.setUint16(28 + i * 2, c.text.charCodeAt(i), true);
	const r: EmfPlusReplayCtx = {
		ctx, view, objectTable: new Map([
			[0, { kind: 'plus-font', family: c.family, emSize: c.size, flags: c.style, unit: 2 }],
			[1, { kind: 'plus-stringformat', flags: c.flags, alignment: c.align, lineAlignment: c.line,
				leadingMargin: c.typo ? 0 : 1 / 6, trailingMargin: c.typo ? 0 : 1 / 6, tracking: c.typo ? 1 : 1.03 }],
		]),
		// R-format JSON float values must be restored to the actual float32
		// matrix operands that Windows and parsed EMF+ records receive.
		worldTransform: [Math.fround(c.sx), 0, 0, Math.fround(c.sy), c.tx, c.ty],
		deferredImages: [], saveStack: [], saveIdMap: new Map(), totalImageObjects: 0, totalDrawImageCalls: 0,
		clipSaveDepth: 0, pageUnit: 2, pageScale: 1, dpiScale: 1, continuationBuffer: null,
		continuationObjectId: 0, continuationObjectType: 0, continuationTotalSize: 0, continuationOffset: 0,
		fonts, textRenderingHint: 4, ext: { textContrast: 0 },
	};
	expect(handleEmfPlusTextImageRecord(r, EMFPLUS_DRAWSTRING, 0x8000, 0, view.byteLength)).toBe(true);
}

function render(c: Capture, fonts: GdiFontCollection): Uint8ClampedArray {
	const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
	ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
	replay(ctx as unknown as CanvasContext, c, fonts);
	return ctx.getImageData(0, 0, W, H).data;
}

function different(actual: Uint8ClampedArray, c: Capture): number {
	const native = Buffer.from(c.bgra, 'base64');
	let count = 0;
	for (let p = 0; p < actual.length; p += 4) if (actual[p] !== native[p + 2] || actual[p + 1] !== native[p + 1] ||
		actual[p + 2] !== native[p] || actual[p + 3] !== native[p + 3]) count++;
	return count;
}

beforeAll(async () => {
	await ensureNodeCanvasModule();
	GlobalFonts.register(privateBytes);
});

for (const group of ['private', 'arial', 'heldout-private', 'heldout-arial', 'heldout-courier-italic']) {
	describe.skipIf(!group.endsWith('private') && !systemBytes)(`native uniformly scaled alignment: ${group}`, () => {
		it('bounds every native RGBA surface and preserves every previously exact control', () => {
			const captures = load(group), limit = bounds.groups[group];
			const source = group.endsWith('private') ? [privateBytes] : systemBytes!;
			const fonts = new GdiFontCollection(source), legacy = legacyFonts(source);
			expect(captures).toHaveLength(576);
			expect(limit.before).toHaveLength(576); expect(limit.ceilings).toHaveLength(576);
			let exact = 0, improved = 0;
			for (const [i, c] of captures.entries()) {
				const actual = render(c, fonts), count = different(actual, c);
				const label = `${c.size}px scale ${c.sx}, ${c.align}/${c.line}, ${c.text}`;
				expect(limit.ceilings[i], label).toBeLessThanOrEqual(limit.before[i]);
				// Round 12 accepted trade: installed-font AntiAlias text under a world scale uses the GDI scan converter, which makes
				// 27 captures exact (25 arial, 2 heldout-arial) and loses none, but takes Arial 16 px x1.25 "AV" (0/0) from 129 to 130
				// differing pixels; that one ceiling was raised by the project owner's decision.
				expect(count, label).toBeLessThanOrEqual(limit.ceilings[i]);
				if (!limit.before[i]) expect(count, label).toBe(0);
				exact += Number(count === 0); improved += Number(count < limit.before[i]);
				const em = Math.fround(c.size * Math.fround(c.sy));
				if ((!c.align && !c.line) || !Number.isInteger(em) || ((c.style & 2) && !(c.flags & 4) && c.align !== 0)) {
					expect(Buffer.from(actual).equals(Buffer.from(render(c, legacy))), `fallback ${label}`).toBe(true);
				}
			}
			expect(exact).toBeGreaterThanOrEqual(limit.minimumExact);
			expect(improved).toBeGreaterThanOrEqual(limit.minimumImproved);
		});
	});
}

it('retains fallback for nonuniform scales and cluster shaping', () => {
	const fonts = new GdiFontCollection([privateBytes]), legacy = legacyFonts([privateBytes]);
	const capture = load('private').find(c => c.align === 1 && c.line === 1)!;
	for (const c of [
		{ ...capture, sy: capture.sy * 1.25 },
		{ ...capture, text: 'A\u0301' }, { ...capture, text: 'A\u200fA' },
		{ ...capture, text: '\u0644\u0627' }, { ...capture, text: 'B' },
	]) expect(Buffer.from(render(c, fonts)).equals(Buffer.from(render(c, legacy)))).toBe(true);
});

it('places scaled vector SVG rectangles within independently captured native ink bounds', async () => {
	const fonts = new GdiFontCollection([privateBytes]);
	let compared = 0;
	for (const group of ['private', 'heldout-private']) for (const [i, c] of load(group).entries()) {
		if (c.text !== 'AA' || (!c.align && !c.line) || bounds.groups[group].ceilings[i] !== 0) continue;
		const svg = new SvgContext(W, H); replay(svg as unknown as CanvasContext, c, fonts);
		const nodes: SvgNode[] = [];
		const visit = (n: SvgNode): void => { if (n.tag === 'text') nodes.push(n); n.children?.forEach(visit); };
		visit(await svg.toTree()); expect(nodes).toHaveLength(1);
		const xs = String(nodes[0].attrs.x).split(/[ ,]+/).map(Number);
		const ys = String(nodes[0].attrs.y).split(/[ ,]+/).map(Number);
		const em = Math.fround(c.size * Math.fround(c.sy));
		const ink = [Math.ceil(Math.min(...xs) + em / 16 - 7 / 8),
			Math.ceil(Math.min(...ys) - em * 3 / 4 - 7 / 8),
			Math.ceil(Math.max(...xs) + em / 4 - 1 / 8) - 1, Math.ceil(Math.max(...ys) - 1 / 8) - 1];
		const native = Buffer.from(c.bgra, 'base64');
		let left = W, top = H, right = -1, bottom = -1;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const p = (y * W + x) * 4;
			if (native[p] === 255 && native[p + 1] === 255 && native[p + 2] === 255) continue;
			left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
		}
		expect(ink).toEqual([left, top, right, bottom]); compared++;
	}
	expect(compared).toBeGreaterThanOrEqual(177);
});
