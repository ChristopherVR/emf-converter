// Run after building. Pass a Vite entry path to check another installed version.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await realpath(await mkdtemp(join(tmpdir(), 'emf-browser-')));
const pkg = join(root, 'node_modules/emf-converter');
await cp(join(repo, 'dist'), join(pkg, 'dist'), { recursive: true });
await cp(join(repo, 'package.json'), join(pkg, 'package.json'));
await writeFile(join(root, 'package.json'), '{"type":"module"}');
await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
await writeFile(join(root, 'main.js'), 'import { loadSystemFonts } from "emf-converter"; console.log(loadSystemFonts());');

// The isolated consumer has no optional peer installed. Check both export formats
// and a browser environment with a Node process polyfill (the guard alone is insufficient).
for (const mode of ['module', 'commonjs']) {
	const code = mode === 'module'
		? 'import * as api from "emf-converter"; console.log(JSON.stringify(await api.loadSystemFonts()));'
		: 'const api = require("emf-converter"); api.loadSystemFonts().then(x => console.log(JSON.stringify(x)));';
	const output = execFileSync(process.execPath, ['--conditions=browser', '--input-type=' + mode, '-e', code], { cwd: root });
	assert.equal(output.toString().trim(), '[]');
	const nodeCode = mode === 'module'
		? 'import * as api from "emf-converter"; console.log(JSON.stringify(await api.loadSystemFonts({dirs: []})));'
		: 'const api = require("emf-converter"); api.loadSystemFonts({dirs: []}).then(x => console.log(JSON.stringify(x)));';
	assert.equal(execFileSync(process.execPath, ['--input-type=' + mode, '-e', nodeCode], { cwd: root }).toString().trim(), '[]');
}
for (const name of ['browser.js', 'browser.mjs']) {
	const source = await readFile(join(pkg, 'dist', name), 'utf8');
	assert.doesNotMatch(source, /import\s*\([^)]*['"](?:@napi-rs\/canvas|node:)/);
}
const { createServer, build } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : 'vite');
// Vite's HTML plugin uses cwd as well as root; keep both on the same Windows drive.
process.chdir(root);
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { port: 0 }, optimizeDeps: { include: ['emf-converter'] } });
try {
	await server.listen();
	const address = server.httpServer.address();
	const base = 'http://localhost:' + address.port;
	const main = await fetch(base + '/main.js');
	assert.equal(main.status, 200);
	const transformed = await main.text();
	const dep = transformed.match(/"([^"\n]*\/deps\/emf-converter\.js[^"\n]*)"/);
	assert.ok(dep, transformed);
	const bundled = await fetch(base + dep[1]);
	assert.equal(bundled.status, 200, await bundled.text());
	await build({ root, configFile: false, logLevel: 'error', build: { write: false } });
	console.log('Browser ESM/CJS exports, Vite dev prebundle and production build passed (optional canvas absent).');
} finally {
	await server.close();
}
