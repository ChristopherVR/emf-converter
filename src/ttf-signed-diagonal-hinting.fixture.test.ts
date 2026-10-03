import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';

interface Capture { kind: 'movement' | 'projection' | 'vectors' | 'dual'; size: number; index: number; native: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-signed-diagonal-hinting.json.gz', import.meta.url))).toString());
const fonts = Object.fromEntries(['movement', 'projection', 'vectors', 'dual'].map(kind => [kind,
	parseFontFile(readFileSync(new URL(`./__fixtures__/gdi/signed-diagonal-${kind}.ttf`, import.meta.url)))[0]]));

function nativePoints(encoded: string): number[] {
	const bytes = Buffer.from(encoded, 'base64');
	const points = [bytes.readInt32LE(8) / 1024, bytes.readInt32LE(12) / 1024];
	for (let offset = 16; offset < bytes.length;) {
		expect(bytes.readUInt16LE(offset)).toBe(1); // TT_PRIM_LINE: all four diagnostic points are on-curve.
		const count = bytes.readUInt16LE(offset + 2);
		for (let i = 0; i < count; i++) points.push(bytes.readInt32LE(offset + 4 + i * 8) / 1024, bytes.readInt32LE(offset + 8 + i * 8) / 1024);
		offset += 4 + count * 8;
	}
	return points;
}

const bounds: Record<string, [number, number, number]> = JSON.parse(readFileSync(new URL(
	'./__fixtures__/gdi/text-signed-diagonal-hinting-bounds.json', import.meta.url)).toString());
const dot = (x: number, y: number, vx: number, vy: number) =>
	Math.floor((x * vx + 8192) / 16384) + Math.floor((y * vy + 8192) / 16384);
const roundAway = (value: number) => value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);

describe('public GDI signed diagonal instruction controls', () => {
	it.each(['movement', 'projection', 'vectors', 'dual'] as const)('preserves every %s outline control', kind => {
		const records = captures.filter(c => c.kind === kind);
		expect(records).toHaveLength(144);
		for (const c of records) {
			const hinted = new HintedSize(fonts[kind], c.size, c.size, { version: 35, grayscale: false }).hintGlyph(c.index);
			const ours = Array.from(hinted.xs).flatMap((x, i) => [x, hinted.ys[i]]), native = nativePoints(c.native);
			expect(ours).toHaveLength(native.length);
			const differences = ours.map((v, i) => Math.abs(v - native[i])), key = `${kind}:${c.size}:${c.index}`;
			expect(differences.filter(v => v !== 0).length, key).toBeLessThanOrEqual(bounds[key][0]);
			expect(differences.reduce((sum, v) => sum + v, 0), key).toBeLessThanOrEqual(bounds[key][1]);
			expect(Math.max(...differences), key).toBeLessThanOrEqual(bounds[key][2]);
		}
	});

	// This describes independently observed primitives, not a runtime correction:
	// the same candidate still regresses existing real-font exact grayscale cases.
	it('isolates per-product rounding and unit-vector movement across all four signed quadrants', () => {
		for (const c of captures.filter(c => c.kind === 'vectors')) {
			const vector = nativePoints(c.native), vx = vector[4], vy = vector[6];
			const lookup = (kind: Capture['kind']) => nativePoints(captures.find(other =>
				other.kind === kind && other.size === c.size && other.index === c.index)!.native);
			const projection = lookup('projection'), dual = lookup('dual'), movement = lookup('movement');
			const key = `${c.size}:${c.index}`;
			expect(dot(projection[4], projection[5], vx, vy), `GC:${key}`).toBe(projection[6]);
			// MD original distance projects font units before scaling to 26.6.
			expect(Math.floor(dot(-1720, -1520, vx, vy) * c.size / 32 + 0.5), `MD:${key}`).toBe(dual[6]);
			const x = Math.floor(-1400 * c.size / 32 + 0.5), y = Math.floor(-1200 * c.size / 32 + 0.5);
			const distance = -1000 - dot(x, y, vx, vy);
			expect(x + roundAway(distance * vx / 16384), `SCFS.x:${key}`).toBe(movement[4]);
			expect(y + roundAway(distance * vy / 16384), `SCFS.y:${key}`).toBe(movement[5]);
		}
	});
});
