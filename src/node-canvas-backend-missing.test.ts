/**
 * Confirms that when `@napi-rs/canvas` genuinely cannot be imported (not
 * installed, or the native binary is missing for the current platform),
 * `convertMetafileToDataUrl` never throws in plain Node.js: it renders
 * through the built-in pure-JavaScript rasteriser when the drawing has no
 * text, and returns `null` when it has text (which needs a font engine).
 *
 * This mocks the dynamic `import('@napi-rs/canvas')` call inside
 * `ensureNodeCanvasModule` (in `emf-canvas-helpers.ts`) to reject, simulating
 * the package being absent. vitest gives each test file its own module
 * registry, so this mock does not leak into `node-canvas-backend.test.ts`,
 * which exercises the real package.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';

vi.mock('@napi-rs/canvas', () => {
	throw new Error('Cannot find module \'@napi-rs/canvas\' (simulated, not installed)');
});

function load(rel: string): ArrayBuffer {
	const bytes = readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('Node.js canvas backend (missing @napi-rs/canvas)', () => {
	it('renders a text-free metafile to PNG with the software rasteriser', async () => {
		const { convertMetafileToDataUrl } = await import('./index');
		const { isNodeCanvasBackendReady } = await import('./emf-canvas-helpers');
		const url = await convertMetafileToDataUrl(load('./__fixtures__/gdi/rop3-grid-solid.emf'));
		expect(url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
		expect(isNodeCanvasBackendReady()).toBe(false);
	});

	it('returns null without throwing for a metafile with text', async () => {
		const { convertMetafileToDataUrl } = await import('./index');
		await expect(convertMetafileToDataUrl(load('./__fixtures__/gdi/rotate-text-25deg.emf'))).resolves.toBeNull();
	});
});