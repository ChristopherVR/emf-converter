import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePath, renderEmfBytes, windowsFonts } from './__fixtures__/gdi-parity-harness';
import { decodePng } from './png-decoder';

/**
 * `text-escapement-playback` (TextEscapementPlaybackProbe.cs, 30 October 2026): 25 metafiles (Arial, Times New Roman,
 * Tahoma, Segoe UI and Courier New at 12, 16, 20, 28 and 36 px) of 400 single-glyph TextOutW records each, 50
 * escapements (41 + 73 n tenths of a degree) by the glyphs "aegpsR25", with Windows' own PlayEnhMetaFile of them as the
 * reference. One glyph per record leaves only the glyph shape: the recorded GM_COMPATIBLE exScale / eyScale turn into a
 * horizontal stretch of the text space (1.000558 here) that native playback applies before the escapement, so the
 * rotation matrix is `rotation * diag(k, 1)`. Without it 910 of the 10,000 glyph cells differed (1,490 pixels); with
 * it 72 do (406 pixels): 19 of the 25 sheets are within 3 pixels and the 12 px sheets keep one whole line each. The
 * lines left in the 12 px sheets (and at 9, 13 and 14 px in a wider sweep) sit where `ppem * major` of the rotation is
 * within 0.02 of a half pixel (11.515 at 106.3 degrees, 12 px), the whole-pixel size GDI hints a rotated glyph at: the
 * model rounds those up and native does not always.
 */
const sheets: Array<[string, number]> = [
	['arial', 12], ['arial', 16], ['arial', 20], ['arial', 28], ['arial', 36],
	['couriernew', 12], ['couriernew', 16], ['couriernew', 20], ['couriernew', 28], ['couriernew', 36],
	['segoeui', 12], ['segoeui', 16], ['segoeui', 20], ['segoeui', 28], ['segoeui', 36],
	['tahoma', 12], ['tahoma', 16], ['tahoma', 20], ['tahoma', 28], ['tahoma', 36],
	['timesnewroman', 12], ['timesnewroman', 16], ['timesnewroman', 20], ['timesnewroman', 28], ['timesnewroman', 36],
];
/** Differing pixels per sheet today (black-and-white ink against Windows' playback). */
const ceilings: Record<string, number> = {
	'arial-12': 73, 'arial-16': 0, 'arial-20': 0, 'arial-28': 2, 'arial-36': 2,
	'couriernew-12': 76, 'couriernew-16': 2, 'couriernew-20': 5, 'couriernew-28': 1, 'couriernew-36': 2,
	'segoeui-12': 51, 'segoeui-16': 1, 'segoeui-20': 1, 'segoeui-28': 3, 'segoeui-36': 0,
	'tahoma-12': 114, 'tahoma-16': 2, 'tahoma-20': 0, 'tahoma-28': 3, 'tahoma-36': 2,
	'timesnewroman-12': 57, 'timesnewroman-16': 3, 'timesnewroman-20': 1, 'timesnewroman-28': 2, 'timesnewroman-36': 3,
};

describe.skipIf(!windowsFonts())('native playback of rotated single glyphs', () => {
	const fonts = windowsFonts() ?? [];
	let total = 0;
	for (const [face, size] of sheets) {
		const key = `${face}-${size}`;
		it(`${key}: at most ${ceilings[key]} differing pixels`, async () => {
			const name = `text-escapement-playback/text-escpb-${key}`;
			const image = await renderEmfBytes(readFileSync(fixturePath(`${name}.emf`)), { fonts });
			const ref = await decodePng(readFileSync(fixturePath(`${name}.png`)));
			expect(image).not.toBeNull();
			let differing = 0;
			for (let y = 0; y < ref.height; y++) {
				for (let x = 0; x < ref.width; x++) {
					const ix = x - (image!.originX ?? 0);
					const iy = y - (image!.originY ?? 0);
					const ink = ix >= 0 && iy >= 0 && ix < image!.width && iy < image!.height && image!.data[(iy * image!.width + ix) * 4] < 128;
					if (ink !== ref.data[(y * ref.width + x) * 4] < 128) {
						differing++;
					}
				}
			}
			total += differing;
			expect(differing).toBeLessThanOrEqual(ceilings[key]);
		}, 60000);
	}
	it('the sheets differ in 406 pixels in all (1,490 without the playback stretch)', () => {
		expect(total).toBeLessThanOrEqual(406);
	});
});
