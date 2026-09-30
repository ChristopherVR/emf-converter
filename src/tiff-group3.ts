import type { IFD } from 'utif';

/**
 * UTIF guesses whether Group 3 has mode bits from the first run's first bit,
 * ignoring T4Options (292). A 1D white run can start with 1, making that
 * guess corrupt the entire strip. Convert explicitly 1D strips to the
 * equivalent tagged 1D representation its decoder understands.
 * TIFF 6 section 11: https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf
 */
export function normalizeGroup3(buffer: ArrayBuffer, page: IFD): ArrayBuffer {
	const options = Array.isArray(page.t292) ? Number(page.t292[0]) : 0;
	if (!Array.isArray(page.t259) || page.t259[0] !== 3 || (options & 3) !== 0) return buffer;
	const offsets = page.t273, lengths = page.t279;
	if (!Array.isArray(offsets) || !Array.isArray(lengths) || offsets.length !== lengths.length) return buffer;
	const source = new Uint8Array(buffer);
	const leastFirst = Array.isArray(page.t266) && page.t266[0] === 2;
	const strips = offsets.map((offset, i) => {
		const start = Number(offset), length = Number(lengths[i]);
		if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 || start + length > source.length) throw new Error('Invalid TIFF strip');
		// Every EOL is at least 12 bits long, so this also bounds inserted bits.
		const output = new Uint8Array(Math.ceil(length * 8 * 13 / 12 / 8) + 1);
		let position = 0, zeros = 0;
		const write = (bit: number) => {
			if (bit) output[position >>> 3] |= 1 << (leastFirst ? position & 7 : 7 - (position & 7));
			position++;
		};
		for (let bitPosition = 0; bitPosition < length * 8; bitPosition++) {
			const bit = (source[start + (bitPosition >>> 3)] >>> (leastFirst ? bitPosition & 7 : 7 - (bitPosition & 7))) & 1;
			write(bit);
			if (bit) {
				if (zeros >= 11) write(1); // EOL + 1 denotes a one-dimensional row.
				zeros = 0;
			} else zeros++;
		}
		return output.subarray(0, Math.ceil(position / 8));
	});
	// decodeImage reads the parsed offsets, so no IFD bytes need rewriting.
	const normalized = new Uint8Array(strips.reduce((size, strip) => size + strip.length, source.length));
	normalized.set(source);
	let position = source.length;
	page.t273 = strips.map(strip => { const offset = position; normalized.set(strip, position); position += strip.length; return offset; });
	page.t279 = strips.map(strip => strip.length);
	page.t292 = [options | 1];
	return normalized.buffer;
}
