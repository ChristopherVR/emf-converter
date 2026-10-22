/**
 * Axis-aligned HighQuality `DrawImage(destRect, srcRect, unit, ImageAttributes)` under a WrapMode with a source
 * sub-rectangle against native impulse captures (`hq-wrap-crop.json.gz`; probe `HighQualityWrapCropProbe.cs`, mode
 * `hq-wrap-crop`). One white row or column of an opaque grey (0 or 128) bitmap per draw, Clamp colour opaque green,
 * seven geometries (whole bitmaps, inner crops, crops against an edge, 1x to 6.4x), both kernels and all five modes:
 * with a grey of 128 the red of the destination line is 128 + 127 x the weight of the texel, and the green adds 255 x
 * the weight on the clamp colour.
 *
 * Established: the kernel's fifth row (the tap past the vertical margin) does not wrap in the bitmap but in the
 * rectangle extended by the margin on each side and cut to the bitmap: for Tile it reads row `srcY - 2` of a rectangle
 * inside the bitmap (period `srcH + 4`), and a Clamp draw puts that tap's small negative weight on the clamp colour.
 * The x axis reads the bitmap and needs no margin.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';

interface Draw {
	kernel: number;
	wrap: number;
	geom: number;
	bg: number;
	axis: number;
	t: number;
	red: string;
	green: string;
}

const data = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-wrap-crop.json.gz', import.meta.url))).toString()) as { geoms: number[][]; draws: Draw[] };
const WRAPS = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy', 'clamp'] as const;

function mismatches(c: Draw): number {
	const [bw, bh, sx, sy, sw, sh, dw, dh] = data.geoms[c.geom];
	const rgba = new Uint8ClampedArray(bw * bh * 4);
	for (let y = 0; y < bh; y++) {
		for (let x = 0; x < bw; x++) {
			const v = (c.axis === 0 ? x : y) === c.t ? 255 : c.bg;
			const o = (y * bw + x) * 4;
			rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
			rgba[o + 3] = 255;
		}
	}
	const kx = dw / sw;
	const ky = dh / sh;
	const block = resampleImage(
		rgba,
		bw,
		bh,
		{ srcX: sx, srcY: sy, srcW: sw, srcH: sh, toDevice: [kx, 0, 0, ky, 8 - kx * sx, 8 - ky * sy], kernel: c.kernel === 7 ? 'hq-bicubic' : 'hq-bilinear', halfPixelOffset: false, wrap: WRAPS[c.wrap], clampArgb: 0xff00ff00 },
		{ w: 128, h: 128 },
	)!;
	const red = Buffer.from(c.red, 'base64');
	const green = Buffer.from(c.green, 'base64');
	let bad = 0;
	for (let i = 0; i < (c.axis === 0 ? dw : dh); i++) {
		const px = c.axis === 0 ? 8 + i : 8 + (dw >> 1);
		const py = c.axis === 0 ? 8 + (dh >> 1) : 8 + i;
		const o = ((py - block.y) * block.w + px - block.x) * 4;
		const a = block.rgba[o + 3];
		if (Math.round((block.rgba[o] * a) / 255) !== red[i] || Math.round((block.rgba[o + 1] * a) / 255) !== green[i]) {
			bad++;
		}
	}
	return bad;
}

describe('high-quality wrapped draws of a source sub-rectangle (native captures)', () => {
	it('reproduces every impulse line under every WrapMode and both kernels', () => {
		expect(data.draws.length).toBeGreaterThan(0);
		let bad = 0;
		for (const c of data.draws) {
			bad += mismatches(c);
		}
		expect(bad).toBe(0);
	});
});
