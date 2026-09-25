/**
 * SVG output: the public converters, the tree serialisers (markup, data URL,
 * React elements, JSX source), the recording context itself, and parity of
 * the rendered SVG against real GDI output for vector-only fixtures.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { diffImages, fixturePath, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';
import {
	convertMetafileToSvg,
	convertMetafileToSvgDataUrl,
	convertMetafileToSvgTree,
	svgTreeToJsx,
	svgTreeToReact,
	svgTreeToString,
} from './index';
import { encodePng } from './png-encoder';
import { SoftwareRasterCanvas } from './software-raster';
import { SvgContext, parseCssColor, parseFont } from './svg-context';
import type { SvgNode } from './svg-tree';
import { bytesToBase64, parseStyle, reactAttrName } from './svg-tree';

function load(path: string): ArrayBuffer {
	const bytes = readFileSync(path);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const crown = () => load(fileURLToPath(new URL('./__fixtures__/sample-crown.wmf', import.meta.url)));
const fixture = (name: string) => load(fixturePath(`${name}.emf`));

function walk(node: SvgNode, visit: (n: SvgNode) => void): void {
	visit(node);
	node.children?.forEach((c) => walk(c, visit));
}

function countTags(node: SvgNode): Record<string, number> {
	const counts: Record<string, number> = {};
	walk(node, (n) => {
		counts[n.tag] = (counts[n.tag] ?? 0) + 1;
	});
	return counts;
}

describe('convertMetafileToSvg*', () => {
	it('converts a WMF into standalone SVG markup', async () => {
		const svg = await convertMetafileToSvg(crown());
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+" viewBox="0 0 \d+ \d+"/);
		expect(svg).toMatch(/<\/svg>$/);
		expect(svg).toContain('<path ');
	});

	it('produces a base64 SVG data URL that decodes back to the markup', async () => {
		const [markup, url] = await Promise.all([
			convertMetafileToSvg(crown(), { idPrefix: 'x-' }),
			convertMetafileToSvgDataUrl(crown(), { idPrefix: 'x-' }),
		]);
		expect(url!.startsWith('data:image/svg+xml;base64,')).toBe(true);
		expect(Buffer.from(url!.split(',')[1], 'base64').toString('utf8')).toBe(markup);
	});

	it('returns null for garbage input', async () => {
		expect(await convertMetafileToSvg(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toBeNull();
	});

	it('uses the id prefix for every generated id and omits the size when asked', async () => {
		const tree = await convertMetafileToSvgTree(fixture('grad-linear-h-tile'), { idPrefix: 'logo-', includeSize: false });
		expect(tree!.attrs.width).toBeUndefined();
		expect(tree!.attrs.viewBox).toBeDefined();
		const ids: string[] = [];
		walk(tree!, (n) => {
			if (typeof n.attrs.id === 'string') {
				ids.push(n.attrs.id);
			}
		});
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.every((id) => id.startsWith('logo-'))).toBe(true);
	});

	it('keeps gradients as vector paint servers', async () => {
		const counts = countTags((await convertMetafileToSvgTree(fixture('grad-linear-a30-tile')))!);
		expect(counts.linearGradient).toBe(1);
		expect(counts.image).toBeUndefined();
	});

	it('expresses a GDI pattern-brush fill as a native, unfiltered <pattern>', async () => {
		const tree = (await convertMetafileToSvgTree(fixture('pattern-fill-rect-color')))!;
		const patterns: SvgNode[] = [];
		walk(tree, (n) => n.tag === 'pattern' && patterns.push(n));
		expect(patterns).toHaveLength(1);
		expect(patterns[0].children![0].attrs.style).toContain('pixelated');
	});

	it('embeds exact ROP3 results as image patches when a canvas backend exists', async () => {
		const tree = (await convertMetafileToSvgTree(fixture('rop3-stretchblt')))!;
		const images: SvgNode[] = [];
		walk(tree, (n) => n.tag === 'image' && images.push(n));
		expect(images.length).toBeGreaterThan(0);
		expect(images.every((i) => String(i.attrs.href).startsWith('data:image/png;base64,'))).toBe(true);
	});

	it('still records vectors with exactRasterOps disabled', async () => {
		const svg = await convertMetafileToSvg(fixture('rotate-ellipse-40deg'), { exactRasterOps: false });
		expect(svg).toContain('<path ');
	});
});

describe('SVG parity against real GDI output (vector fixtures)', () => {
	/**
	 * Rasterises the SVG with Skia's SVG renderer (via @napi-rs/canvas) and
	 * requires it to match the reference no worse than the PNG pipeline does
	 * (plus a small allowance for the two renderers' anti-aliasing).
	 */
	it.each(['rotate-ellipse-40deg', 'rotate-polygon-15deg', 'skew-rect', 'grad-linear-a30-flipx', 'grad-linear-skew-blend-flipxy'])(
		'%s',
		async (name) => {
			const napi = await import('@napi-rs/canvas');
			const svg = await convertMetafileToSvg(fixture(name), { dpiScale: 1 });
			const img = await napi.loadImage(Buffer.from(svg!));
			const canvas = napi.createCanvas(img.width, img.height);
			const ctx = canvas.getContext('2d');
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, img.width, img.height);
			ctx.drawImage(img, 0, 0);
			const rendered = {
				width: img.width,
				height: img.height,
				data: ctx.getImageData(0, 0, img.width, img.height).data as unknown as Uint8ClampedArray,
			};
			const reference = await loadReference(name);
			const svgDiff = diffImages(rendered, reference, 8);
			const pngDiff = diffImages((await renderFixture(`${name}.emf`))!, reference, 8);
			expect(svgDiff.mismatchRatio).toBeLessThanOrEqual(pngDiff.mismatchRatio + 0.005);
		},
	);
});

