import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		// Agent/tooling worktrees live under .claude/ and carry their own copy of the suite.
		exclude: [...configDefaults.exclude, '.claude/**'],
	},
});
