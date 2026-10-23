/**
 * Command-line interface behind `npx emf-converter`: converts EMF, EMF+,
 * WMF and gzip-compressed (`.emz` / `.wmz`) files to PNG, JPEG or SVG.
 *
 * Node.js only. Nothing in the library entry points imports this module;
 * `src/cli-bin.ts` is the thin process wrapper that the `dist/cli.mjs`
 * bundle is built from. {@link main} takes its streams as parameters so
 * tests can drive it directly.
 *
 * @module cli
 */

import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { convertMetafile, loadSystemFonts, type ConvertOptions } from './index';

/**
 * Output formats the CLI writes. The first extension is the default for
 * outputs named after an input. Add a format (for example webp or pdf) here
 * once the library can produce it.
 */
const CLI_FORMATS = [
	{ name: 'png', extensions: ['.png'] },
	{ name: 'jpeg', extensions: ['.jpg', '.jpeg'] },
	{ name: 'svg', extensions: ['.svg'] },
] as const;

type CliFormat = (typeof CLI_FORMATS)[number]['name'];

/** Input extensions the converter reads; gzip-compressed forms are inflated by the library. */
const INPUT_EXTENSIONS = ['.emf', '.wmf', '.emz', '.wmz'];

/** The streams and working directory {@link main} reads and writes. */
export interface CliIo {
	stdout: { write(chunk: string | Uint8Array): unknown };
	stderr: { write(chunk: string): unknown };
	/** Standard input; `-` as an input file reads it to the end. */
	stdin: AsyncIterable<Uint8Array | string>;
	/** Directory that relative paths are resolved against. */
	cwd: string;
}

const OPTIONS = {
	format: { type: 'string', short: 'f' },
	out: { type: 'string', short: 'o' },
	width: { type: 'string' },
	height: { type: 'string' },
	scale: { type: 'string' },
	quality: { type: 'string' },
	background: { type: 'string' },
	antialias: { type: 'boolean' },
	fonts: { type: 'string' },
	quiet: { type: 'boolean', short: 'q' },
	help: { type: 'boolean', short: 'h' },
	version: { type: 'boolean', short: 'v' },
} as const;

type CliValues = {
	format?: string;
	out?: string;
	width?: string;
	height?: string;
	scale?: string;
	quality?: string;
	background?: string;
	antialias?: boolean;
	fonts?: string;
	quiet?: boolean;
	help?: boolean;
	version?: boolean;
};

/** Printed for `--help`. */
const HELP_TEXT = `Usage: emf-converter <files...> [options]

Convert EMF, EMF+, WMF and gzip-compressed (.emz, .wmz) metafiles to PNG,
JPEG or SVG.

Inputs:
  <files...>            Files to convert. "-" reads one file from stdin.
                        Wildcards (* and ?) are expanded by the CLI itself.

Options:
  -f, --format <fmt>    Output format: png, jpeg or svg. Default: from the
                        --out extension, else png.
  -o, --out <path>      Output file for one input, or a directory (created if
                        missing) for several. Default: next to each input,
                        with the new extension. "-" writes to stdout.
                        Stdin input without --out also writes to stdout.
      --width <px>      Maximum output width in pixels.
      --height <px>     Maximum output height in pixels.
      --scale <n>       DPI scale factor (default 1; the library clamps to 4).
      --quality <0-1>   JPEG quality (default 0.92). JPEG only.
      --background <c>  JPEG colour under transparent areas, #rgb or #rrggbb
                        (default #ffffff). JPEG only.
      --antialias       Smooth shape edges instead of reproducing Windows'
                        own rasterisation.
      --fonts <value>   "system" (default): the installed fonts, so text
                        matches Windows; "none": no font files; or a
                        directory of .ttf, .ttc, .fon or .fnt files.
  -q, --quiet           Print only errors.
  -h, --help            Show this help.
  -v, --version         Print the version.

Exit codes: 0 all files converted, 1 one or more files failed (the rest are
still converted), 2 usage error.

Examples:
  emf-converter drawing.emf
  emf-converter drawing.emf --width 1200 -o drawing.jpg
  emf-converter "charts/*.wmf" -f svg -o out/
  cat drawing.emz | emf-converter - -f png > drawing.png
`;

