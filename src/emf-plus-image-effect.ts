/** EMF+ SerializableObject image effects, applied to an immutable RGBA source.
 * MS-EMFPLUS 2.3.5.2, 2.2.3.5 and 2.2.3.6; Windows probes live in
 * scripts/gdi-fixtures/ImageEffectProbe.cs.
 */
import { nativeCurveLookup } from './emf-plus-image-curves';

export type ImageEffect =
	| { kind: 'matrix'; values: number[] }
	| { kind: 'lookup'; values: Uint8Array };

/** A channel lookup, retaining the source alpha and unselected colours. */
function channelLookup(transform: (value: number) => number, channel = 0): ImageEffect {
	const values = new Uint8Array(1024);
	for (let ch = 0; ch < 4; ch++) for (let value = 0; value < 256; value++) {
		values[ch * 256 + value] = ch < 3 && (channel === 0 || channel === 3 - ch) ? Math.min(255, Math.max(0, Math.round(transform(value)))) : value;
	}
	return { kind: 'lookup', values };
}

/** Reads the GUID and bounded parameter block; unsupported/malformed effects clear the previous effect. */
export function parseImageEffect(view: DataView, off: number, size: number): ImageEffect | null {
	if (size < 20 || off < 0 || off + size > view.byteLength) return null;
	const count = view.getUint32(off + 16, true);
	if (count > size - 20) return null;
	const hex = (n: number, digits: number): string => n.toString(16).padStart(digits, '0');
	const guid = hex(view.getUint32(off, true), 8) + hex(view.getUint16(off + 4, true), 4) + hex(view.getUint16(off + 6, true), 4)
		+ Array.from({ length: 8 }, (_, i) => hex(view.getUint8(off + 8 + i), 2)).join('');
	if (guid === '718f2615793340e3a5115f68fe14dd74' && count === 100) {
		const values = Array.from({ length: 25 }, (_, i) => view.getFloat32(off + 20 + i * 4, true));
		return values.every(Number.isFinite) ? { kind: 'matrix', values } : null;
	}
	if (guid === 'a7ce72a90f7f40d7b3ccd0c02d5c3212' && count === 1024) {
		return { kind: 'lookup', values: new Uint8Array(view.buffer, view.byteOffset + off + 20, count).slice() };
	}
	if (guid === '537e597d251e48da966429ca496b70f8' && count === 12) {
		const balance = Array.from({ length: 3 }, (_, i) => view.getInt32(off + 20 + i * 4, true));
		if (balance.some((value) => value < -100 || value > 100)) return null;
		const values = new Uint8Array(1024);
		for (let ch = 0; ch < 3; ch++) {
			// GDI+ quantises the channel gain before building its lookup.
			// A 16.16 gain matches every level at all 201 legal settings.
			const gain = Math.floor((1 + balance[ch] / 100) * 65536) / 65536;
			for (let value = 0; value < 256; value++) values[(2 - ch) * 256 + value] = Math.min(255, Math.round(value * gain));
		}
		for (let value = 0; value < 256; value++) values[768 + value] = value;
		return { kind: 'lookup', values };
	}
	if (guid === 'dd6a002258e44a679d9bd48eb881a53d' && count === 12) {
		const curve = view.getUint32(off + 20, true);
		const channel = view.getUint32(off + 24, true);
		const intensity = view.getInt32(off + 28, true);
		const min = curve < 2 ? -255 : curve < 6 ? -100 : curve === 6 ? 1 : 0;
		const max = curve === 7 ? 254 : curve < 2 || curve === 6 ? 255 : 100;
		if (curve > 7 || channel > 3 || intensity < min || intensity > max) return null;
		const lookup = nativeCurveLookup(curve, intensity);
		return channelLookup((value) => lookup[value], channel);
	}
	if (guid === '99c354ec2a314f3a8c3417a803b33a25' && count === 12) {
		const highlight = view.getInt32(off + 20, true);
		const midtone = view.getInt32(off + 24, true);
		const shadow = view.getInt32(off + 28, true);
		if (highlight < 0 || highlight > 100 || midtone < -100 || midtone > 100 || shadow < 0 || shadow > 100) return null;
		// GDI+ interpolates gamma on successively halved slider intervals:
		// 0/50/75/87.5/... correspond to gamma 1/2/3/4/..., capped at 10.
		let gamma = 1, low = 0, high = 50;
		while (Math.abs(midtone) >= high && high < 100) {
			gamma++; low = high; high = (high + 100) / 2;
		}
		gamma = Math.abs(midtone) === 100 ? 10 : Math.min(10, gamma + (Math.abs(midtone) - low) / (high - low));
		const exponent = Math.fround(midtone < 0 ? gamma : 1 / gamma);
		const base = shadow * 255 / 100 - (highlight === shadow && shadow < 50 ? 1 : 0);
		const span = highlight === shadow ? 1 : (highlight - shadow) * 255 / 100;
		return channelLookup((value) => {
			const level = Math.min(1, Math.max(0, (value - base) / span));
			return 255 * (highlight >= shadow ? level ** exponent : 1 - (1 - level) ** exponent);
		});
	}
	return null;
}

/** Transforms straight RGBA without changing the shared predecoded image cache. */
export function applyImageEffect(source: Uint8ClampedArray, effect: ImageEffect): Uint8ClampedArray {
	const out = new Uint8ClampedArray(source.length);
	const m = effect.values;
	for (let o = 0; o < source.length; o += 4) {
		if (effect.kind === 'lookup') {
			out[o] = m[512 + source[o]];
			out[o + 1] = m[256 + source[o + 1]];
			out[o + 2] = m[source[o + 2]];
			out[o + 3] = m[768 + source[o + 3]];
		} else {
			for (let ch = 0; ch < 4; ch++) {
				const value = source[o] * m[ch] + source[o + 1] * m[5 + ch] + source[o + 2] * m[10 + ch] + source[o + 3] * m[15 + ch] + 255 * m[20 + ch];
				out[o + ch] = Math.round(value);
			}
		}
	}
	return out;
}
