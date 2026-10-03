import { describe, expect, it } from 'vitest';
import { compareFixture, windowsFonts } from './__fixtures__/gdi-parity-harness';

describe.skipIf(!windowsFonts())('EMF text record playback against Windows', () => {
	// Residuals are isolated glyph-edge pixels, including C1 .notdef glyphs.
	// Justification is exact.
	// Keep pixel counts tight so missing text or changed placement cannot pass.
	it.each([
		['emfrec-text-exttextouta', 8],
		['emfrec-text-polytextout', 12],
		['emfrec-text-smalltextout', 2],
		['emfrec-text-justification', 0],
	] as const)('%s', async (name, maxPixels) => {
		const diff = await compareFixture(name, 'emf', 0, { fonts: windowsFonts()! });
		expect(diff).not.toBeNull();
		expect(diff!.mismatched, JSON.stringify(diff)).toBeLessThanOrEqual(maxPixels);
	});

	it.each(['ext', 'poly'])('%s C1 playback preserves the record family and language flag', async (record) => {
		for (const flag of ['', '-ignore']) {
			for (const [face, maxPixels] of [['arial', 3], ['courier', 0]] as const) {
				const name = `emfrec-text-c1-${record}${flag}-${face}`;
				const diff = await compareFixture(name, 'emf', 0, { fonts: windowsFonts()! });
				expect(diff).not.toBeNull();
				expect(diff!.mismatched, `${name}: ${JSON.stringify(diff)}`).toBeLessThanOrEqual(maxPixels);
			}
		}
	});
});
