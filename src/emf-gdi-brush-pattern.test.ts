import { describe, it, expect } from 'vitest';

import { cssHexToRgb, hatchBit, realizeBrush, sampleTile } from './emf-gdi-brush-pattern';
import { defaultState } from './emf-types';

describe('hatchBit', () => {
	it('draws HS_HORIZONTAL on row 3 and HS_VERTICAL on column 4, as Windows does', () => {
		for (let i = 0; i < 8; i++) {
			expect(hatchBit(0, i, 3)).toBe(true);
			expect(hatchBit(0, i, 2)).toBe(false);
			expect(hatchBit(1, 4, i)).toBe(true);
			expect(hatchBit(1, 3, i)).toBe(false);
		}
	});

	it('runs HS_FDIAGONAL top-left to bottom-right and HS_BDIAGONAL the other way', () => {
		expect(hatchBit(2, 0, 0)).toBe(true);
		expect(hatchBit(2, 7, 7)).toBe(true);
		expect(hatchBit(3, 7, 0)).toBe(true);
		expect(hatchBit(3, 0, 7)).toBe(true);
		expect(hatchBit(3, 0, 0)).toBe(false);
	});
});

describe('realizeBrush', () => {
	it('realises a solid brush to its packed colour', () => {
		const state = { ...defaultState(), brushColor: '#123456' };
		expect(realizeBrush(state)).toEqual({ kind: 'solid', rgb: 0x123456 });
	});

	it('realises a null brush to nothing', () => {
		expect(realizeBrush({ ...defaultState(), brushStyle: 1 })).toEqual({ kind: 'none' });
	});

	it('paints a hatch in the brush colour over the DC background colour', () => {
		const state = {
			...defaultState(),
			brushColor: '#ff0000',
			bkColor: '#00ff00',
			brushPattern: { kind: 'hatch' as const, hatch: 0 },
		};
		const tile = realizeBrush(state);
		expect(tile.kind).toBe('tile');
		if (tile.kind === 'tile') {
			expect(tile.rgb[3 * 8]).toBe(0xff0000);
			expect(tile.rgb[0]).toBe(0x00ff00);
		}
	});

	it('paints a monochrome pattern as 0 = text colour, 1 = background colour', () => {
		const state = {
			...defaultState(),
			textColor: '#010203',
			bkColor: '#0a0b0c',
			brushPattern: { kind: 'mono' as const, width: 2, height: 1, bits: new Uint8Array([0, 1]) },
		};
		const tile = realizeBrush(state);
		expect(tile.kind === 'tile' ? Array.from(tile.rgb) : []).toEqual([0x010203, 0x0a0b0c]);
	});
});

describe('sampleTile', () => {
	it('anchors the tile at the brush origin and wraps negative offsets', () => {
		const tile = { width: 2, height: 2, rgb: new Uint32Array([1, 2, 3, 4]) };
		expect(sampleTile(tile, 3, 5, 3, 5)).toBe(1);
		expect(sampleTile(tile, 2, 5, 3, 5)).toBe(2);
		expect(sampleTile(tile, 3, 4, 3, 5)).toBe(3);
	});
});

describe('cssHexToRgb', () => {
	it('parses long and short hex, and falls back to black', () => {
		expect(cssHexToRgb('#a1b2c3')).toBe(0xa1b2c3);
		expect(cssHexToRgb('#abc')).toBe(0xaabbcc);
		expect(cssHexToRgb('rgba(1,2,3,1)')).toBe(0);
	});
});
