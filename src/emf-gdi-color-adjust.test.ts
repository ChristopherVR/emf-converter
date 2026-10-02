import { readFileSync } from 'node:fs';

import { describe, it, expect, vi } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
import { decodePng } from './png-decoder';
import {
	EMR_BITBLT,
	EMR_RESTOREDC,
	EMR_SAVEDC,
	EMR_SETCOLORADJUSTMENT,
	EMR_SETSTRETCHBLTMODE,
	EMR_STRETCHBLT,
} from './emf-constants';
import {
	CA_LOG_FILTER,
	CA_NEGATIVE,
	DEFAULT_COLOR_ADJUSTMENT,
	applyColorAdjustment,
	colorAdjustmentMapper,
	isIdentityColorAdjustment,
	readColorAdjustment,
} from './emf-gdi-color-adjust';
import { handleEmfGdiStateRecord } from './emf-gdi-state-handlers';
import { COLORONCOLOR } from './emf-gdi-stretch';
import { convertMetafileToDataUrl } from './index';
import type { EmfGdiReplayCtx, GdiColorAdjustment } from './emf-types';
import { defaultState } from './emf-types';

/** The COLORADJUSTMENT the `emfrec-coloradjustment` fixture records. */
const FIXTURE_CA: GdiColorAdjustment = {
	flags: CA_NEGATIVE,
	illuminant: 0,
	redGamma: 20000,
	greenGamma: 15000,
	blueGamma: 25000,
	referenceBlack: 0,
	referenceWhite: 10000,
	contrast: 40,
	brightness: -30,
	colorfulness: 50,
	redGreenTint: 20,
};

function caBytes(ca: GdiColorAdjustment): DataView {
	const view = new DataView(new ArrayBuffer(24));
	view.setUint16(0, 24, true);
	view.setUint16(2, ca.flags, true);
	view.setUint16(4, ca.illuminant, true);
	view.setUint16(6, ca.redGamma, true);
	view.setUint16(8, ca.greenGamma, true);
	view.setUint16(10, ca.blueGamma, true);
	view.setUint16(12, ca.referenceBlack, true);
	view.setUint16(14, ca.referenceWhite, true);
	view.setInt16(16, ca.contrast, true);
	view.setInt16(18, ca.brightness, true);
	view.setInt16(20, ca.colorfulness, true);
	view.setInt16(22, ca.redGreenTint, true);
	return view;
}

const adjust = (ca: Partial<GdiColorAdjustment>, rgb: number): number =>
	colorAdjustmentMapper({ ...DEFAULT_COLOR_ADJUSTMENT, ...ca })(rgb);

const channels = (rgb: number): number[] => [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];

describe('readColorAdjustment', () => {
	it('reads every COLORADJUSTMENT field', () => {
		expect(readColorAdjustment(caBytes(FIXTURE_CA), 0)).toEqual(FIXTURE_CA);
	});

	it('rejects the values SetColorAdjustment refuses', () => {
		const bad: Array<Partial<GdiColorAdjustment>> = [
			{ redGamma: 2499 },
			{ blueGamma: 65001 },
			{ referenceBlack: 4001 },
			{ referenceWhite: 5999 },
			{ contrast: 101 },
			{ brightness: -101 },
			{ colorfulness: 200 },
			{ redGreenTint: -128 },
			{ illuminant: 9 },
			{ flags: 4 },
		];
		for (const b of bad) {
			expect(readColorAdjustment(caBytes({ ...DEFAULT_COLOR_ADJUSTMENT, ...b }), 0)).toBeNull();
		}
	});
});

