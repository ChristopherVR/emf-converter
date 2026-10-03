import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';

interface Capture { kind: 'pv' | 'fv' | 'dual' | 'mdoriginal' | 'mdrp' | 'mirp' | 'scfs'; size: number; index: number; native: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-vector-stage-hinting.json.gz', import.meta.url))).toString());
const fonts = Object.fromEntries(['pv', 'fv', 'dual', 'mdoriginal', 'mdrp', 'mirp', 'scfs'].map(kind => [kind,
	parseFontFile(readFileSync(new URL(`./__fixtures__/gdi/vector-stage-${kind}.ttf`, import.meta.url)))[0]]));

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
	'./__fixtures__/gdi/text-vector-stage-hinting-bounds.json', import.meta.url)).toString());
const dot = (x: number, y: number, vx: number, vy: number) =>
	Math.floor((x * vx + 8192) / 16384) + Math.floor((y * vy + 8192) / 16384);
const roundAway = (value: number) => value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);

describe('public GDI projection-vector stage controls', () => {
	it.each(['pv', 'fv', 'dual', 'mdoriginal', 'mdrp', 'mirp', 'scfs'] as const)('preserves every %s outline control', kind => {
		const records = captures.filter(c => c.kind === kind);
		expect(records).toHaveLength(64);
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

	it('preserves explicitly supplied projection and freedom words in every quadrant', () => {
		const vectors = [[17, 31], [137, 193], [4909, 15631], [15513, 5270]];
		const quadrants = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
		const records = captures.filter(c => c.kind === 'pv' || c.kind === 'fv');
		expect(records).toHaveLength(128);
		for (const c of records) {
			const [sx, sy] = quadrants[Math.floor((c.index - 1) / 4)], [x, y] = vectors[(c.index - 1) % 4];
			const points = nativePoints(c.native);
			expect([points[4], points[6]], `${c.kind}:${c.size}:${c.index}`).toEqual([sx * x, sy * y]);
		}
	});
	it('separates original-coordinate and original-font-unit projection after moving the reference', () => {
		const positions = [[142, -475], [-142, -475], [251, 317], [-251, 317]];
		const quadrants = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
		const records = captures.filter(c => c.kind === 'dual' || c.kind === 'mdoriginal');
		expect(records).toHaveLength(128);
		for (const c of records) {
			const [sx, sy] = quadrants[Math.floor((c.index - 1) / 4)], [x, y] = positions[(c.index - 1) % 4];
			const scaled = (value: number) => Math.floor(value * c.size / 32 + 0.5);
			const dx = -scaled(sx * 320), dy = -scaled(sy * 100), length = Math.hypot(dx, dy);
			const vx = Math.round(dx * 16384 / length), vy = Math.round(dy * 16384 / length);
			const expected = c.kind === 'dual' ? dot(scaled(x), scaled(y), vx, vy)
				: scaled(dot(x, y, vx, vy));
			expect(expected, `${c.kind}:${c.size}:${c.index}`).toBe(nativePoints(c.native)[6]);
		}
	});
});