/** A bad flag or value; {@link main} reports it and exits with 2. */
class UsageError extends Error {}

/** One thing to convert, or a problem found while expanding the arguments. */
type Job =
	| { kind: 'file'; label: string; path: string }
	| { kind: 'stdin'; label: string }
	| { kind: 'error'; label: string; message: string };

/** Where an output goes: a file, or `undefined` for stdout. */
interface Plan {
	job: Job;
	target: string | undefined;
}

/**
 * Runs the CLI with the given arguments (without the program name).
 *
 * @returns The exit code: 0 when every file converted, 1 when any failed
 *   (each failure is reported and the rest still run), 2 for a usage error
 *   (nothing is converted).
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
	try {
		return await run(argv, io);
	} catch (err) {
		if (err instanceof UsageError) {
			io.stderr.write(`emf-converter: ${err.message}\nTry 'emf-converter --help' for more information.\n`);
			return 2;
		}
		io.stderr.write(`emf-converter: ${describeError(err)}\n`);
		return 1;
	}
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
	const { values, positionals } = parseCommandLine(argv);
	if (values.help) {
		io.stdout.write(HELP_TEXT);
		return 0;
	}
	if (values.version) {
		io.stdout.write(`${readVersion()}\n`);
		return 0;
	}
	if (positionals.length === 0) {
		throw new UsageError('no input files given');
	}

	const quiet = values.quiet === true;
	const toStdout = values.out === '-';
	const outPath = values.out !== undefined && !toStdout ? resolve(io.cwd, values.out) : undefined;
	const format = chooseFormat(values.format, values.out);
	const settings = convertSettings(values);
	const fonts = chooseFonts(values.fonts ?? 'system');
	if (fonts.kind === 'dir' && !(await isDirectory(resolve(io.cwd, fonts.dir)))) {
		throw new UsageError(`--fonts: "${fonts.dir}" is not a directory`);
	}

	const jobs = await expandInputs(positionals, io.cwd);
	// A wildcard names a set of files even when it matches only one, so it gets a directory.
	const several = positionals.length > 1 || positionals.some((p) => /[*?]/.test(p));
	const plans = await planOutputs(jobs, { format, outPath, toStdout, several, cwd: io.cwd });

	// Fonts are read once, and only when a conversion actually needs them.
	let fontData: Promise<Uint8Array[] | undefined> | undefined;
	const loadFonts = (): Promise<Uint8Array[] | undefined> => {
		fontData ??= fonts.kind === 'none'
			? Promise.resolve(undefined)
			: loadSystemFonts(fonts.kind === 'dir' ? { dirs: [resolve(io.cwd, fonts.dir)] } : undefined);
		return fontData;
	};
	let stdinData: Promise<Uint8Array> | undefined;
	const readStdin = (): Promise<Uint8Array> => {
		stdinData ??= collect(io.stdin);
		return stdinData;
	};

	let failures = 0;
	const fail = (label: string, message: string): void => {
		failures++;
		io.stderr.write(`emf-converter: ${label}: ${message}\n`);
	};

	for (const plan of plans) {
		const { job } = plan;
		if (job.kind === 'error') {
			fail(job.label, job.message);
			continue;
		}
		try {
			const bytes = job.kind === 'stdin' ? await readStdin() : await fs.readFile(job.path);
			const fontList = await loadFonts();
			const options = { ...settings, format, ...(fontList ? { fonts: fontList } : {}) } as ConvertOptions;
			const image = await convertMetafile(bytes, options);
			if (!image) {
				fail(job.label, 'not a readable EMF or WMF file, or the conversion failed');
				continue;
			}
			if (plan.target === undefined) {
				io.stdout.write(image.data);
				continue;
			}
			await fs.mkdir(dirname(plan.target), { recursive: true });
			await fs.writeFile(plan.target, image.data);
			if (!quiet) {
				io.stderr.write(`${job.label} -> ${plan.target}\n`);
			}
		} catch (err) {
			fail(job.label, describeError(err));
		}
	}
	return failures > 0 ? 1 : 0;
}

function parseCommandLine(argv: readonly string[]): { values: CliValues; positionals: string[] } {
	try {
		const parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
		return { values: parsed.values as CliValues, positionals: parsed.positionals };
	} catch (err) {
		throw new UsageError(describeError(err));
	}
}

/** Resolves `--format`, else the `--out` extension, else png. An unknown name is a usage error. */
function chooseFormat(value: string | undefined, out: string | undefined): CliFormat {
	if (value !== undefined) {
		const found = CLI_FORMATS.find((f) => f.name === value.toLowerCase());
		if (!found) {
			throw new UsageError(`unknown format "${value}" (use ${CLI_FORMATS.map((f) => f.name).join(', ')})`);
		}
		return found.name;
	}
	if (out !== undefined && out !== '-') {
		const ext = extname(out).toLowerCase();
		const found = CLI_FORMATS.find((f) => (f.extensions as readonly string[]).includes(ext));
		if (found) {
			return found.name;
		}
	}
	return 'png';
}

