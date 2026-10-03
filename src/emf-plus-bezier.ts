/** Fixed-point GDI+ curve conversion, shared by strokes and brush boundaries. */
const f32 = Math.fround;

/**
 * GDI+'s float to 28.4 conversion of a device coordinate
 * (`RasterizerCeiling`): the value times 256 (exact in single precision)
 * plus a half, floored, then rounded up to a whole 1/16. Pure.
 */
export function gdiplusFix(v: number): number {
	return (Math.floor(f32(f32(v) * 256 + 0.5)) + 15) >> 4;
}

/**
 * GDI+'s Bezier flattener (`Bezier32::bInit` / `cFlatten`), bit exact: the
 * same fixed-point hybrid forward differencing GDI uses, with GDI+'s own
 * error bounds (0x6000 while setting up, 0x30000 to halve the step, and a
 * parent error of 0xC000 to double it again). `p` is the curve's four
 * 28.4 points (x, y pairs); the points after the first are appended to
 * `out`. With `cull` (the visible bounds, in pixels, which GDI+ passes when
 * a path is only partly visible) a curve whose box, grown by a pixel, lies
 * wholly outside is not subdivided at all: it becomes its chord. A curve
 * too large for 32-bit arithmetic (a coordinate span of 1024 pixels or
 * more) goes to GDI+'s `Bezier64` there; it is evaluated by the same steps
 * here in exact arithmetic. Optional `parameters` receives the dyadic curve
 * parameter for each appended point, for interpolating vertex attributes.
 * Pure apart from the output arrays.
 */
export function flattenBezierGdiplus(
	p: ReadonlyArray<number>,
	out: number[],
	cull?: { x: number; y: number; w: number; h: number },
	parameters?: number[],
): void {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let i = 0; i < 8; i += 2) {
		minX = Math.min(minX, p[i]);
		maxX = Math.max(maxX, p[i]);
		minY = Math.min(minY, p[i + 1]);
		maxY = Math.max(maxY, p[i + 1]);
	}
	const left = minX - 16;
	const top = minY - 16;
	const X = [p[0] - left, p[2] - left, p[4] - left, p[6] - left];
	const Y = [p[1] - top, p[3] - top, p[5] - top, p[7] - top];
	const sar = (v: number, n: number): number => Math.floor(v / 2 ** n);
	// e0 = p0, e1 = p3 - p0, e2 = 6 (p1 - 2 p2 + p3), e3 = 6 (p0 - 2 p1 + p2), scaled by 2^10.
	const ex = [X[0] * 1024, (X[3] - X[0]) * 1024, 3 * (X[1] - 2 * X[2] + X[3]) * 2048, 3 * (X[0] - 2 * X[1] + X[2]) * 2048];
	const ey = [Y[0] * 1024, (Y[3] - Y[0]) * 1024, 3 * (Y[1] - 2 * Y[2] + Y[3]) * 2048, 3 * (Y[0] - 2 * Y[1] + Y[2]) * 2048];
	let steps = 1;
	let shift = 0;
	const outside =
		!!cull &&
		(minX - 16 >= (cull.x + cull.w) * 16 ||
			minY - 16 >= (cull.y + cull.h) * 16 ||
			maxX + 16 <= cull.x * 16 ||
			maxY + 16 <= cull.y * 16);
	const maxAbs = (a: number, b: number): number => (Math.abs(a) > Math.abs(b) ? Math.abs(a) : Math.abs(b));
	if (!outside) {
		for (let guard = 0; guard < 40; guard++) {
			const limit = 0x6000 * 2 ** shift;
			if (maxAbs(ex[2], ex[3]) <= limit && maxAbs(ey[2], ey[3]) <= limit) {
				break;
			}
			shift += 2;
			for (const e of [ex, ey]) {
				e[2] = sar(e[2] + e[3], 1);
				e[1] = sar(e[1] - sar(e[2], shift), 1);
			}
			steps *= 2;
		}
	}
	for (const e of [ex, ey]) {
		e[0] *= 8;
		e[1] *= 8;
		const l = shift - 3;
		if (l >= 0) {
			e[2] = sar(e[2], l);
			e[3] = sar(e[3], l);
		} else {
			e[2] *= 2 ** -l;
			e[3] *= 2 ** -l;
		}
	}
	const step = (e: number[]): void => {
		e[0] += e[1];
		const t = e[2];
		e[1] += t;
		e[2] = t + t - e[3];
		e[3] = t;
	};
	let dt = 1 / steps;
	let t = dt;
	// bInit already takes the first step.
	step(ex);
	step(ey);
	steps--;
	for (let guard = 0; guard < 1 << 22; guard++) {
		out.push(sar(ex[0] + 0x1000, 13) + left, sar(ey[0] + 0x1000, 13) + top);
		parameters?.push(t);
		if (steps === 0) {
			return;
		}
		if (Math.max(maxAbs(ex[2], ex[3]), maxAbs(ey[2], ey[3])) > 0x30000) {
			for (const e of [ex, ey]) {
				e[2] = sar(e[2] + e[3], 3);
				e[1] = sar(e[1] - e[2], 1);
				e[3] = sar(e[3], 2);
			}
			steps *= 2;
			dt /= 2;
		}
		while (
			steps % 2 === 0 &&
			maxAbs(ex[3], 2 * ex[2] - ex[3]) <= 0xc000 &&
			maxAbs(ey[3], 2 * ey[2] - ey[3]) <= 0xc000
		) {
			for (const e of [ex, ey]) {
				e[3] *= 4;
				e[1] = e[2] + 2 * e[1];
				e[2] = e[2] * 8 - e[3];
			}
			steps /= 2;
			dt *= 2;
		}
		steps--;
		t += dt;
		step(ex);
		step(ey);
	}
}
