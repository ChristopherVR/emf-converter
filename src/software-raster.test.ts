/**
 * The pure-JavaScript Canvas 2D rasteriser (`software-raster.ts`): exact
 * analytic coverage, strokes, clipping, paints, compositing, images, pixel
 * access and hit testing, checked against ground truth and, where Skia's
 * behaviour is the reference (hairlines, straight edges, gradients), against
 * `@napi-rs/canvas`.
 */
import { describe, expect, it } from 'vitest';

import { SoftwareRasterCanvas } from './software-raster';

type Ctx = SoftwareRasterCanvas['ctx'];

function page(w: number, h: number, draw: (c: Ctx) => void): SoftwareRasterCanvas {
	const s = new SoftwareRasterCanvas(w, h);
	s.ctx.fillStyle = '#ffffff';
	s.ctx.fillRect(0, 0, w, h);
	s.ctx.fillStyle = '#000000';
	draw(s.ctx);
	return s;
}

function at(s: SoftwareRasterCanvas, x: number, y: number): number[] {
	return Array.from(s.ctx.getImageData(x, y, 1, 1).data);
}

/** Covered fraction of pixel (px, py) by `inside`, by 256x256 supersampling. */
function groundTruth(inside: (x: number, y: number) => boolean, px: number, py: number): number {
	const n = 256;
	let hits = 0;
	for (let j = 0; j < n; j++) {
		for (let i = 0; i < n; i++) {
			if (inside(px + (i + 0.5) / n, py + (j + 0.5) / n)) {
				hits++;
			}
		}
	}
	return hits / (n * n);
}

describe('SoftwareRasterCanvas coverage', () => {
	it('fills pixel-aligned rectangles bit-exactly', () => {
		const s = page(10, 10, (c) => c.fillRect(2, 3, 4, 5));
		expect(at(s, 2, 3)).toEqual([0, 0, 0, 255]);
		expect(at(s, 5, 7)).toEqual([0, 0, 0, 255]);
		expect(at(s, 1, 3)).toEqual([255, 255, 255, 255]);
		expect(at(s, 6, 3)).toEqual([255, 255, 255, 255]);
	});

	it('computes the exact covered area on a rotated edge', () => {
		const cs = Math.cos(0.4);
		const sn = Math.sin(0.4);
		const inside = (x: number, y: number): boolean => {
			const u = cs * (x - 50) + sn * (y - 50);
			const v = -sn * (x - 50) + cs * (y - 50);
			return Math.abs(u) <= 30 && Math.abs(v) <= 20;
		};
		const s = page(100, 100, (c) => {
			c.translate(50, 50);
			c.rotate(0.4);
			c.fillRect(-30, -20, 60, 40);
		});
		for (const [x, y] of [
			[54, 30],
			[55, 30],
			[43, 25],
			[25, 30],
		]) {
			const expected = 255 - 255 * groundTruth(inside, x, y);
			expect(Math.abs(at(s, x, y)[0] - expected)).toBeLessThanOrEqual(1);
		}
	});

	it('honours the nonzero and even-odd rules', () => {
		const draw = (rule: CanvasFillRule) =>
			page(20, 20, (c) => {
				c.beginPath();
				c.rect(2, 2, 16, 16);
				c.rect(6, 6, 8, 8);
				c.fill(rule);
			});
		expect(at(draw('nonzero'), 10, 10)[0]).toBe(0);
		expect(at(draw('evenodd'), 10, 10)[0]).toBe(255);
		expect(at(draw('evenodd'), 3, 3)[0]).toBe(0);
	});

	it('clips to an intersected stack of paths, restored by restore()', () => {
		const s = page(20, 20, (c) => {
			c.save();
			c.beginPath();
			c.rect(0, 0, 10, 20);
			c.clip();
			c.beginPath();
			c.rect(5, 0, 15, 20);
			c.clip();
			c.fillStyle = '#ff0000';
			c.fillRect(0, 0, 20, 20);
			c.restore();
			c.fillStyle = '#0000ff';
			c.fillRect(15, 15, 5, 5);
		});
		expect(at(s, 2, 2)).toEqual([255, 255, 255, 255]);
		expect(at(s, 7, 2)).toEqual([255, 0, 0, 255]);
		expect(at(s, 12, 2)).toEqual([255, 255, 255, 255]);
		expect(at(s, 17, 17)).toEqual([0, 0, 255, 255]);
	});
});

