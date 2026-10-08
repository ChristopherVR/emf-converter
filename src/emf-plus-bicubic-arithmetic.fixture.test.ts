import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import type { TransformMatrix } from './emf-types';
import { compareFixture } from './__fixtures__/gdi-parity-harness';

interface Capture {
	pattern: number; mode?: number; sx?: number; sy?: number; origin?: number;
	m?: TransformMatrix; srcBgra: string; bgra: string;
	phase?: number; axis?: number; srcX?: number; srcY?: number;
	scale?: number; srcW?: number; srcH?: number; dx?: number; dy?: number;
}
function load(name: string): Capture[] {
	return JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());
}

function compare(c: Capture, independent: boolean, phases = false, copy = false): [number, number, number] {
	const width = copy ? 13 : phases ? 12 : independent ? 11 : 8, height = copy ? 11 : phases ? 12 : independent ? 7 : 8, extent = copy || phases ? 24 : independent ? 80 : 48;
	const source = Buffer.from(c.srcBgra, 'base64');
	const rgba = new Uint8ClampedArray(source.length);
	for (let p = 0; p < source.length; p += 4) {
		rgba[p] = source[p + 2]; rgba[p + 1] = source[p + 1]; rgba[p + 2] = source[p]; rgba[p + 3] = source[p + 3];
	}
	const block = resampleImage(rgba, width, height, {
		srcX: copy ? Math.fround(c.srcX!) : phases ? c.srcX! : independent ? 1 : 0, srcY: copy ? Math.fround(c.srcY!) : phases ? c.srcY! : independent ? 1 : 0,
		srcW: copy ? c.srcW! : independent ? 9 : 8, srcH: copy ? c.srcH! : independent ? 5 : 8,
		toDevice: copy ? [Math.fround(c.scale!), 0, 0, Math.fround(c.scale!), c.dx! - Math.fround(c.scale!) * Math.fround(c.srcX!), c.dy! - Math.fround(c.scale!) * Math.fround(c.srcY!)]
			: phases ? [1, 0, 0, 1, 4 - c.srcX!, 4 - c.srcY!] : c.m ?? [c.sx!, 0, 0, c.sy!, 4 + c.origin!, 4 + c.origin!],
		kernel: 'bicubic', halfPixelOffset: false,
	}, { w: extent, h: extent })!;
	const native = Buffer.from(c.bgra, 'base64');
	let count = 0, sum = 0, maximum = 0;
	for (let y = 0; y < extent; y++) for (let x = 0; x < extent; x++) {
		const inside = x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
		const offset = ((y - block.y) * block.w + x - block.x) * 4;
		let difference = 0;
		for (let channel = 0; channel < 4; channel++) {
			const actual = inside ? channel === 3 ? block.rgba[offset + 3]
				: Math.round(block.rgba[offset + channel] * block.rgba[offset + 3] / 255) : 0;
			difference = Math.max(difference, Math.abs(actual - native[(y * extent + x) * 4 + (channel === 3 ? 3 : 2 - channel)]));
		}
		if (difference) count++;
		sum += difference;
		maximum = Math.max(maximum, difference);
	}
	return [count, sum, maximum];
}

it('matches 144 native Bicubic arithmetic controls including premultiplied alpha', () => {
	const captures = load('bicubic-arithmetic');
	expect(captures).toHaveLength(144);
	for (const [i, capture] of captures.entries()) {
		const [count, sum, maximum] = compare(capture, false);
		expect(count, `capture ${i}`).toBe(0);
		expect(sum, `capture ${i}`).toBe(0);
		expect(maximum, `capture ${i}`).toBe(0);
	}
});

