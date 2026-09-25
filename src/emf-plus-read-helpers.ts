/**
 * Low-level binary coordinate readers for EMF+ records.
 *
 * Reads compressed (Int16) or uncompressed (Float32) rectangle / point
 * data from a DataView at the given byte offset.
 */

export interface RectCoords {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PointCoords {
	x: number;
	y: number;
}

/** Read four Int16 or Float32 values as a rectangle. */
export function readRectFromView(view: DataView, offset: number, compressed: boolean): RectCoords {
	if (compressed) {
		return {
			x: view.getInt16(offset, true),
			y: view.getInt16(offset + 2, true),
			w: view.getInt16(offset + 4, true),
			h: view.getInt16(offset + 6, true),
		};
	}
	return {
		x: view.getFloat32(offset, true),
		y: view.getFloat32(offset + 4, true),
		w: view.getFloat32(offset + 8, true),
		h: view.getFloat32(offset + 12, true),
	};
}

/** Read two Int16 or Float32 values as a point. */
export function readPointFromView(
	view: DataView,
	offset: number,
	compressed: boolean,
): PointCoords {
	if (compressed) {
		return {
			x: view.getInt16(offset, true),
			y: view.getInt16(offset + 2, true),
		};
	}
	return {
		x: view.getFloat32(offset, true),
		y: view.getFloat32(offset + 4, true),
	};
}

/** Record flag C (0x4000): point data is 16-bit integers (`EmfPlusPoint`). */
export const PLUS_FLAG_COMPRESSED = 0x4000;

/** Record flag P (0x0800): point data is relative (`EmfPlusPointR`); overrides C. */
export const PLUS_FLAG_RELATIVE = 0x0800;

/**
 * Reads one `EmfPlusPointR` coordinate at `offset` the way GDI+ decodes it
 * (measured: records encoded this way play back exactly like the absolute
 * points they stand for): ONE byte when its top bit is SET, holding a 7-bit
 * signed value, else TWO bytes, big-endian, holding a 15-bit signed value.
 * MS-EMFPLUS 2.2.2.21/22 state the top bit the other way round; GDI+ draws
 * nothing for a record encoded that way (the decoding overruns the data).
 * Returns the value and the bytes consumed, or `null` past `end`.
 */
export function readPointRCoord(view: DataView, offset: number, end: number): { value: number; size: number } | null {
	if (offset >= end) {
		return null;
	}
	const b0 = view.getUint8(offset);
	if (b0 & 0x80) {
		const v = b0 & 0x7f;
		return { value: v & 0x40 ? v - 0x80 : v, size: 1 };
	}
	if (offset + 2 > end) {
		return null;
	}
	const v = (b0 << 8) | view.getUint8(offset + 1);
	return { value: v & 0x4000 ? v - 0x8000 : v, size: 2 };
}

/**
 * Reads `count` points of an EMF+ drawing record's point data at `offset`
 * (not beyond `end`), in the encoding its flags select: relative
 * `EmfPlusPointR` deltas (flag P, each point relative to the previous one,
 * the first to (0, 0); see {@link readPointRCoord}), 16-bit integers (flag
 * C) or 32-bit floats. Returns `null` when the data ends before `count`
 * points, which GDI+ treats as an invalid record and draws nothing for.
 * Pure.
 */
export function readPlusPoints(
	view: DataView,
	offset: number,
	end: number,
	count: number,
	flags: number,
): PointCoords[] | null {
	if (!(count >= 0) || count > 1_000_000) {
		return null;
	}
	const pts: PointCoords[] = [];
	if (flags & PLUS_FLAG_RELATIVE) {
		let o = offset;
		let x = 0;
		let y = 0;
		for (let i = 0; i < count; i++) {
			const dx = readPointRCoord(view, o, end);
			if (!dx) {
				return null;
			}
			o += dx.size;
			const dy = readPointRCoord(view, o, end);
			if (!dy) {
				return null;
			}
			o += dy.size;
			x += dx.value;
			y += dy.value;
			pts.push({ x, y });
		}
		return pts;
	}
	const compressed = (flags & PLUS_FLAG_COMPRESSED) !== 0;
	const size = compressed ? 4 : 8;
	if (offset + count * size > end) {
		return null;
	}
	for (let i = 0; i < count; i++) {
		pts.push(readPointFromView(view, offset + i * size, compressed));
	}
	return pts;
}