describe('SoftwareRasterCanvas strokes', () => {
	it('strokes wide lines with caps and miter joins', () => {
		const s = page(40, 40, (c) => {
			c.lineWidth = 6;
			c.lineCap = 'square';
			c.beginPath();
			c.moveTo(10, 10);
			c.lineTo(30, 10);
			c.lineTo(30, 30);
			c.stroke();
		});
		expect(at(s, 20, 10)[0]).toBe(0); // body
		expect(at(s, 8, 10)[0]).toBe(0); // square cap past the start
		expect(at(s, 32, 8)[0]).toBe(0); // miter corner
		expect(at(s, 20, 20)[0]).toBe(255);
	});

	it('dashes along the path with an offset', () => {
		const s = page(40, 10, (c) => {
			c.lineWidth = 2;
			c.setLineDash([4, 4]);
			c.lineDashOffset = 2;
			c.beginPath();
			c.moveTo(0, 5);
			c.lineTo(40, 5);
			c.stroke();
		});
		// Dashes cover [0,2), [6,10), [14,18), ...
		expect(at(s, 1, 5)[0]).toBe(0);
		expect(at(s, 4, 5)[0]).toBe(255);
		expect(at(s, 8, 5)[0]).toBe(0);
		expect(at(s, 12, 5)[0]).toBe(255);
	});

	it('draws one-pixel strokes as Skia hairlines, pixel for pixel like @napi-rs/canvas', async () => {
		const napi = await import('@napi-rs/canvas');
		const draw = (c: Ctx | ReturnType<ReturnType<typeof napi.createCanvas>['getContext']>) => {
			c.fillStyle = '#ffffff';
			c.fillRect(0, 0, 100, 100);
			c.beginPath();
			c.moveTo(10.5, 10.5);
			c.lineTo(90.5, 20.5);
			c.lineTo(50.5, 90.5);
			c.closePath();
			c.lineWidth = 1;
			c.strokeStyle = '#000000';
			c.stroke();
		};
		const n = napi.createCanvas(100, 100);
		draw(n.getContext('2d'));
		const s = new SoftwareRasterCanvas(100, 100);
		draw(s.ctx);
		expect(Array.from(s.ctx.getImageData(0, 0, 100, 100).data)).toEqual(
			Array.from(n.getContext('2d').getImageData(0, 0, 100, 100).data),
		);
	});

	it('hit-tests paths and strokes', () => {
		const s = new SoftwareRasterCanvas(20, 20);
		const c = s.ctx;
		c.beginPath();
		c.rect(2, 2, 10, 10);
		expect(c.isPointInPath(5, 5)).toBe(true);
		expect(c.isPointInPath(15, 5)).toBe(false);
		c.lineWidth = 2;
		expect(c.isPointInStroke(2, 6)).toBe(true);
		expect(c.isPointInStroke(6, 6)).toBe(false);
	});
});

