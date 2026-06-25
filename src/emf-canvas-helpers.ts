/**
 * Canvas creation, styling, string reading, stock objects, and export helpers.
 */

import {
	MAX_CANVAS_DIMENSION,
	R2_MASKPEN,
	R2_MERGEPEN,
	R2_NOT,
	R2_XORPEN,
} from './emf-constants';
import { emfLog, emfWarn } from './emf-logging';
import type { CanvasContext, DrawState, GdiObject } from './emf-types';

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------

/**
 * The default DPI scale factor used for EMF/WMF rendering.
 * Set to 1 for 1:1 pixel mapping (default).
 * Set to 2 for HiDPI output (2x resolution).
 */
export const DEFAULT_DPI_SCALE = 1;

export function createCanvas(
	width: number,
	height: number,
	maxWidth?: number,
	maxHeight?: number,
	dpiScale: number = DEFAULT_DPI_SCALE,
	maxCanvasDimension: number = MAX_CANVAS_DIMENSION,
): {
	canvas: OffscreenCanvas | HTMLCanvasElement;
	ctx: CanvasContext;
	scaleX: number;
	scaleY: number;
} | null {
	const effectiveScale = Math.max(1, Math.min(dpiScale, 4));
	let w = Math.round(width * effectiveScale);
	let h = Math.round(height * effectiveScale);
	let scaleX = effectiveScale;
	let scaleY = effectiveScale;

	if (maxWidth && w > maxWidth) {
		const factor = maxWidth / w;
		w = maxWidth;
		h = Math.round(h * factor);
		scaleX *= factor;
		scaleY *= factor;
	}
	if (maxHeight && h > maxHeight) {
		const factor = maxHeight / h;
		w = Math.round(w * factor);
		h = maxHeight;
		scaleX *= factor;
		scaleY *= factor;
	}

	const dimCap = Math.max(1, Math.floor(maxCanvasDimension));
	const clampedW = Math.max(1, Math.min(w, dimCap));
	const clampedH = Math.max(1, Math.min(h, dimCap));
	if (clampedW !== w || clampedH !== h) {
		console.warn(
			`[emf-converter] Canvas size clamped from ${w}×${h} to ${clampedW}×${clampedH}. Output may lose detail.`,
		);
	}
	w = clampedW;
	h = clampedH;

	try {
		if (typeof OffscreenCanvas !== 'undefined') {
			emfLog(
				`createCanvas: using OffscreenCanvas ${w}×${h}, scale=(${scaleX.toFixed(3)},${scaleY.toFixed(3)})`,
			);
			const canvas = new OffscreenCanvas(w, h);
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				emfWarn('createCanvas: OffscreenCanvas.getContext("2d") returned null');
				return null;
			}
			return { canvas, ctx, scaleX, scaleY };
		}

		if (typeof document === 'undefined') {
			emfWarn('createCanvas: no OffscreenCanvas and no document — cannot create canvas');
			return null;
		}

		emfLog(
			`createCanvas: using HTMLCanvasElement ${w}×${h}, scale=(${scaleX.toFixed(3)},${scaleY.toFixed(3)})`,
		);
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			emfWarn('createCanvas: HTMLCanvasElement.getContext("2d") returned null');
			return null;
		}
		return { canvas, ctx, scaleX, scaleY };
	} catch (err) {
		emfWarn('createCanvas: exception:', err);
		return null;
	}
}

export function createTempCanvas(
	width: number,
	height: number,
): {
	canvas: OffscreenCanvas | HTMLCanvasElement;
	ctx: CanvasContext;
} | null {
	if (width <= 0 || height <= 0) {
		return null;
	}
	width = Math.max(1, Math.min(Math.floor(width), MAX_CANVAS_DIMENSION));
	height = Math.max(1, Math.min(Math.floor(height), MAX_CANVAS_DIMENSION));
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return null;
		}
		return { canvas, ctx };
	}
	if (typeof document !== 'undefined') {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			return null;
		}
		return { canvas, ctx };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Apply pen/brush/font to context
// ---------------------------------------------------------------------------

/**
 * Maps a GDI binary raster-operation (ROP2) mode onto the closest Canvas 2D
 * `globalCompositeOperation`. GDI ROP2 modes are bitwise boolean operations
 * between pen/brush and destination pixels; Canvas offers alpha compositing, so
 * only a subset has a reasonable equivalent. Unsupported modes fall back to the
 * default `'source-over'` (and the common `R2_COPYPEN` default is a no-op).
 *
 * @param rop2 - A ROP2 mode constant (R2_*); 13 (R2_COPYPEN) is the default.
 * @returns The closest `globalCompositeOperation` value.
 */
