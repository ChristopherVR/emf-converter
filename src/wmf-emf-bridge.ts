/**
 * Plays WMF operations through the EMF record handlers.
 *
 * Many WMF records are the 16-bit form of an EMF record with the same
 * meaning (a polygon, a line, a text run, a bitmap blit). Rather than a
 * second implementation of each, the WMF player writes the equivalent EMF
 * record into a scratch buffer ({@link EmfRecordWriter}) and dispatches it
 * to the EMF handlers against the same replay context, so both formats
 * share one exact implementation: the GDI rasteriser, the ROP3 blit
 * evaluator, the font engine, SVG output and the software canvas alike.
 *
 * @module wmf-emf-bridge
 */

import { handleEmfGdiDrawRecord } from './emf-gdi-draw-handlers';
import { handleEmfGdiPolyPathRecord } from './emf-gdi-poly-path-handlers';
import { flushRasterLayer, isLayerSafeRecord } from './emf-gdi-raster-layer';
import { handleEmfGdiStateRecord } from './emf-gdi-state-handlers';
import type { EmfGdiReplayCtx } from './emf-types';

/** Builds one EMF record (type, size, then little-endian fields). */
export class EmfRecordWriter {
	private bytes: Uint8Array;
	private view: DataView;
	private len = 8;

	constructor(
		private readonly type: number,
		capacity = 64,
	) {
		this.bytes = new Uint8Array(Math.max(16, capacity));
		this.view = new DataView(this.bytes.buffer);
	}

	private ensure(n: number): void {
		if (this.len + n <= this.bytes.length) {
			return;
		}
		const next = new Uint8Array(Math.max(this.bytes.length * 2, this.len + n));
		next.set(this.bytes);
		this.bytes = next;
		this.view = new DataView(next.buffer);
	}

	/** Current length in bytes (the offset the next field is written at). */
	get offset(): number {
		return this.len;
	}

	i32(v: number): this {
		this.ensure(4);
		this.view.setInt32(this.len, v | 0, true);
		this.len += 4;
		return this;
	}

	u32(v: number): this {
		this.ensure(4);
		this.view.setUint32(this.len, v >>> 0, true);
		this.len += 4;
		return this;
	}

	i16(v: number): this {
		this.ensure(2);
		this.view.setInt16(this.len, v, true);
		this.len += 2;
		return this;
	}

	u16(v: number): this {
		this.ensure(2);
		this.view.setUint16(this.len, v & 0xffff, true);
		this.len += 2;
		return this;
	}

	f32(v: number): this {
		this.ensure(4);
		this.view.setFloat32(this.len, v, true);
		this.len += 4;
		return this;
	}

	/** Appends raw bytes. */
	raw(src: Uint8Array): this {
		this.ensure(src.length);
		this.bytes.set(src, this.len);
		this.len += src.length;
		return this;
	}

	/** Pads to a multiple of four bytes. */
	align(): this {
		while (this.len % 4 !== 0) {
			this.ensure(1);
			this.bytes[this.len++] = 0;
		}
		return this;
	}

	/** Overwrites the u32 at byte `at` (for offsets known only later). */
	patchU32(at: number, v: number): this {
		this.view.setUint32(at, v >>> 0, true);
		return this;
	}

	/** The finished record. */
	finish(): DataView {
		this.align();
		this.view.setUint32(0, this.type, true);
		this.view.setUint32(4, this.len, true);
		return new DataView(this.bytes.buffer, 0, this.len);
	}
}

/**
 * Dispatches the EMF record `record` (as built by {@link EmfRecordWriter})
 * to the EMF handlers on `rCtx`, flushing the exact-pixel layer first when
 * the record is not layer-safe, exactly as the EMF replay loop does.
 */
export function playEmfRecord(rCtx: EmfGdiReplayCtx, record: DataView): void {
	const type = record.getUint32(0, true);
	const size = record.getUint32(4, true);
	if (!isLayerSafeRecord(type)) {
		flushRasterLayer(rCtx);
	}
	const saved = rCtx.view;
	rCtx.view = record;
	try {
		if (!handleEmfGdiStateRecord(rCtx, type, 0, 8, size) && !handleEmfGdiDrawRecord(rCtx, type, 0, 8, size)) {
			handleEmfGdiPolyPathRecord(rCtx, type, 0, 8, size);
		}
	} finally {
		rCtx.view = saved;
	}
}
