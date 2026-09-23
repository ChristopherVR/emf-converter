/**
 * Pixel parity against real Windows GDI / GDI+ output.
 *
 * Every fixture under `__fixtures__/gdi` pairs a metafile with a PNG of what
 * Windows itself painted for the same drawing calls (regenerate them with
 * `scripts/gdi-fixtures/generate.ps1` on Windows). Each case replays the
 * metafile at `dpiScale: 1` on the `@napi-rs/canvas` backend and bounds the
 * share of pixels whose largest channel differs by more than `tolerance`.
 */
import { describe, it, expect } from 'vitest';

import { compareFixture } from './__fixtures__/gdi-parity-harness';

interface ParityCase {
	name: string;
	ext: 'emf' | 'wmf';
	/** Largest per-channel difference that still counts as a match. */
	tolerance: number;
	/** Largest share of mismatching pixels allowed (0 = pixel-exact). */
	maxMismatch: number;
}

const exact = (name: string): ParityCase => ({ name, ext: 'emf', tolerance: 0, maxMismatch: 0 });

const ROP3_CASES: ParityCase[] = [
	// All 256 ROP3 functions over striped D and banded S, per brush kind.
	exact('rop3-grid-solid'),
	exact('rop3-grid-hatch'),
	exact('rop3-grid-pattern-mono'),
	exact('rop3-grid-pattern-color'),
	exact('rop3-patblt-hatch'),
	exact('rop3-hatch-styles'),
	// StretchBlt / StretchDIBits: mirrors, source sub-rects, brush origin, stretch modes.
	exact('rop3-stretchblt'),
	exact('rop3-stretchdibits'),
	exact('rop3-stretch-sampling'),
];

describe('GDI ground-truth parity', () => {
	describe('ROP3 raster operations', () => {
		it.each(ROP3_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
			const diff = await compareFixture(c.name, c.ext, c.tolerance);
			expect(diff).not.toBeNull();
			expect(diff!.mismatchRatio).toBeLessThanOrEqual(c.maxMismatch);
		});
	});
});