describe('svgTreeToReact', () => {
	const tree: SvgNode = {
		tag: 'svg',
		attrs: { viewBox: '0 0 10 10', width: 10 },
		children: [
			{ tag: 'path', attrs: { d: 'M0 0L1 1', 'stroke-width': 2, 'clip-path': 'url(#c)', style: 'mix-blend-mode:difference' } },
			{ tag: 'text', attrs: { 'font-family': 'Arial', 'xml:space': 'preserve' }, text: ' hi ' },
		],
	};

	it('maps attributes to React props and passes text as children', () => {
		const calls: Array<{ type: string; props: Record<string, unknown>; children: unknown[] }> = [];
		const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => {
			const el = { type, props: props ?? {}, children };
			calls.push(el);
			return el;
		};
		const root = svgTreeToReact(tree, h, { className: 'fig', width: '100%' }) as unknown as (typeof calls)[number];
		expect(root.type).toBe('svg');
		expect(root.props).toMatchObject({ viewBox: '0 0 10 10', width: '100%', className: 'fig' });
		const [path, text] = root.children as Array<(typeof calls)[number]>;
		expect(path.props).toMatchObject({ d: 'M0 0L1 1', strokeWidth: 2, clipPath: 'url(#c)', style: { mixBlendMode: 'difference' } });
		expect(text.props).toMatchObject({ fontFamily: 'Arial', xmlSpace: 'preserve' });
		expect(text.children).toEqual([' hi ']);
		expect(new Set(calls.map((c) => c.props.key)).size).toBe(calls.length);
	});

	it('works with the real React createElement shape of a converted metafile', async () => {
		const converted = (await convertMetafileToSvgTree(crown()))!;
		let elements = 0;
		svgTreeToReact(converted, (type, props, ...children) => {
			elements++;
			expect(typeof type).toBe('string');
			for (const key of Object.keys(props ?? {})) {
				expect(key).not.toMatch(/-/);
			}
			return { type, props, children };
		});
		expect(elements).toBeGreaterThan(1);
	});
});

describe('svgTreeToJsx', () => {
	it('generates a typed component with camelCase props and a props spread', async () => {
		const tree = (await convertMetafileToSvgTree(fixture('grad-linear-a30-tile'), { idPrefix: 'a-' }))!;
		const src = svgTreeToJsx(tree, { componentName: 'Gradient' });
		expect(src).toContain("import type { SVGProps } from 'react';");
		expect(src).toContain('export function Gradient(props: SVGProps<SVGSVGElement>)');
		expect(src).toContain('{...props}');
		expect(src).toContain('gradientUnits="userSpaceOnUse"');
		expect(src).toContain('stopColor=');
		expect(src).toContain('style={{ isolation: "isolate" }}');
		expect(src).not.toMatch(/ stop-color=/);
	});

	it('emits plain JSX without types when typescript is false', () => {
		const src = svgTreeToJsx({ tag: 'svg', attrs: {}, children: [{ tag: 'text', attrs: {}, text: 'a{b}"c' }] }, { typescript: false });
		expect(src).not.toContain('SVGProps');
		expect(src).toContain('export function Metafile(props)');
		expect(src).toContain('{"a{b}\\"c"}');
	});
});