/** Builds the library options from the numeric and colour flags; a bad value is a usage error. */
function convertSettings(values: CliValues): Record<string, unknown> {
	const settings: Record<string, unknown> = {};
	if (values.width !== undefined) {
		settings.maxWidth = parseNumber('width', values.width, (n) => n > 0, 'a positive number');
	}
	if (values.height !== undefined) {
		settings.maxHeight = parseNumber('height', values.height, (n) => n > 0, 'a positive number');
	}
	if (values.scale !== undefined) {
		settings.dpiScale = parseNumber('scale', values.scale, (n) => n > 0, 'a positive number');
	}
	if (values.quality !== undefined) {
		settings.quality = parseNumber('quality', values.quality, (n) => n >= 0 && n <= 1, 'a number from 0 to 1');
	}
	if (values.background !== undefined) {
		if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(values.background)) {
			throw new UsageError(`--background needs #rgb or #rrggbb, not "${values.background}"`);
		}
		settings.background = values.background;
	}
	if (values.antialias) {
		settings.gdiAntialias = true;
	}
	return settings;
}

function parseNumber(flag: string, raw: string, valid: (n: number) => boolean, expected: string): number {
	const n = raw.trim() === '' ? Number.NaN : Number(raw);
	if (!Number.isFinite(n) || !valid(n)) {
		throw new UsageError(`--${flag} needs ${expected}, not "${raw}"`);
	}
	return n;
}

type FontChoice = { kind: 'system' } | { kind: 'none' } | { kind: 'dir'; dir: string };

function chooseFonts(value: string): FontChoice {
	if (value === 'system' || value === 'none') {
		return { kind: value };
	}
	return { kind: 'dir', dir: value };
}

/**
 * Turns the positional arguments into conversion jobs. Wildcards are expanded
 * here because Windows shells pass them through unexpanded. A pattern that
 * cannot be expanded becomes an error job, reported like a failed file.
 */
async function expandInputs(args: readonly string[], cwd: string): Promise<Job[]> {
	const jobs: Job[] = [];
	for (const arg of args) {
		if (arg === '-') {
			jobs.push({ kind: 'stdin', label: 'stdin' });
		} else if (/[*?]/.test(arg)) {
			jobs.push(...(await expandPattern(arg, cwd)));
		} else {
			jobs.push(fileJob(arg, resolve(cwd, arg)));
		}
	}
	return jobs;
}

