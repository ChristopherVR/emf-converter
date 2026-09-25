/**
 * A minimal, pure-JavaScript raster surface that stands in for a scratch
 * canvas when no canvas implementation exists at all (plain Node.js without
 * the optional `@napi-rs/canvas` package) and the output is SVG.
 *
 * The raster pipeline never needs this: without a canvas it cannot produce a
 * PNG anyway. The SVG backend, however, records vectors and text without any
 * canvas, and only needs scratch surfaces for bitmap work: decoded DIBs
 * placed with `putImageData`, source rectangles resampled with `drawImage`
 * (nearest-neighbour or bilinear, under an arbitrary affine transform),
 * and pixels read back with `getImageData`. That is exactly, and only, what
 * this class implements; vector path methods are accepted as no-ops so a
 * caller probing the context does not throw. Callers that genuinely need
 * vector rasterisation on a scratch surface (the exact bitwise-ROP2 path)
 * check {@link isSoftwareRaster} and fall back to their approximate path.
 *
 * @module software-raster
 */

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

function invert(m: Matrix): Matrix | null {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!det || !Number.isFinite(det)) {
		return null;
	}
	return [
		m[3] / det,
		-m[1] / det,
		-m[2] / det,
		m[0] / det,
		(m[2] * m[5] - m[3] * m[4]) / det,
		(m[1] * m[4] - m[0] * m[5]) / det,
	];
}

/** Plain `ImageData`-shaped pixel holder (the DOM class may not exist). */
export interface RasterPixels {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

interface RasterState {
	transform: Matrix;
	globalAlpha: number;
	imageSmoothingEnabled: boolean;
	fillStyle: string;
}

function parseSolid(color: string): [number, number, number, number] | null {
	const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
	if (hex) {
		const v = parseInt(hex[1], 16);
		return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
	}
	const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
	if (rgb) {
		const p = rgb[1].split(',').map((s) => parseFloat(s));
		return [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? Math.round(p[3] * 255) : 255];
	}
	return null;
}

/** The "canvas" half of a software raster: dimensions plus its context. */
export class SoftwareRasterCanvas {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8ClampedArray;
	readonly ctx: SoftwareRasterContext;

	constructor(width: number, height: number) {
		this.width = Math.max(1, Math.floor(width));
		this.height = Math.max(1, Math.floor(height));
		this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
		this.ctx = new SoftwareRasterContext(this);
	}

	getContext(_type: '2d'): SoftwareRasterContext {
		return this.ctx;
	}
}

/** True when `value` is a {@link SoftwareRasterCanvas} or its context. */
export function isSoftwareRaster(value: unknown): value is SoftwareRasterCanvas | SoftwareRasterContext {
	return value instanceof SoftwareRasterCanvas || value instanceof SoftwareRasterContext;
}

/** The subset of the Canvas 2D API that bitmap scratch work needs. */
export class SoftwareRasterContext {
	readonly canvas: SoftwareRasterCanvas;
	private state: RasterState = {
		transform: [...IDENTITY],
		globalAlpha: 1,
		imageSmoothingEnabled: true,
		fillStyle: '#000000',
	};
	private stack: RasterState[] = [];
	globalCompositeOperation = 'source-over';
	strokeStyle: unknown = '#000000';
	lineWidth = 1;
	font = '10px sans-serif';
	textAlign = 'start';
	textBaseline = 'alphabetic';

	constructor(canvas: SoftwareRasterCanvas) {
		this.canvas = canvas;
	}

	get globalAlpha(): number {
		return this.state.globalAlpha;
	}
	set globalAlpha(v: number) {
		if (Number.isFinite(v) && v >= 0 && v <= 1) {
			this.state.globalAlpha = v;
		}
	}
	get imageSmoothingEnabled(): boolean {
		return this.state.imageSmoothingEnabled;
	}
	set imageSmoothingEnabled(v: boolean) {
		this.state.imageSmoothingEnabled = v;
	}
	get fillStyle(): unknown {
		return this.state.fillStyle;
	}
	set fillStyle(v: unknown) {
		if (typeof v === 'string') {
			this.state.fillStyle = v;
		}
	}

