export interface CodecPixels {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

export function validCodecSize(width: number, height: number): boolean {
	return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192;
}