export function rop2ToGco(rop2: number): GlobalCompositeOperation {
	switch (rop2) {
		case R2_XORPEN:
			return 'xor';
		case R2_MASKPEN:
			return 'multiply';
		case R2_MERGEPEN:
			return 'lighten';
		case R2_NOT:
			return 'difference';
		default:
			return 'source-over';
	}
}

export function applyPen(ctx: CanvasContext, state: DrawState): void {
	ctx.globalCompositeOperation = rop2ToGco(state.rop2);
	if (state.penStyle === 5) {
		ctx.strokeStyle = 'rgba(0,0,0,0)';
		ctx.lineWidth = 0;
		return;
	}
	ctx.strokeStyle = state.penColor;
	ctx.lineWidth = Math.max(state.penWidth, 1);
	switch (state.penStyle) {
		case 1:
			ctx.setLineDash([8, 4]);
			break;
		case 2:
			ctx.setLineDash([2, 2]);
			break;
		case 3:
			ctx.setLineDash([8, 4, 2, 4]);
			break;
		case 4:
			ctx.setLineDash([8, 4, 2, 4, 2, 4]);
			break;
		default:
			ctx.setLineDash([]);
			break;
	}
}

export function applyBrush(ctx: CanvasContext, state: DrawState): void {
	ctx.globalCompositeOperation = rop2ToGco(state.rop2);
	if (state.brushStyle === 1) {
		ctx.fillStyle = 'rgba(0,0,0,0)';
		return;
	}
	ctx.fillStyle = state.brushColor;
}

/**
 * Maps a GDI/GDI+ numeric font weight (100..900, where 400 = normal and
 * 700 = bold) to the corresponding CSS `font-weight` token. Returns an empty
 * string for the normal weight so the default is left implicit.
 */
export function cssFontWeight(weight: number): string {
	if (!weight || weight === 400) {
		return '';
	}
	const rounded = Math.round(weight / 100) * 100;
	// 'bold' is the canonical CSS alias for 700 and keeps output stable for the
	// overwhelmingly common bold case; finer weights are emitted numerically.
	if (rounded === 700) {
		return 'bold';
	}
	if (rounded >= 100 && rounded <= 900) {
		return String(rounded);
	}
	return weight >= 700 ? 'bold' : '';
}

/**
 * Resolves a Windows face name to a CSS font family, applying an optional
 * caller-supplied remap (keyed by lowercased face name) and quoting multi-word
 * names so the Canvas font shorthand parses them as a single family.
 *
 * @param face - The raw Windows face name (e.g. `Times New Roman`).
 * @param map  - Optional lowercased-face → CSS-family overrides.
 */
export function mapFontFamily(face: string, map?: Record<string, string>): string {
	const resolved = map?.[face.toLowerCase().trim()] ?? face;
	// Quote names containing whitespace or commas unless already quoted.
	if (/[\s,]/.test(resolved) && !/^["']/.test(resolved)) {
		return `"${resolved}"`;
	}
	return resolved;
}

export function applyFont(ctx: CanvasContext, state: DrawState): void {
	const italic = state.fontItalic ? 'italic ' : '';
	const weight = cssFontWeight(state.fontWeight);
	const weightPart = weight ? `${weight} ` : '';
	const size = Math.max(Math.abs(state.fontHeight), 8);
	const family = mapFontFamily(state.fontFamily, state.fontFamilyMap);
	ctx.font = `${italic}${weightPart}${size}px ${family}`;
}

/**
 * Draws underline and/or strike-out decorations for a run of text, using the
 * current font/colour state. Canvas has no native text-decoration support, so
 * the lines are rendered as thin filled rectangles. No-op when neither
 * decoration is active.
 *
 * @param ctx   - The target rendering context.
 * @param state - The active draw state (provides decoration flags + size).
 * @param x     - The left edge of the text run, in the current user space.
 * @param y     - The text baseline Y coordinate.
 * @param width - The measured advance width of the text run.
 */
export function drawTextDecorations(
	ctx: CanvasContext,
	state: DrawState,
	x: number,
	y: number,
	width: number,
): void {
	if (!state.fontUnderline && !state.fontStrikeOut) {
		return;
	}
	const size = Math.max(Math.abs(state.fontHeight), 8);
	const thickness = Math.max(1, Math.round(size / 14));
	const prevFill = ctx.fillStyle;
	ctx.fillStyle = state.textColor;
	if (state.fontUnderline) {
		ctx.fillRect(x, y + Math.round(size * 0.12), width, thickness);
	}
	if (state.fontStrikeOut) {
		ctx.fillRect(x, y - Math.round(size * 0.3), width, thickness);
	}
	ctx.fillStyle = prevFill;
}

// ---------------------------------------------------------------------------
// Read a UTF-16LE string from a DataView
// ---------------------------------------------------------------------------

export function readUtf16LE(view: DataView, offset: number, charCount: number): string {
	if (charCount <= 0) {
		return '';
	}
	const maxBytes = view.byteLength - offset;
	if (maxBytes <= 0) {
		return '';
	}
	const usableChars = Math.min(charCount, Math.floor(maxBytes / 2));
	if (usableChars <= 0) {
		return '';
	}
	let decoded: string;
	try {
		const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, usableChars * 2);
		decoded = new TextDecoder('utf-16le').decode(bytes);
	} catch {
		// Fallback if TextDecoder is unavailable or input rejected.
		const chars: string[] = [];
		for (let i = 0; i < usableChars; i++) {
			const code = view.getUint16(offset + i * 2, true);
			if (code === 0) {
				return chars.join('');
			}
			chars.push(String.fromCharCode(code));
		}
		return chars.join('');
	}
	// Truncate at first NUL terminator, matching previous behaviour.
	const nul = decoded.indexOf(String.fromCharCode(0));
	return nul === -1 ? decoded : decoded.slice(0, nul);
}

