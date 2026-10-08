import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';

// The interpreter's runaway-program guard (a million instructions) counts one program, not the lifetime of a size.
// It used to accumulate, so after about a million instructions' worth of glyphs every later glyph of that size
// aborted at its first instruction and came back with its unhinted outline.
describe('TrueType instruction budget', () => {
	const font = parseFontFile(readFileSync(new URL('./__fixtures__/gdi/opcode-mdrp.ttf', import.meta.url)))[0];

	it('hints the same glyph identically before and after a million instructions have run at that size', () => {
		const size = new HintedSize(font, 23, 23, { version: 35, grayscale: false });
		const first = size.hintGlyph(1);
		let executed = 0;
		const internals = size as unknown as { step: (op: number, code: Uint8Array, ip: number) => boolean };
		const step = internals.step.bind(size);
		internals.step = (op, code, ip) => { executed++; return step(op, code, ip); };
		// About ten instructions per call: a little over a million in all.
		for (let i = 0; i < 120000; i++) size.hintGlyph(1);
		const later = size.hintGlyph(1);
		expect(Array.from(later.xs)).toEqual(Array.from(first.xs));
		expect(Array.from(later.ys)).toEqual(Array.from(first.ys));
		// The program moved something: the outline really is the hinted one, not the unhinted scaling.
		const unhinted = new HintedSize(font, 23, 23, { version: 35, grayscale: false }, false).hintGlyph(1);
		expect([Array.from(first.xs), Array.from(first.ys)]).not.toEqual([Array.from(unhinted.xs), Array.from(unhinted.ys)]);
	});
});
