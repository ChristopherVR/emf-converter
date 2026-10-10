import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitepress';

// The library imports @napi-rs/canvas and node:fs/path/os only through
// guarded runtime import() calls that run in plain Node.js. Resolve those
// imports from the library source to an empty module so the browser bundle
// never tries to resolve the native package or Node built-ins.
const emptyShim = fileURLToPath(new URL('./shims/empty.ts', import.meta.url));
const srcDir = fileURLToPath(new URL('../../src/', import.meta.url)).replace(/\\/g, '/');
const nodeOnlyImports = new Set(['@napi-rs/canvas', 'node:fs/promises', 'node:path', 'node:os']);

function shimNodeOnlyImports(): Plugin {
	return {
		name: 'emf-converter:shim-node-only-imports',
		enforce: 'pre',
		resolveId(id, importer) {
			if (nodeOnlyImports.has(id) && importer?.replace(/\\/g, '/').startsWith(srcDir)) {
				return emptyShim;
			}
			return null;
		},
	};
}

export default defineConfig({
	title: 'emf-converter',
	description: 'Convert EMF and WMF metafiles to PNG, JPEG or SVG in the browser and Node.js.',
	base: '/emf-converter/',
	cleanUrls: true,
	themeConfig: {
		nav: [
			{ text: 'Guide', link: '/getting-started' },
			{ text: 'API', link: '/api' },
			{ text: 'Demo', link: '/#live-demo' },
			{
				text: 'Changelog',
				link: 'https://github.com/ChristopherVR/emf-converter/blob/main/CHANGELOG.md',
			},
		],
		sidebar: [
			{
				text: 'Guide',
				items: [
					{ text: 'Getting started', link: '/getting-started' },
					{ text: 'Usage', link: '/usage' },
					{ text: 'How it works', link: '/how-it-works' },
					{ text: 'Limitations', link: '/limitations' },
					{ text: 'Outstanding work', link: '/outstanding-work' },
				],
			},
			{
				text: 'Reference',
				items: [{ text: 'API', link: '/api' }],
			},
		],
		socialLinks: [
			{ icon: 'github', link: 'https://github.com/ChristopherVR/emf-converter' },
			{ icon: 'npm', link: 'https://www.npmjs.com/package/emf-converter' },
		],
		search: { provider: 'local' },
		footer: {
			message: 'Released under the Apache-2.0 License.',
		},
	},
	vite: {
		plugins: [shimNodeOnlyImports()],
		optimizeDeps: {
			exclude: ['@napi-rs/canvas'],
		},
	},
});