describe('colorAdjustmentMapper', () => {
	it('matches all 256 native log-filter levels on grey and each colour channel', async () => {
		const reference = (await decodePng(new Uint8Array(readFileSync(fixturePath('emfrec-ca-control-log-ramp.png')))))!;
		const map = colorAdjustmentMapper({ ...DEFAULT_COLOR_ADJUSTMENT, flags: CA_LOG_FILTER });
		for (const [y, mask] of [[8, 0x010101], [16, 0x010000], [24, 0x000100], [32, 0x000001]]) {
			for (let value = 0; value < 256; value++) {
				const offset = (y * reference.width + 5 + 2 * value) * 4;
				expect(channels(map(value * mask))).toEqual(Array.from(reference.data.subarray(offset, offset + 3)));
			}
		}
	});
	it('leaves every colour unchanged under the default adjustment', () => {
		expect(isIdentityColorAdjustment(DEFAULT_COLOR_ADJUSTMENT)).toBe(true);
		expect(isIdentityColorAdjustment({ ...DEFAULT_COLOR_ADJUSTMENT, illuminant: 6 })).toBe(true);
		expect(isIdentityColorAdjustment({ ...DEFAULT_COLOR_ADJUSTMENT, illuminant: 3 })).toBe(false);
		const map = colorAdjustmentMapper(DEFAULT_COLOR_ADJUSTMENT);
		for (const c of [0x000000, 0xffffff, 0xf0d010, 0x9020b0, 0x10c0c0, 0x123456, 0x7f7f7f]) {
			expect(map(c)).toBe(c);
		}
	});

	it('inverts under CA_NEGATIVE', () => {
		expect(adjust({ flags: CA_NEGATIVE }, 0x000000)).toBe(0xffffff);
		expect(adjust({ flags: CA_NEGATIVE }, 0x10c0f0)).toBe(0xef3f0f);
	});

	it('applies standalone channel gammas once, as in the native captures', () => {
		expect(adjust({ redGamma: 20000, greenGamma: 5000, blueGamma: 10000 }, 0x808080)).toBe(0x40b580);
		// With contrast they decide where the channel sits on the L* curve.
		const [r, g] = channels(adjust({ redGamma: 25000, contrast: 30 }, 0x808080));
		expect(r).toBeLessThan(g);
	});

	it('stretches the reference black and white to the full range', () => {
		const ca = { referenceBlack: 2000, referenceWhite: 8000 };
		expect(adjust(ca, 0x333333)).toBe(0x000000); // 0.2 -> black
		expect(adjust(ca, 0xcccccc)).toBe(0xffffff); // 0.8 -> white
		expect(adjust(ca, 0x808080)).toBe(0x808080);
	});

	it('scales every channel by exp(0.0148885 c) for contrast and adds 0.95625 b for brightness', () => {
		// Native palette captures: contrast 100 turns level 25 into 111 and 8 into 35,
		// contrast -100 maps 255 to 58; brightness +-50 shifts by 48 (+-100 by 96).
		expect(channels(adjust({ contrast: 100 }, 0x191919))).toEqual([111, 111, 111]);
		expect(channels(adjust({ contrast: 100 }, 0x080808))).toEqual([35, 35, 35]);
		expect(adjust({ contrast: 100 }, 0xc0c0c0)).toBe(0xffffff);
		expect(channels(adjust({ contrast: -100 }, 0xffffff))).toEqual([58, 58, 58]);
		expect(channels(adjust({ brightness: 50 }, 0x000000))).toEqual([48, 48, 48]);
		expect(channels(adjust({ brightness: -50 }, 0x3a3a3a))).toEqual([10, 10, 10]);
		expect(adjust({ brightness: 100 }, 0x000000)).toBe(0x606060);
		expect(adjust({ brightness: -100 }, 0xcccccc)).toBe(0x6c6c6c);
		expect(adjust({ brightness: -100 }, 0x202020)).toBe(0x000000);
	});

	it('adds brightness after contrast and negates last', () => {
		// Native cubes: contrast 40 then brightness 30; CA_NEGATIVE inverts the brightened colour.
		const lifted = channels(adjust({ contrast: 40, brightness: 30 }, 0x404040));
		expect(lifted[0]).toBe(Math.round(0x40 * Math.exp(0.0148885 * 40) + 0.95625 * 30));
		expect(channels(adjust({ flags: CA_NEGATIVE, brightness: 30 }, 0x404040))[0]).toBe(255 - Math.round(0x40 + 0.95625 * 30));
	});

	it('maps palette colours through the native illuminant cubes', () => {
		// Windows (IlluminantIndex 1, tungsten): pure primaries compress into the gamut instead of clipping.
		const tungsten = { illuminant: 1 };
		expect(channels(adjust(tungsten, 0x00ff00))).toEqual([0, 248, 159]);
		expect(channels(adjust(tungsten, 0xff0000))).toEqual([255, 5, 45]);
		expect(channels(adjust(tungsten, 0x0000ff))).toEqual([0, 21, 118]);
		expect(channels(adjust(tungsten, 0x848484))).toEqual([132, 132, 132]);
		expect(channels(adjust({ illuminant: 3 }, 0x00ff00))).toEqual([7, 251, 0]);
		// D65 (6) and the device default leave colours alone.
		expect(adjust({ illuminant: 6 }, 0x123456)).toBe(0x123456);
		expect(adjust({ illuminant: 0 }, 0x123456)).toBe(0x123456);
	});

	it('scales chroma by 1 + c / 100, turns it by -0.6 degrees per tint unit and compresses the gamut', () => {
		// Native: colorfulness -100 is the BT.709 grey (54, 182, 18 for the primaries).
		expect(adjust({ colorfulness: -100 }, 0xff0000)).toBe(0x363636);
		expect(adjust({ colorfulness: -100 }, 0x00ff00)).toBe(0xb6b6b6);
		expect(adjust({ colorfulness: -100 }, 0x0000ff)).toBe(0x121212);
		// Native: +50 on (123, 123, 255) gives (91, 91, 255): the blue is not clipped, the others fall.
		const [r, g, b] = channels(adjust({ colorfulness: 50 }, 0x7b7bff));
		expect(b).toBe(255);
		expect(Math.abs(r - 91)).toBeLessThanOrEqual(1);
		expect(g).toBe(r);
		// Native: tint 50 turns pure green into (162, 224, 0).
		const tinted = channels(adjust({ redGreenTint: 50 }, 0x00ff00));
		expect(Math.abs(tinted[0] - 162)).toBeLessThanOrEqual(1);
		expect(Math.abs(tinted[1] - 224)).toBeLessThanOrEqual(1);
		expect(tinted[2]).toBe(0);
		// Native: tint 100 turns pure blue into (0, 82, 111). The turned u' goes
		// negative here and is floored at 0 (the affine remap alone gives 0, 106, 128).
		const blue = channels(adjust({ redGreenTint: 100 }, 0x0000ff));
		expect(blue[0]).toBe(0);
		expect(Math.abs(blue[1] - 82)).toBeLessThanOrEqual(1);
		expect(Math.abs(blue[2] - 111)).toBeLessThanOrEqual(1);
	});

	it('feeds the unclamped illuminant output into the chroma stage', () => {
		// Native illuminant A (index 1) with tint 40, palette colours: the illuminant
		// cube is clamped, so chroma applied to the cube value would be far off.
		const cases: Array<[number, number]> = [
			[0xa55229, 0xde5084],
			[0x29ce63, 0x00c54a],
			[0xe6e652, 0xffdcbc],
		];
		for (const [input, expected] of cases) {
			const got = channels(adjust({ illuminant: 1, redGreenTint: 40 }, input));
			const want = channels(expected);
			for (let c = 0; c < 3; c++) {
				expect(Math.abs(got[c] - want[c])).toBeLessThanOrEqual(1);
			}
		}
	});

	it('reads palette levels unrounded and rounds the chroma result before the curves', () => {
		// Native colorfulness 25 cube entries (the chroma stage sees 255 n / 31, not the rounded entry).
		const cube: Array<[number, number]> = [
			[0x21e642, 0x02f22a],
			[0x3110ef, 0x2803ff],
			[0x3a4a94, 0x3449a9],
			[0x42843a, 0x37882d],
			[0x4ab5e6, 0x32baf9],
			[0x52ef8c, 0x37f87e],
		];
		for (const [input, native] of cube) {
			expect(adjust({ colorfulness: 25 }, input)).toBe(native);
		}
	});

	it('matches the Windows grey ramp of the halftone fixtures within three levels', () => {
		// emfrec-halftone-ramp-2x-ca: Windows' colour for each of the 32
		// quantisation levels of a grey ramp (gamma 1.5, reference black /
		// white 400 / 9600, contrast 30, brightness -20).
		const ca = { redGamma: 15000, greenGamma: 15000, blueGamma: 15000, referenceBlack: 400, referenceWhite: 9600, contrast: 30, brightness: -20, colorfulness: 40, redGreenTint: 20 };
		const windows = [0, 0, 0, 0, 0, 0, 0, 11, 21, 31, 43, 54, 68, 81, 95, 109, 125, 140, 155, 171, 189, 206, 223, 240, 255];
		windows.forEach((w, n) => {
			const v = Math.round((n * 255) / 31);
			const [r, g, b] = channels(adjust(ca, v * 0x010101));
			expect(r).toBe(g);
			expect(g).toBe(b);
			expect(Math.abs(r - w)).toBeLessThanOrEqual(3);
		});
	});

	it('scales the chromaticity for colorfulness, keeping luminance', () => {
		// -100: grey of the same luminance (BT.709 Y of red is 0.2126).
		expect(adjust({ colorfulness: -100 }, 0xff0000)).toBe(0x363636);
		const vivid = channels(adjust({ colorfulness: 50 }, 0xa06060));
		expect(vivid[0]).toBeGreaterThan(0xa0);
		expect(vivid[1]).toBeLessThan(0x60);
		// Grey has no colour to scale.
		expect(adjust({ colorfulness: 100 }, 0x606060)).toBe(0x606060);
		// A dark saturated blue comes out bright, as on Windows (0000a3 for this input level).
		expect(channels(adjust({ colorfulness: 40 }, 0x000021))[2]).toBeGreaterThan(0x40);
	});

	it('turns the hue for RedGreenTint, leaving grey alone', () => {
		const warm = channels(adjust({ redGreenTint: 50 }, 0x20a040));
		const cool = channels(adjust({ redGreenTint: -50 }, 0x20a040));
		// A positive tint moves green towards red (Windows: 00ff00 -> 25ff00 at tint 20).
		expect(warm[0]).toBeGreaterThan(cool[0]);
		expect(warm[2]).toBeLessThan(cool[2]);
		expect(adjust({ redGreenTint: 50 }, 0x808080)).toBe(0x808080);
	});

	it('lifts dark tones under CA_LOG_FILTER, keeping black and white', () => {
		expect(adjust({ flags: CA_LOG_FILTER }, 0x000000)).toBe(0x000000);
		expect(adjust({ flags: CA_LOG_FILTER }, 0xffffff)).toBe(0xffffff);
		expect(channels(adjust({ flags: CA_LOG_FILTER }, 0x202020))[0]).toBe(77); // native log-ramp level 32
	});

	it('approximates the Windows output of the emfrec-coloradjustment fixture', () => {
		// Windows' (dithered, averaged) results for the fixture's pure source
		// colours; the approximation is within 72 per channel (mostly far less).
		const windows: Array<[number, number]> = [
			[0xf0d010, 0x0022ff],
			[0x9020b0, 0x98ff00],
			[0x10c0c0, 0xff0042],
			[0xffffff, 0x000000],
			[0x000000, 0xffffff],
			[0xe03020, 0x00ffff],
			[0x20a040, 0xff23ff],
			[0x3050d0, 0xffaa00],
		];
		const map = colorAdjustmentMapper(FIXTURE_CA);
		for (const [src, win] of windows) {
			const ours = channels(map(src));
			channels(win).forEach((v, i) => expect(Math.abs(ours[i] - v)).toBeLessThanOrEqual(72));
		}
	});
});

