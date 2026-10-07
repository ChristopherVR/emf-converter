import { cmykPlanesToRgba } from './jpeg-cmyk';
import { decodeJpegPixels } from './jpeg-decoder';
import { decodeJpegPlanes } from './jpeg-turbo';
import type { IFD } from 'utif';

/** JPEG-in-TIFF carries its colour space in PhotometricInterpretation.
 * UTIF always converts three JPEG components from YCbCr, corrupting RGB
 * JPEG strips. Decode supported RGB/YCbCr strips and tiles explicitly.
 */
export function decodeJpegTiff(bytes: Uint8Array, page: IFD): Uint8ClampedArray | null {
	const values = (tag: string): number[] => Array.isArray(page[tag]) ? (page[tag] as number[]).map(Number) : [];
	const first = (tag: string, fallback = 0): number => values(tag)[0] ?? fallback;
	const photo = first('t262');
	// Separated (CMYK) JPEG strips hold the ink amounts as stored: unlike a standalone Adobe CMYK JPEG they are not inverted.
	const cmyk = photo === 5 && first('t277') === 4;
	if (first('t259') !== 7 || (!cmyk && ((photo !== 2 && photo !== 6) || first('t277') !== 3)) || first('t284', 1) !== 1 || values('t258').some(v => v !== 8)) return null;
	const width = first('t256'), height = first('t257');
	const tiled = !!page.t322;
	const blockWidth = tiled ? first('t322') : width;
	const blockHeight = tiled ? first('t323') : first('t278', height);
	if (!Number.isInteger(blockWidth) || !Number.isInteger(blockHeight) || blockWidth <= 0 || blockHeight <= 0 || blockWidth > 8192 || blockHeight > 8192) throw new Error('Invalid TIFF JPEG block');
	const offsets = values(tiled ? 't324' : 't273');
	const lengths = values(tiled ? 't325' : 't279');
	const columns = Math.ceil(width / blockWidth), rows = Math.ceil(height / blockHeight);
	if (offsets.length !== columns * rows || lengths.length !== offsets.length) throw new Error('Invalid TIFF JPEG offsets');
	const tables = page.t347 instanceof Uint8Array ? page.t347 : new Uint8Array(values('t347'));
	const tableLength = tables.length >= 2 && tables[tables.length - 2] === 255 && tables[tables.length - 1] === 217 ? tables.length - 2 : tables.length;
	const result = new Uint8ClampedArray(width * height * 4);
	for (let block = 0; block < offsets.length; block++) {
		const offset = offsets[block], length = lengths[block];
		if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > bytes.length) throw new Error('Invalid TIFF JPEG data');
		const skip = tableLength && bytes[offset] === 255 && bytes[offset + 1] === 216 ? 2 : 0;
		const jpeg = new Uint8Array(tableLength + length - skip);
		jpeg.set(tables.subarray(0, tableLength));
		jpeg.set(bytes.subarray(offset + skip, offset + length), tableLength);
		let decoded: { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
		if (cmyk) {
			const planes = decodeJpegPlanes(jpeg);
			if (!planes || planes.planes.length !== 4) throw new Error('Invalid TIFF JPEG data');
			decoded = { width: planes.width, height: planes.height, data: cmykPlanesToRgba(planes.planes.map(p => p.map(v => 255 - v)), planes.width, planes.height, false) };
		} else decoded = decodeJpegPixels(jpeg, photo === 6);
		const x = (block % columns) * blockWidth, y = Math.floor(block / columns) * blockHeight;
		const copyWidth = Math.min(blockWidth, width - x), copyHeight = Math.min(blockHeight, height - y);
		if (decoded.width !== blockWidth || decoded.height < copyHeight || decoded.height > blockHeight) throw new Error('Invalid TIFF JPEG dimensions');
		for (let row = 0; row < copyHeight; row++) result.set(decoded.data.subarray(row * decoded.width * 4, (row * decoded.width + copyWidth) * 4), ((y + row) * width + x) * 4);
	}
	return result;
}
