import { checkBudget, runSliced, yieldDue, type Budget } from './abort-budget';
import {
	EMFPLUS_SERIALIZABLEOBJECT,
	EMR_EXTCREATEFONTINDIRECTW,
	EMR_SETCOLORADJUSTMENT,
	MAX_RECORDS_DEFAULT,
	META_CREATEFONTINDIRECT,
	META_EOF,
} from './emf-constants';
import { COLOR_ADJUSTMENT_SIZE, readColorAdjustment } from './emf-gdi-color-adjust';
import { parseSerializableObject } from './emf-plus-image-effects';
import type { EmfRecordObserver } from './emf-plus-texture-predecode';
import { lazyReplayData, loadReplayData } from './replay-data';

const REPLAY_DATA_KINDS = ['johab', 'illuminants', 'chromaTies', 'colorCurve'] as const;
export type ReplayDataKind = typeof REPLAY_DATA_KINDS[number];

export interface ReplayDataOptions {
	maxRecords?: number;
	budget?: Budget | null;
}

export function observeEmfReplayData(view: DataView, options: ReplayDataOptions | undefined) {
	if (!lazyReplayData) return null;
	const needs = new Set<ReplayDataKind>();
	let scanned = 0;
	const poll = () => {
		if ((++scanned & 1023) === 0) options?.budget?.check();
	};
	const observer: EmfRecordObserver = {
		emf(type, dataOff, recordSize) {
			poll();
			if (type === EMR_EXTCREATEFONTINDIRECTW && recordSize >= 332 && view.getUint8(dataOff + 27) === 130) {
				needs.add('johab');
			} else if (type === EMR_SETCOLORADJUSTMENT && recordSize >= 8 + COLOR_ADJUSTMENT_SIZE) {
				const adjustment = readColorAdjustment(view, dataOff);
				if (adjustment && adjustment.illuminant !== 0 && adjustment.illuminant !== 6) {
					needs.add('illuminants');
				} else if (adjustment && (adjustment.colorfulness !== 0 || adjustment.redGreenTint !== 0)) {
					needs.add('chromaTies');
				}
			}
		},
		plus(type, dataOff, dataSize) {
			poll();
			if (type === EMFPLUS_SERIALIZABLEOBJECT && !needs.has('colorCurve') && parseSerializableObject(view, dataOff, dataSize)?.kind === 'colorCurve') {
				needs.add('colorCurve');
			}
		},
	};
	return { needs, observer };
}

export async function prepareEmfReplayData(needs: ReadonlySet<ReplayDataKind> | null, options: ReplayDataOptions | undefined): Promise<void> {
	if (!lazyReplayData) return;
	options?.budget?.check();
	if (needs?.size !== 0) await loadReplayData(needs ?? REPLAY_DATA_KINDS).finally(() => options?.budget?.check());
}

function* needsWmfJohab(view: DataView, start: number, maxRecords: number): Generator<void, boolean> {
	let offset = start;
	let count = 0;
	while (offset + 6 <= view.byteLength && count < maxRecords) {
		const size = view.getUint32(offset, true) * 2;
		const type = view.getUint16(offset + 4, true);
		if (size < 6 || offset + size > view.byteLength || type === META_EOF) break;
		checkBudget();
		if (yieldDue()) yield;
		if (type === META_CREATEFONTINDIRECT && size >= 24 && view.getUint8(offset + 6 + 13) === 130) return true;
		offset += size;
		count++;
	}
	return false;
}

export async function prepareWmfReplayData(view: DataView, start: number, options: ReplayDataOptions): Promise<void> {
	if (!lazyReplayData) return;
	const budget = options.budget ?? null;
	if (await runSliced(budget, needsWmfJohab(view, start, options.maxRecords ?? MAX_RECORDS_DEFAULT))) {
		await loadReplayData(['johab']).finally(() => budget?.check());
	}
}
