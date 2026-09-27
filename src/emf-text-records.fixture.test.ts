import { describe, expect, it } from 'vitest';
import { compareFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';

describe.skipIf(!windowsFonts())('EMF text record playback against Windows', () => {
	// ANSI/small-text residuals are isolated glyph-edge pixels. PolyTextOut
	// additionally differs on a C1 control glyph in Windows' metafile playback.
	// Justification is exact.
	// Keep pixel counts tight so missing text or changed placement cannot pass.
	it.each([
		['emfrec-text-exttextouta', 8],
		['emfrec-text-polytextout', 39],
		['emfrec-text-smalltextout', 2],
		['emfrec-text-justification', 0],
	] as const)('%s', async (name, maxPixels) => {
		const diff = await compareFixture(name, 'emf', 0, { fonts: windowsFonts()! });
		expect(diff).not.toBeNull();
		expect(diff!.mismatched, JSON.stringify(diff)).toBeLessThanOrEqual(maxPixels);
	});
});