async function expandPattern(pattern: string, cwd: string): Promise<Job[]> {
	if (typeof fs.glob !== 'function') {
		return [{ kind: 'error', label: pattern, message: 'wildcards need Node.js 22 or later, so the pattern was not expanded' }];
	}
	// On Windows the separators are backslashes, which the glob matcher reads as escapes.
	const globPattern = sep === '\\' ? pattern.replace(/\\/g, '/') : pattern;
	const matches: string[] = [];
	for await (const match of fs.glob(globPattern, { cwd })) {
		if (INPUT_EXTENSIONS.includes(extname(match).toLowerCase())) {
			matches.push(match);
		}
	}
	if (matches.length === 0) {
		return [{ kind: 'error', label: pattern, message: 'no .emf, .wmf, .emz or .wmz files match' }];
	}
	return matches.sort().map((match) => fileJob(match, resolve(cwd, match)));
}

// Files named explicitly are converted whatever their extension (the library
// detects EMF, WMF and gzip from the bytes); wildcards only pick metafile extensions.
function fileJob(label: string, path: string): Job {
	return { kind: 'file', label, path };
}

interface OutputContext {
	format: CliFormat;
	outPath: string | undefined;
	toStdout: boolean;
	/** Several inputs, or a wildcard: `-o` names a directory unless it is an existing file. */
	several: boolean;
	cwd: string;
}

/**
 * Works out where each input's output goes and rejects layouts that would
 * overwrite a file (two inputs with the same name, or an output that is an
 * input). Nothing is written until every plan is valid.
 */
async function planOutputs(jobs: Job[], ctx: OutputContext): Promise<Plan[]> {
	if (ctx.toStdout && jobs.length > 1) {
		throw new UsageError('"-o -" writes one file to stdout, so give a single input');
	}
	const newExt = CLI_FORMATS.find((f) => f.name === ctx.format)!.extensions[0];
	let outIsDirectory = false;
	if (ctx.outPath !== undefined) {
		const existing = await statOrNull(ctx.outPath);
		if (ctx.several) {
			if (existing && !existing.isDirectory()) {
				throw new UsageError(`"${ctx.outPath}" is not a directory; several inputs need an output directory`);
			}
			outIsDirectory = true;
		} else {
			outIsDirectory = existing?.isDirectory() ?? false;
		}
	}

	const plans: Plan[] = [];
	const claimed = new Map<string, string>();
	const inputPaths = new Set(jobs.flatMap((job) => (job.kind === 'file' ? [resolve(job.path)] : [])));
	for (const job of jobs) {
		if (job.kind === 'error' || ctx.toStdout || (job.kind === 'stdin' && ctx.outPath === undefined)) {
			plans.push({ job, target: undefined });
			continue;
		}
		let target: string;
		if (ctx.outPath !== undefined) {
			const stem = job.kind === 'stdin' ? 'stdin' : basename(job.path, extname(job.path));
			target = outIsDirectory ? join(ctx.outPath, stem + newExt) : ctx.outPath;
		} else if (job.kind === 'file') {
			target = join(dirname(job.path), basename(job.path, extname(job.path)) + newExt);
		} else {
			throw new Error('unreachable: stdin without --out goes to stdout');
		}
		const key = resolve(target);
		if (inputPaths.has(key)) {
			throw new UsageError(`the output "${target}" would overwrite an input file`);
		}
		const previous = claimed.get(key);
		if (previous !== undefined) {
			throw new UsageError(`"${previous}" and "${job.label}" would both write "${target}"`);
		}
		claimed.set(key, job.label);
		plans.push({ job, target });
	}
	return plans;
}

async function statOrNull(path: string) {
	return fs.stat(path).catch(() => null);
}

async function isDirectory(path: string): Promise<boolean> {
	return (await statOrNull(path))?.isDirectory() ?? false;
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream) {
		const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
		chunks.push(bytes);
		total += bytes.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function describeError(err: unknown): string {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	if (code === 'ENOENT') {
		return 'no such file or directory';
	}
	if (code === 'EISDIR') {
		return 'is a directory';
	}
	return err instanceof Error ? err.message : String(err);
}

/** Reads the version from the package.json beside the built bundle or the source. */
function readVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
		return pkg.version ?? 'unknown';
	} catch {
		return 'unknown';
	}
}
