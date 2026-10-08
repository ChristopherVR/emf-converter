/**
 * Native HighQualityBicubic weights of an upscaled axis, one row per 1/128-texel phase bin below one half (bins
 * 0 to 63), as integers over 65536.
 *
 * Origin: measured from Windows GDI+ (not derived). The probe `HighQualityCubicWeightProbe.cs` draws rows of
 * noise through a 128/127 upscale so that every destination column visits all 128 bins, with source values chosen
 * so that many sums fall close to a half level (`generate-hq-cubic-source.ts`); the rounded native result then
 * excludes every neighbouring weight vector, and exactly one integer vector per bin reproduces all 1.2 million
 * values (the capture is `hq-cubic-weights.json.gz` under `src/__fixtures__/gdi`). Each row sums to 65536 and the
 * five taps are the texels `-2..2` around the bin's base texel, centred on `(bin + 1/2) / 128`. The 64 bins from
 * one half to one are the mirror image (the measured table is exactly symmetric): bin `127 - b` is row `b`
 * reversed, over the texels `-1..3`. 88 of the 128 rows equal the kernel integral with each texel edge rounded to
 * 1/65536; the other 40 differ by one unit between two adjacent taps, which is why the table is measured.
 */
export const HQ_CUBIC_HALF_TABLE: readonly (readonly number[])[] = [
	[-1675, 5953, 56660, 6337, -1739],
	[-1612, 5575, 56650, 6727, -1804],
	[-1550, 5203, 56630, 7123, -1870],
	[-1489, 4837, 56600, 7525, -1937],
	[-1429, 4477, 56561, 7931, -2004],
	[-1371, 4125, 56510, 8345, -2073],
	[-1313, 3777, 56451, 8763, -2142],
	[-1257, 3437, 56381, 9187, -2212],
	[-1202, 3103, 56301, 9617, -2283],
	[-1148, 2775, 56211, 10053, -2355],
	[-1095, 2453, 56112, 10493, -2427],
	[-1044, 2139, 56002, 10939, -2500],
	[-993, 1829, 55884, 11389, -2573],
	[-945, 1529, 55754, 11845, -2647],
	[-897, 1233, 55616, 12305, -2721],
	[-851, 945, 55467, 12771, -2796],
	[-806, 663, 55309, 13241, -2871],
	[-762, 387, 55142, 13715, -2946],
	[-720, 119, 54964, 14195, -3022],
	[-679, -143, 54778, 14677, -3097],
	[-639, -399, 54582, 15165, -3173],
	[-600, -649, 54377, 15657, -3249],
	[-563, -891, 54162, 16153, -3325],
	[-528, -1125, 53937, 16653, -3401],
	[-493, -1355, 53705, 17155, -3476],
	[-460, -1577, 53462, 17663, -3552],
	[-429, -1791, 53210, 18173, -3627],
	[-398, -2001, 52950, 18687, -3702],
	[-369, -2203, 52681, 19203, -3776],
	[-341, -2399, 52403, 19723, -3850],
	[-315, -2587, 52116, 20245, -3923],
	[-289, -2771, 51821, 20771, -3996],
	[-265, -2947, 51517, 21299, -4068],
	[-243, -3115, 51204, 21829, -4139],
	[-221, -3279, 50884, 22361, -4209],
	[-201, -3435, 50554, 22897, -4279],
	[-182, -3585, 50217, 23433, -4347],
	[-164, -3729, 49872, 23971, -4414],
	[-147, -3867, 49518, 24513, -4481],
	[-131, -3999, 49158, 25053, -4545],
	[-117, -4123, 48788, 25597, -4609],
	[-103, -4243, 48412, 26141, -4671],
	[-90, -4357, 48029, 26685, -4731],
	[-79, -4463, 47637, 27231, -4790],
	[-68, -4565, 47239, 27777, -4847],
	[-59, -4659, 46833, 28323, -4902],
	[-50, -4749, 46421, 28869, -4955],
	[-42, -4833, 46002, 29415, -5006],
	[-35, -4911, 45576, 29961, -5055],
	[-29, -4983, 45143, 30507, -5102],
	[-24, -5049, 44704, 31051, -5146],
	[-19, -5111, 44259, 31595, -5188],
	[-15, -5167, 43807, 32139, -5228],
	[-11, -5219, 43351, 32679, -5264],
	[-8, -5265, 42888, 33219, -5298],
	[-6, -5305, 42419, 33757, -5329],
	[-4, -5341, 41944, 34295, -5358],
	[-3, -5371, 41464, 34829, -5383],
	[-2, -5397, 40980, 35359, -5404],
	[-1, -5419, 40490, 35889, -5423],
	[0, -5437, 39996, 36415, -5438],
	[0, -5449, 39497, 36937, -5449],
	[0, -5457, 38993, 37457, -5457],
	[0, -5461, 38485, 37973, -5461],
];

/**
 * The five integer weights (over 65536) of the texels `first .. first + 4` for the phase bin `bin` (0 to 127) of
 * an upscaled HighQualityBicubic axis, where `first` is relative to the texel containing the phase position: `-2`
 * for bins below 64, `-1` from 64.
 */
export function hqCubicBinWeights(bin: number): { first: number; weights: readonly number[] } {
	if (bin < 64) {
		return { first: -2, weights: HQ_CUBIC_HALF_TABLE[bin] };
	}
	return { first: -1, weights: HQ_CUBIC_HALF_TABLE[127 - bin].slice().reverse() };
}

/**
 * The running integral of the native bicubic kernel (an odd function, `-32768 .. 32768` over 65536) at the
 * half-grid points `u = (m + 1/2) / 128`, for `m` from -256 to 255, rebuilt from the measured weights: tap `i` of
 * bin `b` spans the texel edges `128 t - 64 - b - 1` and `+ 128` in these units.
 */
const HQ_CUBIC_CDF: Int32Array = (() => {
	const cdf = new Int32Array(512).fill(Number.NaN);
	for (let bin = 0; bin < 128; bin++) {
		const { first, weights } = hqCubicBinWeights(bin);
		let acc = -32768;
		for (let i = 0; i <= 5; i++) {
			const m = 128 * (first + i) - 64 - bin - 1;
			if (m >= -256 && m <= 255) {
				cdf[m + 256] = acc;
			}
			if (i < 5) {
				acc += weights[i];
			}
		}
	}
	return cdf;
})();

/** The kernel's running integral at the half-grid index `m` (`u = (m + 1/2) / 128` kernel units), over 65536. */
export function hqCubicCdf(m: number): number {
	if (m < -256) {
		return -32768;
	}
	if (m > 255) {
		return 32768;
	}
	return HQ_CUBIC_CDF[m + 256];
}