describe('svg-tree helpers', () => {
	it('escapes markup-significant characters', () => {
		const s = svgTreeToString({ tag: 'text', attrs: { 'font-family': '"A&B"' }, text: '<x & y>' });
		expect(s).toBe('<text font-family="&quot;A&amp;B&quot;">&lt;x &amp; y&gt;</text>');
	});
	it('drops characters XML forbids and repairs lone surrogates', () => {
		const s = svgTreeToString({ tag: 'text', attrs: {}, text: 'a\u0001b\ud800c\u{1f600}' });
		expect(s).toBe('<text>ab�c\u{1f600}</text>');
	});
	it('maps attribute names', () => {
		expect(reactAttrName('stroke-dasharray')).toBe('strokeDasharray');
		expect(reactAttrName('viewBox')).toBe('viewBox');
		expect(reactAttrName('class')).toBe('className');
		expect(reactAttrName('data-id')).toBe('data-id');
		expect(parseStyle('image-rendering:pixelated; mix-blend-mode: darken')).toEqual({
			imageRendering: 'pixelated',
			mixBlendMode: 'darken',
		});
	});
	it('base64-encodes every length like Buffer does', () => {
		for (let n = 0; n < 20; n++) {
			const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
			expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
		}
	});
});

describe('SvgContext', () => {
	function body(ctx: SvgContext): Promise<SvgNode[]> {
		return ctx.toTree().then((t) => t.children!.filter((c) => c.tag !== 'defs'));
	}

	it('emits fills in device space and strokes in their own user space', async () => {
		const ctx = new SvgContext(100, 100);
		ctx.setTransform(2, 0, 0, 3, 10, 20);
		ctx.beginPath();
		ctx.rect(0, 0, 5, 5);
		ctx.fillStyle = 'rgba(255,0,0,0.5)';
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.stroke();
		const [fill, stroke] = await body(ctx);
		expect(fill.attrs).toMatchObject({ d: 'M10 20l10 0 0 15-10 0zm0 0', fill: '#ff0000', 'fill-opacity': '0.5' });
		expect(stroke.attrs).toMatchObject({ d: 'M0 0l5 0 0 5-5 0zm0 0', transform: 'matrix(2 0 0 3 10 20)', 'stroke-width': '2' });
	});

	it('turns arcs into Beziers that land on the exact end point', async () => {
		const ctx = new SvgContext(100, 100);
		ctx.beginPath();
		ctx.arc(50, 50, 10, 0, Math.PI);
		ctx.fill();
		const [path] = await body(ctx);
		// Two quarter arcs, relative: the end point is (60,50) + (-10,10) + (-10,-10) = (40,50).
		expect(path.attrs.d).toBe('M60 50c0 5.52-4.48 10-10 10-5.52 0-10-4.48-10-10');
	});

	it('chains clips so each one intersects its parent', async () => {
		const ctx = new SvgContext(100, 100);
		ctx.beginPath();
		ctx.rect(0, 0, 50, 50);
		ctx.clip();
		ctx.beginPath();
		ctx.rect(10, 10, 50, 50);
		ctx.clip('evenodd');
		ctx.fillRect(0, 0, 100, 100);
		const tree = await ctx.toTree();
		const clips = tree.children![0].children!.filter((c) => c.tag === 'clipPath');
		expect(clips).toHaveLength(2);
		expect(clips[1].attrs['clip-path']).toBe(`url(#${clips[0].attrs.id})`);
		expect(clips[1].children![0].attrs['clip-rule']).toBe('evenodd');
		const group = tree.children![1];
		expect(group.attrs['clip-path']).toBe(`url(#${clips[1].attrs.id})`);
	});

	it('maps blend composite operations to mix-blend-mode', async () => {
		const ctx = new SvgContext(10, 10);
		ctx.globalCompositeOperation = 'difference';
		ctx.fillRect(0, 0, 5, 5);
		expect((await body(ctx))[0].attrs.style).toBe('mix-blend-mode:difference');
	});

	it('ignores invalid line widths like Canvas does', () => {
		const ctx = new SvgContext(10, 10);
		ctx.lineWidth = 3;
		ctx.lineWidth = 0;
		expect(ctx.lineWidth).toBe(3);
	});

	it('records text with font, alignment and transform', async () => {
		const ctx = new SvgContext(100, 100);
		ctx.font = 'italic bold 12px "Times New Roman"';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		ctx.fillStyle = '#123456';
		ctx.translate(5, 6);
		ctx.fillText('Hi', 1, 2);
		const [text] = await body(ctx);
		expect(text).toMatchObject({
			tag: 'text',
			text: 'Hi',
			attrs: {
				x: '1',
				y: '2',
				transform: 'matrix(1 0 0 1 5 6)',
				'font-family': '"Times New Roman"',
				'font-size': '12',
				'font-weight': 'bold',
				'font-style': 'italic',
				'text-anchor': 'middle',
				'dominant-baseline': 'text-before-edge',
				fill: '#123456',
			},
		});
	});

	it('emits only the changed pixels of a putImageData', async () => {
		const napi = await import('@napi-rs/canvas');
		const shadow = napi.createCanvas(4, 4).getContext('2d');
		const ctx = new SvgContext(4, 4, { shadow: shadow as never });
		const img = ctx.getImageData(0, 0, 4, 4);
		img.data.set([255, 0, 0, 255], (1 * 4 + 2) * 4);
		ctx.putImageData(img, 0, 0);
		const [patch] = await body(ctx);
		expect(patch.attrs).toMatchObject({ x: '2', y: '1', width: '1', height: '1' });
	});

	it('answers isPointInPath without a canvas backend', () => {
		const ctx = new SvgContext(10, 10);
		ctx.beginPath();
		ctx.rect(0, 0, 4, 4);
		ctx.rect(1, 1, 2, 2);
		expect(ctx.isPointInPath(0.5, 0.5)).toBe(true);
		expect(ctx.isPointInPath(2, 2, 'nonzero')).toBe(true);
		expect(ctx.isPointInPath(2, 2, 'evenodd')).toBe(false);
		expect(ctx.isPointInPath(5, 5)).toBe(false);
	});

	it('parses colours and fonts', () => {
		expect(parseCssColor('rgba(0,0,0,0)')).toEqual({ color: '#000000', alpha: 0 });
		expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ color: '#0a141e', alpha: 1 });
		expect(parseCssColor('#AbCdEf')).toEqual({ color: '#abcdef', alpha: 1 });
		expect(parseFont('700 9.5px Arial')).toEqual({ style: '', weight: '700', size: 9.5, family: 'Arial' });
	});
});

