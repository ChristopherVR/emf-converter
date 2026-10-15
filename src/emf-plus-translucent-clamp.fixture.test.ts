/**
 * Translucent ImageAttributes Clamp colours against `translucent-clamp-surfaces.json.gz`
 * (`TranslucentClampProbe.cs`, `scripts/gdi-fixtures/generate-translucent-clamp.ps1`): a 4 x 3 source of mixed alpha
 * drawn at 1x and 2.5x with `SetWrapMode(WrapMode.Clamp, Color.FromArgb(alpha, 217, 43, 129))` for alpha 40, 160 and
 * 255, under Bilinear, Bicubic, HighQualityBilinear and HighQualityBicubic, onto straight (Argb) and premultiplied
 * (PArgb) surfaces over six backdrops with SourceCopy and SourceOver.
 *
 * - GDI+ reads the colour's RGB as literal premultiplied bytes: alpha 160 gives the pixel (217, 43, 129, 160), a red
 *   above its alpha, so a clamp pixel blended in can hold a channel above the alpha (red 179 for alpha 147). Plain
 *   Bilinear, plain Bicubic and HighQualityBilinear reproduce every pixel that way; HighQualityBicubic does not yet.
 * - A SourceOver draw onto a premultiplied surface is a plain 32-bit add of the source pixel and the backdrop times
 *   `(255 - alpha) / 255` rounded per channel, carries included: 6,578 of 6,578 touched pixels. A channel above its
 *   alpha therefore carries into the next channel and, when the red one (the last colour channel) does, wraps the alpha itself (alpha 0 with
 *   colour). That is not representable in a canvas, which stores premultiplied bytes at most equal to the alpha, so
 *   the converter saturates (see `EdgeMode.literal`).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { resampleImage } from './emf-plus-image-resample';
import type { ImageResampleKernel } from './emf-types';

interface Capture {
	clampAlpha: number;
	backdrop: number[];
	format: 'argb' | 'pargb';
	over: boolean;
	imode: number;
	scale: number;
	srcBgra: string;
	background: string;
	bgra: string;
}

const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(
	new URL('./__fixtures__/gdi/translucent-clamp-surfaces.json.gz', import.meta.url),
)).toString('utf8'));

const KERNELS: Record<number, ImageResampleKernel> = { 3: 'bilinear', 4: 'bicubic', 6: 'hq-bilinear', 7: 'hq-bicubic' };

function toRgba(base64: string): Uint8ClampedArray {
	const bgra = Buffer.from(base64, 'base64');
	const out = new Uint8ClampedArray(bgra.length);
	for (let i = 0; i < bgra.length; i += 4) {
		out.set([bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]], i);
	}
	return out;
}

/** Pixels (of a premultiplied SourceCopy draw onto a transparent backdrop) that differ from native, saturating a channel above its alpha. */
function differing(c: Capture): number {
	const block = resampleImage(toRgba(c.srcBgra), 4, 3, {
		srcX: 0, srcY: 0, srcW: 4, srcH: 3,
		toDevice: [c.scale, 0, 0, c.scale, 3, 3],
		kernel: KERNELS[c.imode], halfPixelOffset: false, pointsForm: true, wrap: 'clamp',
		clampArgb: ((c.clampAlpha << 24) | (217 << 16) | (43 << 8) | 129) >>> 0,
	}, { w: 16, h: 14 });
	const native = Buffer.from(c.bgra, 'base64');
	let bad = 0;
	for (let y = 0; y < 14; y++) {
		for (let x = 0; x < 16; x++) {
			let rgba = [0, 0, 0, 0];
			if (block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h) {
				const o = ((y - block.y) * block.w + x - block.x) * 4;
				const a = block.rgba[o + 3];
				rgba = [0, 1, 2].map((k) => Math.round(block.rgba[o + k] * a / 255)).concat(a);
			}
			const n = (y * 16 + x) * 4;
			const nat = [native[n + 2], native[n + 1], native[n], native[n + 3]];
			if (nat[3] === 0 && rgba[3] === 0) continue;
			if ([0, 1, 2].some((k) => rgba[k] !== Math.min(nat[k], nat[3])) || rgba[3] !== nat[3]) bad++;
		}
	}
	return bad;
}

describe('translucent Clamp colour, premultiplied SourceCopy onto a transparent backdrop', () => {
	const copies = captures.filter((c) => c.format === 'pargb' && !c.over && c.backdrop[0] === 0);

	it('has 24 draws', () => {
		expect(copies).toHaveLength(24);
	});

	// Differing pixels per interpolation mode over alphas 40, 160, 255 and scales 1 and 2.5 (before the literal-premultiplied
	// reading: Bilinear 64, Bicubic 131, HighQualityBilinear 131, HighQualityBicubic 160).
	const bounds: Record<number, number> = { 3: 0, 4: 0, 6: 0, 7: 35 };
	for (const [mode, bound] of Object.entries(bounds)) {
		it(`mode ${mode}`, () => {
			let bad = 0;
			for (const c of copies.filter((x) => x.imode === Number(mode))) bad += differing(c);
			expect(bad).toBeLessThanOrEqual(bound);
		});
	}
});

describe('native SourceOver onto a premultiplied surface', () => {
	it('is a 32-bit add of the pixel and the backdrop scaled by one minus its alpha, carries included', () => {
		const key = (c: Capture): string => `${c.clampAlpha}|${c.backdrop.join(',')}|${c.format}|${c.scale}|${c.imode}`;
		const copies = new Map(captures.filter((c) => !c.over).map((c) => [key(c), c]));
		let touched = 0;
		let wrong = 0;
		for (const c of captures.filter((x) => x.over && x.format === 'pargb')) {
			const over = Buffer.from(c.bgra, 'base64');
			const copy = Buffer.from(copies.get(key(c))!.bgra, 'base64');
			const background = Buffer.from(c.background, 'base64');
			for (let n = 0; n < over.length; n += 4) {
				if ([0, 1, 2, 3].every((k) => copy[n + k] === background[n + k])) continue;
				touched++;
				const alpha = copy[n + 3];
				let word = 0;
				for (let k = 0; k < 4; k++) {
					word += (copy[n + k] + Math.round(background[n + k] * (255 - alpha) / 255)) * 2 ** (8 * k);
				}
				word %= 2 ** 32;
				for (let k = 0; k < 4; k++) {
					if (Math.floor(word / 2 ** (8 * k)) % 256 !== over[n + k]) {
						wrong++;
						break;
					}
				}
			}
		}
		expect(touched).toBe(6578);
		expect(wrong).toBe(0);
	});
});
