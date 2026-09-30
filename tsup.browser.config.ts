import { resolve } from 'node:path';
import { defineConfig, type Options } from 'tsup';

export const browserConfig: Options = {
	entry: { browser: 'src/index.ts' },
	format: ['esm', 'cjs'],
	dts: false,
	splitting: false,
	sourcemap: false,
	clean: false,
	treeshake: true,
	platform: 'browser',
	noExternal: ['jpeg-js', 'gifuct-js', 'js-binary-schema-parser', 'utif', 'pako'],
	esbuildPlugins: [{
		name: 'browser-runtime',
		setup(build) {
			build.onResolve({ filter: /^\.\/(node-canvas-loader|load-system-fonts)$/ }, () => ({
				path: resolve('src/browser-runtime.ts'),
			}));
		},
	}],
};

export default defineConfig(browserConfig);
