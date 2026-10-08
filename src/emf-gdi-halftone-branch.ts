/**
 * Which enlargement branch Windows' HALFTONE `StretchBlt` takes for a source
 * rectangle: the replicated branch (despeckle, then the nearest source pixel)
 * or the filtered branch (sharpen, then interpolate).
 *
 * The rule was isolated by boundary sweeps against the native engine
 * (`scripts/gdi-fixtures/HalftoneBoundaryProbe.cs`, `halftone-boundary.json.gz`):
 * the decision depends only on the source rectangle (its pixels, not the rest
 * of the bitmap), never on the destination size, the colour adjustment or the
 * blit API, and it is global. The engine scans the rectangle row by row counting
 * distinct colours and compares the count with limits that depend on the size
 * of the rectangle (`n` pixels, `w` wide, `h` high):
 *
 * - A colour is the exact 24-bit value, except that a colour whose red and
 *   blue are equal is identified by the top six bits of its blue and green.
 * - Up to 2,304 pixels the replicated branch is always taken.
 * - Above 16,384 pixels only rows 0, 6, 12, ... are looked at, and the filtered
 *   branch needs 20 distinct colours among them.
 * - In between every row is scanned. With `rows` the least row count whose
 *   pixels (`rows * w`) exceed 2,304 and `o = rows * w - 2304`, a rectangle with
 *   fewer rows is replicated, one with more rows takes the filtered branch as
 *   soon as it has counted `145 + floor(o / 16)` colours, or 20 colours and more
 *   than 2,304 pixels in the rows that introduced a colour. The scan gives up
 *   (replicated) once the colours counted so far plus one row of pixels for
 *   every duplicate row (a row whose colours were all seen in earlier rows)
 *   plus the next row reaches `n - 2305 + limit`.
 * - A rectangle with exactly `rows` rows needs 289 + floor(o / 8) colours, but
 *   its give-up rule is not the one above, so it is reported as unknown.
 *
 * Every constant reproduces the native sweeps committed with the probe (see
 * `halftone-boundary.fixture.test.ts` for the counts and for what stays
 * unexplained). The scale factor was only varied over whole factors 2 to 4
 * (no change), so non-integer stretches are outside the evidence.
 */

/** Distinct-colour identity used by the engine's count (see the module comment). */
export function halftoneColorKey(r: number, g: number, b: number): number {
	return b === r ? 0x1000000 | ((b >> 2) << 8) | (g >> 2) : b | (g << 8) | (r << 16);
}

export type HalftoneBranch = 'replicate' | 'filter' | 'unknown';

/**
 * @param rgb RGB triples of the source rectangle, row-major.
 * @param w Rectangle width in pixels.
 * @param h Rectangle height in pixels.
 */
export function halftoneBranch(rgb: ArrayLike<number>, w: number, h: number): HalftoneBranch {
	if (w <= 0 || h <= 0) return 'replicate';
	const n = w * h;
	if (n <= 2304) return 'replicate';
	const keyAt = (i: number): number => halftoneColorKey(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
	const seen = new Set<number>();
	if (n > 16384) {
		for (let y = 0; y < h; y += 6) {
			for (let x = 0; x < w; x++) seen.add(keyAt(y * w + x));
			if (seen.size >= 20) return 'filter';
		}
		return 'replicate';
	}
	const rows = Math.floor(2304 / w) + 1;
	if (h < rows) return 'replicate';
	if (h === rows) return 'unknown';
	const limit = 145 + Math.floor((rows * w - 2304) / 16);
	let colors = 0;
	let duplicateRows = 0;
	let coloredPixels = 0;
	let gaveUp = false;
	for (let y = 0; y < h; y++) {
		let added = 0;
		for (let x = 0; x < w; x++) {
			const key = keyAt(y * w + x);
			if (!seen.has(key)) {
				seen.add(key);
				added++;
			}
		}
		colors += added;
		if (!gaveUp && colors >= limit) return 'filter';
		if (added === 0) duplicateRows++;
		else coloredPixels += w;
		if (colors >= 20 && coloredPixels > 2304) return 'filter';
		if (colors + (duplicateRows + 1) * w >= n - 2305 + limit) gaveUp = true;
	}
	return 'replicate';
}
