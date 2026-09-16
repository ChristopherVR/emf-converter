import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	splitting: false,
	sourcemap: false,
	clean: !options.watch,
	treeshake: true,
	platform: 'neutral',
	// Optional peer dependency, only ever reached via a dynamic import() at
	// runtime in plain Node.js. Keep it external so consumers who never hit
	// that path aren't forced to bundle or install it.
	external: ['@napi-rs/canvas'],
}));
