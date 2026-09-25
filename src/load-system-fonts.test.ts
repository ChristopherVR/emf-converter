/**
 * Tests for `loadSystemFonts()`: directory scanning, file-type and custom
 * filtering, and that what it returns feeds the font engine.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildTestFnt, buildTestFon } from './__fixtures__/test-fnt';
import { buildTestFont } from './__fixtures__/test-font';
import { GdiFontCollection } from './gdi-font-engine';
import { loadSystemFonts } from './index';

describe('loadSystemFonts', () => {
	const root = mkdtempSync(join(tmpdir(), 'emf-fonts-'));
	mkdirSync(join(root, 'sub', 'deeper'), { recursive: true });
	writeFileSync(join(root, 'test.ttf'), buildTestFont());
	writeFileSync(join(root, 'sub', 'raster.FON'), buildTestFon([buildTestFnt({ pixHeight: 13, ascent: 11, internalLeading: 2, width: 5 })]));
	writeFileSync(join(root, 'sub', 'deeper', 'bare.fnt'), buildTestFnt({ pixHeight: 16, ascent: 13, internalLeading: 3, width: 7 }));
	writeFileSync(join(root, 'readme.txt'), 'not a font');
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('reads the font files under the given directories, recursively', async () => {
		const fonts = await loadSystemFonts({ dirs: [root, join(root, 'missing')] });
		expect(fonts).toHaveLength(3);
		const collection = new GdiFontCollection(fonts);
		const spec = { height: -11, width: 0, weight: 400, italic: false, charSet: 1, pitchAndFamily: 0, quality: 3 };
		expect(collection.realize({ ...spec, face: 'Test Sans' })).not.toBeNull();
		expect(collection.realize({ ...spec, face: 'Test Raster' })).not.toBeNull();
	});

	it('honours filter and maxDepth', async () => {
		expect(await loadSystemFonts({ dirs: [root], filter: (_p, n) => n.endsWith('.fon') })).toHaveLength(1);
		expect(await loadSystemFonts({ dirs: [root], maxDepth: 0 })).toHaveLength(1);
		expect(await loadSystemFonts({ dirs: [root], maxDepth: 1 })).toHaveLength(2);
	});
});
