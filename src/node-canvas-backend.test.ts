/**
 * Real (non-mocked) integration coverage for the optional Node.js canvas
 * backend (`@napi-rs/canvas`).
 *
 * vitest's default environment for this project is plain Node (no jsdom, no
 * `OffscreenCanvas`, no `document`), see `vitest.config.ts`. Every other
 * conversion test either mocks the canvas layer entirely (`emf-converter.test.ts`)
 * or exercises pure record-replay logic against a mock 2D context
 * (`emf-replay.fixture.test.ts`, `wmf-replay.fixture.test.ts`). This file is
 * the one place that runs `convertMetafileToDataUrl` end-to-end against real
 * fixture bytes and lets it actually create a canvas, so it is the only test
 * that exercises `@napi-rs/canvas` (installed here as a devDependency) for
 * real: `createCanvas`, `loadImage`, and `toDataURLAsync`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { isNodeCanvasBackendReady } from './emf-canvas-helpers';
import { convertMetafileToDataUrl } from './index';

/** Load a binary fixture as an ArrayBuffer, copied out of the Buffer's pool. */
function loadFixtureArrayBuffer(name: string): ArrayBuffer {
	const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
	const bytes = readFileSync(path);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('Node.js canvas backend (@napi-rs/canvas)', () => {
	it('converts a real WMF fixture to a PNG data URL in plain Node.js', async () => {
		const buffer = loadFixtureArrayBuffer('sample-crown.wmf');
		const result = await convertMetafileToDataUrl(buffer);
		expect(result).not.toBeNull();
		expect(result).toMatch(/^data:image\/png;base64,/);
		// A real, non-trivial multi-colour fixture should encode to more than a
		// few bytes of PNG payload.
		expect(result!.length).toBeGreaterThan(100);
	});

	it('converts a real EMF fixture to a PNG data URL in plain Node.js', async () => {
		const buffer = loadFixtureArrayBuffer('sample-clip-gdi.emf');
		const result = await convertMetafileToDataUrl(buffer);
		expect(result).not.toBeNull();
		expect(result).toMatch(/^data:image\/png;base64,/);
	});

	it('reports the Node canvas backend as ready after a successful conversion', async () => {
		const buffer = loadFixtureArrayBuffer('sample-crown.wmf');
		await convertMetafileToDataUrl(buffer);
		// No OffscreenCanvas/document exist in this plain-Node test environment,
		// so a successful conversion is only possible via the @napi-rs/canvas
		// backend, and it should now be cached as ready.
		expect(isNodeCanvasBackendReady()).toBe(true);
	});
});
