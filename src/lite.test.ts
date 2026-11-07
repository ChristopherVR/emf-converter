import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { litePlugin } from '../tsup.lite.config';
import * as full from './index';

/**
 * The lite build is the full source with the modules of `LITE_MODULES`
 * swapped at bundle time, so these tests bundle it the same way (keeping the
 * Node canvas loader, so it renders here) and compare it with the full build.
 */
type LiteApi = typeof import('./lite');
let lite: LiteApi;

beforeAll(async () => {
	const result = await build({
		entryPoints: ['src/lite.ts'],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		external: ['@napi-rs/canvas'],
		plugins: [litePlugin(false)],
	});
	const file = join(mkdtempSync(join(tmpdir(), 'emf-lite-')), 'lite.mjs');
	writeFileSync(file, result.outputFiles[0].contents);
	lite = await import(pathToFileURL(file).href);
}, 60_000);

const fixtureRoot = new URL('./__fixtures__/', import.meta.url);

function metafileFixtures(): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(emf|wmf)$/i.test(name)) files.push(path);
		}
	};
	walk(fileURLToPath(fixtureRoot));
	return files;
}

/**
 * Fixtures whose rendering needs a table the lite build leaves out: the CMYK
 * JPEG transform and `SetColorAdjustment` illuminants and chroma corrections.
 */
const NEEDS_LEFT_OUT_TABLE = /cmyk|illuminant|ca-dither|-ca\.emf$/;

describe('lite build', () => {
	it('renders the same pixels as the full build', { timeout: 120_000 }, async () => {
		// Every 8th fixture keeps the run short; all 936 were identical outside
		// NEEDS_LEFT_OUT_TABLE when this test was written.
		const sample = metafileFixtures().filter((f, i) => i % 8 === 0 && !NEEDS_LEFT_OUT_TABLE.test(f));
		expect(sample.length).toBeGreaterThan(100);
		const differing: string[] = [];
		for (const file of sample) {
			const bytes = readFileSync(file);
			const a = await full.convertMetafileToImageData(bytes);
			const b = await lite.convertMetafileToImageData(bytes);
			const same = a === null ? b === null
				: b !== null && a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
			if (!same) differing.push(file);
		}
		expect(differing).toEqual([]);
	});

	it('produces a PNG data URL', async () => {
		const bytes = readFileSync(new URL('sample-crown.wmf', fixtureRoot));
		const url = await lite.convertMetafileToDataUrl(bytes);
		expect(url).toBe(await full.convertMetafileToDataUrl(bytes));
		expect(url?.startsWith('data:image/png;base64,')).toBe(true);
	});

	it('ignores the TrueType engine options', async () => {
		const bytes = readFileSync(new URL('sample-clip-gdi.emf', fixtureRoot));
		const options = { fonts: [new Uint8Array(16)], fontSmoothing: 'gray' } as Parameters<LiteApi['convertMetafileToDataUrl']>[1];
		expect(await lite.convertMetafileToDataUrl(bytes, options)).toBe(await full.convertMetafileToDataUrl(bytes));
	});

	it('exports only the PNG path', () => {
		expect(Object.keys(lite).sort()).toEqual(['DEFAULT_DPI_SCALE', 'convertMetafileToDataUrl', 'convertMetafileToImageData']);
	});

	it('stays small', { timeout: 60_000 }, async () => {
		const result = await build({
			entryPoints: ['src/lite.ts'],
			bundle: true,
			format: 'esm',
			platform: 'browser',
			minify: true,
			write: false,
			plugins: [litePlugin()],
		});
		const bytes = result.outputFiles[0].contents;
		// 427 KB minified and 160 KB gzipped when written (the full browser
		// build is about 1.4 MB minified); raise these only on purpose.
		expect(bytes.length).toBeLessThan(450_000);
		expect(gzipSync(bytes).length).toBeLessThan(170_000);
	});
});
