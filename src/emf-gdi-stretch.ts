/**
 * GDI-exact bitmap stretching for StretchBlt / StretchDIBits.
 *
 * Canvas `drawImage` resamples with its own rules, which differ from GDI's
 * on ties and on shrinking. GDI's non-HALFTONE stretch modes are all
 * nearest-neighbour on enlargement; on reduction COLORONCOLOR drops the
 * eliminated pixels, while BLACKONWHITE ANDs and WHITEONBLACK ORs them into
 * the surviving pixel. HALFTONE (a filtered resample) is left to the canvas.
 * The sampling rules were matched against real Windows GDI output
 * (`scripts/gdi-fixtures`, case `rop3-stretch-sampling`).
 *
 * @module emf-gdi-stretch
 */

/** GDI stretch modes (EMR_SETSTRETCHBLTMODE). */
export const BLACKONWHITE = 1;
export const WHITEONBLACK = 2;
export const COLORONCOLOR = 3;
export const HALFTONE = 4;

/** Plain pixel buffer (structurally an `ImageData`). */
export interface Pixels {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

/**
 * GDI's nearest source pixel for destination pixel `i`: the pixel under the
 * destination pixel's centre, computed in exact integer arithmetic so an
 * exact tie (a 2.5x stretch) always resolves upward, as GDI does.
 */
export function gdiNearest(i: number, srcLen: number, dstLen: number): number {
	const k = Math.floor(((2 * i + 1) * srcLen) / (2 * dstLen));
	return Math.max(0, Math.min(srcLen - 1, k));
}

/**
 * Source indices feeding each of `dstLen` destination pixels along one
 * axis, for a source run of `srcLen` pixels starting at `srcStart`.
 * `reverse` walks the source backwards (a mirrored blit). When enlarging
 * (or dropping pixels, COLORONCOLOR) each destination pixel reads its
 * {@link gdiNearest} source pixel; when reducing under BLACKONWHITE /
 * WHITEONBLACK, it also absorbs every source pixel eliminated since the
 * previous destination pixel's, i.e. the run `(c[i-1], c[i]]` (leftovers
 * after the last kept pixel are dropped, as GDI's DDA does).
 */
export function axisSamples(
	srcStart: number,
	srcLen: number,
	dstLen: number,
	reverse: boolean,
	combine: boolean,
): number[][] {
	const out: number[][] = [];
	const at = (k: number): number => (reverse ? srcStart + srcLen - 1 - k : srcStart + k);
	if (dstLen <= 0 || srcLen <= 0) {
		return out;
	}
	let prev = -1;
	for (let i = 0; i < dstLen; i++) {
		const c = gdiNearest(i, srcLen, dstLen);
		const run: number[] = [];
		const from = combine && dstLen < srcLen ? prev + 1 : c;
		for (let k = from; k <= c; k++) {
			run.push(at(k));
		}
		out.push(run);
		prev = c;
	}
	return out;
}

/**
 * Stretches the source rect (`sx`,`sy`,`sw`,`sh`, negative extents mirror)
 * of `src` onto a `dw` x `dh` destination (negative extents mirror), using
 * GDI's rules for `mode`. Pixels outside `src` read as black.
 */
export function stretchGdi(
	src: Pixels,
	sx: number,
	sy: number,
	sw: number,
	sh: number,
	dw: number,
	dh: number,
	mode: number,
): Pixels {
	const W = Math.max(0, Math.round(Math.abs(dw)));
	const H = Math.max(0, Math.round(Math.abs(dh)));
	const flipX = dw < 0 !== sw < 0;
	const flipY = dh < 0 !== sh < 0;
	const combine = mode === BLACKONWHITE || mode === WHITEONBLACK;
	const cols = axisSamples(Math.round(Math.min(sx, sx + sw)), Math.round(Math.abs(sw)), W, flipX, combine);
	const rows = axisSamples(Math.round(Math.min(sy, sy + sh)), Math.round(Math.abs(sh)), H, flipY, combine);
	const data = new Uint8ClampedArray(W * H * 4);
	const s = src.data;
	const read = (x: number, y: number): number => {
		if (x < 0 || y < 0 || x >= src.width || y >= src.height) {
			return 0;
		}
		const i = (y * src.width + x) * 4;
		return (s[i] << 16) | (s[i + 1] << 8) | s[i + 2];
	};
	for (let y = 0; y < H; y++) {
		const ys = rows[y] ?? [];
		for (let x = 0; x < W; x++) {
			const xs = cols[x] ?? [];
			let v = mode === BLACKONWHITE ? 0xffffff : 0;
			let first = true;
			for (const yy of ys) {
				for (const xx of xs) {
					const p = read(xx, yy);
					if (mode === BLACKONWHITE) {
						v &= p;
					} else if (mode === WHITEONBLACK) {
						v |= p;
					} else if (first) {
						v = p;
					}
					first = false;
				}
			}
			const o = (y * W + x) * 4;
			data[o] = (v >> 16) & 0xff;
			data[o + 1] = (v >> 8) & 0xff;
			data[o + 2] = v & 0xff;
			data[o + 3] = 255;
		}
	}
	return { width: W, height: H, data };
}
