/** Native DrawImage captures; regenerate with scripts/gdi-fixtures/capture-bilinear.ps1. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';
import type { TransformMatrix } from './emf-types';

interface Capture {
	pattern: number;
	sx: number;
	sy: number;
	origin: number;
	mode: number;
	m: TransformMatrix;
	srcBgra: string;
	bgra: string;
	scale: number;
	clamp: boolean;
	over: boolean;
	background: string;
}

const load = (name: string): Capture[] => JSON.parse(gunzipSync(
	readFileSync(new URL(`./__fixtures__/gdi/${name}.json.gz`, import.meta.url)),
).toString());

function rgba(base64: string): Uint8ClampedArray {
	const bgra = Buffer.from(base64, 'base64');
	const pixels = new Uint8ClampedArray(bgra.length);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels.set([bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]], i);
	}
	return pixels;
}

function diff(block: ReturnType<typeof resampleImage>, native: string, size: number): { pixels: number; maximum: number } {
	const reference = Buffer.from(native, 'base64');
	let pixels = 0;
	let maximum = 0;
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const inside = !!block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
		const offset = inside ? ((y - block!.y) * block!.w + x - block!.x) * 4 : 0;
		let pixel = 0;
		for (let channel = 0; channel < 4; channel++) {
			// Captures are native 32bppPArgb surfaces. Compare the actual stored premultiplied bytes.
			const value = inside ? (channel === 3 ? block!.rgba[offset + 3]
				: Math.round(block!.rgba[offset + channel] * block!.rgba[offset + 3] / 255)) : 0;
			pixel = Math.max(pixel, Math.abs(value - reference[(y * size + x) * 4 + (channel === 3 ? 3 : 2 - channel)]));
		}
		if (pixel) pixels++;
		maximum = Math.max(maximum, pixel);
	}
	return { pixels, maximum };
}

describe('recorded plain Bilinear DrawImage fixtures', () => {
	// The source position steps across a row in float32 rounded toward minus infinity, from the first covered
	// pixel, measured from the device position of the source rectangle's corner (see `writeTextureRect` and
	// `texture-coordinate.json.gz` for the stepper). Zero-tolerance counts over every pixel; before: 18 (default,
	// low, bilinear: a drifting column of the 0.9x enlargement), 3 (each attr-*-bilinear) and 4 (rotated).
	const bounds: Record<string, number> = {
		bilinear: 0, default: 0, low: 0, 'rotated-bilinear': 0, 'attr-clamp-bilinear': 0, 'attr-flipxy-bilinear': 0,
		'attr-tile-bilinear': 0, 'pom-half-bilinear': 0, 'pom-highquality-bilinear': 0, 'pom-highspeed-bilinear': 0,
	};
	for (const [suffix, bound] of Object.entries(bounds)) {
		it(suffix, async () => {
			const name = `gpx-image-${suffix}`;
			const actual = await renderFixture(`${name}.emf`);
			expect(actual).not.toBeNull();
			const reference = await loadReference(name);
			const result = diffImages(actual!, reference, 0, 0);
			expect(result.mismatched).toBeLessThanOrEqual(bound);
			expect(result.maxDiff).toBeLessThanOrEqual(bound === 0 ? 0 : 1);
		});
	}
});

describe('native Bilinear premultiplication and output rounding', () => {
	it('pins 144 opaque, translucent and impulse rectangle draws independently', () => {
		const captures = load('bilinear-arithmetic');
		expect(captures).toHaveLength(144);
		for (const c of captures) {
			const block = resampleImage(rgba(c.srcBgra), 8, 8, {
				srcX: 0, srcY: 0, srcW: 8, srcH: 8,
				toDevice: [c.sx, 0, 0, c.sy, 4 + c.origin, 4 + c.origin],
				kernel: 'bilinear', halfPixelOffset: false,
			}, { w: 48, h: 48 });
			const result = diff(block, c.bgra, 48);
			const label = `${c.pattern}: ${c.sx} x ${c.sy}, origin ${c.origin}`;
			expect(result, label).toEqual({ pixels: 0, maximum: 0 });
		}
		// Before: 1293/4144/349/453 differing pixels in the four source patterns.
	});

	it('improves a separate seed and 64 cropped DrawImagePoints draws under scaling and mirroring', () => {
		const captures = load('bilinear-independent');
		expect(captures).toHaveLength(64);
		const totals: Record<string, number> = {};
		for (const [index, c] of captures.entries()) {
			const block = resampleImage(rgba(c.srcBgra), 11, 7, {
				srcX: 1, srcY: 1, srcW: 9, srcH: 5, toDevice: c.m,
				kernel: 'bilinear', halfPixelOffset: false, pointsForm: true,
			}, { w: 80, h: 80 });
			const result = diff(block, c.bgra, 80);
			const remaining: Record<number, number> = { 30: 2, 31: 2, 62: 1, 63: 1 };
			expect(result).toEqual({ pixels: remaining[index] ?? 0, maximum: index in remaining ? 1 : 0 });
			const key = `${c.pattern}:${c.mode}`;
			totals[key] = (totals[key] ?? 0) + result.pixels;
		}
		// Before: 133, 148, 1426, 1433; byte rounding chiefly fixes translucent sources.
		expect(totals).toEqual({ '0:0': 0, '0:1': 4, '1:0': 0, '1:1': 2 });
	});

	it('matches 24 transparent SourceCopy and SourceOver draws, unit-scale alpha and opaque clamp colours exactly', () => {
		const captures = load('bilinear-alpha');
		expect(captures).toHaveLength(24);
		for (const c of captures) {
			const block = resampleImage(rgba(c.srcBgra), 4, 3, {
				srcX: 0, srcY: 0, srcW: 4, srcH: 3,
				toDevice: [c.scale, 0, 0, c.scale, 2 + c.origin, 2 + c.origin],
				kernel: 'bilinear', halfPixelOffset: false, pointsForm: true,
				wrap: c.clamp ? 'clamp' : undefined, clampArgb: 0xffd92b81,
			}, { w: 16, h: 14 });
			const native = Buffer.from(c.bgra, 'base64');
			const background = Buffer.from(c.background, 'base64');
			const label = `${c.scale}, origin ${c.origin}, clamp ${c.clamp}, SourceOver ${c.over}`;
			for (let y = 0; y < 14; y++) for (let x = 0; x < 16; x++) {
				const inside = !!block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
				const offset = inside ? ((y - block!.y) * block!.w + x - block!.x) * 4 : 0;
				const alpha = inside ? block!.rgba[offset + 3] : 0;
				for (let channel = 0; channel < 4; channel++) {
					const nativeOffset = (y * 16 + x) * 4 + (channel === 3 ? 3 : 2 - channel);
					const source = inside ? (channel === 3 ? alpha : Math.round(block!.rgba[offset + channel] * alpha / 255)) : 0;
					const output = c.over ? source + Math.round(background[nativeOffset] * (255 - alpha) / 255) : source;
					expect(output, `${label}, pixel ${x},${y}, channel ${channel}`).toBe(native[nativeOffset]);
				}
			}
		}
	});

	it('pins signed half-share phases and adjacent float32 source rectangles without adding a spare share', () => {
		const captures = load('bilinear-phase-ties');
		expect(captures).toHaveLength(48);
		// These float neighbours expose the remaining matrix-coordinate rounding at a share boundary.
		const remaining: Record<number, number> = { 4: 16, 5: 16, 22: 16, 23: 16, 24: 1, 25: 8, 28: 7, 42: 1, 43: 11, 46: 10 };
		for (const [index, c] of captures.entries()) {
			// Native JSON uses shortest float32 decimals; restore the exact recorded binary values.
			const x = Math.fround(c.sx), y = Math.fround(c.sy);
			const block = resampleImage(rgba(c.srcBgra), 4, 4, {
				srcX: x, srcY: y, srcW: 3, srcH: 3,
				toDevice: [2, 0, 0, 2, 4 - 2 * x, 4 - 2 * y],
				kernel: 'bilinear', halfPixelOffset: false,
			}, { w: 12, h: 12 });
			expect(diff(block, c.bgra, 12), `${x}, ${y}`).toEqual({
				pixels: remaining[index] ?? 0, maximum: index in remaining ? 1 : 0,
			});
		}
	});

	it('records native translucent Clamp output that exceeds the representable straight-RGBA range', () => {
		// Evidence of an existing unsupported case, independent of the production renderer.
		// Native treats Color.FromArgb(160,217,43,129) as literal PArgb border bytes.
		const captures = load('bilinear-translucent-clamp');
		expect(captures).toHaveLength(24);
		const capture = captures.find((c) => c.scale === 2.5 && c.origin === 0 && c.clamp && !c.over)!;
		const pixels = Buffer.from(capture.bgra, 'base64');
		const offset = (2 * 16 + 11) * 4;
		expect([...pixels.subarray(offset, offset + 4)]).toEqual([116, 33, 179, 147]);
		expect(pixels[offset + 2]).toBeGreaterThan(pixels[offset + 3]);
	});
});
