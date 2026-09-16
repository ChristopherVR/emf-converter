/**
 * Confirms that when `@napi-rs/canvas` genuinely cannot be imported (not
 * installed, or the native binary is missing for the current platform),
 * `convertMetafileToDataUrl` degrades to `null` in plain Node.js instead of
 * throwing.
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

describe('Node.js canvas backend (missing @napi-rs/canvas)', () => {
	it('convertMetafileToDataUrl returns null without throwing when the Node backend fails to load', async () => {
		const { convertMetafileToDataUrl } = await import('./index');
		const { isNodeCanvasBackendReady } = await import('./emf-canvas-helpers');

		const path = fileURLToPath(new URL('./__fixtures__/sample-crown.wmf', import.meta.url));
		const bytes = readFileSync(path);
		const buffer = bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;

		await expect(convertMetafileToDataUrl(buffer)).resolves.toBeNull();
		expect(isNodeCanvasBackendReady()).toBe(false);
	});
});
