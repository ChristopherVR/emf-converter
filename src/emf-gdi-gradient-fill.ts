/**
 * EMR_GRADIENTFILL: GDI's GradientFill (rectangles shaded horizontally or
 * vertically, and Gouraud-shaded triangles), painted exactly as Windows
 * paints them onto a true colour surface.
 *
 * Measured against real GDI (`emfrec-gradient-rect`, `emfrec-gradient-tri`,
 * and a few hundred thousand further probe pixels): there is no dithering on
 * a 32bpp surface, and each colour channel is interpolated from the
 * vertices' 16-bit values and truncated to its high byte.
 *
 *   - Rectangles (`GRADIENT_FILL_RECT_H` / `_V`) cover device pixels
 *     `[left, right) x [top, bottom)` whichever way the two vertices are
 *     given; along the gradient the i-th pixel from the left (top) vertex has
 *     `(c0 * 65536 + i * floor((c1 - c0) * 65536 / n)) >> 24` (a 16.16
 *     DDA with the step rounded down, `n` the rectangle's width or height).
 *   - Triangles (`GRADIENT_FILL_TRIANGLE`) cover the pixels a polygon fill
 *     of the three device points does. Vertex channels above 0xFF00 count
 *     as 0xFF00. Each scanline starts from the exact plane value at its first
 *     pixel, plus half a 16-bit unit on every scanline but the topmost, and
 *     steps across by the plane's x gradient rounded down to 16.16 fixed
 *     point; the level is the high byte, floored.
 *
 * SVG output keeps a rectangle gradient as vector geometry (an SVG linear
 * gradient between the two vertex colours, which Windows' DDA matches to
 * within one level) unless the output is in the exact `gdiAntialias: false`
 * mode; triangles, whose colour is a plane per channel that no single SVG
 * gradient can express, are embedded as their exact pixels (an image
 * patch). PNG output is always exact.
 *
 * @module emf-gdi-gradient-fill
 */

import { createImageDataCompat } from './emf-canvas-helpers';
import { EMR_GRADIENTFILL } from './emf-constants';
import { fixPoint } from './emf-gdi-raster-shapes';
import { acquireScratch, compositeOverlay } from './emf-rop2-exact';
import type { EmfGdiReplayCtx } from './emf-types';
import { fillPolygonSpans } from './gdi-raster';
import { isSvgContext } from './svg-context';

/** GradientFill modes. */
const GRADIENT_FILL_RECT_H = 0;
const GRADIENT_FILL_RECT_V = 1;
const GRADIENT_FILL_TRIANGLE = 2;

/** A TRIVERTEX mapped to device FIX, with its 16-bit red, green and blue. */
interface Vertex {
	x: number;
	y: number;
	c: [number, number, number];
}

/** A box of device pixels and their colours (`-1`: not painted). */
interface Patch {
	x: number;
	y: number;
	w: number;
	h: number;
	rgb: Int32Array;
}

/**
 * The level of the i-th of `n` pixels of a rectangle gradient from `c0` to
 * `c1` (16-bit): GDI's 16.16 DDA with the step rounded down.
 */
export function rectGradientLevel(c0: number, c1: number, i: number, n: number): number {
	const step = Math.floor(((c1 - c0) * 65536) / n);
	return Math.floor((c0 * 65536 + step * i) / 65536) >> 8;
}

/**
 * Paints the triangle `v` (device FIX) into `patch` (see the module doc):
 * each scanline from the exact plane value at its first pixel (plus half a
 * unit below the top scanline), stepped across in 16.16.
 */
