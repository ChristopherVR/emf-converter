/**
 * High-quality DrawImagePoints with an ImageAttributes WrapMode against native draws (`hq-wrap.json.gz`; probe
 * `HighQualityWrapProbe.cs`, mode `hq-wrap`): a 12 x 12 noise image (opaque and alpha) drawn rotated 25 and 45 degrees,
 * sheared and axis-aligned, at 1.55x, 2.25x, 0.625x and 2.35 x 1.55, without attributes and under Clamp (transparent
 * and opaque red), Tile, TileFlipX, TileFlipY and TileFlipXY.
 *
 * - Clamp to a transparent colour is no WrapMode: every native draw equals the draw without attributes, pixel for pixel.
 * - Under the other modes the draw changes only in a ring about two pixels wide along the quad's edge, where the
 *   kernel overhang reads the wrapped (or clamp-coloured) texels instead of fading out.
 * - An axis-aligned draw takes those wrapped texels through the same weights: exact at 2.25x in every mode.
 * - A rotated draw is the two-stage draw with the wrap applied to the source in the pre-scale and to the intermediate in
 *   the plain-kernel pass; its ring is still off (hundreds of pixels by more than 3 levels over 4 draws, up to the full
 *   range at the far edges), which is open.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';

interface Capture {
	kernel: number;
	wrap: number;
	deg: number;
	sx: number;
	sy: number;
	shear: number;
	pattern: number;
	p: number[];
	srcBgra: string;
	bgra: string;
}

const captures = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/hq-wrap.json.gz', import.meta.url))).toString()) as Capture[];
const N = 12;
const E = 96;
const WRAPS = [undefined, 'clamp', 'clamp', 'tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy'] as const;
const WRAP_NAMES = ['none', 'clamp transparent', 'clamp red', 'tile', 'flip x', 'flip y', 'flip xy'];

/** Pixels whose colour or alpha differ from the native draw by more than `threshold`, and the largest difference. */
function compare(c: Capture, threshold: number): { px: number; max: number } {
	const s = Buffer.from(c.srcBgra, 'base64');
	const rgba = new Uint8ClampedArray(s.length);
	for (let p = 0; p < s.length; p += 4) {
		rgba[p] = s[p + 2];
		rgba[p + 1] = s[p + 1];
		rgba[p + 2] = s[p];
		rgba[p + 3] = s[p + 3];
	}
	const [x0, y0, x1, y1, x2, y2] = c.p;
	const block = resampleImage(
		rgba,
		N,
		N,
		{
			srcX: 0,
			srcY: 0,
			srcW: N,
			srcH: N,
			toDevice: [(x1 - x0) / N, (y1 - y0) / N, (x2 - x0) / N, (y2 - y0) / N, x0, y0],
			kernel: c.kernel === 7 ? 'hq-bicubic' : 'hq-bilinear',
			halfPixelOffset: false,
			wrap: WRAPS[c.wrap],
			clampArgb: c.wrap === 2 ? 0xffff0000 : 0,
		},
		{ w: E, h: E },
	);
	const native = Buffer.from(c.bgra, 'base64');
	let px = 0;
	let max = 0;
	for (let y = 0; y < E; y++) {
		for (let x = 0; x < E; x++) {
			const inside = !!block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
			const o = inside ? ((y - block.y) * block.w + x - block.x) * 4 : 0;
			let d = 0;
			for (let ch = 0; ch < 4; ch++) {
				const alpha = inside ? block.rgba[o + 3] : 0;
				const mine = inside ? (ch === 3 ? alpha : Math.round((block.rgba[o + ch] * alpha) / 255)) : 0;
				d = Math.max(d, Math.abs(mine - native[(y * E + x) * 4 + (ch === 3 ? 3 : 2 - ch)]));
			}
			if (d > threshold) {
				px++;
				max = Math.max(max, d);
			}
		}
	}
	return { px, max };
}

const shapeOf = (c: Capture): string => `${c.deg} deg ${c.sx}x${c.sy}${c.shear ? ' sheared' : ''}`;

