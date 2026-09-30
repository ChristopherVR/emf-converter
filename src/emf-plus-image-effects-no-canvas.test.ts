/**
 * EMF+ image effects in SVG output with no canvas backend (`@napi-rs/canvas`
 * mocked to fail, as in plain Node.js): an embedded PNG is still decoded to
 * pixels ahead of replay by the built-in `png-decoder.ts`, so the effect is
 * applied and the effected pixels are embedded instead of the original bytes.
 */
import { describe, it, expect, vi } from 'vitest';

import { colorMatrixObject, fixtureBuffer, withEffect } from './__fixtures__/emf-plus-effect-records';
import { decodePng } from './png-decoder';

vi.mock('@napi-rs/canvas', () => {
	throw new Error("Cannot find module '@napi-rs/canvas' (simulated, not installed)");
});

const SWAP_RB = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];

async function svgImages(svg: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }[]> {
	const found = [...svg.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
	return Promise.all(found.map(async (m) => (await decodePng(Buffer.from(m[1], 'base64')))!));
}

describe('EMF+ image effects in SVG output without a canvas backend', () => {
	it('applies the effect to an embedded PNG', async () => {
		const { convertMetafileToSvg } = await import('./index');
		const FIXTURE = 'gpx-image-rotated-bilinear.emf';
		const plainSvg = (await convertMetafileToSvg(fixtureBuffer(FIXTURE)))!;
		const swappedSvg = (await convertMetafileToSvg(withEffect(FIXTURE, colorMatrixObject(SWAP_RB))))!;
		const [a] = await svgImages(plainSvg);
		const [b] = await svgImages(swappedSvg);
		expect(swappedSvg).not.toBe(plainSvg);
		expect([b.width, b.height]).toEqual([a.width, a.height]);
		let differing = 0;
		for (let i = 0; i < a.data.length; i += 4) {
			expect([b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]]).toEqual([
				a.data[i + 2],
				a.data[i + 1],
				a.data[i],
				a.data[i + 3],
			]);
			if (a.data[i] !== a.data[i + 2]) {
				differing++;
			}
		}
		expect(differing).toBeGreaterThan(0);
	});
});