describe('SoftwareRasterCanvas paints and compositing', () => {
	it('renders gradients like @napi-rs/canvas (within two levels of rounding)', async () => {
		const napi = await import('@napi-rs/canvas');
		const paint = (c: Ctx | ReturnType<ReturnType<typeof napi.createCanvas>['getContext']>) => {
			const g = c.createLinearGradient(10, 10, 90, 60);
			g.addColorStop(0, '#ff0000');
			g.addColorStop(0.5, 'rgba(0,255,0,0.5)');
			g.addColorStop(1, '#0000ff');
			c.fillStyle = g as never;
			c.fillRect(0, 0, 100, 50);
			const r = c.createRadialGradient(40, 70, 5, 55, 75, 25);
			r.addColorStop(0, '#ffffff');
			r.addColorStop(1, '#003366');
			c.fillStyle = r as never;
			c.fillRect(0, 50, 100, 50);
		};
		const n = napi.createCanvas(100, 100);
		paint(n.getContext('2d'));
		const s = new SoftwareRasterCanvas(100, 100);
		paint(s.ctx);
		const a = n.getContext('2d').getImageData(0, 0, 100, 100).data;
		const b = s.ctx.getImageData(0, 0, 100, 100).data;
		let worst = 0;
		for (let i = 0; i < a.length; i++) {
			worst = Math.max(worst, Math.abs(a[i] - b[i]));
		}
		expect(worst).toBeLessThanOrEqual(2);
	});

	it('repeats patterns under their own transform, unfiltered when smoothing is off', () => {
		const tile = new SoftwareRasterCanvas(2, 1);
		tile.ctx.putImageData({ data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1 }, 0, 0);
		const s = page(8, 2, (c) => {
			const p = c.createPattern(tile, 'repeat')!;
			p.setTransform({ a: 2, d: 2, e: 1 });
			c.imageSmoothingEnabled = false;
			c.fillStyle = p;
			c.fillRect(0, 0, 8, 2);
		});
		expect(at(s, 0, 0)).toEqual([0, 0, 255, 255]);
		expect(at(s, 1, 0)).toEqual([255, 0, 0, 255]);
		expect(at(s, 3, 0)).toEqual([0, 0, 255, 255]);
		expect(at(s, 5, 1)).toEqual([255, 0, 0, 255]);
	});

	it('implements blend and Porter-Duff operators', () => {
		const s = page(4, 1, (c) => {
			c.fillStyle = '#336699';
			c.fillRect(0, 0, 4, 1);
			c.globalCompositeOperation = 'difference';
			c.fillStyle = '#ffffff';
			c.fillRect(0, 0, 1, 1);
			c.globalCompositeOperation = 'multiply';
			c.fillStyle = '#ff0000';
			c.fillRect(1, 0, 1, 1);
			c.globalCompositeOperation = 'destination-out';
			c.fillRect(2, 0, 1, 1);
			c.globalCompositeOperation = 'source-over';
			c.globalAlpha = 0.5;
			c.fillStyle = '#000000';
			c.fillRect(3, 0, 1, 1);
		});
		expect(at(s, 0, 0)).toEqual([0xcc, 0x99, 0x66, 255]);
		expect(at(s, 1, 0)).toEqual([0x33, 0, 0, 255]);
		expect(at(s, 2, 0)[3]).toBe(0);
		expect(at(s, 3, 0)).toEqual([26, 51, 76, 255]);
	});

	it('clears outside the shape for the unbounded copy operator', () => {
		const s = page(4, 1, (c) => {
			c.globalCompositeOperation = 'copy';
			c.fillStyle = '#ff0000';
			c.fillRect(0, 0, 2, 1);
		});
		expect(at(s, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(at(s, 3, 0)[3]).toBe(0);
	});
});

describe('SoftwareRasterCanvas images and pixels', () => {
	it('puts, scales (nearest) and reads back pixels', () => {
		const src = new SoftwareRasterCanvas(2, 1);
		src.ctx.putImageData({ data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1 }, 0, 0);
		const dst = new SoftwareRasterCanvas(4, 2);
		dst.ctx.imageSmoothingEnabled = false;
		dst.ctx.drawImage(src, 0, 0, 4, 2);
		const px = dst.ctx.getImageData(0, 0, 4, 2).data;
		expect(Array.from(px.slice(0, 4))).toEqual([255, 0, 0, 255]);
		expect(Array.from(px.slice(8, 12))).toEqual([0, 0, 255, 255]);
		expect(Array.from(px.slice(28, 32))).toEqual([0, 0, 255, 255]);
	});

	it('mirrors through a negative-scale transform and crops a source rectangle', () => {
		const src = new SoftwareRasterCanvas(3, 1);
		src.ctx.putImageData(
			{ data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]), width: 3, height: 1 },
			0,
			0,
		);
		const dst = new SoftwareRasterCanvas(2, 1);
		dst.ctx.transform(-1, 0, 0, 1, 2, 0);
		dst.ctx.imageSmoothingEnabled = false;
		dst.ctx.drawImage(src, 1, 0, 2, 1, 0, 0, 2, 1);
		expect(Array.from(dst.ctx.getImageData(0, 0, 2, 1).data)).toEqual([0, 0, 255, 255, 0, 255, 0, 255]);
	});

	it('round-trips translucent pixels through premultiplied storage like Canvas', () => {
		const s = new SoftwareRasterCanvas(1, 1);
		s.ctx.putImageData({ data: Uint8ClampedArray.from([200, 100, 50, 128]), width: 1, height: 1 }, 0, 0);
		const back = Array.from(s.ctx.getImageData(0, 0, 1, 1).data);
		expect(back[3]).toBe(128);
		back.slice(0, 3).forEach((v, i) => expect(Math.abs(v - [200, 100, 50][i])).toBeLessThanOrEqual(1));
	});

	it('paints no glyphs but counts text and marks where it would be unknown', () => {
		const s = page(100, 40, (c) => {
			c.font = '16px Arial';
			c.fillText('Hi there', 5, 25);
		});
		expect(s.textDraws).toBe(1);
		expect(at(s, 10, 20)).toEqual([255, 255, 255, 255]);
		expect(s.unknownIn(5, 10, 20, 15)).not.toBeNull();
		expect(s.unknownIn(0, 36, 100, 4)).toBeNull();
		s.ctx.putImageData({ data: new Uint8ClampedArray(100 * 40 * 4), width: 100, height: 40 }, 0, 0);
		expect(s.unknownIn(0, 0, 100, 40)).toBeNull();
	});
});
