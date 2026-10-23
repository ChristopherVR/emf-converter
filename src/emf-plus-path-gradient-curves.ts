/**
 * The Blend and InterpolationColors curves of a path gradient, as gdiplus.dll applies them (`SetBlend` and `SetPresetBlend` store
 * the factors, colours and positions reversed and subtracted from one; `slowAdjustValue` and `interpolatePresetColors` read them).
 * Both the one-dimensional ramp (`t` runs 0 at the centre to 1 at the boundary) and the fan triangles (`t` is the weight of the
 * centre) read the same stored curves.
 *
 * @module emf-plus-path-gradient-curves
 */

import { premultipliedColor } from './emf-plus-path-gradient-fan';
import { add, div, downF32, f32, ja, jae, jb, mul, sub } from './gdiplus-float';
import type { EmfPlusPathGradientShape } from './emf-types';

/** `1 - v` in double, rounded down to single precision (native stores the reversed positions this way). */
const reversed = (v: number): number => downF32(1 - f32(v));

/**
 * `slowAdjustValue`: the Blend curve applied to the ramp position `t` (0 at the centre, 1 at the boundary). `SetBlend` stores the
 * factors and positions reversed and subtracted from one, and the curve is linear between them; a single factor is an exponent.
 */
export function blendAdjuster(blend: EmfPlusPathGradientShape['blend']): ((t: number) => number) | null {
	if (!blend || blend.factors.length === 0) return null;
	const count = blend.factors.length;
	if (count === 1) {
		const scale = f32(blend.factors[0]);
		if (scale === 1) return null;
		return (t) => (scale > 0 && t >= 0 && t <= 1 ? downF32(Math.pow(t, scale)) : t);
	}
	const values = blend.factors.map(reversed).reverse();
	const positions = blend.positions.map(reversed).reverse();
	return (t) => {
		if (jb(t, 0) || jb(1, t)) return t;
		let i = 1;
		if (ja(sub(t, positions[1]), EPSILON)) {
			for (;;) {
				i++;
				if (i >= count) return t;
				if (!ja(sub(t, positions[i]), EPSILON)) break;
			}
		}
		const span = sub(positions[i], positions[i - 1]);
		if (ja(span, 0)) {
			return add(mul(div(sub(t, positions[i - 1]), span), sub(values[i], values[i - 1])), values[i - 1]);
		}
		return mul(add(values[i], values[i - 1]), 0.5);
	};
}

/** The comparison epsilon of the ramp lookups (`1.1920929e-07`). */
const EPSILON = 1.1920929e-7;

/**
 * `interpolatePresetColors`: the InterpolationColors ramp read at `t` into premultiplied channels, or `null` without one. The
 * colours and positions are stored reversed and the positions subtracted from one; the colours blend linearly in premultiplied form.
 */
export function presetRamp(preset: EmfPlusPathGradientShape['preset']): ((t: number, out: number[]) => void) | null {
	if (!preset || preset.argb.length < 2) return null;
	const count = preset.argb.length;
	const colors = preset.argb.map((c) => premultipliedColor(c)).reverse();
	const positions = preset.positions.map(reversed).reverse();
	return (t, out) => {
		let c: number[];
		if (jb(t, 0) || jb(1, t)) {
			// outside [0, 1]: the first colour at or below zero, the last above one
			c = jae(0, t) ? colors[0] : colors[count - 1];
			for (let q = 0; q < 4; q++) out[q] = c[q];
			return;
		}
		let i = 1;
		while (i < count && ja(t, positions[i])) i++;
		if (i >= count) {
			c = colors[count - 1];
			for (let q = 0; q < 4; q++) out[q] = c[q];
			return;
		}
		const lo = colors[i - 1];
		const hi = colors[i];
		const span = sub(positions[i], positions[i - 1]);
		if (ja(span, 0)) {
			const d = div(sub(t, positions[i - 1]), span);
			for (let q = 0; q < 4; q++) out[q] = add(mul(sub(hi[q], lo[q]), d), lo[q]);
		} else {
			for (let q = 0; q < 4; q++) out[q] = mul(add(hi[q], lo[q]), 0.5);
		}
	};
}
