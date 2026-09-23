/**
 * Pixel-parity harness for the real-GDI/GDI+ fixtures in `__fixtures__/gdi`
 * (generated on Windows by `scripts/gdi-fixtures/generate.ps1`).
 *
 * Each fixture is a metafile plus a PNG of what Windows itself painted for the
 * same drawing calls. The harness replays the metafile through the public API
 * at `dpiScale: 1` on the `@napi-rs/canvas` backend and diffs it against that
 * PNG over their common area.
 *
 * Test-only: lives under `__fixtures__`, is never exported from the package.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { convertMetafileToDataUrl } from '../index';

export interface PixelDiff {
	/** Pixels compared (the overlap of the two images). */
	compared: number;
	/** Pixels whose largest RGB channel difference exceeds `tolerance`. */
	mismatched: number;
	/** `mismatched / compared`. */
	mismatchRatio: number;
	/** Mean absolute per-channel difference over every compared RGB channel. */
	meanAbsDiff: number;
	/** Largest single channel difference seen. */
	maxDiff: number;
}

export function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./gdi/${name}`, import.meta.url));
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface Rgba {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

async function decodePng(bytes: Buffer): Promise<Rgba> {
	const napi = await import('@napi-rs/canvas');
	const img = await napi.loadImage(bytes);
	const canvas = napi.createCanvas(img.width, img.height);
	const ctx = canvas.getContext('2d');
	// Composite over white: an unpainted converter pixel is transparent,
	// while Windows' reference DIB/bitmap is opaque (or transparent too).
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, img.width, img.height);
	ctx.drawImage(img, 0, 0);
	const data = ctx.getImageData(0, 0, img.width, img.height);
	return { width: img.width, height: img.height, data: data.data };
}

/** Replays a fixture metafile and decodes the resulting PNG. */
export async function renderFixture(file: string): Promise<Rgba | null> {
	const url = await convertMetafileToDataUrl(toArrayBuffer(readFileSync(fixturePath(file))), {
		dpiScale: 1,
	});
	if (!url) {
		return null;
	}
	return decodePng(Buffer.from(url.split(',')[1], 'base64'));
}

export async function loadReference(name: string): Promise<Rgba> {
	return decodePng(readFileSync(fixturePath(`${name}.png`)));
}

/**
 * Diffs two images over their common top-left-anchored area. `inset` skips
 * that many pixels at the right/bottom edge of the overlap (GDI's EMF bounds
 * are inclusive, so the converter's canvas can be one pixel short there).
 */
export function diffImages(a: Rgba, b: Rgba, tolerance: number, inset = 1): PixelDiff {
	const w = Math.min(a.width, b.width) - inset;
	const h = Math.min(a.height, b.height) - inset;
	let mismatched = 0;
	let sum = 0;
	let maxDiff = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const ia = (y * a.width + x) * 4;
			const ib = (y * b.width + x) * 4;
			let worst = 0;
			for (let c = 0; c < 3; c++) {
				const d = Math.abs(a.data[ia + c] - b.data[ib + c]);
				sum += d;
				if (d > worst) {
					worst = d;
				}
			}
			if (worst > tolerance) {
				mismatched++;
			}
			if (worst > maxDiff) {
				maxDiff = worst;
			}
		}
	}
	const compared = Math.max(0, w) * Math.max(0, h);
	return {
		compared,
		mismatched,
		mismatchRatio: compared > 0 ? mismatched / compared : 1,
		meanAbsDiff: compared > 0 ? sum / (compared * 3) : 255,
		maxDiff,
	};
}

/** Replays `<name>.<ext>` and diffs it against `<name>.png`. */
export async function compareFixture(name: string, ext: 'emf' | 'wmf', tolerance: number): Promise<PixelDiff | null> {
	const rendered = await renderFixture(`${name}.${ext}`);
	if (!rendered) {
		return null;
	}
	return diffImages(rendered, await loadReference(name), tolerance);
}
