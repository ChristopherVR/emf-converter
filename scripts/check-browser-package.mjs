// Run after building. Pass a Vite entry path to check another installed version.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await realpath(await mkdtemp(join(tmpdir(), 'emf-browser-')));
const pkg = join(root, 'node_modules/emf-converter');
await cp(join(repo, 'dist'), join(pkg, 'dist'), { recursive: true });
await cp(join(repo, 'package.json'), join(pkg, 'package.json'));
await writeFile(join(root, 'package.json'), '{"type":"module"}');
await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
await writeFile(join(root, 'main.js'), 'import { loadSystemFonts } from "emf-converter"; import { convertMetafileToDataUrl } from "emf-converter/lite"; console.log(loadSystemFonts(), convertMetafileToDataUrl);');

const fixtureDir = join(repo, 'src/__fixtures__/gdi');
const johabPath = join(root, 'johab.wmf');
const johab = await readFile(join(fixtureDir, 'textx-wmf-segoeui-mono.wmf'));
assert.equal(johab.readUInt16LE(144), 0x02fb);
assert.equal(johab.readUInt16LE(208), 0x0521);
johab[159] = 130;
johab.set([0x88, 0x61], 212);
await writeFile(johabPath, johab);
const curvePath = join(root, 'curve.emf');
const curve = await readFile(join(fixtureDir, 'plus-only-effect-colorcurve-contrast-50.emf'));
const curveGuidOffset = curve.indexOf(Buffer.from('a972cea77f0fd740b3ccd0c02d5c3212', 'hex'));
assert.ok(curveGuidOffset >= 0);
Buffer.from('22006adde458674a9d9bd48eb881a53d', 'hex').copy(curve, curveGuidOffset);
await writeFile(curvePath, curve);
let outputReference;
for (const mode of ['module', 'commonjs']) {
	const load = mode === 'module' ? 'await import("emf-converter")' : 'require("emf-converter")';
	const code = `void (async () => {
		const api = ${load};
		const { default: assert } = await import('node:assert/strict');
		const { createHash } = await import('node:crypto');
		const { readFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
		assert.deepEqual(await api.loadSystemFonts(process.argv[2] === 'browser' ? undefined : { dirs: [] }), []);
		const results = [];
		const fixtures = ['raster-bench-shapes', 'codec-jpeg-arithmetic-playback', 'codec-jpeg-cmyk-photo-playback', 'emfrec-ca-illuminant-chart-1']
			.map(name => join(process.argv[1], name + '.emf'));
		for (const fixture of [...fixtures, process.argv[4]]) {
			const input = await readFile(fixture);
			const png = await api.convertMetafileToDataUrl(input);
			const rgba = await api.convertMetafileToImageData(input);
			assert.match(png, /^data:image\\/png;base64,iVBORw0KGgo/);
			assert.ok(rgba.width > 0 && rgba.height > 0);
			assert.equal(rgba.data.length, rgba.width * rgba.height * 4);
			results.push([rgba.width, rgba.height, hash(png), hash(rgba.data)]);
		}
		const svg = await api.convertMetafileToSvg(await readFile(process.argv[3]), { idPrefix: 'johab-' });
		assert.match(svg, /가/);
		results.push(hash(svg));
		console.log(JSON.stringify(results));
	})().catch(error => { console.error(error); process.exitCode = 1; });`;
	for (const environment of ['browser', 'node']) {
		const conditions = environment === 'browser' ? ['--conditions=browser'] : [];
		const output = execFileSync(process.execPath, [...conditions, '--input-type=' + mode, '-e', code, fixtureDir, environment, johabPath, curvePath], { cwd: root, encoding: 'utf8' });
		const current = JSON.parse(output);
		outputReference ??= current;
		assert.deepEqual(current, outputReference, `${environment} ${mode}`);
	}
}
// The lite entry resolves in both formats; with no canvas it returns null rather than throwing.
for (const mode of ['module', 'commonjs']) {
	const code = mode === 'module'
		? 'import * as lite from "emf-converter/lite"; console.log(Object.keys(lite).sort().join(), await lite.convertMetafileToDataUrl(new Uint8Array(8)));'
		: 'const lite = require("emf-converter/lite"); lite.convertMetafileToDataUrl(new Uint8Array(8)).then(x => console.log(Object.keys(lite).sort().join(), x));';
	const output = execFileSync(process.execPath, ['--conditions=browser', '--input-type=' + mode, '-e', code], { cwd: root });
	assert.equal(output.toString().trim(), 'DEFAULT_DPI_SCALE,convertMetafileToDataUrl,convertMetafileToImageData,getMetafileInfo null');
}
const browserChunks = await readdir(join(pkg, 'dist/browser-chunks'));
for (const name of ['browser.js', 'browser.mjs', 'lite.js', 'lite.mjs', ...browserChunks.map((file) => `browser-chunks/${file}`)]) {
	const source = await readFile(join(pkg, 'dist', name), 'utf8');
	assert.doesNotMatch(source, /import\s*\([^)]*['"](?:@napi-rs\/canvas|node:)/);
}
// Both Node entry formats must preserve the directives for consumer bundlers.
const nodeChunks = await readdir(join(pkg, 'dist/node-chunks'));
for (const extension of ['.js', '.mjs']) {
	const files = ['index' + extension, ...nodeChunks
		.filter(name => name.endsWith(extension))
		.map(name => `node-chunks/${name}`)];
	const sources = await Promise.all(files.map(name => readFile(join(pkg, 'dist', name), 'utf8')));
	const canvasImports = sources.flatMap(source =>
		source.match(/import\(\s*(?:\/\*[^*]*\*\/\s*)*['"]@napi-rs\/canvas['"]\s*\)/g) ?? []);
	assert.equal(canvasImports.length, 1, `expected an optional canvas import in Node ${extension}`);
	assert.match(canvasImports[0], /\/\*\s*webpackIgnore:\s*true\s*\*\//, `Node ${extension} lost webpackIgnore`);
	assert.match(canvasImports[0], /\/\*\s*@vite-ignore\s*\*\//, `Node ${extension} lost @vite-ignore`);
}
const { createServer, build } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : 'vite');
// Vite's HTML plugin uses cwd as well as root; keep both on the same Windows drive.
process.chdir(root);
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { port: 0 }, optimizeDeps: { include: ['emf-converter', 'emf-converter/lite'] } });
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
} finally {
	await server.close();
}

for (const name of ['convertMetafileToDataUrl', 'convertMetafileToImageData']) {
	await writeFile(join(root, 'main.js'), `import { ${name} } from 'emf-converter'; globalThis.convert = ${name};`);
	const { output } = await build({ root, configFile: false, logLevel: 'error', build: { write: false } });
	const chunks = new Map(output.filter((item) => item.type === 'chunk').map((chunk) => [chunk.fileName, chunk]));
	const loaded = new Set();
	const include = (chunk) => {
		if (loaded.has(chunk)) return;
		loaded.add(chunk);
		for (const dependency of chunk.imports) include(chunks.get(dependency));
	};
	include([...chunks.values()].find((chunk) => chunk.isEntry));
	if (name === 'convertMetafileToDataUrl') {
		const encoder = [...chunks.values()].find((chunk) => chunk.name.startsWith('png-encoder'));
		assert.ok(encoder, 'PNG encoder chunk missing from the PNG consumer');
		include(encoder);
	}
	const gzipBytes = [...loaded].reduce((size, chunk) => size + gzipSync(chunk.code).length, 0);
	assert.ok(gzipBytes <= 250_000, `${name} ships ${gzipBytes} bytes gzip before codec and parity-table loads`);
	console.log(`${name}: ${gzipBytes} bytes gzip for ordinary raster conversion`);
}
console.log('Browser, Node and lite ESM/CJS exports, output parity and Vite dev/production builds passed (optional canvas absent).');