describe('applyColorAdjustment', () => {
	it('maps every pixel and keeps alpha', () => {
		const px = { data: new Uint8ClampedArray([0, 0, 0, 10, 255, 255, 255, 20]) };
		applyColorAdjustment(px, { ...DEFAULT_COLOR_ADJUSTMENT, flags: CA_NEGATIVE });
		expect([...px.data]).toEqual([255, 255, 255, 10, 0, 0, 0, 20]);
	});

	it('does nothing without an adjustment or with the default one', () => {
		const px = { data: new Uint8ClampedArray([1, 2, 3, 4]) };
		applyColorAdjustment(px, undefined);
		applyColorAdjustment(px, DEFAULT_COLOR_ADJUSTMENT);
		expect([...px.data]).toEqual([1, 2, 3, 4]);
	});
});

describe('EMR_SETCOLORADJUSTMENT state', () => {
	function makeRCtx(): EmfGdiReplayCtx {
		return {
			ctx: { save: vi.fn<() => void>(), restore: vi.fn<() => void>() } as unknown as CanvasRenderingContext2D,
			view: new DataView(new ArrayBuffer(64)),
			objectTable: new Map(),
			state: defaultState(),
			stateStack: [],
			inPath: false,
			windowOrg: { x: 0, y: 0 },
			windowExt: { cx: 1000, cy: 1000 },
			viewportOrg: { x: 0, y: 0 },
			viewportExt: { cx: 1000, cy: 1000 },
			useMappingMode: false,
			clipSaveDepth: 0,
			bounds: { left: 0, top: 0, right: 1000, bottom: 1000 },
			canvasW: 500,
			canvasH: 500,
			sx: 1,
			sy: 1,
			pathCmds: [],
		};
	}

	function setAdjustment(rCtx: EmfGdiReplayCtx, ca: GdiColorAdjustment): void {
		new Uint8Array(rCtx.view.buffer).set(new Uint8Array(caBytes(ca).buffer), 8);
		expect(handleEmfGdiStateRecord(rCtx, EMR_SETCOLORADJUSTMENT, 0, 8, 32)).toBe(true);
	}

	it('keeps the adjustment in the DC state, saved and restored with SaveDC / RestoreDC', () => {
		const rCtx = makeRCtx();
		expect(rCtx.state.colorAdjustment).toBeUndefined();
		setAdjustment(rCtx, FIXTURE_CA);
		expect(rCtx.state.colorAdjustment).toEqual(FIXTURE_CA);
		handleEmfGdiStateRecord(rCtx, EMR_SAVEDC, 0, 8, 8);
		setAdjustment(rCtx, { ...DEFAULT_COLOR_ADJUSTMENT, flags: CA_LOG_FILTER });
		expect(rCtx.state.colorAdjustment?.flags).toBe(CA_LOG_FILTER);
		rCtx.view.setInt32(8, -1, true);
		handleEmfGdiStateRecord(rCtx, EMR_RESTOREDC, 0, 8, 12);
		expect(rCtx.state.colorAdjustment).toEqual(FIXTURE_CA);
	});

	it('keeps the previous adjustment when the record is out of range', () => {
		const rCtx = makeRCtx();
		setAdjustment(rCtx, FIXTURE_CA);
		setAdjustment(rCtx, { ...FIXTURE_CA, contrast: 500 });
		expect(rCtx.state.colorAdjustment).toEqual(FIXTURE_CA);
	});
});

