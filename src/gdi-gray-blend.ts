/**
 * GDI's grayscale (`ANTIALIASED_QUALITY`) glyph blend, per colour channel,
 * measured on native Windows (`scripts/gdi-fixtures/GrayBlendProbe.cs`,
 * `gray-blend-grid.json.gz`): a glyph pixel has coverage `k` of 16
 * (2 to 15 blend; 0 and 1 leave the pixel, 16 paints the text colour).
 *
 * Two paths exist:
 *
 * - Text over a TRANSPARENT background computes `d + floor((s - d) * a)`
 *   for text `s` over backdrop `d`, with a constant `a` per coverage level
 *   that depends only on which of `s` and `d` is lighter in that channel
 *   ({@link GRAY_LIGHT}, {@link GRAY_DARK}). All 14 x 65,280 grey pairs per
 *   direction match, and 20 million channel samples of random colours.
 * - Text drawn together with a background fill (`OPAQUE` background mode,
 *   or `ETO_OPAQUE` even under TRANSPARENT mode) is blended in an 8-bit
 *   "linear" domain: `ENC[floor((k * DEC[s] + (16 - k) * DEC[d]) / 16)]`.
 *   `DEC[c]` is `round(255 * (c / 255) ** 2.3535)`, which loses the darkest
 *   18 levels (text colour equal to the background still changes it), and
 *   `ENC` is the table the native results fix for each of the 256 linear
 *   values (close to `round(255 * (l / 255) ** (1 / 2.3535))`, not equal).
 *   All 14 x 65,536 grey pairs, 93,600 random-colour channel samples with
 *   OPAQUE mode and 93,600 with `ETO_OPAQUE` match.
 *
 * @module gdi-gray-blend
 */

/** Weight of the text colour when it is lighter than the backdrop (transparent text), by coverage 2..15. */
const GRAY_LIGHT = [0, 0, 0.4096065, 0.4875311, 0.5515784, 0.6070649, 0.656426, 0.7013281, 0.7426686, 0.7811829, 0.8173296, 0.8514569, 0.8838279, 0.9147507, 0.9443338, 0.9726402];

/** Weight of the text colour when it is darker than the backdrop (transparent text), by coverage 2..15. */
const GRAY_DARK = [0, 0, 0.0556662, 0.0852493, 0.1161453, 0.1485431, 0.1826704, 0.2188171, 0.2572957, 0.2986719, 0.343574, 0.3929351, 0.4483443, 0.5124689, 0.5903349, 0.6957428];

/** 8-bit "linear" value of an encoded channel (opaque text). */
const GRAY_DEC = [
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2,
	2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
	5, 5, 6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9,
	10, 10, 11, 11, 11, 12, 12, 13, 13, 13, 14, 14, 15, 15, 16, 16,
	17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 23, 23, 24, 24, 25,
	26, 26, 27, 28, 28, 29, 30, 30, 31, 32, 32, 33, 34, 35, 35, 36,
	37, 38, 38, 39, 40, 41, 42, 42, 43, 44, 45, 46, 47, 48, 49, 49,
	50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
	66, 68, 69, 70, 71, 72, 73, 74, 75, 77, 78, 79, 80, 81, 83, 84,
	85, 86, 88, 89, 90, 92, 93, 94, 96, 97, 98, 100, 101, 102, 104, 105,
	107, 108, 109, 111, 112, 114, 115, 117, 118, 120, 121, 123, 124, 126, 128, 129,
	131, 132, 134, 136, 137, 139, 141, 142, 144, 146, 147, 149, 151, 153, 154, 156,
	158, 160, 161, 163, 165, 167, 169, 171, 173, 174, 176, 178, 180, 182, 184, 186,
	188, 190, 192, 194, 196, 198, 200, 202, 204, 206, 208, 210, 213, 215, 217, 219,
	221, 223, 225, 228, 230, 232, 234, 237, 239, 241, 243, 246, 248, 250, 253, 255,
];

/** Encoded channel for an 8-bit "linear" value (opaque text). */
const GRAY_ENC = [
	0, 24, 32, 39, 44, 48, 52, 55, 59, 62, 64, 67, 70, 72, 74, 77,
	79, 81, 83, 85, 86, 88, 90, 92, 93, 95, 97, 98, 100, 101, 103, 104,
	106, 107, 108, 110, 111, 112, 114, 115, 116, 117, 118, 120, 121, 122, 123, 124,
	125, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 140,
	142, 143, 144, 145, 145, 146, 147, 148, 149, 150, 151, 152, 152, 153, 154, 154,
	156, 157, 157, 158, 159, 160, 161, 161, 162, 163, 164, 165, 165, 166, 167, 167,
	168, 169, 170, 171, 171, 172, 173, 173, 174, 175, 176, 176, 177, 178, 178, 178,
	180, 180, 181, 182, 182, 183, 184, 184, 185, 186, 186, 187, 188, 188, 189, 189,
	190, 191, 192, 192, 193, 193, 194, 195, 195, 196, 196, 197, 198, 198, 199, 199,
	200, 201, 201, 202, 202, 203, 204, 204, 205, 205, 206, 206, 207, 208, 208, 208,
	209, 210, 210, 211, 211, 212, 212, 213, 214, 214, 215, 215, 216, 216, 217, 217,
	218, 218, 219, 219, 220, 220, 221, 221, 222, 222, 223, 224, 224, 225, 225, 225,
	226, 227, 227, 228, 228, 229, 229, 229, 230, 230, 231, 231, 232, 232, 233, 233,
	234, 234, 235, 235, 236, 236, 237, 237, 238, 238, 239, 239, 239, 240, 240, 240,
	241, 242, 242, 243, 243, 244, 244, 245, 245, 245, 246, 246, 247, 247, 248, 248,
	249, 249, 249, 250, 250, 251, 251, 252, 252, 252, 253, 253, 254, 254, 255, 255,
];

/**
 * Blends one channel of text `s` over backdrop `d` at grayscale coverage
 * `k` (0 to 16). `opaque` selects the path of text drawn with a
 * background fill.
 */
export function blendGrayChannel(s: number, d: number, k: number, opaque: boolean): number {
	if (k <= 1) {
		return d;
	}
	if (k >= 16) {
		return s;
	}
	if (opaque) {
		return GRAY_ENC[Math.floor((k * GRAY_DEC[s] + (16 - k) * GRAY_DEC[d]) / 16)];
	}
	return d + Math.floor((s - d) * (s > d ? GRAY_LIGHT[k] : GRAY_DARK[k]));
}
