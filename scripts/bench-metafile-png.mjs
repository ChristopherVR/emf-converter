// Node 24+: node --experimental-transform-types scripts/bench-metafile-png.mjs --help
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { basename, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = resolve(repo, 'src/__fixtures__');
const deckNames = ['e2e/ole-editable.pptx', 'corpus/ole-embedded-media.pptx'];
const metafile = /\.(?:emf|wmf|emz|wmz)$/i;
const { values: args, positionals: deckPaths } = parseArgs({
	allowPositionals: true,
	options: {
		group: { type: 'string', default: 'all' },
		runs: { type: 'string', default: '7' },
		entry: { type: 'string', default: resolve(repo, 'src/index.ts') },
		against: { type: 'string' },
		help: { type: 'boolean' },
	},
});
if (args.help) {
	console.log(`Usage: node --experimental-transform-types scripts/bench-metafile-png.mjs [options] [deck.pptx ...]
  --group all|decks|fixtures  Input set (default all)
  --runs N                    Timed runs per input and implementation (default 7, minimum 5)
  --entry PATH                Converter module (default src/index.ts)
  --against PATH              Baseline module, interleaved with --entry; require identical PNG URLs

Deck paths default to the two OLE fixture decks under the ooxml-core checkout
beside this repo's parent directory. The report is tab-separated. Use Node's
--cpu-prof for a separate profiling run.`);
	process.exit(0);
}
assert.ok(['all', 'decks', 'fixtures'].includes(args.group), 'Expected --group all, decks or fixtures');
const runs = Number(args.runs);
assert.ok(Number.isSafeInteger(runs) && runs >= 5, 'Expected --runs to be an integer of at least 5');

// The source uses extensionless imports. Let Node transpile each TS module so
// the profiler keeps the original filenames, line numbers and function names.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && !extname(specifier)) {
			return nextResolve(`${specifier}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

async function* fixtureInputs() {
	const files = await readdir(fixtureRoot, { recursive: true, withFileTypes: true });
	const paths = files.filter(file => file.isFile() && metafile.test(file.name))
		.map(file => resolve(file.parentPath, file.name)).sort();
	for (const path of paths) {
		yield [relative(fixtureRoot, path).replaceAll('\\', '/'), await readFile(path)];
	}
}

function* deckInputs(path, zip) {
	// A regular PPTX uses a single-disk ZIP central directory. The local header
	// can omit sizes when a data descriptor follows the payload.
	let end = zip.length - 22;
	for (; end >= Math.max(0, zip.length - 22 - 0xffff); end--) {
		if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
	}
	assert.ok(end >= Math.max(0, zip.length - 22 - 0xffff), `ZIP directory missing in ${path}`);
	const count = zip.readUInt16LE(end + 10);
	assert.equal(zip.readUInt32LE(end + 4), 0, `Multi-disk ZIP in ${path}`);
	assert.equal(zip.readUInt16LE(end + 8), count);
	let dir = zip.readUInt32LE(end + 16);
	let found = 0;
	for (let i = 0; i < count; i++) {
		assert.equal(zip.readUInt32LE(dir), 0x02014b50, `Invalid ZIP directory in ${path}`);
		const nameLength = zip.readUInt16LE(dir + 28);
		const name = zip.toString('utf8', dir + 46, dir + 46 + nameLength);
		const entry = dir;
		dir += 46 + nameLength + zip.readUInt16LE(dir + 30) + zip.readUInt16LE(dir + 32);
		if (!/^ppt\/(?:media|embeddings)\//i.test(name) || !metafile.test(name)) continue;
		assert.equal(zip.readUInt16LE(entry + 8) & 1, 0, `Encrypted ZIP entry ${name}`);
		const method = zip.readUInt16LE(entry + 10);
		const compressedSize = zip.readUInt32LE(entry + 20);
		const size = zip.readUInt32LE(entry + 24);
		const local = zip.readUInt32LE(entry + 42);
		assert.equal(zip.readUInt32LE(local), 0x04034b50, `Invalid ZIP entry ${name}`);
		const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		assert.ok(start + compressedSize <= zip.length && size <= 256 * 1024 * 1024, `Invalid ZIP size for ${name}`);
		assert.ok(method === 0 || method === 8, `Unsupported ZIP method ${method} for ${name}`);
		const compressed = zip.subarray(start, start + compressedSize);
		const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
		assert.equal(data.length, size, name);
		found++;
		yield [`${basename(path)}/${name}`, data];
	}
	assert.ok(found, `No metafile parts in ${path}`);
}

async function* inputs() {
	if (args.group !== 'fixtures') {
		const decks = deckPaths.length ? deckPaths : deckNames.map(name =>
			resolve(repo, '../../ooxml-core/src/core/pptx/__tests__/fixtures', name));
		for (const path of decks) yield* deckInputs(path, await readFile(path));
	}
	if (args.group !== 'decks') yield* fixtureInputs();
}

function stats(samples) {
	const sorted = samples.toSorted((a, b) => a - b);
	const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
	return [median, sorted[0], sorted.at(-1)].map(ms => ms.toFixed(3));
}

const entries = [args.against, args.entry].filter(Boolean);
const converters = await Promise.all(entries.map(async entry =>
	(await import(pathToFileURL(resolve(entry)).href)).convertMetafileToDataUrl));
console.log(`# Node ${process.version}, ${runs} timed runs and one warmup per file and implementation`);
console.log(['file', 'bytes', 'result', ...entries.flatMap((_, i) => {
	const label = args.against && i === 0 ? 'before' : 'current';
	return ['wall', 'cpu'].flatMap(clock => ['median', 'min', 'max'].map(stat => `${label}_${clock}_${stat}_ms`));
})].join('\t'));
let rendered = 0;
let nulls = 0;
for await (const [name, data] of inputs()) {
	const timings = converters.map(() => ({ wall: [], cpu: [] }));
	let reference;
	for (let run = -1; run < runs; run++) {
		for (let i = 0; i < converters.length; i++) {
			const index = run % 2 === 1 ? converters.length - 1 - i : i;
			const cpuStart = process.cpuUsage();
			const wallStart = performance.now();
			const png = await converters[index](data);
			const wall = performance.now() - wallStart;
			const cpu = process.cpuUsage(cpuStart);
			if (run >= 0) {
				timings[index].wall.push(wall);
				timings[index].cpu.push((cpu.user + cpu.system) / 1000);
			}
			if (png !== null) assert.ok(png.startsWith('data:image/png;base64,'), name);
			if (reference === undefined) reference = png;
			assert.ok(png === reference, `PNG data URL changed for ${name} (${entries[index]}, run ${run + 1})`);
		}
	}
	if (reference === null) {
		assert.ok(!name.includes('.pptx/'), `Conversion returned null for ${name}`);
		nulls++;
	} else {
		rendered++;
	}
	const result = reference === null ? 'null' : createHash('sha256').update(reference).digest('hex');
	console.log([name, data.length, result, ...timings.flatMap(({ wall, cpu }) => [...stats(wall), ...stats(cpu)])].join('\t'));
}
console.log(`# ${rendered} rendered, ${nulls} null, ${args.against ? 'baseline and current PNG URLs match' : 'repeated PNG URLs match'}`);
