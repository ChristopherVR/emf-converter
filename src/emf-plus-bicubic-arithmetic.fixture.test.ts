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
}
function load(name: string): Capture[] {
	return JSON.parse(gunzipSync(readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url))).toString());
}

function compare(c: Capture, independent: boolean, phases = false): [number, number, number] {
	const width = phases ? 12 : independent ? 11 : 8, height = phases ? 12 : independent ? 7 : 8, extent = phases ? 24 : independent ? 80 : 48;
	const source = Buffer.from(c.srcBgra, 'base64');
	const rgba = new Uint8ClampedArray(source.length);
	for (let p = 0; p < source.length; p += 4) {
		rgba[p] = source[p + 2]; rgba[p + 1] = source[p + 1]; rgba[p + 2] = source[p]; rgba[p + 3] = source[p + 3];
	}
	const block = resampleImage(rgba, width, height, {
		srcX: phases ? c.srcX! : independent ? 1 : 0, srcY: phases ? c.srcY! : independent ? 1 : 0,
		srcW: independent ? 9 : 8, srcH: independent ? 5 : 8,
		toDevice: phases ? [1, 0, 0, 1, 4 - c.srcX!, 4 - c.srcY!] : c.m ?? [c.sx!, 0, 0, c.sy!, 4 + c.origin!, 4 + c.origin!],
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

it('matches every captured native Bicubic kernel phase with bounded copy-path residuals', () => {
	const captures = load('bicubic-phases');
	expect(captures).toHaveLength(384);
	// Native unit-scale draws copy texels at near-integer source origins when
	// the other axis is integral. The finer eligibility boundary remains open.
	const residuals: Record<number, [number, number, number]> = {
		3: [61, 81, 2], 46: [62, 84, 2], 148: [58, 81, 2], 189: [62, 83, 2],
		195: [57, 67, 2], 238: [60, 72, 2], 340: [62, 72, 2], 381: [62, 73, 2],
	};
	for (const [i, capture] of captures.entries()) {
		const metrics = compare(capture, false, true), ceiling = residuals[i] ?? [0, 0, 0];
		for (let metric = 0; metric < 3; metric++) {
			expect(metrics[metric], `capture ${i}, metric ${metric}`).toBeLessThanOrEqual(ceiling[metric]);
		}
	}
});
