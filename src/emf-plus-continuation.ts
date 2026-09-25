/**
 * Reassembly of EMF+ objects split across several `EMFPLUS_OBJECT` records.
 *
 * An object too large for one EMF+ record (in practice, one whose data
 * would push its `EMR_COMMENT` past GDI+'s ~64 KiB comment limit, such as a
 * TextureFill brush or Image holding a sizeable bitmap) is written as a run
 * of records sharing one object id, each with the continuation bit
 * (`0x8000`) set, the last one typically with it clear. Per [MS-EMFPLUS]
 * 2.3.5.1 each continued record's data starts with a 4-byte
 * `TotalObjectSize` (the size of the whole assembled object) before its
 * chunk of object bytes; the run usually spans several `EMR_COMMENT`
 * records.
 *
 * {@link feedEmfPlusObjectRecord} is the single implementation of that
 * reassembly, shared by the replay pass (`emf-plus-replay.ts`) and the async
 * texture pre-decode pass (`emf-plus-texture-predecode.ts`) so both see
 * byte-identical assembled objects, and both key a pre-decoded texture by
 * the same {@link AssembledEmfPlusObject.cacheKey}. It is deliberately
 * lenient about the two layouts seen in the wild:
 *
 * - A chunk's leading `TotalObjectSize` is skipped only when it actually
 *   equals the run's total (so a writer that omits it on later chunks, or on
 *   the final continuation-bit-clear chunk, still assembles correctly).
 * - The object completes as soon as `TotalObjectSize` bytes have arrived,
 *   whether or not the final chunk clears the continuation bit.
 *
 * @module emf-plus-continuation
 */

import { emfWarn } from './emf-logging';
import type { EmfPlusReplayCtx } from './emf-types';

/** Hard cap on one assembled object (64 MiB). */
const MAX_CONTINUATION_BYTES = 64 * 1024 * 1024;

/**
 * In-progress reassembly state. Structurally the continuation fields of
 * {@link EmfPlusReplayCtx}, so the replay context itself can be fed; the
 * replay persists it in `EmfPlusState.continuation` because a run spans
 * several `EMR_COMMENT` records, each replayed with a fresh context.
 */
export type ContinuationAccumulator = Pick<
	EmfPlusReplayCtx,
	| 'continuationBuffer'
	| 'continuationObjectId'
	| 'continuationObjectType'
	| 'continuationTotalSize'
	| 'continuationOffset'
	| 'continuationKey'
>;

/** A fresh, idle {@link ContinuationAccumulator}. */
export function createContinuationAccumulator(): ContinuationAccumulator {
	return {
		continuationBuffer: null,
		continuationObjectId: -1,
		continuationObjectType: 0,
		continuationTotalSize: 0,
		continuationOffset: 0,
		continuationKey: undefined,
	};
}

/** A complete EMF+ object, ready for `handleEmfPlusObjectRecord`. */
export interface AssembledEmfPlusObject {
	/** The bytes holding the object (the original view, or the assembled buffer). */
	view: DataView;
	/** Record flags with the continuation bit cleared (object type and id). */
	flags: number;
	/** Offset of the object data within {@link view}. */
	dataOff: number;
	/** Size of the object data. */
	dataSize: number;
	/**
	 * A key identifying this object instance across passes over the same
	 * metafile: the `dataOff` (in the original buffer) of its only record, or
	 * of the FIRST record of a continuation run.
	 */
	cacheKey: number;
}

function reset(acc: ContinuationAccumulator): void {
	acc.continuationBuffer = null;
	acc.continuationObjectId = -1;
	acc.continuationObjectType = 0;
	acc.continuationTotalSize = 0;
	acc.continuationOffset = 0;
	acc.continuationKey = undefined;
}

/** Appends one chunk, skipping a leading `TotalObjectSize` when present. */
function append(acc: ContinuationAccumulator, view: DataView, dataOff: number, recDataSize: number): void {
	const buffer = acc.continuationBuffer;
	if (!buffer) {
		return;
	}
	let start = dataOff;
	let size = recDataSize;
	if (size >= 4 && view.getUint32(dataOff, true) === acc.continuationTotalSize) {
		start += 4;
		size -= 4;
	}
	const n = Math.max(0, Math.min(size, acc.continuationTotalSize - acc.continuationOffset));
	buffer.set(new Uint8Array(view.buffer, view.byteOffset + start, n), acc.continuationOffset);
	acc.continuationOffset += n;
}

/** Hands out the finished object and resets `acc`. */
function finish(acc: ContinuationAccumulator, objectId: number): AssembledEmfPlusObject | null {
	const buffer = acc.continuationBuffer;
	const out: AssembledEmfPlusObject | null = buffer
		? {
				view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength),
				flags: (acc.continuationObjectType << 8) | objectId,
				dataOff: 0,
				dataSize: acc.continuationTotalSize,
				cacheKey: acc.continuationKey ?? -1,
			}
		: null;
	reset(acc);
	return out;
}

/**
 * Feeds one `EMFPLUS_OBJECT` record (`dataOff`/`recDataSize` within `view`)
 * to the reassembly. Returns the complete object when this record is a
 * self-contained object or completes a continuation run, otherwise `null`
 * (the record was a chunk of a run still in progress, or was rejected).
 */
export function feedEmfPlusObjectRecord(
	acc: ContinuationAccumulator,
	view: DataView,
	recFlags: number,
	dataOff: number,
	recDataSize: number,
): AssembledEmfPlusObject | null {
	const isContinuation = (recFlags & 0x8000) !== 0;
	const objectId = recFlags & 0xff;
	const inRun = acc.continuationBuffer !== null && objectId === acc.continuationObjectId;

	if (!isContinuation && !inRun) {
		return { view, flags: recFlags, dataOff, dataSize: recDataSize, cacheKey: dataOff };
	}

	if (isContinuation && !inRun) {
		// First chunk of a new run (any unfinished run for another id is dropped).
		if (acc.continuationBuffer !== null) {
			emfWarn(`EMFPLUS_OBJECT continuation: object ${acc.continuationObjectId} never completed, dropping it`);
		}
		reset(acc);
		if (recDataSize < 4) {
			return null;
		}
		const totalSize = view.getUint32(dataOff, true);
		const remaining = view.byteLength - dataOff;
		if (totalSize <= 0 || totalSize > MAX_CONTINUATION_BYTES || totalSize > remaining) {
			emfWarn(
				`EMFPLUS_OBJECT continuation: rejecting invalid totalObjectSize=${totalSize} (remaining=${remaining}, recDataSize=${recDataSize})`,
			);
			return null;
		}
		acc.continuationBuffer = new Uint8Array(totalSize);
		acc.continuationObjectId = objectId;
		acc.continuationObjectType = (recFlags >> 8) & 0x7f;
		acc.continuationTotalSize = totalSize;
		acc.continuationOffset = 0;
		acc.continuationKey = dataOff;
	}

	append(acc, view, dataOff, recDataSize);
	if (!isContinuation || acc.continuationOffset >= acc.continuationTotalSize) {
		return finish(acc, objectId);
	}
	return null;
}
