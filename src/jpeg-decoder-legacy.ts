import { decode } from 'jpeg-js';

const options = { useTArray: true as const, formatAsRGBA: true, maxResolutionInMP: 67.108864, maxMemoryUsageInMB: 512 };

/** Reconstruct subsampled JPEG chroma at pixel centres, as Windows does.
 * jpeg-js otherwise repeats each chroma sample over its whole sampling block.
 */
export function decodeJpegPixelsLegacy(bytes: Uint8Array, colorTransform?: boolean) {
	let sampling: { id: number; h: number; v: number }[] = [];
	let adobeTransform: number | undefined;
	let adobeOffset = -1;
	for (let position = 2; position + 4 <= bytes.length;) {
		if (bytes[position] !== 255) break;
		if (bytes[position + 1] === 255) { position++; continue; }
		const marker = bytes[position + 1];
		if (marker === 0xda || marker === 0xd9) break;
		const length = bytes[position + 2] * 256 + bytes[position + 3];
		if (length < 2 || position + length + 2 > bytes.length) break;
		const start = position + 4;
		if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
			const count = bytes[start + 5];
			if (length >= 8 + 3 * count) sampling = Array.from({ length: count }, (_, i) => ({ id: bytes[start + 6 + i * 3], h: bytes[start + 7 + i * 3] >> 4, v: bytes[start + 7 + i * 3] & 15 }));
		}
		if (marker === 0xee && length >= 14 && String.fromCharCode(...bytes.subarray(start, start + 5)) === 'Adobe') {
			adobeOffset = start + 11;
			adobeTransform = bytes[adobeOffset];
		}
		position += length + 2;
	}
	const transform = colorTransform ?? (adobeTransform !== undefined ? adobeTransform !== 0 : !sampling.every((component, i) => component.id === [82, 71, 66][i]));
	if (sampling.length !== 3 || !transform) return decode(bytes, { ...options, colorTransform: sampling.length === 3 ? transform : colorTransform });
	const maxH = Math.max(...sampling.map(c => c.h)), maxV = Math.max(...sampling.map(c => c.v));
	if (sampling.some(c => !c.h || !c.v || maxH % c.h || maxV % c.v)) return decode(bytes, { ...options, colorTransform });
	// jpeg-js lets Adobe's transform marker override its explicit option.
	// Clear it on a private copy to obtain the unconverted component samples.
	let encoded = bytes;
	if (adobeTransform) { encoded = bytes.slice(); encoded[adobeOffset] = 0; }
	const raw = decode(encoded, { ...options, colorTransform: false });
	const { width, height } = raw;
	const data = new Uint8Array(raw.data.length);
	const sample = (x: number, y: number, channel: number): number => {
		const sx = maxH / sampling[channel].h, sy = maxV / sampling[channel].v;
		const px = Math.max(0, Math.min(Math.ceil(width / sx) - 1, (x + 0.5) / sx - 0.5));
		const py = Math.max(0, Math.min(Math.ceil(height / sy) - 1, (y + 0.5) / sy - 0.5));
		const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
		const at = (xx: number, yy: number) => raw.data[(Math.min(height - 1, yy * sy) * width + Math.min(width - 1, xx * sx)) * 4 + channel];
		return (1 - fy) * ((1 - fx) * at(ix, iy) + fx * at(ix + 1, iy)) + fy * ((1 - fx) * at(ix, iy + 1) + fx * at(ix + 1, iy + 1));
	};
	const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const luma = sample(x, y, 0), cb = sample(x, y, 1) - 128, cr = sample(x, y, 2) - 128;
		const offset = (y * width + x) * 4;
		data[offset] = byte(luma + 1.402 * cr);
		data[offset + 1] = byte(luma - 0.3441363 * cb - 0.71413636 * cr);
		data[offset + 2] = byte(luma + 1.772 * cb);
		data[offset + 3] = 255;
	}
	return { ...raw, data };
}