// Independent crop, scale, mirror, rotation and shear captures retain a
// per-case ceiling. Open geometry and transformed-kernel residuals cannot
// be hidden by the closed axis-aligned arithmetic cases.
const independentBounds: [number, number, number][] = [[0,0,0],[0,0,0],[6,7,2],[6,9,2],[32,663,255],[34,670,255],[34,157,8],[34,152,10],[0,0,0],[0,0,0],[12,16,2],[10,16,2],[68,809,255],[69,1038,255],[69,382,11],[70,388,16],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[95,271,7],[94,521,255],[99,618,255],[99,656,255],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[192,737,255],[196,1046,255],[197,676,255],[197,1179,255],[6,13,3],[0,0,0],[0,0,0],[0,0,0],[122,573,255],[122,553,255],[127,708,255],[126,714,255],[13,28,4],[0,0,0],[0,0,0],[13,31,6],[250,888,255],[247,1130,255],[251,991,255],[250,989,255],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[173,1204,255],[169,377,6],[176,827,255],[175,841,255],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[343,1306,255],[348,1583,255],[353,1513,255],[347,1500,255],[0,0,0],[0,0,0],[5,5,1],[6,6,1],[32,371,180],[34,341,213],[33,110,9],[34,124,8],[0,0,0],[0,0,0],[10,10,1],[13,13,1],[68,479,168],[68,445,112],[69,320,9],[71,317,13],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[94,219,6],[93,329,112],[99,334,9],[99,441,104],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[191,453,9],[195,697,124],[194,560,189],[195,567,113],[6,17,4],[0,0,0],[0,0,0],[0,0,0],[122,298,25],[122,467,189],[127,493,110],[128,437,35],[13,35,5],[0,0,0],[0,0,0],[13,30,4],[248,578,30],[246,851,192],[249,751,189],[252,604,100],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[171,642,110],[169,344,5],[175,728,228],[176,609,105],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[344,921,132],[346,1123,240],[347,1012,162],[347,1102,227]];

it('preserves all 128 independent Bicubic scale and transform captures', () => {
	const captures = load('bicubic-independent');
	expect(captures).toHaveLength(128);
	expect(independentBounds).toHaveLength(captures.length);
	for (const [i, capture] of captures.entries()) {
		const values = compare(capture, true);
		for (let metric = 0; metric < 3; metric++) {
			expect(values[metric], `capture ${i}, metric ${metric}`).toBeLessThanOrEqual(independentBounds[i][metric]);
		}
	}
});

it('keeps Bicubic PNG playback pixel-exact to native pixels', async () => {
 const png = await compareFixture('gpx-image-bicubic', 'emf', 0, 0);
 expect(png!.mismatched).toBe(0);
 expect(png!.maxDiff).toBe(0);
});

it('matches all 384 native Bicubic kernel phases, the positive copy boundary included', () => {
	const captures = load('bicubic-phases');
	expect(captures).toHaveLength(384);
	// A source phase of +1/64 copies for these 8 x 8 rectangles (the four captures that were residuals before
	// round 5); negative phases and the interior copy interval were exact already.
	for (const [i, capture] of captures.entries()) {
		const metrics = compare(capture, false, true);
		for (let metric = 0; metric < 3; metric++) {
			expect(metrics[metric], `capture ${i}, metric ${metric}`).toBe(0);
		}
	}
});

it('matches all 936 independent Bicubic copy captures, the boundary residuals included', () => {
	const captures = load('bicubic-copy');
	expect(captures).toHaveLength(936);
	// Independent noise and alpha, unequal cropped dimensions, integral and
	// fractional destination origins, both source axes, and scales 1 +/- 1/1024.
	// Offsets straddle the 1/64 boundary by 1/16384. All controls are exact (six were boundary residuals before round 5).
	for (const [i, capture] of captures.entries()) {
		const metrics = compare(capture, false, false, true);
		for (let metric = 0; metric < 3; metric++) {
			expect(metrics[metric], `copy capture ${i}, metric ${metric}`).toBe(0);
		}
	}
});

interface BoundaryDraw {
	axis: number; destFrac: number; w: number; h: number; k: number; k2: number;
	srcX: number; srcY: number; destX: number; destY: number; bgra: string;
}

function boundaryModel(src: Uint8ClampedArray, dim: number, srcDim: number, d: { w: number; h: number; srcX: number; srcY: number; destX: number; destY: number }): Uint8ClampedArray {
	const block = resampleImage(src, srcDim, srcDim, {
		srcX: d.srcX, srcY: d.srcY, srcW: d.w, srcH: d.h,
		toDevice: [1, 0, 0, 1, d.destX - d.srcX, d.destY - d.srcY], kernel: 'bicubic', halfPixelOffset: false,
	}, { w: dim, h: dim });
	const out = new Uint8ClampedArray(dim * dim * 4);
	if (block) {
		for (let y = 0; y < block.h; y++) {
			for (let x = 0; x < block.w; x++) {
				const o = (y * block.w + x) * 4;
				const t = ((y + block.y) * dim + x + block.x) * 4;
				out[t + 3] = block.rgba[o + 3];
				for (let ch = 0; ch < 3; ch++) out[t + ch] = Math.round(block.rgba[o + 2 - ch] * block.rgba[o + 3] / 255);
			}
		}
	}
	return out;
}