	save(): void {
		this.stack.push({ ...this.state, transform: [...this.state.transform] as Matrix });
	}
	restore(): void {
		const s = this.stack.pop();
		if (s) {
			this.state = s;
		}
	}
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.state.transform = [a, b, c, d, e, f];
	}
	resetTransform(): void {
		this.state.transform = [...IDENTITY];
	}
	transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.state.transform = multiply(this.state.transform, [a, b, c, d, e, f]);
	}
	translate(x: number, y: number): void {
		this.transform(1, 0, 0, 1, x, y);
	}
	scale(x: number, y: number): void {
		this.transform(x, 0, 0, y, 0, 0);
	}
	rotate(angle: number): void {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		this.transform(c, s, -s, c, 0, 0);
	}

	// Vector operations are not rasterised (see the module doc).
	beginPath(): void {}
	closePath(): void {}
	moveTo(): void {}
	lineTo(): void {}
	bezierCurveTo(): void {}
	quadraticCurveTo(): void {}
	arc(): void {}
	arcTo(): void {}
	ellipse(): void {}
	rect(): void {}
	fill(): void {}
	stroke(): void {}
	clip(): void {}
	setLineDash(): void {}
	fillText(): void {}
	isPointInPath(): boolean {
		return false;
	}
	measureText(text: string): { width: number } {
		return { width: text.length * 6 };
	}

	/** Solid, axis-aligned fills only (the scratch-surface use case). */
	fillRect(x: number, y: number, w: number, h: number): void {
		const color = parseSolid(this.state.fillStyle);
		const m = this.state.transform;
		if (!color || m[1] !== 0 || m[2] !== 0) {
			return;
		}
		const x0 = m[0] * x + m[4];
		const y0 = m[3] * y + m[5];
		const x1 = m[0] * (x + w) + m[4];
		const y1 = m[3] * (y + h) + m[5];
		const left = Math.max(0, Math.round(Math.min(x0, x1)));
		const right = Math.min(this.canvas.width, Math.round(Math.max(x0, x1)));
		const top = Math.max(0, Math.round(Math.min(y0, y1)));
		const bottom = Math.min(this.canvas.height, Math.round(Math.max(y0, y1)));
		const alpha = (color[3] / 255) * this.state.globalAlpha;
		for (let py = top; py < bottom; py++) {
			for (let px = left; px < right; px++) {
				this.blend((py * this.canvas.width + px) * 4, color[0], color[1], color[2], alpha);
			}
		}
	}

	clearRect(x: number, y: number, w: number, h: number): void {
		const left = Math.max(0, Math.round(x));
		const top = Math.max(0, Math.round(y));
		const right = Math.min(this.canvas.width, Math.round(x + w));
		const bottom = Math.min(this.canvas.height, Math.round(y + h));
		for (let py = top; py < bottom; py++) {
			this.canvas.pixels.fill(0, (py * this.canvas.width + left) * 4, (py * this.canvas.width + right) * 4);
		}
	}

	getImageData(x: number, y: number, w: number, h: number): RasterPixels {
		const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
		const { width, height, pixels } = this.canvas;
		for (let row = 0; row < h; row++) {
			const sy = y + row;
			if (sy < 0 || sy >= height) {
				continue;
			}
			for (let col = 0; col < w; col++) {
				const sx = x + col;
				if (sx < 0 || sx >= width) {
					continue;
				}
				const si = (sy * width + sx) * 4;
				const di = (row * w + col) * 4;
				out[di] = pixels[si];
				out[di + 1] = pixels[si + 1];
				out[di + 2] = pixels[si + 2];
				out[di + 3] = pixels[si + 3];
			}
		}
		return { data: out, width: w, height: h };
	}

	putImageData(image: RasterPixels, x: number, y: number): void {
		const { width, height, pixels } = this.canvas;
		const dx = Math.round(x);
		const dy = Math.round(y);
		for (let row = 0; row < image.height; row++) {
			const ty = dy + row;
			if (ty < 0 || ty >= height) {
				continue;
			}
			for (let col = 0; col < image.width; col++) {
				const tx = dx + col;
				if (tx < 0 || tx >= width) {
					continue;
				}
				const si = (row * image.width + col) * 4;
				const di = (ty * width + tx) * 4;
				pixels[di] = image.data[si];
				pixels[di + 1] = image.data[si + 1];
				pixels[di + 2] = image.data[si + 2];
				pixels[di + 3] = image.data[si + 3];
			}
		}
	}

	private blend(di: number, r: number, g: number, b: number, a: number): void {
		const p = this.canvas.pixels;
		if (a >= 1) {
			p[di] = r;
			p[di + 1] = g;
			p[di + 2] = b;
			p[di + 3] = 255;
			return;
		}
		if (a <= 0) {
			return;
		}
		const da = p[di + 3] / 255;
		const oa = a + da * (1 - a);
		p[di] = (r * a + p[di] * da * (1 - a)) / oa;
		p[di + 1] = (g * a + p[di + 1] * da * (1 - a)) / oa;
		p[di + 2] = (b * a + p[di + 2] * da * (1 - a)) / oa;
		p[di + 3] = oa * 255;
	}

	/**
	 * `drawImage(src, dx, dy)`, `(src, dx, dy, dw, dh)` or
	 * `(src, sx, sy, sw, sh, dx, dy, dw, dh)` from another software raster (or
	 * any `{width, height, data}` pixel holder), under the current transform,
	 * sampled by inverse mapping each covered device pixel centre.
	 */
	drawImage(source: SoftwareRasterCanvas | RasterPixels, ...args: number[]): void {
		const src: RasterPixels =
			source instanceof SoftwareRasterCanvas
				? { data: source.pixels, width: source.width, height: source.height }
				: source;
		let sx = 0;
		let sy = 0;
		let sw = src.width;
		let sh = src.height;
		let dx: number;
		let dy: number;
		let dw: number;
		let dh: number;
		if (args.length >= 8) {
			[sx, sy, sw, sh, dx, dy, dw, dh] = args;
		} else if (args.length >= 4) {
			[dx, dy, dw, dh] = args;
		} else {
			[dx, dy] = args;
			dw = sw;
			dh = sh;
		}
		if (!sw || !sh || !dw || !dh) {
			return;
		}
		const place: Matrix = [dw / sw, 0, 0, dh / sh, dx - (sx * dw) / sw, dy - (sy * dh) / sh];
		const m = multiply(this.state.transform, place);
		const inv = invert(m);
		if (!inv) {
			return;
		}
		const corners = [
			[sx, sy],
			[sx + sw, sy],
			[sx, sy + sh],
			[sx + sw, sy + sh],
		].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
		const { width, height } = this.canvas;
		const left = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
		const right = Math.min(width, Math.ceil(Math.max(...corners.map((c) => c[0]))));
		const top = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
		const bottom = Math.min(height, Math.ceil(Math.max(...corners.map((c) => c[1]))));
		const uMin = Math.min(sx, sx + sw);
		const uMax = Math.max(sx, sx + sw);
		const vMin = Math.min(sy, sy + sh);
		const vMax = Math.max(sy, sy + sh);
		const smooth = this.state.imageSmoothingEnabled;
		const alpha = this.state.globalAlpha;
		const sd = src.data;
		const texel = (x: number, y: number, c: number): number => {
			const cx = Math.min(Math.max(x, Math.ceil(uMin)), Math.ceil(uMax) - 1, src.width - 1);
			const cy = Math.min(Math.max(y, Math.ceil(vMin)), Math.ceil(vMax) - 1, src.height - 1);
			return sd[(Math.max(0, cy) * src.width + Math.max(0, cx)) * 4 + c];
		};
		for (let py = top; py < bottom; py++) {
			for (let px = left; px < right; px++) {
				const cx = px + 0.5;
				const cy = py + 0.5;
				const u = inv[0] * cx + inv[2] * cy + inv[4];
				const v = inv[1] * cx + inv[3] * cy + inv[5];
				if (u < uMin || u >= uMax || v < vMin || v >= vMax) {
					continue;
				}
				let r: number;
				let g: number;
				let b: number;
				let a: number;
				if (smooth) {
					const fu = u - 0.5;
					const fv = v - 0.5;
					const x0 = Math.floor(fu);
					const y0 = Math.floor(fv);
					const tx = fu - x0;
					const ty = fv - y0;
					const lerp = (c: number): number => {
						const top0 = texel(x0, y0, c) * (1 - tx) + texel(x0 + 1, y0, c) * tx;
						const bot0 = texel(x0, y0 + 1, c) * (1 - tx) + texel(x0 + 1, y0 + 1, c) * tx;
						return top0 * (1 - ty) + bot0 * ty;
					};
					r = lerp(0);
					g = lerp(1);
					b = lerp(2);
					a = lerp(3);
				} else {
					const x = Math.floor(u);
					const y = Math.floor(v);
					r = texel(x, y, 0);
					g = texel(x, y, 1);
					b = texel(x, y, 2);
					a = texel(x, y, 3);
				}
				this.blend((py * width + px) * 4, r, g, b, (a / 255) * alpha);
			}
		}
	}
}
