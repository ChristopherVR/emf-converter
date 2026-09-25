/**
 * Builds tiny synthetic raster fonts for the `.fon` / `.fnt` tests: bare
 * FNT 2.0 resources and an NE (`.fon`) container holding several of them.
 * Every glyph is a solid box one pixel narrower than its advance, so the
 * rendered pixels are easy to predict.
 *
 * @module test-fnt
 */

/** One raster size of the synthetic "Test Raster" family. */
export interface TestFntSpec {
	/** Cell height in pixels. */
	pixHeight: number;
	ascent: number;
	internalLeading: number;
	/** Advance of every character. */
	width: number;
	weight?: number;
	family?: string;
}

/** A bare FNT 2.0 resource covering characters 0x20..0x7E. */
export function buildTestFnt(spec: TestFntSpec): Uint8Array {
	const first = 0x20;
	const last = 0x7e;
	const count = last - first + 2; // plus the sentinel entry
	const tableOff = 118;
	const cols = Math.ceil(spec.width / 8);
	const glyphBytes = cols * spec.pixHeight;
	const bitsOff = tableOff + count * 4;
	const faceOff = bitsOff + count * glyphBytes;
	const family = spec.family ?? 'Test Raster';
	const size = faceOff + family.length + 1;
	const out = new Uint8Array(size);
	const v = new DataView(out.buffer);
	v.setUint16(0, 0x200, true);
	v.setUint32(2, size, true);
	v.setUint16(66, 0, true); // dfType: raster
	v.setUint16(68, Math.round((spec.pixHeight - spec.internalLeading) * 0.75), true);
	v.setUint16(70, 96, true);
	v.setUint16(72, 96, true);
	v.setUint16(74, spec.ascent, true);
	v.setUint16(76, spec.internalLeading, true);
	v.setUint16(83, spec.weight ?? 400, true);
	v.setUint8(85, 0);
	v.setUint16(88, spec.pixHeight, true);
	v.setUint16(91, spec.width, true);
	v.setUint16(93, spec.width, true);
	v.setUint8(95, first);
	v.setUint8(96, last);
	v.setUint8(97, 0x3f - first); // default '?'
	v.setUint8(98, 0x20 - first);
	v.setUint32(105, faceOff, true);
	for (let i = 0; i < count; i++) {
		const off = bitsOff + i * glyphBytes;
		v.setUint16(tableOff + i * 4, spec.width, true);
		v.setUint16(tableOff + i * 4 + 2, off, true);
		const code = first + i;
		if (code === 0x20 || i === count - 1) {
			continue; // blank space and sentinel
		}
		// A box: columns 0..width-2, rows from the top of the em to the baseline.
		for (let x = 0; x < spec.width - 1; x++) {
			for (let y = spec.internalLeading; y < spec.ascent; y++) {
				out[off + (x >> 3) * spec.pixHeight + y] |= 0x80 >> (x & 7);
			}
		}
	}
	for (let i = 0; i < family.length; i++) {
		out[faceOff + i] = family.charCodeAt(i);
	}
	return out;
}

/** An NE `.fon` container holding the given FNT resources. */
export function buildTestFon(fnts: Uint8Array[]): Uint8Array {
	const ne = 0x40;
	const rtOff = 0x40; // resource table, relative to the NE header
	const shift = 4;
	const align = 1 << shift;
	const tableSize = 2 + 8 + fnts.length * 12 + 2;
	let dataStart = Math.ceil((ne + rtOff + tableSize) / align) * align;
	const offsets: number[] = [];
	for (const f of fnts) {
		offsets.push(dataStart);
		dataStart += Math.ceil(f.length / align) * align;
	}
	const out = new Uint8Array(dataStart);
	const v = new DataView(out.buffer);
	v.setUint16(0, 0x5a4d, true); // 'MZ'
	v.setUint32(0x3c, ne, true);
	v.setUint16(ne, 0x454e, true); // 'NE'
	v.setUint16(ne + 0x24, rtOff, true);
	let p = ne + rtOff;
	v.setUint16(p, shift, true);
	p += 2;
	v.setUint16(p, 0x8008, true); // RT_FONT
	v.setUint16(p + 2, fnts.length, true);
	p += 8;
	fnts.forEach((f, i) => {
		v.setUint16(p, offsets[i] >> shift, true);
		v.setUint16(p + 2, Math.ceil(f.length / align), true);
		out.set(f, offsets[i]);
		p += 12;
	});
	v.setUint16(p, 0, true);
	return out;
}
