import { type HalftoneTaps } from './emf-gdi-stretch';

// Public native measurements only: this model is not a production selector.
// The controlled ratios produce nearest-source runs of length two to four.
// Filtering phase is local to those discrete runs, rather than an inverse
// continuous destination coordinate. No claim is made for other run lengths.
const tentIntegral = (x: number): number => x <= -1 ? 0 : x < 0 ? (x + 1) ** 2 / 2 : x < 1 ? 1 - (1 - x) ** 2 / 2 : 1;
export function measuredRunAxis(source: number, destination: number): HalftoneTaps[] {
	return Array.from({ length: destination }, (_, pixel) => {
		const nearest = Math.ceil((2 * pixel + 1) * source / (2 * destination)) - 1;
		const start = Math.floor(nearest * destination / source - 0.5) + 1;
		const end = Math.floor((nearest + 1) * destination / source - 0.5) + 1;
		const length = end - start;
		if (length < 2 || length > 4) throw new Error('Unmeasured HALFTONE run length');
		const position = nearest + Math.round(((pixel - start + 0.5) / length - 0.5) * 8) / 8;
		const aperture = (length - 2) / 2;
		const row: HalftoneTaps = [];
		for (let sample = nearest - 2; sample <= nearest + 2; sample++) {
			const distance = position - sample;
			const tent = aperture ? (tentIntegral(distance + aperture / 2) - tentIntegral(distance - aperture / 2)) / aperture : Math.max(0, 1 - Math.abs(distance));
			const weight = Math.round(tent * 16) / 16;
			if (weight) row.push([Math.max(0, Math.min(source - 1, sample)), weight]);
		}
		return row;
	});
}

export interface MeasuredCrop {
	sw: number; sh: number; dw: number; dh: number;
	cropX: number; cropY: number; cropW: number; cropH: number;
}

// Held-out 2D RGB controls distinguish vertical-first integer intermediate
// samples from horizontal-first filtering or a single rounded tensor sum.
export function measuredRunCrop(source: Int32Array, c: MeasuredCrop): Int32Array {
	const columns = measuredRunAxis(c.sw, c.dw), rows = measuredRunAxis(c.sh, c.dh);
	const crop = new Int32Array(c.cropW * c.cropH * 3);
	for (let y = 0; y < c.cropH; y++) for (let x = 0; x < c.cropW; x++) for (let channel = 0; channel < 3; channel++) {
		let value = 0;
		for (const [xx, wx] of columns[x + c.cropX]) {
			let vertical = 0;
			for (const [yy, wy] of rows[y + c.cropY]) vertical += source[(yy * c.sw + xx) * 3 + channel] * wy;
			value += Math.floor(vertical + 0.5) * wx;
		}
		crop[(y * c.cropW + x) * 3 + channel] = Math.floor(value + 0.5);
	}
	return crop;
}
