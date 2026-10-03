import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseFontFile } from './ttf-font';
import { HintedSize } from './ttf-hinting';

interface Capture { kind: 'gc' | 'mdcurrent' | 'mdoriginal' | 'mdrp' | 'mirp' | 'scfs'; size: number; index: number; native: string }
const captures: Capture[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/text-opcode-hinting.json.gz', import.meta.url))).toString());
const fonts = Object.fromEntries(['gc', 'mdcurrent', 'mdoriginal', 'mdrp', 'mirp', 'scfs'].map(kind => [kind,
	parseFontFile(readFileSync(new URL(`./__fixtures__/gdi/opcode-${kind}.ttf`, import.meta.url)))[0]]));

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
	'./__fixtures__/gdi/text-opcode-hinting-bounds.json', import.meta.url)).toString());
const dot = (x: number, y: number, vx: number, vy: number) =>
	Math.floor((x * vx + 8192) / 16384) + Math.floor((y * vy + 8192) / 16384);
const roundAway = (value: number) => value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);

describe('public GDI diagonal opcode controls', () => {
	it.each(['gc', 'mdcurrent', 'mdoriginal', 'mdrp', 'mirp', 'scfs'] as const)('preserves every %s outline control', kind => {
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

	it('observes per-product arithmetic in GC, both MD forms, and unequal-vector MDRP', () => {
		const positions = [[142, -475], [-142, -475], [251, 317], [-251, 317]];
		const quadrants = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
		for (const c of captures) {
			if (c.kind === 'mirp' || c.kind === 'scfs') continue;
			const points = nativePoints(c.native), [sx, sy] = quadrants[Math.floor((c.index - 1) / 4)];
			const vx = sx * 15513, vy = sy * 5270, fx = sx * 4909, fy = sy * 15631;
			const [ox, oy] = positions[(c.index - 1) % 4], key = `${c.kind}:${c.size}:${c.index}`;
			const original = Math.floor(dot(ox, oy, vx, vy) * c.size / 32 + 0.5);
			if (c.kind === 'gc') expect(dot(points[4], points[5], vx, vy), key).toBe(points[6]);
			else if (c.kind === 'mdcurrent') expect(dot(points[4] - points[0], points[5] - points[1], vx, vy), key).toBe(points[6]);
			else if (c.kind === 'mdoriginal') expect(original, key).toBe(points[6]);
			else {
				const x = Math.floor(ox * c.size / 32 + 0.5), y = Math.floor(oy * c.size / 32 + 0.5);
				const distance = original - dot(x - points[0], y - points[1], vx, vy);
				const denominator = Math.floor((vx * fx + vy * fy) / 16384);
				expect(x + roundAway(distance * fx / denominator), `${key}:x`).toBe(points[4]);
				expect(y + roundAway(distance * fy / denominator), `${key}:y`).toBe(points[5]);
			}
		}
	});
});
