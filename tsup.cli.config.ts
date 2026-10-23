import { defineConfig, type Options } from 'tsup';

/**
 * The `emf-converter` command: a Node.js-only bundle with a shebang, kept
 * out of the library builds (`dist/index.*`, `dist/browser.*`). `clean` is
 * off because the default config cleans `dist/` before this one runs.
 */
export const cliConfig: Options = {
	entry: { cli: 'src/cli-bin.ts' },
	format: ['esm'],
	dts: false,
	splitting: false,
	sourcemap: false,
	clean: false,
	treeshake: true,
	platform: 'node',
	banner: { js: '#!/usr/bin/env node' },
	// The optional canvas peer stays external, as in the library build.
	external: ['@napi-rs/canvas'],
	noExternal: ['jpeg-js', 'gifuct-js', 'js-binary-schema-parser', 'utif', 'pako'],
};

export default defineConfig(cliConfig);
