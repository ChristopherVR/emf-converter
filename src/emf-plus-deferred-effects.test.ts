import { describe, it, expect, vi } from 'vitest';

const mode = vi.hoisted(() => ({ deferred: false }));
vi.mock('./emf-plus-image-predecode', async (importOriginal) => {
	const original = await importOriginal<typeof import('./emf-plus-image-predecode')>();
	return { ...original, preDecodeEmfPlusImages: async (...args: Parameters<typeof original.preDecodeEmfPlusImages>) => mode.deferred ? new Map() : original.preDecodeEmfPlusImages(...args) };
});

import { convertMetafileToDataUrl, convertMetafileToSvg } from './index';
import { blurObject, colorMatrixObject, withEffect } from './__fixtures__/emf-plus-effect-records';
import { decodePng } from './png-decoder';

const fixture = 'gpx-image-rotated-bilinear.emf';
const swap = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];

describe('deferred image effects', () => {
	it.each(['matrix', 'cropped blur'])('preserves %s pixels and source mapping in PNG and SVG', async (effect) => {
		const bytes = effect === 'matrix' ? withEffect(fixture, colorMatrixObject(swap)) : withEffect(fixture, blurObject(3, false), true, [4, 3, 10, 9]);
		for (const svg of [false, true]) {
			const render = async () => {
				const result = svg ? await convertMetafileToSvg(bytes, { imageResampling: 'exact' }) : await convertMetafileToDataUrl(bytes, { dpiScale: 1 });
				expect(result).not.toBeNull();
				const base64 = svg ? /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(result!)![1] : result!.split(',')[1];
				return (await decodePng(Buffer.from(base64, 'base64')))!;
			};
			mode.deferred = false;
			const immediate = await render();
			mode.deferred = true;
			try {
				const deferred = await render();
				expect([deferred.width, deferred.height]).toEqual([immediate.width, immediate.height]);
				expect(deferred.data).toEqual(immediate.data);
			} finally { mode.deferred = false; }
		}
	});
});
