/**
 * `loadSystemFonts()`: reads the operating system's installed font files
 * (Node.js only) into buffers for the converter's `fonts` option.
 *
 * The Node.js modules are loaded with dynamic `import()` (and bundler
 * ignore comments) only when the function is called, so the package stays
 * browser-safe: nothing here is resolved or bundled for a browser build.
 *
 * @module load-system-fonts
 */

/** Options for {@link loadSystemFonts}. */
export interface LoadSystemFontsOptions {
	/**
	 * Directories to scan instead of the platform defaults (Windows:
	 * `%WINDIR%\Fonts` and the per-user `%LOCALAPPDATA%\Microsoft\Windows\Fonts`;
	 * Linux: `/usr/share/fonts`, `/usr/local/share/fonts`, `~/.fonts`,
	 * `~/.local/share/fonts`; macOS: `/Library/Fonts`,
	 * `/System/Library/Fonts`, `~/Library/Fonts`). Missing directories are
	 * skipped.
	 */
	dirs?: string[];
	/**
	 * Keeps only the files this returns true for, given the full path and
	 * the lower-case file name (for example to load just the faces a
	 * metafile names: `(p, n) => /^(arial|times|cour)/.test(n)`).
	 */
	filter?: (path: string, name: string) => boolean;
	/** Subdirectory depth to descend (default 4; 0 scans only the directories themselves). */
	maxDepth?: number;
}

/** File types the font engine reads: TrueType fonts and collections, and raster fonts. */
const FONT_FILE = /\.(ttf|ttc|fon|fnt)$/i;

type FsPromises = typeof import('node:fs/promises');
type PathModule = typeof import('node:path');
type OsModule = typeof import('node:os');

/**
 * Reads the installed TrueType (`.ttf`, `.ttc`) and raster (`.fon`,
 * `.fnt`) font files, for `convertMetafileToDataUrl(data, { fonts })`
 * and the SVG converters. Node.js only: in a browser (or any runtime
 * without `process.versions.node`) it resolves to an empty array.
 *
 * Reading every installed font can take a few hundred megabytes on
 * Windows; pass `filter` to load only what your metafiles use. Load once
 * and reuse the array across conversions.
 *
 * @example
 * ```ts
 * import { convertMetafileToDataUrl, loadSystemFonts } from 'emf-converter';
 *
 * const fonts = await loadSystemFonts();
 * const png = await convertMetafileToDataUrl(emfBytes, { fonts });
 * ```
 */
export async function loadSystemFonts(options: LoadSystemFontsOptions = {}): Promise<Uint8Array[]> {
	if (typeof process === 'undefined' || !process.versions?.node) {
		return [];
	}
	let fs: FsPromises;
	let path: PathModule;
	let os: OsModule;
	try {
		// The magic comments keep webpack/Turbopack and Vite from resolving
		// these into a browser bundle; the guard above means this never runs there.
		fs = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:fs/promises');
		path = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:path');
		os = await import(/* webpackIgnore: true */ /* @vite-ignore */ 'node:os');
	} catch {
		return [];
	}
	const dirs = options.dirs ?? defaultFontDirs(path, os);
	const maxDepth = options.maxDepth ?? 4;
	const files: string[] = [];
	const seen = new Set<string>();
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: import('node:fs').Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (depth < maxDepth) {
					await walk(full, depth + 1);
				}
			} else if (FONT_FILE.test(e.name)) {
				const key = full.toLowerCase();
				if (!seen.has(key) && (!options.filter || options.filter(full, e.name.toLowerCase()))) {
					seen.add(key);
					files.push(full);
				}
			}
		}
	};
	for (const d of dirs) {
		await walk(d, 0);
	}
	const out: Uint8Array[] = [];
	for (const f of files) {
		try {
			out.push(new Uint8Array(await fs.readFile(f)));
		} catch {
			// Unreadable (locked or permission-denied) files are skipped.
		}
	}
	return out;
}

/** The platform's usual system and per-user font directories. */
function defaultFontDirs(path: PathModule, os: OsModule): string[] {
	const home = os.homedir();
	if (process.platform === 'win32') {
		const win = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
		const dirs = [path.join(win, 'Fonts')];
		if (process.env.LOCALAPPDATA) {
			dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
		}
		return dirs;
	}
	if (process.platform === 'darwin') {
		return ['/Library/Fonts', '/System/Library/Fonts', path.join(home, 'Library', 'Fonts')];
	}
	return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local', 'share', 'fonts')];
}
