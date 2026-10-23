/**
 * The vertical stage of GDI ClearType with symmetric smoothing (native `ulClearTypeFilter_6x5` in fontdrvhost.exe) turns
 * five rows of per-channel levels (0 to 6 samples of a three-subpixel box) into one level per channel, then looks the
 * three levels up in a table of 343 codes. Only 115 level triples can come out of a single row (the 3-tap box over
 * consecutive two-sample subpixels cannot jump by more than two between neighbouring channels); the table sends every other
 * triple to the code of a reachable one (a lone level 1 in the middle channel disappears, (0, 0, 3) becomes (0, 0, 2)).
 * `TABLE` is that table, a native constant read from fontdrvhost.exe at rva 0xa6720 (indexed by (r * 7 + g) * 7 + b);
 * the reachable triple of each code follows from the box sums.
 */
const TABLE: readonly number[] = [
	0, 1, 2, 2, 5, 5, 8, 0, 3, 4, 5, 5, 8, 8, 3, 3, 6, 7, 8, 8, 23, 16, 6, 6, 7, 8, 23, 23, 16, 20, 20, 21, 22, 23, 23, 20, 20, 20, 21, 22, 23, 45, 41, 41, 41, 42, 43, 44, 45,
	9, 10, 11, 11, 15, 15, 19, 12, 13, 14, 15, 15, 19, 19, 12, 16, 17, 18, 19, 19, 23, 16, 16, 20, 21, 22, 23, 23, 36, 20, 20, 21, 22, 23, 45, 36, 41, 41, 42, 43, 44, 45, 41, 41, 41, 42, 43, 44, 45,
	24, 25, 26, 26, 30, 30, 35, 27, 28, 29, 30, 30, 35, 35, 31, 32, 33, 34, 35, 35, 40, 31, 36, 37, 38, 39, 40, 40, 36, 36, 41, 42, 43, 44, 45, 36, 41, 41, 42, 43, 44, 45, 41, 41, 65, 65, 66, 67, 68,
	24, 25, 26, 49, 49, 49, 54, 46, 47, 48, 49, 49, 54, 54, 50, 51, 52, 53, 54, 54, 59, 50, 55, 56, 57, 58, 59, 59, 55, 55, 60, 61, 62, 63, 64, 55, 60, 60, 65, 66, 67, 68, 60, 60, 65, 65, 66, 67, 68,
	46, 47, 48, 49, 49, 73, 73, 46, 47, 48, 49, 73, 73, 73, 69, 70, 71, 72, 73, 73, 78, 69, 74, 75, 76, 77, 78, 78, 74, 74, 79, 80, 81, 82, 83, 74, 79, 79, 84, 85, 86, 87, 79, 79, 84, 84, 88, 89, 90,
	46, 47, 48, 49, 73, 73, 73, 69, 70, 71, 72, 73, 73, 73, 69, 70, 71, 72, 73, 73, 78, 91, 91, 92, 93, 94, 78, 78, 91, 91, 95, 96, 97, 98, 83, 91, 95, 95, 99, 100, 101, 102, 95, 95, 99, 99, 103, 104, 105,
	69, 70, 71, 72, 73, 73, 73, 69, 70, 71, 72, 73, 73, 73, 91, 91, 92, 93, 94, 94, 78, 91, 91, 92, 93, 94, 94, 98, 91, 106, 106, 107, 108, 98, 98, 106, 106, 106, 109, 110, 111, 102, 106, 106, 109, 109, 112, 113, 114,
];

const REACHABLE = new Map<number, [number, number, number]>();
for (let i = 0; i < 243; i++) {
	const u = Math.floor(i / 81) % 3;
	const s0 = Math.floor(i / 27) % 3;
	const s1 = Math.floor(i / 9) % 3;
	const s2 = Math.floor(i / 3) % 3;
	const r = i % 3;
	const triple: [number, number, number] = [u + s0 + s1, s0 + s1 + s2, s1 + s2 + r];
	REACHABLE.set(TABLE[(triple[0] * 7 + triple[1]) * 7 + triple[2]], triple);
}

/** The levels (each 0 to 6) native keeps for a pixel whose vertically filtered per-channel levels are `r`, `g`, `b`. */
export function snapClearTypeLevels(r: number, g: number, b: number): [number, number, number] {
	return REACHABLE.get(TABLE[(r * 7 + g) * 7 + b])!;
}