export function paintTriangle(v: readonly Vertex[], patch: Patch): void {
	const spans = fillPolygonSpans([v.flatMap((p) => [p.x, p.y])], false);
	if (spans.length === 0) {
		return;
	}
	const [a, b, c] = v.map((p) => ({ x: p.x / 16, y: p.y / 16, c: p.c.map((ch) => Math.min(ch, 0xff00)) }));
	const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
	if (det === 0) {
		return;
	}
	const dx = [0, 1, 2].map((k) => ((b.c[k] - a.c[k]) * (c.y - a.y) - (c.c[k] - a.c[k]) * (b.y - a.y)) / det);
	const dy = [0, 1, 2].map((k) => ((c.c[k] - a.c[k]) * (b.x - a.x) - (b.c[k] - a.c[k]) * (c.x - a.x)) / det);
	const stepX = dx.map((d) => Math.floor(d * 65536));
	const d = spans.data;
	const top = d[0];
	for (let s = 0; s < spans.length * 3; s += 3) {
		const y = d[s];
		const xs = d[s + 1];
		const xe = d[s + 2];
		if (y < patch.y || y >= patch.y + patch.h) {
			continue;
		}
		const start = [0, 1, 2].map((k) => a.c[k] + dx[k] * (xs - a.x) + dy[k] * (y - a.y) + (y === top ? 0 : 0.5));
		for (let x = Math.max(xs, patch.x); x < Math.min(xe, patch.x + patch.w); x++) {
			let rgb = 0;
			for (let k = 0; k < 3; k++) {
				const level = Math.floor(start[k] + (stepX[k] * (x - xs)) / 65536 + 1e-9) >> 8;
				rgb = (rgb << 8) | Math.max(0, Math.min(255, level));
			}
			patch.rgb[(y - patch.y) * patch.w + (x - patch.x)] = rgb;
		}
	}
}

/** Reads the record's vertices (device FIX) and mesh indices. */
function readRecord(rCtx: EmfGdiReplayCtx, dataOff: number, recSize: number): { mode: number; vertices: Vertex[]; mesh: number[][] } | null {
	const { view } = rCtx;
	if (recSize < 36) {
		return null;
	}
	const nVer = view.getUint32(dataOff + 16, true);
	const nTri = view.getUint32(dataOff + 20, true);
	const mode = view.getUint32(dataOff + 24, true);
	const per = mode === GRADIENT_FILL_TRIANGLE ? 3 : 2;
	const vOff = dataOff + 28;
	const mOff = vOff + nVer * 16;
	if (nVer > 1_000_000 || nTri > 1_000_000 || mOff + nTri * per * 4 > dataOff - 8 + recSize) {
		return null;
	}
	const vertices: Vertex[] = [];
	for (let i = 0; i < nVer; i++) {
		const o = vOff + i * 16;
		const [x, y] = fixPoint(rCtx, view.getInt32(o, true), view.getInt32(o + 4, true));
		vertices.push({ x, y, c: [view.getUint16(o + 8, true), view.getUint16(o + 10, true), view.getUint16(o + 12, true)] });
	}
	const mesh: number[][] = [];
	for (let i = 0; i < nTri; i++) {
		const idx: number[] = [];
		for (let k = 0; k < per; k++) {
			idx.push(view.getUint32(mOff + (i * per + k) * 4, true));
		}
		if (idx.every((j) => j < nVer)) {
			mesh.push(idx);
		}
	}
	return { mode, vertices, mesh };
}

/** Paints `patch` onto the canvas (opaque where set, clip applied). */
function drawPatch(rCtx: EmfGdiReplayCtx, patch: Patch): void {
	const x0 = Math.max(0, patch.x);
	const y0 = Math.max(0, patch.y);
	const x1 = Math.min(rCtx.canvasW, patch.x + patch.w);
	const y1 = Math.min(rCtx.canvasH, patch.y + patch.h);
	if (x1 <= x0 || y1 <= y0) {
		return;
	}
	const w = x1 - x0;
	const h = y1 - y0;
	const data = new Uint8ClampedArray(w * h * 4);
	let any = false;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const c = patch.rgb[(y + y0 - patch.y) * patch.w + (x + x0 - patch.x)];
			if (c < 0) {
				continue;
			}
			const i = (y * w + x) * 4;
			data[i] = (c >> 16) & 0xff;
			data[i + 1] = (c >> 8) & 0xff;
			data[i + 2] = c & 0xff;
			data[i + 3] = 255;
			any = true;
		}
	}
	const scratch = any ? acquireScratch(w, h) : null;
	if (scratch) {
		compositeOverlay(rCtx.ctx, { x: x0, y: y0, w, h }, scratch, createImageDataCompat(data, w, h));
	}
}

/** `#rrggbb` of a vertex's high bytes. */
function hex(c: readonly number[]): string {
	return `#${c.map((v) => (v >> 8).toString(16).padStart(2, '0')).join('')}`;
}

