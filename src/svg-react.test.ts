/**
 * The React integration, checked against real React: converted metafiles
 * rendered through `svgTreeToReact(tree, createElement)` must produce valid
 * markup with no React DOM-property warnings, and the TSX that
 * `svgTreeToJsx` generates must compile and render to the same markup.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';

import { convertMetafileToSvgTree, svgTreeToJsx, svgTreeToReact } from './index';

function load(rel: string): ArrayBuffer {
	const bytes = readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const SAMPLES = [
	'./__fixtures__/sample-crown.wmf',
	'./__fixtures__/sample-gradient-clip.emf',
	'./__fixtures__/gdi/rotate-text-25deg.emf',
	'./__fixtures__/gdi/pattern-fill-ellipse-color.emf',
	'./__fixtures__/gdi/rop2-bitwise-grid.emf',
	'./__fixtures__/gdi/grad-path-triangle-flipxy.emf',
	'./__fixtures__/gdi/image-draw-png.emf',
];

/** Compiles generated TSX with TypeScript and loads it as a CommonJS module. */
function compileComponent(source: string): (props: Record<string, unknown>) => unknown {
	const js = ts.transpileModule(source, {
		compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const requireShim = (id: string): unknown => {
		if (id === 'react/jsx-runtime') {
			return jsxRuntime;
		}
		return createRequire(import.meta.url)(id);
	};
	const module = { exports: {} as Record<string, unknown> };
	new Function('require', 'module', 'exports', js)(requireShim, module, module.exports);
	return module.exports.default as (props: Record<string, unknown>) => unknown;
}

describe('React rendering of converted metafiles', () => {
	it.each(SAMPLES)('%s renders through createElement without React warnings', async (rel) => {
		const tree = await convertMetafileToSvgTree(load(rel), { idPrefix: 'r-' });
		expect(tree).not.toBeNull();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const html = renderToStaticMarkup(svgTreeToReact(tree!, createElement, { className: 'figure' }) as never);
			expect(html.startsWith('<svg')).toBe(true);
			expect(html).toContain('class="figure"');
			// React turns camelCase props back into the SVG attribute names.
			expect(html).not.toMatch(/ (strokeWidth|clipPath|fillOpacity|stopColor|fontFamily)=/);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});

	it.each(SAMPLES)('%s: generated TSX compiles and renders the same markup', async (rel) => {
		const tree = (await convertMetafileToSvgTree(load(rel), { idPrefix: 'j-' }))!;
		const Component = compileComponent(svgTreeToJsx(tree, { componentName: 'Figure' }));
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const fromJsx = renderToStaticMarkup(createElement(Component as never, { width: '100%' }));
			const fromTree = renderToStaticMarkup(svgTreeToReact(tree, createElement, { width: '100%' }) as never);
			expect(fromJsx).toBe(fromTree);
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});

	it('keeps hostile metafile strings inert in generated TSX', () => {
		const tree = {
			tag: 'svg',
			attrs: { viewBox: '0 0 1 1' },
			children: [
				{
					tag: 'text',
					attrs: { 'font-family': 'Evil" onLoad={alert(1)} x="', 'data-x': 'a\\b{c}&amp;', 'data-y': 'p\\q' },
					text: '"}</text>{alert(2)}',
				},
			],
		};
		const Component = compileComponent(svgTreeToJsx(tree));
		const html = renderToStaticMarkup(createElement(Component as never, {}));
		expect(html).toContain('font-family="Evil&quot; onLoad={alert(1)} x=&quot;"');
		expect(html).toContain('data-x="a\\b{c}&amp;amp;"');
		// A lone backslash must not ride in a JSX string attribute (no escapes there).
		expect(html).toContain('data-y="p\\q"');
		expect(svgTreeToJsx(tree)).toContain('data-y={"p\\\\q"}');
		expect(html).toContain('&quot;}&lt;/text&gt;{alert(2)}');
		expect(() => svgTreeToJsx(tree, { componentName: 'x(); alert(1); function Y' })).toThrow(TypeError);
	});
});
