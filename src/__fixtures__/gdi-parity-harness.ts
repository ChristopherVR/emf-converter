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

import { getRenderableEmfBounds, parseEmfHeader } from '../emf-header-parser';
import { convertMetafileToDataUrl, type EmfConvertOptions } from '../index';

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

export interface Rgba {
	width: number;
	height: number;
	data: Uint8ClampedArray;
	/**
	 * Device-space coordinate of this image's pixel (0, 0). A reference PNG
	 * is the whole device surface, so its origin is (0, 0); a replayed EMF's
	 * canvas starts at its header's `rclBounds` top-left, which is negative
	 * whenever a drawing (e.g. a rotated shape) reaches above or left of
	 * the device origin. Omitted means (0, 0).
	 */
	originX?: number;
	originY?: number;
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

/**
 * Device-space origin of an EMF's rendered canvas: the top-left of the
 * header bounds the converter sizes its canvas from (see
 * `getRenderableEmfBounds`). WMF (placeable header at 0,0) and unparseable
 * inputs report (0, 0).
 */
function emfDeviceOrigin(bytes: Buffer): { x: number; y: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const header = parseEmfHeader(view);
	const bounds = header ? getRenderableEmfBounds(header) : null;
	return bounds ? { x: bounds.left, y: bounds.top } : { x: 0, y: 0 };
}

/**
 * Replays a fixture metafile and decodes the resulting PNG, tagging it with
 * the device-space origin of its pixel (0, 0) so `diffImages` compares each
 * rendered pixel against the reference pixel that names the same device
 * coordinate. `options` are passed through to the converter (on top of
 * `dpiScale: 1`).
 */
export async function renderFixture(file: string, options: EmfConvertOptions = {}): Promise<Rgba | null> {
	const bytes = readFileSync(fixturePath(file));
	const url = await convertMetafileToDataUrl(toArrayBuffer(bytes), {
		dpiScale: 1,
		...options,
	});
	if (!url) {
		return null;
	}
	const image = await decodePng(Buffer.from(url.split(',')[1], 'base64'));
	if (file.endsWith('.emf')) {
		const origin = emfDeviceOrigin(bytes);
		image.originX = origin.x;
		image.originY = origin.y;
	}
	return image;
}

export async function loadReference(name: string): Promise<Rgba> {
	return decodePng(readFileSync(fixturePath(`${name}.png`)));
}

/**
 * Diffs two images over the device-space area they share, aligning each by
 * its `originX`/`originY` (so an EMF whose bounds start above/left of the
 * device origin is not compared a few pixels out of register). `inset`
 * skips that many pixels at the right/bottom edge of the overlap (GDI's EMF
 * bounds are inclusive, so the converter's canvas can be one pixel short
 * there).
 */
export function diffImages(a: Rgba, b: Rgba, tolerance: number, inset = 1): PixelDiff {
	const ax = a.originX ?? 0;
	const ay = a.originY ?? 0;
	const bx = b.originX ?? 0;
	const by = b.originY ?? 0;
	const x0 = Math.max(ax, bx);
	const y0 = Math.max(ay, by);
	const w = Math.min(ax + a.width, bx + b.width) - x0 - inset;
	const h = Math.min(ay + a.height, by + b.height) - y0 - inset;
	let mismatched = 0;
	let sum = 0;
	let maxDiff = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const ia = ((y + y0 - ay) * a.width + (x + x0 - ax)) * 4;
			const ib = ((y + y0 - by) * b.width + (x + x0 - bx)) * 4;
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

/** Replays `<name>.<ext>` (with converter `options`) and diffs it against `<name>.png`. */
export async function compareFixture(
	name: string,
	ext: 'emf' | 'wmf',
	tolerance: number,
	options: EmfConvertOptions = {},
): Promise<PixelDiff | null> {
	const rendered = await renderFixture(`${name}.${ext}`, options);
	if (!rendered) {
		return null;
	}
	return diffImages(rendered, await loadReference(name), tolerance);
}