/** One rectangle of the mesh (device pixels, and the vertex at the gradient's start first). */
function rectOf(u: Vertex, v: Vertex, vertical: boolean) {
	const ux = Math.round(u.x / 16);
	const uy = Math.round(u.y / 16);
	const vx = Math.round(v.x / 16);
	const vy = Math.round(v.y / 16);
	const first = (vertical ? uy <= vy : ux <= vx) ? u : v;
	return { l: Math.min(ux, vx), t: Math.min(uy, vy), r: Math.max(ux, vx), b: Math.max(uy, vy), first, second: first === u ? v : u };
}

/** Handles EMR_GRADIENTFILL; returns false for any other record type. */
export function handleEmfGdiGradientFillRecord(rCtx: EmfGdiReplayCtx, recType: number, dataOff: number, recSize: number): boolean {
	if (recType !== EMR_GRADIENTFILL) {
		return false;
	}
	const rec = readRecord(rCtx, dataOff, recSize);
	if (!rec) {
		return true;
	}
	const { ctx } = rCtx;
	if (rec.mode === GRADIENT_FILL_RECT_H || rec.mode === GRADIENT_FILL_RECT_V) {
		const vertical = rec.mode === GRADIENT_FILL_RECT_V;
		const vector = isSvgContext(ctx) && rCtx.gdiAntialias !== false;
		for (const [i, j] of rec.mesh) {
			const r = rectOf(rec.vertices[i], rec.vertices[j], vertical);
			const w = r.r - r.l;
			const h = r.b - r.t;
			if (w <= 0 || h <= 0) {
				continue;
			}
			if (vector) {
				// The last pixel shows the DDA's value one step short of the far colour.
				const n = vertical ? h : w;
				const g: CanvasGradient = vertical ? ctx.createLinearGradient(0, r.t, 0, r.t + n) : ctx.createLinearGradient(r.l, 0, r.l + n, 0);
				g.addColorStop(0, hex(r.first.c));
				g.addColorStop(1, hex(r.second.c));
				ctx.save();
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				(ctx as CanvasRenderingContext2D).fillStyle = g;
				ctx.fillRect(r.l, r.t, w, h);
				ctx.restore();
				continue;
			}
			// Only the part on the canvas is computed.
			const px0 = Math.max(r.l, 0);
			const py0 = Math.max(r.t, 0);
			const px1 = Math.min(r.r, rCtx.canvasW);
			const py1 = Math.min(r.b, rCtx.canvasH);
			if (px1 <= px0 || py1 <= py0) {
				continue;
			}
			const patch: Patch = { x: px0, y: py0, w: px1 - px0, h: py1 - py0, rgb: new Int32Array((px1 - px0) * (py1 - py0)) };
			const n = vertical ? h : w;
			const along: number[] = [];
			for (let pos = vertical ? py0 - r.t : px0 - r.l; pos < (vertical ? py1 - r.t : px1 - r.l); pos++) {
				let rgb = 0;
				for (let k = 0; k < 3; k++) {
					rgb = (rgb << 8) | Math.max(0, Math.min(255, rectGradientLevel(r.first.c[k], r.second.c[k], pos, n)));
				}
				along.push(rgb);
			}
			for (let y = 0; y < patch.h; y++) {
				for (let x = 0; x < patch.w; x++) {
					patch.rgb[y * patch.w + x] = along[vertical ? y : x];
				}
			}
			drawPatch(rCtx, patch);
		}
		return true;
	}
	if (rec.mode === GRADIENT_FILL_TRIANGLE) {
		for (const idx of rec.mesh) {
			const tri = idx.map((i) => rec.vertices[i]);
			const xs = tri.map((p) => p.x / 16);
			const ys = tri.map((p) => p.y / 16);
			const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1);
			const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
			const x1 = Math.min(rCtx.canvasW, Math.ceil(Math.max(...xs)) + 1);
			const y1 = Math.min(rCtx.canvasH, Math.ceil(Math.max(...ys)) + 1);
			if (x1 <= x0 || y1 <= y0) {
				continue;
			}
			const patch: Patch = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rgb: new Int32Array((x1 - x0) * (y1 - y0)).fill(-1) };
			paintTriangle(tri, patch);
			drawPatch(rCtx, patch);
		}
	}
	return true;
}
