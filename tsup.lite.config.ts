import { resolve } from 'node:path';
import { defineConfig, type Options } from 'tsup';

/**
 * Modules the lite build (`emf-converter/lite`) replaces with the small
 * stand-ins of the same name in `src/lite/`. Each stand-in exports only what
 * the PNG path reaches; esbuild fails the build if one misses an import.
 */
export const LITE_MODULES = [
	'emf-ansi-johab',
	'emf-gdi-chroma-tie-data',
	'emf-gdi-illuminant-data',
	'emf-plus-image-curves',
	'gdi-font-engine',
	'image-codec-fallback',
	'jpeg-encoder',
	'software-raster',
	'svg-context',
	'webp-encoder',
];

interface ResolveBuild {
	onResolve(options: { filter: RegExp }, callback: (args: { importer: string; path: string }) => { path: string } | undefined): void;
}

/**
 * The esbuild plugin that swaps in the stand-ins. With `browser` (the
 * published build) the Node-only loaders are swapped for their browser
 * versions too; the lite test leaves them in so it can render with
 * `@napi-rs/canvas`.
 */
export function litePlugin(browser = true) {
	const liteDir = resolve('src/lite');
	const lite = new RegExp(`^\\./(${LITE_MODULES.join('|')})$`);
	return {
		name: 'lite-modules',
		setup(build: ResolveBuild) {
			if (browser) {
				build.onResolve({ filter: /^\.\/(node-canvas-loader|load-system-fonts)$/ }, () => ({ path: resolve('src/browser-runtime.ts') }));
			}
			build.onResolve({ filter: lite }, (args) =>
				resolve(args.importer, '..') === liteDir ? undefined : { path: resolve(liteDir, `${args.path.slice(2)}.ts`) });
		},
	};
}

export const liteConfig: Options = {
	entry: { lite: 'src/lite.ts' },
	format: ['esm', 'cjs'],
	dts: true,
	splitting: false,
	sourcemap: false,
	clean: false,
	treeshake: true,
	// Size is the point of this build, so it ships minified.
	minify: true,
	platform: 'browser',
	esbuildPlugins: [litePlugin()],
};

export default defineConfig(liteConfig);
