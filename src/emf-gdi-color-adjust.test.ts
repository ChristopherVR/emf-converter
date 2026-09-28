import { readFileSync } from 'node:fs';

import { describe, it, expect, vi } from 'vitest';

import { fixturePath } from './__fixtures__/gdi-parity-harness';
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
	it('leaves every colour unchanged under the default adjustment', () => {
		expect(isIdentityColorAdjustment(DEFAULT_COLOR_ADJUSTMENT)).toBe(true);
		expect(isIdentityColorAdjustment({ ...DEFAULT_COLOR_ADJUSTMENT, illuminant: 3 })).toBe(true);
		const map = colorAdjustmentMapper(DEFAULT_COLOR_ADJUSTMENT);
		for (const c of [0x000000, 0xffffff, 0xf0d010, 0x9020b0, 0x10c0c0, 0x123456, 0x7f7f7f]) {
			expect(map(c)).toBe(c);
		}
	});

	it('inverts under CA_NEGATIVE', () => {
		expect(adjust({ flags: CA_NEGATIVE }, 0x000000)).toBe(0xffffff);
		expect(adjust({ flags: CA_NEGATIVE }, 0x10c0f0)).toBe(0xef3f0f);
	});

	it('raises each channel to its own gamma', () => {
		const [r, g, b] = channels(adjust({ redGamma: 20000, greenGamma: 5000, blueGamma: 10000 }, 0x808080));
		expect(r).toBe(Math.round(255 * (128 / 255) ** 2));
		expect(g).toBe(Math.round(255 * (128 / 255) ** 0.5));
		expect(b).toBe(128);
	});

	it('stretches the reference black and white to the full range', () => {
		const ca = { referenceBlack: 2000, referenceWhite: 8000 };
		expect(adjust(ca, 0x333333)).toBe(0x000000); // 0.2 -> black
		expect(adjust(ca, 0xcccccc)).toBe(0xffffff); // 0.8 -> white
		expect(adjust(ca, 0x808080)).toBe(0x808080);
	});

	it('scales grey about mid-grey for contrast and shifts it for brightness', () => {
		expect(adjust({ contrast: 100 }, 0xc0c0c0)).toBe(0xffffff);
		expect(adjust({ contrast: -100 }, 0x303030)).toBe(0x808080);
		expect(adjust({ brightness: 50 }, 0x404040)).toBe(0xa6a6a6); // + 0.4
		expect(adjust({ brightness: -100 }, 0xcccccc)).toBe(0x000000);
	});

	it('scales the colour differences for colorfulness, keeping luma', () => {
		const grey = adjust({ colorfulness: -100 }, 0xff0000);
		const [r, g, b] = channels(grey);
		expect(r).toBe(g);
		expect(g).toBe(b);
		expect(r).toBe(Math.round(0.299 * 255));
		const vivid = channels(adjust({ colorfulness: 50 }, 0xa06060));
		expect(vivid[0]).toBeGreaterThan(0xa0);
		expect(vivid[1]).toBeLessThan(0x60);
		// Grey has no colour to scale.
		expect(adjust({ colorfulness: 100 }, 0x606060)).toBe(0x606060);
	});

	it('tints towards red for a positive RedGreenTint and towards green for a negative one', () => {
		const red = channels(adjust({ redGreenTint: 50 }, 0x808080));
		const green = channels(adjust({ redGreenTint: -50 }, 0x808080));
		expect(red[0]).toBeGreaterThan(0x80);
		expect(red[1]).toBeLessThan(0x80);
		expect(green[0]).toBeLessThan(0x80);
		expect(green[1]).toBeGreaterThan(0x80);
	});

	it('lifts dark tones under CA_LOG_FILTER, keeping black and white', () => {
		expect(adjust({ flags: CA_LOG_FILTER }, 0x000000)).toBe(0x000000);
		expect(adjust({ flags: CA_LOG_FILTER }, 0xffffff)).toBe(0xffffff);
		expect(channels(adjust({ flags: CA_LOG_FILTER }, 0x202020))[0]).toBe(Math.round(255 * Math.log10(1 + (9 * 32) / 255)));
	});

	it('approximates the Windows output of the emfrec-coloradjustment fixture', () => {
		// Windows' (dithered, averaged) results for the fixture's pure source
		// colours; the approximation is within 68 per channel (mostly far less).
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
