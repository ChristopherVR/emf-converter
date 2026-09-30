/**
 * Compares the converter's image effects with GDI+'s own effected bitmaps
 * (see `emf-plus-effect-baked.ts`). Test-only.
 */
import { applyImageEffectToRect } from '../emf-plus-image-effects';
import { readBakedEffects } from './emf-plus-effect-baked';

/** Mismatch of every effected draw of a fixture against GDI+'s result. */
export interface EffectDiff {
	/** Pixels compared (the draws' source rectangles). */
	compared: number;
	/** Pixels whose largest channel difference exceeds the tolerance. */
	mismatched: number;
	mismatchRatio: number;
	maxDiff: number;
}

/**
 * Applies each effected draw of `<name>.emf` with `applyImageEffectToRect`
 * and diffs it against GDI+'s bitmap over the draw's source rectangle. A
 * pixel both sides leave fully transparent compares by alpha only (its
 * colour is invisible).
 */
export async function diffBakedEffects(name: string, tolerance: number): Promise<EffectDiff> {
	let compared = 0;
	let mismatched = 0;
	let maxDiff = 0;
	for (const { source, effect, srcRect, baked } of await readBakedEffects(name)) {
		const [sx, sy, sw, sh] = srcRect;
		const region = applyImageEffectToRect(source.data, source.width, source.height, effect, { x: sx, y: sy, w: sw, h: sh });
		if (!region) {
			throw new Error(`${name}: effect not applied`);
		}
		const w = Math.min(baked.width, Math.ceil(sw));
		const h = Math.min(baked.height, Math.ceil(sh));
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const rx = Math.floor(sx) + x - region.x;
				const ry = Math.floor(sy) + y - region.y;
				const j = (ry * region.width + rx) * 4;
				const i = (y * baked.width + x) * 4;
				const ours = rx >= 0 && ry >= 0 && rx < region.width && ry < region.height ? region.rgba.subarray(j, j + 4) : [0, 0, 0, 0];
				let d = Math.abs(ours[3] - baked.data[i + 3]);
				if (ours[3] !== 0 || baked.data[i + 3] !== 0) {
					for (let c = 0; c < 3; c++) {
						d = Math.max(d, Math.abs(ours[c] - baked.data[i + c]));
					}
				}
				compared++;
				if (d > tolerance) {
					mismatched++;
				}
				maxDiff = Math.max(maxDiff, d);
			}
		}
	}
	return { compared, mismatched, mismatchRatio: compared ? mismatched / compared : 1, maxDiff };
}
