import { mkdtemp, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type CliIo } from './cli';

const EMF = fileURLToPath(new URL('./__fixtures__/sample-gradient-clip.emf', import.meta.url));
const WMF = fileURLToPath(new URL('./__fixtures__/sample-crown.wmf', import.meta.url));

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'emf-cli-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

interface Captured {
	io: CliIo;
	stdout: Uint8Array[];
	stderr: string;
}

/** A CLI IO whose streams are captured in memory; stdin yields `stdin` once. */
function captureIo(stdin: Uint8Array = new Uint8Array()): Captured {
	const captured = { stdout: [] as Uint8Array[], stderr: '' } as Captured;
	captured.io = {
		stdout: {
			write(chunk) {
				captured.stdout.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
				return true;
			},
		},
		stderr: {
			write(chunk) {
				captured.stderr += chunk;
				return true;
			},
		},
		stdin: (async function* () {
			if (stdin.byteLength > 0) {
				yield stdin;
			}
		})(),
		cwd: dir,
	};
	return captured;
}

function stdoutBytes(captured: Captured): Uint8Array {
	const total = captured.stdout.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of captured.stdout) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
	return magic.every((byte, i) => bytes[i] === byte);
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

describe('emf-converter CLI', () => {
	it('writes a PNG next to the input by default', async () => {
		await copyFile(EMF, join(dir, 'drawing.emf'));
		const captured = captureIo();
		expect(await main(['drawing.emf', '--fonts', 'none'], captured.io)).toBe(0);
		const bytes = new Uint8Array(await readFile(join(dir, 'drawing.png')));
		expect(startsWith(bytes, PNG_MAGIC)).toBe(true);
		expect(captured.stderr).toContain('drawing.emf -> ');
	});

	it('infers JPEG from the --out extension and writes JPEG magic bytes', async () => {
		const out = join(dir, 'crown.jpg');
		const captured = captureIo();
		expect(await main([WMF, '-o', out, '--fonts', 'none', '--quality', '0.8'], captured.io)).toBe(0);
		expect(startsWith(new Uint8Array(await readFile(out)), JPEG_MAGIC)).toBe(true);
	});

	it('writes SVG markup for -f svg', async () => {
		const captured = captureIo();
		expect(await main([EMF, '-f', 'svg', '-o', join(dir, 'drawing.svg')], captured.io)).toBe(0);
		expect(await readFile(join(dir, 'drawing.svg'), 'utf8')).toContain('<svg');
	});

	it('writes several inputs into a directory it creates', async () => {
		const out = join(dir, 'converted');
		const captured = captureIo();
		expect(await main([EMF, WMF, '-o', out, '--fonts', 'none'], captured.io)).toBe(0);
		expect(startsWith(new Uint8Array(await readFile(join(out, 'sample-gradient-clip.png'))), PNG_MAGIC)).toBe(true);
		expect(startsWith(new Uint8Array(await readFile(join(out, 'sample-crown.png'))), PNG_MAGIC)).toBe(true);
	});

	it('writes to stdout for "-o -"', async () => {
		const captured = captureIo();
		expect(await main([EMF, '-o', '-', '--fonts', 'none'], captured.io)).toBe(0);
		expect(startsWith(stdoutBytes(captured), PNG_MAGIC)).toBe(true);
		expect(captured.stderr).toBe('');
	});

	it('reads stdin with "-" and writes stdout when no --out is given', async () => {
		const emf = new Uint8Array(await readFile(EMF));
		const captured = captureIo(emf);
		expect(await main(['-', '-f', 'png', '--fonts', 'none'], captured.io)).toBe(0);
		expect(startsWith(stdoutBytes(captured), PNG_MAGIC)).toBe(true);
	});

	it('reports a missing file on stderr and exits 1, still converting the others', async () => {
		await copyFile(EMF, join(dir, 'ok.emf'));
		const captured = captureIo();
		expect(await main(['missing.emf', 'ok.emf', '--fonts', 'none'], captured.io)).toBe(1);
		expect(captured.stderr).toContain('missing.emf');
		expect(await exists(join(dir, 'ok.png'))).toBe(true);
	});

	it('exits 1 for an input that is not a metafile', async () => {
		await writeFile(join(dir, 'notes.txt'), 'hello');
		const captured = captureIo();
		expect(await main([join(dir, 'notes.txt')], captured.io)).toBe(1);
		expect(captured.stderr).toContain('not a readable EMF or WMF file');
	});

	it('exits 2 for usage errors and converts nothing', async () => {
		await copyFile(EMF, join(dir, 'drawing.emf'));
		const cases: string[][] = [
			['--bogus', 'drawing.emf'],
			['drawing.emf', '-f', 'gif'],
			['drawing.emf', '--quality', '2'],
			['drawing.emf', '--width', 'wide'],
			['drawing.emf', '--background', 'red'],
			['drawing.emf', '--width'],
			['--fonts', 'none'],
			['drawing.emf', 'drawing.emf', '-o', '-'],
		];
		for (const args of cases) {
			const captured = captureIo();
			expect(await main(args, captured.io), args.join(' ')).toBe(2);
			expect(captured.stderr).toContain('emf-converter:');
		}
		expect(await exists(join(dir, 'drawing.png'))).toBe(false);
	});

	it('exits 2 when several inputs are given a file rather than a directory', async () => {
		await copyFile(EMF, join(dir, 'a.emf'));
		await copyFile(WMF, join(dir, 'b.wmf'));
		await writeFile(join(dir, 'taken.txt'), 'x');
		const captured = captureIo();
		expect(await main(['a.emf', 'b.wmf', '-o', 'taken.txt'], captured.io)).toBe(2);
	});

	it('exits 2 for a --fonts directory that does not exist', async () => {
		const captured = captureIo();
		expect(await main([EMF, '--fonts', join(dir, 'no-such-fonts')], captured.io)).toBe(2);
	});

	it('loads fonts from a --fonts directory', async () => {
		await mkdir(join(dir, 'fonts'));
		const captured = captureIo();
		expect(await main([EMF, '--fonts', join(dir, 'fonts'), '-o', join(dir, 'f.png')], captured.io)).toBe(0);
		expect(startsWith(new Uint8Array(await readFile(join(dir, 'f.png'))), PNG_MAGIC)).toBe(true);
	});

	it('prints the version from package.json', async () => {
		const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
		const captured = captureIo();
		expect(await main(['--version'], captured.io)).toBe(0);
		expect(new TextDecoder().decode(stdoutBytes(captured)).trim()).toBe(pkg.version);
	});

	it('prints help to stdout and exits 0', async () => {
		const captured = captureIo();
		expect(await main(['--help'], captured.io)).toBe(0);
		expect(new TextDecoder().decode(stdoutBytes(captured))).toContain('Usage: emf-converter <files...> [options]');
	});

	it('expands wildcards itself when fs.glob is available', async () => {
		if (typeof fsp.glob !== 'function') {
			return;
		}
		await copyFile(EMF, join(dir, 'one.emf'));
		await copyFile(WMF, join(dir, 'two.wmf'));
		const captured = captureIo();
		expect(await main(['*.emf', '*.wmf', '--fonts', 'none', '-o', 'out'], captured.io)).toBe(0);
		expect(await exists(join(dir, 'out', 'one.png'))).toBe(true);
		expect(await exists(join(dir, 'out', 'two.png'))).toBe(true);
	});

	it('treats -o as a directory for a wildcard that matches a single file', async () => {
		if (typeof fsp.glob !== 'function') {
			return;
		}
		await copyFile(EMF, join(dir, 'only.emf'));
		const captured = captureIo();
		expect(await main(['*.emf', '--fonts', 'none', '-o', 'single'], captured.io)).toBe(0);
		expect(await exists(join(dir, 'single', 'only.png'))).toBe(true);
	});

	it('reports a wildcard that matches nothing as a failed input', async () => {
		const captured = captureIo();
		expect(await main(['*.emf', '--fonts', 'none'], captured.io)).toBe(1);
		expect(captured.stderr).toContain('no .emf, .wmf, .emz or .wmz files match');
	});
});