/**
 * The `emfrec-coloradjustment` fixtures are the same HALFTONE StretchBlts
 * with and without an EMR_SETCOLORADJUSTMENT; patching their records shows
 * when the adjustment takes effect.
 */
describe('colour adjustment applies only to HALFTONE StretchBlt / StretchDIBits', () => {
	function patched(name: string, patch: (view: DataView, off: number, type: number) => void): ArrayBuffer {
		const bytes = readFileSync(fixturePath(`${name}.emf`));
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		const view = new DataView(buf);
		for (let off = 0; off + 8 <= view.byteLength; ) {
			const size = view.getUint32(off + 4, true);
			if (size < 8) {
				break;
			}
			patch(view, off, view.getUint32(off, true));
			off += size;
		}
		return buf;
	}

	const render = async (buf: ArrayBuffer): Promise<string | null> => convertMetafileToDataUrl(buf, { dpiScale: 1 });
	const both = async (patch: (view: DataView, off: number, type: number) => void): Promise<[string | null, string | null]> => [
		await render(patched('emfrec-coloradjustment', patch)),
		await render(patched('emfrec-coloradjustment-off', patch)),
	];

	it('changes a HALFTONE StretchBlt', async () => {
		const [on, off] = await both(() => {});
		expect(on).not.toBeNull();
		expect(on).not.toBe(off);
	});

	it('has no effect under another stretch mode', async () => {
		const [on, off] = await both((view, off, type) => {
			if (type === EMR_SETSTRETCHBLTMODE && view.getUint32(off + 8, true) === 4) {
				view.setUint32(off + 8, COLORONCOLOR, true);
			}
		});
		expect(on).not.toBeNull();
		expect(on).toBe(off);
	});

	it('has no effect on BitBlt, which never halftones', async () => {
		const [on, off] = await both((view, off, type) => {
			if (type === EMR_STRETCHBLT) {
				view.setUint32(off, EMR_BITBLT, true);
			}
		});
		expect(on).not.toBeNull();
		expect(on).toBe(off);
	});
});