// ---------------------------------------------------------------------------
// Matrix sanitization
// ---------------------------------------------------------------------------

/**
 * Replace any non-finite (NaN/Infinity) entries in an affine transform matrix
 * with safe identity defaults. Returns a new array; does not mutate input.
 *
 * The identity matrix is [1, 0, 0, 1, 0, 0]. Translation (e, f) defaults to 0
 * on non-finite, scale/skew (a, d) default to 1 on non-finite, and (b, c)
 * default to 0 on non-finite.
 */
export function sanitizeMatrix(
	m: ReadonlyArray<number>,
): [number, number, number, number, number, number] {
	const a = Number.isFinite(m[0]) ? m[0] : 1;
	const b = Number.isFinite(m[1]) ? m[1] : 0;
	const c = Number.isFinite(m[2]) ? m[2] : 0;
	const d = Number.isFinite(m[3]) ? m[3] : 1;
	const e = Number.isFinite(m[4]) ? m[4] : 0;
	const f = Number.isFinite(m[5]) ? m[5] : 0;
	return [a, b, c, d, e, f];
}

// ---------------------------------------------------------------------------
// Stock objects (default GDI objects referenced via STOCK_OBJECT_BASE + idx)
// ---------------------------------------------------------------------------

export function getStockObject(index: number): GdiObject | null {
	switch (index) {
		case 0:
			return { kind: 'brush', style: 0, color: '#ffffff' };
		case 1:
			return { kind: 'brush', style: 0, color: '#c0c0c0' };
		case 2:
			return { kind: 'brush', style: 0, color: '#808080' };
		case 3:
			return { kind: 'brush', style: 0, color: '#404040' };
		case 4:
			return { kind: 'brush', style: 0, color: '#000000' };
		case 5:
			return { kind: 'brush', style: 1, color: '#000000' };
		case 6:
			return { kind: 'pen', style: 0, widthX: 1, color: '#ffffff' };
		case 7:
			return { kind: 'pen', style: 0, widthX: 1, color: '#000000' };
		case 8:
			return { kind: 'pen', style: 5, widthX: 0, color: '#000000' };
		case 10:
		case 11:
			return {
				kind: 'font',
				height: 12,
				weight: 400,
				italic: false,
				underline: false,
				strikeOut: false,
				family: 'monospace',
			};
		case 12:
		case 13:
		case 14:
		case 17:
			return {
				kind: 'font',
				height: 12,
				weight: 400,
				italic: false,
				underline: false,
				strikeOut: false,
				family: 'sans-serif',
			};
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Canvas export helpers
// ---------------------------------------------------------------------------

export async function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

export async function exportCanvasToPngDataUrl(
	canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<string | null> {
	if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
		emfLog(
			`exportCanvasToPngDataUrl: using OffscreenCanvas.convertToBlob (${canvas.width}×${canvas.height})`,
		);
		const blob = await canvas.convertToBlob({ type: 'image/png' });
		emfLog(`exportCanvasToPngDataUrl: blob size=${blob.size} bytes, type=${blob.type}`);
		return blobToDataUrl(blob);
	}

	if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
		emfLog(
			`exportCanvasToPngDataUrl: using HTMLCanvasElement.toDataURL (${canvas.width}×${canvas.height})`,
		);
		return canvas.toDataURL('image/png');
	}

	emfWarn('exportCanvasToPngDataUrl: no canvas type matched — returning null');
	return null;
}
