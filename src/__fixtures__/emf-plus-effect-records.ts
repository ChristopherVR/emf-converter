/**
 * Builders for EMF+ image effect records in tests: `EmfPlusSerializableObject`
 * data and a fixture rewrite that puts one in front of a `DrawImagePoints`.
 *
 * Test-only: lives under `__fixtures__`, is never exported from the package.
 */
import { readFileSync } from 'node:fs';

import { EMFPLUS_DRAWIMAGEPOINTS, EMFPLUS_SERIALIZABLEOBJECT, EMFPLUS_SIGNATURE, EMR_COMMENT } from '../emf-constants';
import { DRAWIMAGE_EFFECT_FLAG } from '../emf-plus-image-effects';
import { fixturePath } from './gdi-parity-harness';

/** ColorMatrixEffectGuid, as its little-endian bytes. */
export const COLOR_MATRIX_GUID = [
	0x15, 0x26, 0x8f, 0x71, 0x33, 0x79, 0xe3, 0x40, 0xa5, 0x11, 0x5f, 0x68, 0xfe, 0x14, 0xdd, 0x74,
];
/** TintEffectGuid. */
export const TINT_GUID = [0x00, 0xaf, 0x77, 0x10, 0x48, 0x28, 0x41, 0x44, 0x94, 0x89, 0x44, 0xad, 0x4c, 0x2d, 0x7a, 0x2c];
/** BlurEffectGuid. */
export const BLUR_GUID = [0xa4, 0x80, 0x3c, 0x63, 0x43, 0x18, 0x2b, 0x48, 0x9e, 0xf2, 0xbe, 0x28, 0x34, 0xc5, 0xfd, 0xd4];

/** An EmfPlusSerializableObject record's data: GUID, BufferSize, buffer. */
export function serializableObject(guid: number[], buffer: Uint8Array): Uint8Array {
	const out = new Uint8Array(20 + buffer.length);
	out.set(guid, 0);
	new DataView(out.buffer).setUint32(16, buffer.length, true);
	out.set(buffer, 20);
	return out;
}

/** A ColorMatrix effect (25 floats, row-major). */
export function colorMatrixObject(m: number[]): Uint8Array {
	const buf = new Uint8Array(100);
	const v = new DataView(buf.buffer);
	m.forEach((x, i) => v.setFloat32(4 * i, x, true));
	return serializableObject(COLOR_MATRIX_GUID, buf);
}

/** A Blur effect. */
export function blurObject(radius: number, expandEdge: boolean): Uint8Array {
	const buf = new Uint8Array(8);
	const v = new DataView(buf.buffer);
	v.setFloat32(0, radius, true);
	v.setUint32(4, expandEdge ? 1 : 0, true);
	return serializableObject(BLUR_GUID, buf);
}

/** A fixture's bytes as a standalone ArrayBuffer. */
export function fixtureBuffer(name: string): ArrayBuffer {
	const b = readFileSync(fixturePath(name));
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/**
 * Rewrites a fixture so that a SerializableObject record carrying `effect`
 * precedes its first DrawImagePoints record, which gets flag E (unless
 * `flagE` is false) and, when `srcRect` is given, that source rectangle
 * (x, y, width, height in image pixels).
 */
export function withEffect(
	name: string,
	effect: Uint8Array,
	flagE = true,
	srcRect?: [number, number, number, number],
): ArrayBuffer {
	const src = new Uint8Array(readFileSync(fixturePath(name)));
	const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
	const inserted = 12 + effect.length;
	for (let off = 0; off + 8 <= src.length; ) {
		const size = v.getUint32(off + 4, true);
		if (v.getUint32(off, true) === EMR_COMMENT && v.getUint32(off + 12, true) === EMFPLUS_SIGNATURE) {
			const end = off + 12 + v.getUint32(off + 8, true);
			for (let p = off + 16; p + 12 <= end; p += v.getUint32(p + 4, true)) {
				if (v.getUint16(p, true) !== EMFPLUS_DRAWIMAGEPOINTS) {
					continue;
				}
				const out = new Uint8Array(src.length + inserted);
				out.set(src.subarray(0, p), 0);
				out.set(src.subarray(p), p + inserted);
				const o = new DataView(out.buffer);
				o.setUint16(p, EMFPLUS_SERIALIZABLEOBJECT, true);
				o.setUint16(p + 2, 0, true);
				o.setUint32(p + 4, inserted, true);
				o.setUint32(p + 8, effect.length, true);
				out.set(effect, p + 12);
				const draw = p + inserted;
				if (flagE) {
					o.setUint16(draw + 2, o.getUint16(draw + 2, true) | DRAWIMAGE_EFFECT_FLAG, true);
				}
				if (srcRect) {
					srcRect.forEach((x, i) => o.setFloat32(draw + 12 + 8 + 4 * i, x, true));
				}
				o.setUint32(off + 4, size + inserted, true);
				o.setUint32(off + 8, v.getUint32(off + 8, true) + inserted, true);
				o.setUint32(48, out.length, true);
				return out.buffer;
			}
		}
		off += size;
	}
	throw new Error(`${name}: no DrawImagePoints record`);
}
