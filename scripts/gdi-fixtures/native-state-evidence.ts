// Builds the evidence files that native GDI+ glyph output is not a pure function of the font, size and hint:
// the same probe, on the same machine with the same OS build and the same gdiplus.dll, returned different
// images at different times.
//
//   bun scripts/gdi-fixtures/native-state-evidence.ts <out-dir> <label>=<real-glyphs-dir>... --coverage <fresh-dir>
//
// Each `<label>=<dir>` names a directory holding a `text-real-glyphs.json.gz` and its
// `environment-text-real-glyphs.json`; the first is the reference. `text-native-states.json.gz` keeps, for every
// capture that differs between any two of them, each distinct image. `--coverage <dir>` compares a fresh
// `text-coverage.json.gz` with the committed one and keeps the differing captures (red channel) of both.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const outDir = resolve(args.shift()!);
const coverageAt = args.indexOf('--coverage');
const coverageDir = coverageAt >= 0 ? resolve(args.splice(coverageAt, 2)[1]) : null;
const states = args.map((a) => { const [label, dir] = a.split('='); return { label, dir: resolve(dir) }; });
const load = (path: string): any[] => JSON.parse(gunzipSync(readFileSync(path)).toString());
const manifest = (path: string) => { const e = JSON.parse(readFileSync(path, 'utf8')); return { capturedAt: e.capturedAt, os: e.os, build: e.build, gdiplus: e.libraries.find((l: any) => l.name === 'gdiplus.dll')?.sha256 }; };

if (states.length) {
	const captures = states.map((s) => load(`${s.dir}/text-real-glyphs.json.gz`));
	const differing: any[] = [];
	for (let i = 0; i < captures[0].length; i++) {
		const images = captures.map((c) => c[i].gray);
		if (new Set(images).size === 1) continue;
		const { face, style, size, hint, code } = captures[0][i];
		differing.push({ face, style, size, hint, code, images });
	}
	const record = { states: states.map((s) => ({ label: s.label, ...manifest(`${s.dir}/environment-text-real-glyphs.json`) })), total: captures[0].length, differing };
	writeFileSync(`${outDir}/text-native-states.json.gz`, gzipSync(JSON.stringify(record)));
	console.log('real glyphs:', differing.length, 'of', captures[0].length, 'captures differ between states');
}
if (coverageDir) {
	const committed = load(resolve('src/__fixtures__/gdi/text-coverage.json.gz')), fresh = load(`${coverageDir}/text-coverage.json.gz`);
	const red = (rgba: string) => { const b = Buffer.from(rgba, 'base64'); const o = Buffer.alloc(b.length / 4); for (let i = 0; i < o.length; i++) o[i] = b[i * 4]; return o.toString('base64'); };
	const differing: any[] = [];
	for (let i = 0; i < committed.length; i++) {
		if (committed[i].rgba === fresh[i].rgba) continue;
		const { face, size, style, hint, contrast, code, qx, qy } = committed[i];
		differing.push({ face, size, style, hint, contrast, code, qx, qy, committed: red(committed[i].rgba), fresh: red(fresh[i].rgba) });
	}
	const record = {
		committed: manifest(resolve('src/__fixtures__/gdi/environment-text-coverage.json')), fresh: manifest(`${coverageDir}/environment-text-coverage.json`),
		total: committed.length, differing,
	};
	writeFileSync(`${outDir}/text-coverage-restate.json.gz`, gzipSync(JSON.stringify(record)));
	console.log('text-coverage:', differing.length, 'of', committed.length, 'captures differ from a fresh capture');
}
