import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { nativeCurveLookup } from './emf-plus-image-curves';
import { describe, expect, it } from 'vitest';
import { applyImageEffect as applyNativeEffect, applyBlur, parseSerializableObject as parseImageEffect, levelsLut, sharpenGain, type EmfPlusImageEffect } from './emf-plus-image-effects';
const applyImageEffect = (source: Uint8ClampedArray, effect: EmfPlusImageEffect) => applyNativeEffect(source, 16, 16, effect)!;
const greyRamp = Uint8ClampedArray.from(Array.from({ length: 1024 }, (_, i) => i % 4 === 3 ? 255 : Math.floor(i / 4)));

import { replayEmfPlusRecords } from './emf-plus-replay';
import { createEmfPlusState } from './emf-types';
import { ensureNodeCanvasModule } from './emf-canvas-helpers';
import { SvgContext } from './svg-context';
import { svgTreeToString } from './svg-tree';
import { decodePng } from './png-decoder';

function nativeCase(name: string) {
	const data = JSON.parse(readFileSync(new URL(`./__fixtures__/gdi/effect-${name}.json`, import.meta.url), 'utf8')) as Record<string, string>;
	const params = Buffer.from(data.parameters, 'base64');
	const bytes = new Uint8Array(20 + params.length);
	const view = new DataView(bytes.buffer);
	const guid = data.guid.split('-');
	view.setUint32(0, parseInt(guid[0], 16), true);
	view.setUint16(4, parseInt(guid[1], 16), true);
	view.setUint16(6, parseInt(guid[2], 16), true);
	bytes.set(Buffer.from(guid[3] + guid[4], 'hex'), 8);
	view.setUint32(16, params.length, true);
	bytes.set(params, 20);
	return { view, source: new Uint8ClampedArray(Buffer.from(data.source, 'base64')), expected: Buffer.from(data.expected, 'base64') };
}

