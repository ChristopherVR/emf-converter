import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defaultLinearBrushMatrix, linearRampSampler } from './emf-plus-linear-ramp';
import { rotateWorldTransform } from './emf-plus-state-handlers';
import type { EmfPlusLinearGradient, TransformMatrix } from './emf-types';

/**
 * A linear gradient under a world transform, read to one 16.16 unit (`LinearRampWorldProbe.cs`,
 * `linear-ramp-world.json.gz`). As in `linear-ramp-origin.json.gz`, the brush rectangle moves in 2^-16 pixel steps and three
 * scanlines are kept per step, but the world transform is a translation, a rotation and (for 30 scenes) a scale, with a
 * brush angle of 0 (the brush matrix is then the one GDI+ derives from the rectangle, `defaultLinearBrushMatrix`) or a random angle
 * (30 scenes). 162 scenes (7,986 steps): the fixture's own (97 steps), one every five degrees from -175 to 175 (49 steps each), 60 random angles and 30
 * scaled ones.
 *
 * The device-to-ramp matrix is a float32 chain read from gdiplus.dll with every operation rounded toward minus infinity
 * (brush matrix times world matrix, ramp-to-rectangle matrix times that, inverted: `nativeRampInverse`), and every pixel of
 * every step is then exact. A double precision inverse is wrong on the 60 and 90 degree scenes of
 * `linear-ramp-origin.json.gz` and the same chain rounded to nearest on a third of the steps here.
 */
interface Scene {
	name: string; w: number; rows: number[]; first: number; last: number;
	angle: number; scale: number; tx: number; ty: number; rect: number[]; brushAngle: number;
	world: number[]; matrices: number[][]; rgb: string;
}
const scenes: Scene[] = JSON.parse(gunzipSync(readFileSync(new URL('./__fixtures__/gdi/linear-ramp-world.json.gz', import.meta.url))).toString());
const argb = (r: number, g: number, b: number): number => ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;

function wrongPixels(scene: Scene, useDefaultMatrix: boolean): { steps: number; pixels: number } {
	const data = Buffer.from(scene.rgb, 'base64');
	const [rx, ry, rw, rh] = scene.rect;
	let steps = 0;
	let pixels = 0;
	const out = new Uint8ClampedArray(scene.w * 4);
	for (let i = 0; i <= scene.last - scene.first; i++) {
		const brush = scene.matrices[i];
		const rect = { x: Math.fround(rx + (scene.first + i) / 65536), y: ry, w: rw, h: rh };
		const grad = {
			type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [], wrapMode: 'tile', rect,
			// A brush at angle 0 is the one GDI+ derives from its rectangle: the probe records what Transform returned
			transform: useDefaultMatrix && scene.brushAngle === 0 ? undefined : (brush as TransformMatrix),
			ramp: { startArgb: argb(230, 40, 30), endArgb: argb(20, 90, 220), preset: null, blend: null, gammaCorrected: false },
		} as unknown as EmfPlusLinearGradient;
		const sampler = linearRampSampler(grad, scene.world as TransformMatrix, false)!;
		let wrong = 0;
		for (let r = 0; r < scene.rows.length; r++) {
			out.fill(0);
			sampler(0, scene.rows[r], scene.w, 1, out);
			for (let x = 0; x < scene.w; x++) {
				const o = ((i * scene.rows.length + r) * scene.w + x) * 3;
				if (data[o] !== out[x * 4] || data[o + 1] !== out[x * 4 + 1] || data[o + 2] !== out[x * 4 + 2]) wrong++;
			}
		}
		if (wrong) {
			steps++;
			pixels += wrong;
		}
	}
	return { steps, pixels };
}

describe('linear gradient under a world transform (native, 2^-16 pixel sweeps)', () => {
	it('has 162 scenes', () => {
		expect(scenes).toHaveLength(162);
		expect(scenes.every((s) => s.last - s.first + 1 === (s.name === 'fixture' ? 97 : 49))).toBe(true);
	});

	it('is exact on every pixel of every step', () => {
		let steps = 0;
		let pixels = 0;
		for (const scene of scenes) {
			const r = wrongPixels(scene, false);
			steps += r.steps;
			pixels += r.pixels;
		}
		expect({ steps, pixels }).toEqual({ steps: 0, pixels: 0 });
	});

	it('records the brush matrix GDI+ derives from a rectangle at angle 0 as defaultLinearBrushMatrix', () => {
		for (const scene of scenes.filter((s) => s.brushAngle === 0)) {
			const [rx, ry, rw, rh] = scene.rect;
			// the probe moves the rectangle's x in 2^-16 steps: every step's matrix is the function of that rectangle
			for (let i = 0; i <= scene.last - scene.first; i += 12) {
				const rect = { x: Math.fround(rx + (scene.first + i) / 65536), y: ry, w: rw, h: rh };
				expect(defaultLinearBrushMatrix(rect).map(Math.fround)).toEqual(scene.matrices[i].map(Math.fround));
			}
		}
	});

	it('forms the world matrix of Translate then Rotate the way GpMatrix::Rotate does', () => {
		for (const scene of scenes.filter((s) => s.scale === 1 && s.name !== 'scaled')) {
			const m = rotateWorldTransform([1, 0, 0, 1, scene.tx, scene.ty], scene.angle, false);
			expect(m.map(Math.fround)).toEqual(scene.world.map(Math.fround));
		}
	});
});
