/**
 * Float32 arithmetic rounded toward minus infinity, the rounding the GDI+ path-gradient code was
 * measured to use (see `emf-plus-path-gradient-copies.ts` and `emf-plus-brush-gradient.ts`).
 *
 * @module float32-down
 */

const float32 = new Float32Array(1);
const float32Bits = new Uint32Array(float32.buffer);

/** The float32 at or below `x` (rounding toward minus infinity). */
export function down32(x: number): number {
	const r = Math.fround(x);
	if (r <= x || Number.isNaN(r)) return r;
	if (r === 0) {
		float32Bits[0] = 0x80000001;
		return float32[0];
	}
	float32[0] = r;
	float32Bits[0] += r > 0 ? -1 : 1;
	return float32[0];
}
