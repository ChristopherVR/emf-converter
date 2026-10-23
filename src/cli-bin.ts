/**
 * Process entry point for `emf-converter`: passes the arguments and the
 * standard streams to {@link main} and sets the exit code. Built to
 * `dist/cli.mjs` by `tsup.cli.config.ts`.
 *
 * @module cli-bin
 */

import { main } from './cli';

main(process.argv.slice(2), {
	stdout: process.stdout,
	stderr: process.stderr,
	stdin: process.stdin,
	cwd: process.cwd(),
}).then((code) => {
	process.exitCode = code;
});