it('puts the positive source-phase boundary of the unit-scale copy on power-of-two rectangles (native sweep)', () => {
	// `bicubic-boundary` (probe `BicubicBoundaryProbe.cs`): the source offset swept in 1/4096 steps through
	// +-1/64 for 12 x 12 noise, every rectangle from 1 x 1 to 10 x 10 at a whole destination offset, 8 x 8 and 5 x 7
	// at six fractional ones, and the two offsets swept independently for six sizes.
	const capture = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/bicubic-boundary.json.gz', import.meta.url))).toString()) as {
		src: string; draws: BoundaryDraw[]; sizes: { w: number; h: number; destX: number; destY: number; k: number; k2: number; same: number }[];
	};
	const source = Buffer.from(capture.src, 'base64');
	const rgba = new Uint8ClampedArray(source.length);
	for (let p = 0; p < source.length; p += 4) {
		rgba[p] = source[p + 2]; rgba[p + 1] = source[p + 1]; rgba[p + 2] = source[p]; rgba[p + 3] = source[p + 3];
	}
	expect(capture.draws).toHaveLength(11058);
	const off: Record<string, number> = {};
	for (const d of capture.draws) {
		const model = boundaryModel(rgba, 24, 12, d);
		const native = Buffer.from(d.bgra, 'base64');
		let bad = false;
		for (let y = 0; y < 10 && !bad; y++) {
			for (let x = 0; x < 10 && !bad; x++) {
				for (let ch = 0; ch < 4; ch++) {
					const m = model[((y + 3) * 24 + x + 3) * 4 + ch];
					if (m !== native[(y * 10 + x) * 4 + ch]) bad = true;
				}
			}
		}
		if (bad) {
			const key = `${d.axis === 3 ? 'independent' : d.destFrac ? 'fractional destination' : 'whole destination'} ${d.w}x${d.h}`;
			off[key] = (off[key] ?? 0) + 1;
		}
	}
	// Exact in every sweep draw: whole and fractional destination offsets, both axes, 1 x 1 to 10 x 10 and the six
	// independent-offset sizes.
	expect(off).toEqual({});

	// The size sweep on a 48 x 48 bitmap (3,456 draws per destination offset): whether the draw at offset
	// (63..65, y) equals the draw at offset 0, native against the model.
	const bigBgra = Buffer.from((capture as unknown as { big: string }).big, 'base64');
	const bigRgba = new Uint8ClampedArray(bigBgra.length);
	for (let p = 0; p < bigBgra.length; p += 4) {
		bigRgba[p] = bigBgra[p + 2]; bigRgba[p + 1] = bigBgra[p + 1]; bigRgba[p + 2] = bigBgra[p]; bigRgba[p + 3] = bigBgra[p + 3];
	}
	const image = (w: number, h: number, destX: number, destY: number, kx: number, ky: number): string =>
		Buffer.from(boundaryModel(bigRgba, 64, 48, { w, h, srcX: 2 + kx / 4096, srcY: 2 + ky / 4096, destX, destY })).toString('base64');
	const references = new Map<string, string>();
	let disagreements = 0;
	let copies = 0;
	for (const s of capture.sizes) {
		const key = `${s.w},${s.h},${s.destX},${s.destY}`;
		const reference = references.get(key) ?? references.set(key, image(s.w, s.h, s.destX, s.destY, 0, 0)).get(key)!;
		const same = image(s.w, s.h, s.destX, s.destY, s.k, s.k2) === reference ? 1 : 0;
		if (same !== s.same) disagreements++;
		copies += s.same;
	}
	expect(capture.sizes).toHaveLength(10368);
	expect(copies).toBe(4016);
	expect(disagreements).toBe(0);
});
