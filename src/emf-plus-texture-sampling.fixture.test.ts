import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { writeTextureColor } from './emf-plus-brush-texture';
import { invertAffine } from './emf-plus-exact-fill';
import type { EmfPlusGradientWrapMode, TransformMatrix } from './emf-types';
import { diffImages, loadReference, renderFixture } from './__fixtures__/gdi-parity-harness';

interface TextureControl {
	name: string;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	wrap: number;
	half: boolean;
	matrix: TransformMatrix;
	source: string;
	rgba: string;
	premultiplied: string;
}

const controls: TextureControl[] = JSON.parse(gunzipSync(readFileSync(
	new URL('./__fixtures__/gdi/texture-sampling.json.gz', import.meta.url),
)).toString('utf8'));
const wraps: EmfPlusGradientWrapMode[] = ['tile', 'tile-flip-x', 'tile-flip-y', 'tile-flip-xy', 'clamp'];

describe('native TextureBrush sampling', () => {
	// Direct Windows TextureBrush SourceCopy captures, with random opaque,
	// translucent (including zero alpha) and ramp sources, 8 independent
	// affine transforms, all 5 WrapModes, and PixelOffsetMode None/Half.
	// Compare the premultiplied bytes the renderer actually composites.
	// Native straight ARGB extraction truncates and does not round-trip;
	// comparing only its RGB bytes would mask a wrong runtime intermediate.
	for (const control of controls) {
		it(control.name, () => {
			const inv = invertAffine(control.matrix)!;
			const source = new Uint8ClampedArray(Buffer.from(control.source, 'base64'));
			const expected = Buffer.from(control.premultiplied, 'base64');
			const actual = new Uint8ClampedArray(control.width * control.height * 4);
			for (let y = 0; y < control.height; y++) {
				for (let x = 0; x < control.width; x++) {
					const p = (y * control.width + x) * 4;
					writeTextureColor(inv, control.sourceWidth, control.sourceHeight, source,
						wraps[control.wrap], control.half, x, y, actual, p);
					for (let c = 0; c < 3; c++) {
						actual[p + c] = Math.round(actual[p + c] * actual[p + 3] / 255);
					}
				}
			}
			expect(Buffer.from(actual).equals(expected)).toBe(true);
		});
	}
});

describe('recorded texture fills retain tighter native bounds', () => {
	// Zero-tolerance RGB counts over every output pixel; each residual is at
	// most one level. This pins the improvement at the public replay boundary,
	// including the original rotated and reduced texture draws.
	const bounds: Record<string, number> = {
		clamp: 1,
		flipx: 138,
		flipxy: 115,
		flipy: 163,
		'hqbicubic-flipxy': 115,
		'nearest-tile': 181,
		'pom-half-tile': 318,
		tile: 181,
	};
	for (const [suffix, bound] of Object.entries(bounds)) {
		it(suffix, async () => {
			const name = `gpx-texture-${suffix}`;
			const actual = await renderFixture(`${name}.emf`);
			expect(actual).not.toBeNull();
			const reference = await loadReference(name);
			expect([actual!.width, actual!.height]).toEqual([reference.width, reference.height]);
			const diff = diffImages(actual!, reference, 0, 0);
			expect(diff.maxDiff).toBeLessThanOrEqual(1);
			expect(diff.mismatched).toBeLessThanOrEqual(bound);
		});
	}
});