describe('high-quality draws under an ImageAttributes WrapMode (native captures)', () => {
	it('draws Clamp to a transparent colour exactly as no attributes', () => {
		expect(captures).toHaveLength(2 * 2 * 7 * 7);
		const key = (c: Capture): string => `${c.kernel}|${shapeOf(c)}|${c.pattern}`;
		const none = new Map(captures.filter((c) => c.wrap === 0).map((c) => [key(c), c.bgra]));
		const clamp = captures.filter((c) => c.wrap === 1);
		expect(clamp).toHaveLength(28);
		for (const c of clamp) {
			expect(c.bgra === none.get(key(c)), key(c)).toBe(true);
		}
	});

	it('differs from the unwrapped native draw only along the edge ring under Tile and the flips', () => {
		let ring = 0;
		for (const c of captures.filter((q) => q.wrap >= 2)) {
			const base = captures.find((q) => q.wrap === 0 && q.kernel === c.kernel && q.pattern === c.pattern && shapeOf(q) === shapeOf(c))!;
			const a = Buffer.from(c.bgra, 'base64');
			const b = Buffer.from(base.bgra, 'base64');
			for (let i = 0; i < E * E; i++) {
				let differs = false;
				for (let ch = 0; ch < 4; ch++) differs ||= a[i * 4 + ch] !== b[i * 4 + ch];
				if (differs) ring++;
			}
		}
		expect(ring).toBe(24523);
	});

	it('snaps only the first destination corner of a rotated draw to 1/16 pixel', () => {
		// The unwrapped rotated and sheared draws (16): the converter snaps the first corner and leaves the other two,
		// which moves the edge vectors; snapping all three corners to 1/16 puts more pixels off.
		const rotated = captures.filter((c) => c.wrap === 0 && (c.deg !== 0 || c.shear !== 0));
		expect(rotated).toHaveLength(16);
		const count = (round: (v: number) => number): number => rotated.reduce((n, c) => n + compare({ ...c, p: c.p.map(round) }, 1).px, 0);
		const asRecorded = count((v) => v);
		const allThree = count((v) => Math.round(v * 16) / 16);
		expect([asRecorded, allThree]).toEqual([704, 1141]);
	});

	it('pins the converter against every capture (pixels more than 3 levels off, per wrap mode and shape)', () => {
		const tally: Record<string, number> = {};
		for (const c of captures) {
			const { px } = compare(c, 3);
			const k = `${WRAP_NAMES[c.wrap]} / ${shapeOf(c)}`;
			tally[k] = (tally[k] ?? 0) + px;
		}
		// The unwrapped rotated and sheared draws carry their own residue (the pre-scale and plain-kernel arithmetic is not
		// exact for every shape); the wrapped ones add the unmodelled far-edge ring on top.
		expect(tally).toEqual({
			'none / 25 deg 1.55x1.55': 4,
			'clamp transparent / 25 deg 1.55x1.55': 4,
			'clamp red / 25 deg 1.55x1.55': 252,
			'tile / 25 deg 1.55x1.55': 230,
			'flip x / 25 deg 1.55x1.55': 230,
			'flip y / 25 deg 1.55x1.55': 230,
			'flip xy / 25 deg 1.55x1.55': 232,
			'none / 45 deg 1.55x1.55': 4,
			'clamp transparent / 45 deg 1.55x1.55': 4,
			'clamp red / 45 deg 1.55x1.55': 326,
			'tile / 45 deg 1.55x1.55': 298,
			'flip x / 45 deg 1.55x1.55': 294,
			'flip y / 45 deg 1.55x1.55': 300,
			'flip xy / 45 deg 1.55x1.55': 296,
			'none / 0 deg 1.55x1.55': 0,
			'clamp transparent / 0 deg 1.55x1.55': 0,
			'clamp red / 0 deg 1.55x1.55': 0,
			'tile / 0 deg 1.55x1.55': 0,
			'flip x / 0 deg 1.55x1.55': 0,
			'flip y / 0 deg 1.55x1.55': 0,
			'flip xy / 0 deg 1.55x1.55': 0,
			'none / 0 deg 2.25x2.25': 0,
			'clamp transparent / 0 deg 2.25x2.25': 0,
			'clamp red / 0 deg 2.25x2.25': 0,
			'tile / 0 deg 2.25x2.25': 0,
			'flip x / 0 deg 2.25x2.25': 0,
			'flip y / 0 deg 2.25x2.25': 0,
			'flip xy / 0 deg 2.25x2.25': 0,
			'none / 0 deg 0.625x0.625': 0,
			'clamp transparent / 0 deg 0.625x0.625': 0,
			'clamp red / 0 deg 0.625x0.625': 0,
			'tile / 0 deg 0.625x0.625': 0,
			'flip x / 0 deg 0.625x0.625': 0,
			'flip y / 0 deg 0.625x0.625': 0,
			'flip xy / 0 deg 0.625x0.625': 0,
			'none / 25 deg 2.35x1.55': 8,
			'clamp transparent / 25 deg 2.35x1.55': 8,
			'clamp red / 25 deg 2.35x1.55': 313,
			'tile / 25 deg 2.35x1.55': 290,
			'flip x / 25 deg 2.35x1.55': 286,
			'flip y / 25 deg 2.35x1.55': 294,
			'flip xy / 25 deg 2.35x1.55': 288,
			'none / 0 deg 1.55x1.55 sheared': 15,
			'clamp transparent / 0 deg 1.55x1.55 sheared': 15,
			'clamp red / 0 deg 1.55x1.55 sheared': 257,
			'tile / 0 deg 1.55x1.55 sheared': 247,
			'flip x / 0 deg 1.55x1.55 sheared': 245,
			'flip y / 0 deg 1.55x1.55 sheared': 247,
			'flip xy / 0 deg 1.55x1.55 sheared': 246,
		});
	});
});