describe('encodePng', () => {
	it('round-trips through a real PNG decoder', async () => {
		const napi = await import('@napi-rs/canvas');
		const w = 13;
		const h = 7;
		const data = Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 29) & 0xff));
		const png = await encodePng(data, w, h);
		const img = await napi.loadImage(Buffer.from(png));
		const c = napi.createCanvas(w, h).getContext('2d');
		c.drawImage(img, 0, 0);
		expect(Array.from(c.getImageData(0, 0, w, h).data)).toEqual(Array.from(data));
	});
});

describe('SoftwareRasterCanvas', () => {
	it('puts, scales (nearest) and reads back pixels', () => {
		const src = new SoftwareRasterCanvas(2, 1);
		src.ctx.putImageData({ data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1 }, 0, 0);
		const dst = new SoftwareRasterCanvas(4, 2);
		dst.ctx.imageSmoothingEnabled = false;
		dst.ctx.drawImage(src, 0, 0, 4, 2);
		const px = dst.ctx.getImageData(0, 0, 4, 2).data;
		expect(Array.from(px.slice(0, 4))).toEqual([255, 0, 0, 255]);
		expect(Array.from(px.slice(4, 8))).toEqual([255, 0, 0, 255]);
		expect(Array.from(px.slice(8, 12))).toEqual([0, 0, 255, 255]);
		expect(Array.from(px.slice(28, 32))).toEqual([0, 0, 255, 255]);
	});

	it('mirrors through a negative-scale transform', () => {
		const src = new SoftwareRasterCanvas(2, 1);
		src.ctx.putImageData({ data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1 }, 0, 0);
		const dst = new SoftwareRasterCanvas(2, 1);
		dst.ctx.transform(-1, 0, 0, 1, 2, 0);
		dst.ctx.imageSmoothingEnabled = false;
		dst.ctx.drawImage(src, 0, 0);
		expect(Array.from(dst.ctx.getImageData(0, 0, 2, 1).data)).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
	});
});
