/**
 * Input and output files of the `halftone-boundary` mode as the kernel-row generators use them: 4 x n images (one
 * constant colour per row) stretched to 2 x N pixels with HALFTONE, of which destination column 0 is read back.
 */

/** The `.hbin` input of `halftone-boundary`: 4 x n images (constant per row) stretched to 2 x N. */
export function inputFile(n: number, N: number, levels: number[][][]): Buffer {
	const parts: Buffer[] = [];
	const head = Buffer.alloc(8); head.writeInt32LE(-levels.length, 0); head.writeInt32LE(1, 4); parts.push(head);
	for (const channels of levels) {
		const h = Buffer.alloc(36);
		[4, n, 0, 0, 4, n, 2, N, 0].forEach((v, i) => h.writeInt32LE(v, i * 4));
		const bgra = new Uint8Array(4 * n * 4);
		for (let y = 0; y < n; y++) for (let x = 0; x < 4; x++) bgra.set([channels[2][y], channels[1][y], channels[0][y], 255], (y * 4 + x) * 4);
		parts.push(h, Buffer.from(bgra));
	}
	return Buffer.concat(parts);
}

/** Destination column 0 of every image of a `.hout`: out[image][row * 3 + channel]. */
export function readColumns(data: Uint8Array, count: number, N: number): number[][] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let p = 0;
	if (view.getInt32(p, true) !== count) throw new Error('result count');
	p += 4;
	const result: number[][] = [];
	for (let i = 0; i < count; i++) {
		const sw = view.getInt32(p, true), sh = view.getInt32(p + 4, true); p += 16 + 4 * (sw + sh);
		const column: number[] = [];
		for (let y = 0; y < N; y++) column.push(data[p + y * 2 * 4 + 2], data[p + y * 2 * 4 + 1], data[p + y * 2 * 4]);
		p += 2 * N * 4;
		result.push(column);
	}
	return result;
}