describe('EMF+ image effects', () => {
	it('matches native blur across tall, narrow and square buffers through radius 16', () => {
		const cases = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/effect-blur-dimensions.json', import.meta.url), 'utf8'));
		for (const c of cases) {
			if (c.radius > 16) continue;
			for (const pattern of ['ramp', 'impulse']) {
				const source = new Uint8ClampedArray(c.width * c.height * 4);
				for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
					const grey = (y * c.width + x) & 255;
					source.set(pattern === 'ramp' ? [grey, grey, grey, 255] : [x === 0 ? 255 : 0, x === c.width / 2 - 1 ? 255 : 0, x === c.width - 1 ? 255 : 0, 255], (y * c.width + x) * 4);
				}
				const actual = applyBlur(source, c.width, c.height, c.radius);
				const expected = Buffer.from(c[pattern], 'base64');
				let maxDiff = 0;
				for (let i = 0; i < actual.length; i++) maxDiff = Math.max(maxDiff, Math.abs(actual[i] - expected[i]));
				expect(maxDiff, `${c.width}x${c.height} radius=${c.radius} ${pattern}`).toBeLessThanOrEqual(pattern === 'impulse' ? 0 : 1);
			}
		}
	});
	it('matches native blur colour impulses at 14 radii from 0.25 through 10', () => {
		const sweep = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/effect-sharpen-sweep.json', import.meta.url), 'utf8'));
		const source = new Uint8ClampedArray(1024);
		for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
			source.set([x === 0 ? 255 : 0, x === 7 ? 255 : 0, x === 15 ? 255 : 0, 255], (y * 16 + x) * 4);
		}
		for (let r = 0; r < sweep.radii.length && sweep.radii[r] <= 10; r++) {
			expect(Array.from(applyBlur(source, 16, 16, sweep.radii[r])), `radius=${sweep.radii[r]}`).toEqual(Array.from(Buffer.from(sweep.impulseBlur[r], 'base64')));
		}
	});
	it('matches native sharpen strength for every integer amount and 19 radii', () => {
		const sweep = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/effect-sharpen-sweep.json', import.meta.url), 'utf8'));
		const amounts = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/effect-sharpen-amounts.json', import.meta.url), 'utf8'));
		const expectedAmounts = Buffer.from(amounts.expected, 'base64');
		const check = (radius: number, amount: number, blur: Buffer, expected: Buffer) => {
			// Isolate strength from convolution using Windows' own blurred pixels.
			const gain = sharpenGain(radius, amount);
			const actual = Uint8ClampedArray.from(greyRamp, (v, i) => i % 4 === 3 ? v : Math.round(v + gain * (v - blur[i])));
			expect(Array.from(actual), `radius=${radius}, amount=${amount}`).toEqual(Array.from(expected));
		};
		for (let r = 0; r < sweep.radii.length; r++) {
			const blur = Buffer.from(sweep.blur[r], 'base64');
			for (let a = 0; a < sweep.amounts.length; a++) {
				check(sweep.radii[r], sweep.amounts[a], blur, Buffer.from(sweep.expected[r * sweep.amounts.length + a], 'base64'));
			}
		}
		const blur = Buffer.from(sweep.blur[sweep.radii.indexOf(amounts.radius)], 'base64');
		for (let amount = 0; amount <= 100; amount++) check(amounts.radius, amount, blur, expectedAmounts.subarray(amount * 1024, (amount + 1) * 1024));
	});
	it.each(['matrix-swap', 'matrix-mix', 'lookup', 'balance-0', 'balance-1', 'balance-2', 'balance-3', 'balance-4', ...Array.from({ length: 8 }, (_, i) => `curve-${i}`), ...Array.from({ length: 5 }, (_, i) => `levels-${i}`)])('matches native GDI+ %s pixels', (name) => {
		const { view, source, expected } = nativeCase(name);
		const original = source.slice();
		const effect = parseImageEffect(view, 0, view.byteLength)!;
		expect(effect).not.toBeNull();
		const actual = applyImageEffect(source, effect);
		const differences = Array.from(actual, (v, i) => Math.abs(v - expected[i]));
		// GDI+'s arbitrary fractional matrix coefficients retain rounding ties.
		// Channel permutations and lookup tables must be byte-exact.
		expect(Math.max(...differences)).toBeLessThanOrEqual(name === 'matrix-mix' ? 1 : 0);
		expect(differences.filter(Boolean)).toHaveLength(name === 'matrix-mix' ? 21 : 0);
		expect(source).toEqual(original);
	});
	it('preserves every Windows colour-curve lookup across the complete parameter ranges', () => {
		const hashes = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/effect-curve-hashes.json', import.meta.url), 'utf8'));
		for (let curve = 0; curve < 8; curve++) {
			const min = curve < 2 ? -255 : curve < 6 ? -100 : curve === 6 ? 1 : 0;
			const max = curve === 7 ? 254 : curve < 2 || curve === 6 ? 255 : 100;
			const hash = createHash('sha256');
			for (let intensity = min; intensity <= max; intensity++) hash.update(nativeCurveLookup(curve, intensity));
			expect(hash.digest('hex')).toBe(hashes[curve]);
		}
	});
	it('selects curve channels and rejects invalid adjustment parameters', () => {
		const { view, source } = nativeCase('curve-0');
		for (let channel = 1; channel <= 3; channel++) {
			view.setUint32(24, channel, true);
			const pixels = applyImageEffect(source, parseImageEffect(view, 0, view.byteLength)!);
			for (let o = 0; o < source.length; o += 4) for (let ch = 0; ch < 4; ch++) {
				if (ch !== channel - 1) expect(pixels[o + ch]).toBe(source[o + ch]);
			}
		}
		view.setUint32(20, 8, true);
		expect(parseImageEffect(view, 0, view.byteLength)).toBeNull();
		view.setUint32(20, 6, true); view.setInt32(28, 0, true);
		expect(parseImageEffect(view, 0, view.byteLength)).toBeNull();
		view.setUint32(20, 7, true); view.setInt32(28, 255, true);
		expect(parseImageEffect(view, 0, view.byteLength)).toBeNull();
	});
	it('matches 1,010 mixed levels settings, endpoints and inversions against Windows', () => {
		const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/effect-levels-sweep.json', import.meta.url), 'utf8')) as { settings: number[][]; expected: string };
		const expected = inflateSync(Buffer.from(fixture.expected, 'base64'));
		const { view } = nativeCase('levels-0');
		let differences = 0;
		let maximumDifference = 0;
		fixture.settings.forEach((setting, i) => {
			setting.forEach((value, ch) => view.setInt32(20 + ch * 4, value, true));
			const effect = parseImageEffect(view, 0, view.byteLength)!;
			expect(effect.kind).toBe('levels');
			if (effect.kind !== 'levels') throw new Error('Expected a levels effect');
			const lut = levelsLut(effect.highlight, effect.midtone, effect.shadow);
			for (let value = 0; value < 256; value++) {
				const diff = Math.abs(lut[value] - expected[i * 256 + value]);
				maximumDifference = Math.max(maximumDifference, diff);
				if (diff) differences++;
			}
		});
		expect(maximumDifference).toBeLessThanOrEqual(1);
		expect(differences).toBe(1);
	});
	it('rejects truncated and nonfinite parameters', () => {
		const { view } = nativeCase('matrix-swap');
		expect(parseImageEffect(view, 0, view.byteLength - 1)).toBeNull();
		view.setFloat32(20, NaN, true);
		expect(parseImageEffect(view, 0, view.byteLength)).toBeNull();
	});
	it('bounds a SerializableObject to its own record and clears an earlier effect on malformed data', () => {
		const { view } = nativeCase('matrix-swap');
		const record = new DataView(new ArrayBuffer(12 + view.byteLength));
		record.setUint16(0, 0x4038, true);
		record.setUint32(4, record.byteLength, true);
		record.setUint32(8, view.byteLength, true);
		new Uint8Array(record.buffer).set(new Uint8Array(view.buffer), 12);
		const state = createEmfPlusState();
		const ctx = new SvgContext(16, 16);
		replayEmfPlusRecords(record, 0, record.byteLength, ctx as never, 16, 16, state);
		expect(state.ext?.pendingEffect?.kind).toBe('colorMatrix');
		// DataSize claims an entire effect, but Size ends the record after its GUID.
		record.setUint32(4, 32, true);
		replayEmfPlusRecords(record, 0, record.byteLength, ctx as never, 16, 16, state);
		expect(state.ext?.pendingEffect).toBeNull();
	});
	it('matches every colour-balance setting and input channel level against Windows', () => {
		const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/gdi/effect-balance-sweep.json', import.meta.url), 'utf8'));
		const expected = Buffer.from(fixture.expected, 'base64');
		const { view } = nativeCase('balance-0');
		for (let balance = -100; balance <= 100; balance++) {
			for (let ch = 0; ch < 3; ch++) view.setInt32(20 + ch * 4, balance, true);
			const effect = parseImageEffect(view, 0, view.byteLength)!;

			for (let ch = 0; ch < 3; ch++) {
				expect(Array.from(applyNativeEffect(greyRamp, 256, 1, effect)!).filter((_, i) => i % 4 === ch)).toEqual(Array.from(expected.subarray((balance + 100) * 256, (balance + 101) * 256)));
			}
		}
	});

	it('replays effects across comments, honours flag E, and preserves cached images in PNG and SVG', async () => {
		await ensureNodeCanvasModule();
		const { createCanvas } = await import('@napi-rs/canvas');
		const native = nativeCase('matrix-swap');
		const effectRecord = new DataView(new ArrayBuffer(12 + native.view.byteLength));
		effectRecord.setUint16(0, 0x4038, true);
		effectRecord.setUint32(4, effectRecord.byteLength, true);
		effectRecord.setUint32(8, native.view.byteLength, true);
		new Uint8Array(effectRecord.buffer).set(new Uint8Array(native.view.buffer), 12);
		const drawRecord = new DataView(new ArrayBuffer(64));
		drawRecord.setUint16(0, 0x401b, true);
		drawRecord.setUint16(2, 0x2000, true);
		drawRecord.setUint32(4, 64, true);
		drawRecord.setUint32(8, 52, true);
		drawRecord.setUint32(12, 0xffffffff, true);
		drawRecord.setUint32(16, 2, true);
		drawRecord.setFloat32(28, 16, true);
		drawRecord.setFloat32(32, 8, true);
		drawRecord.setUint32(36, 3, true);
		drawRecord.setFloat32(48, 16, true);
		drawRecord.setFloat32(60, 8, true);
		const source = native.source.slice(0, 16 * 8 * 4);
		for (const svg of [false, true]) {
			const ctx = svg ? new SvgContext(16, 8) : createCanvas(16, 8).getContext('2d');
			const state = createEmfPlusState();
			state.interpolationMode = 5; // nearest neighbour
			state.pixelOffsetMode = 0;
			state.objectTable.set(0, { kind: 'plus-image', type: 1, data: new ArrayBuffer(4), cacheKey: 1 });
			state.imageCache = new Map([[1, { kind: 'bitmap', width: 16, height: 8, rgba: source }]]);
			replayEmfPlusRecords(effectRecord, 0, effectRecord.byteLength, ctx as never, 16, 8, state);
			expect(replayEmfPlusRecords(drawRecord, 0, drawRecord.byteLength, ctx as never, 16, 8, state)).toEqual([]);
			if (ctx instanceof SvgContext) {
				const markup = svgTreeToString(await ctx.toTree());
				const encoded = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(markup);
				expect(encoded).not.toBeNull();
				const pixels = await decodePng(Buffer.from(encoded![1], 'base64'));
				expect(Array.from(pixels!.data)).toEqual(Array.from(native.expected.subarray(0, source.length)));
			} else {
				expect(Array.from(ctx.getImageData(0, 0, 16, 8).data)).toEqual(Array.from(native.expected.subarray(0, source.length)));
				// The same cached image drawn without E keeps its original colours.
				drawRecord.setUint16(2, 0, true);
				replayEmfPlusRecords(drawRecord, 0, drawRecord.byteLength, ctx as never, 16, 8, state);
				expect(Array.from(ctx.getImageData(0, 0, 16, 8).data)).toEqual(Array.from(source));
				drawRecord.setUint16(2, 0x2000, true);
			}
		}
		expect(source).toEqual(native.source.slice(0, source.length));
	});
});
