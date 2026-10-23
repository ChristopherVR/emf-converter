import { describe, expect, it } from 'vitest';
import * as K from './emf-constants';
import { recordNameTables } from './metafile-record-names';

describe('metafile record names', () => {
	it('match the constants in emf-constants.ts exactly', () => {
		const expectedEmr = new Map<number, string>();
		const expectedMeta = new Map<number, string>();
		const expectedPlus = new Map<number, string>();
		for (const [key, value] of Object.entries(K)) {
			if (typeof value !== 'number') {
				continue;
			}
			if (key.startsWith('EMR_') && !key.startsWith('EMR_COMMENT_')) {
				expectedEmr.set(value, key);
			} else if (key.startsWith('META_')) {
				expectedMeta.set(value, key);
			} else if (key.startsWith('EMFPLUS_') && value >= 0x4001 && value <= 0x403f) {
				expectedPlus.set(value, key);
			}
		}
		const { emr, meta, plus } = recordNameTables();
		expect(emr).toEqual(expectedEmr);
		expect(meta).toEqual(expectedMeta);
		expect(plus).toEqual(expectedPlus);
		expect(emr.size).toBeGreaterThan(100);
	});
});
