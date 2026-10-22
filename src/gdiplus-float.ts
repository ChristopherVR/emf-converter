/**
 * Single-precision arithmetic as gdiplus.dll performs it.
 *
 * GDI+ sets the SSE control register to `0x3F80` for the duration of its calls (round toward minus infinity, all exceptions
 * masked; the routines that guard the register compare it with `0x3F80` and load it when it differs), so every `addss`,
 * `subss`, `mulss`, `divss` and `sqrtss` of the renderer rounds down, not to nearest. Captures of the per-vertex path gradient
 * fan are exact on all 174,084 painted pixels with it and 1.2 to 6% off with round-to-nearest.
 *
 * The helpers take single-precision values (or whole numbers) and return the largest single-precision value not above the exact
 * result of the one operation; a double holds the exact result of an add, subtract or multiply of two single-precision values
 * (a sum of operands more than 29 binary orders apart is the only inexact case, and it cannot change a result by a single-precision
 * step), and a double quotient or square root never lands on a single-precision value the exact one is below.
 *
 * @module gdiplus-float
 */

import { down32 } from './float32-down';

export const f32 = Math.fround;

/** The largest single-precision value not above `x`. */
export const downF32 = down32;

const scratch = new Float32Array(1);
const scratchBits = new Uint32Array(scratch.buffer);

/** The single-precision value just below the single-precision value `r` (toward minus infinity). */
function prevF32(r: number): number {
	scratch[0] = r;
	if (r > 0) scratchBits[0] -= 1;
	else if (r < 0) scratchBits[0] += 1;
	else scratchBits[0] = 0x80000001;
	return scratch[0];
}

export const add = (a: number, b: number): number => downF32(a + b);
export const sub = (a: number, b: number): number => downF32(a - b);
export const mul = (a: number, b: number): number => downF32(a * b);

export function div(a: number, b: number): number {
	const r = a / b;
	if (!Number.isFinite(r)) return r;
	let c = downF32(r);
	if (b > 0 ? c * b > a : c * b < a) c = prevF32(c);
	return c;
}

export function sqrt(a: number): number {
	const r = Math.sqrt(a);
	if (!Number.isFinite(r)) return r;
	let c = downF32(r);
	if (c * c > a) c = prevF32(c);
	return c;
}

/** `floor(v)` to a 32-bit integer the way `cvttss2si` returns it (out of range and NaN give -2^31). */
export function floorInt(v: number): number {
	const r = Math.floor(v);
	return r >= -2147483648 && r <= 2147483647 ? r : -2147483648;
}

/** `ceil(v)` to a 32-bit integer. */
export function ceilInt(v: number): number {
	const r = Math.ceil(v);
	return r >= -2147483648 && r <= 2147483647 ? r : -2147483648;
}

/** A point (rounded to single precision, as the records store it) under a matrix in native's order: `(x m11 + y m21) + dx`, `(x m12 + y m22) + dy`. */
export function transformPoint(m: readonly number[], x: number, y: number): [number, number] {
	x = f32(x);
	y = f32(y);
	return [
		add(add(mul(x, f32(m[0])), mul(y, f32(m[2]))), f32(m[4])),
		add(add(mul(x, f32(m[1])), mul(y, f32(m[3]))), f32(m[5])),
	];
}

/** `comiss a, b` followed by `ja`: true when `a > b` (false when unordered). */
export const ja = (a: number, b: number): boolean => a > b;
/** `comiss a, b` followed by `jae`: true when `a >= b` (false when unordered). */
export const jae = (a: number, b: number): boolean => a >= b;
/** `comiss a, b` followed by `jb`: true when `a < b` or unordered. */
export const jb = (a: number, b: number): boolean => !(a >= b);
/** `comiss a, b` followed by `jbe`: true when `a <= b` or unordered. */
export const jbe = (a: number, b: number): boolean => !(a > b);
