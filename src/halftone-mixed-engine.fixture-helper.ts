/**
 * The cases behind `__fixtures__/gdi/halftone-mixed-engine.json.gz`: native HALFTONE stretches that pick the
 * engine of a mixed enlarge-and-reduce stretch (`halftoneMixedEngine`) and the despeckle size bands
 * (`scripts/gdi-fixtures/generate-halftone-mixed-engine.ts`, probe `HalftoneBoundaryProbe.cs`). Everything is
 * deterministic, so the capture stores the SHA-256 of each native output (and the bytes of the few cases that
 * are not reproduced) and the test regenerates the sources.
 */

export type SourceKind = 'check' | 'k3' | 'k27' | 'k100' | 'noise' | 'smooth';

export interface MixedCase {
	id: string;
	group: 'grid' | 'cap' | 'area' | 'band' | 'random' | 'reduce';
	kind: SourceKind;
	seed: number;
	w: number;
	h: number;
	dw: number;
	dh: number;
}

/** The linear congruential generator every source seeds explicitly. */
export function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/**
 * RGB bytes of a source: `check` a black/white checkerboard with 10% flipped cells (dense in two-by-two
 * checkers), `k3` / `k27` / `k100` random picks from that many random colours, `noise` uniform random bytes,
 * `smooth` sinusoids plus noise.
 */
export function mixedSource(kind: SourceKind, w: number, h: number, seed: number): Uint8Array {
	const next = lcg(seed * 2654435761 + w * 131 + h);
	const rgb = new Uint8Array(w * h * 3);
	if (kind === 'check') {
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			let v = (x + y) & 1 ? 255 : 0;
			if (next() < 0.1) v = 255 - v;
			rgb.set([v, v, v], (y * w + x) * 3);
		}
	} else if (kind === 'noise') {
		for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(next() * 256);
	} else if (kind === 'smooth') {
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
			rgb[(y * w + x) * 3 + c] = Math.floor(128 + 100 * Math.sin(x / 5 + c) * Math.cos(y / 7 + c) + next() * 6);
		}
	} else {
		const count = kind === 'k3' ? 3 : kind === 'k27' ? 27 : 100;
		const palette = Array.from({ length: count }, () => [Math.floor(next() * 256), Math.floor(next() * 256), Math.floor(next() * 256)]);
		for (let i = 0; i < w * h; i++) rgb.set(palette[Math.floor(next() * count)], i * 3);
	}
	return rgb;
}

/** All cases, in capture order. */
export function mixedEngineCases(): MixedCase[] {
	const cases: MixedCase[] = [];
	let seed = 1;
	const add = (group: MixedCase['group'], kind: SourceKind, w: number, h: number, dw: number, dh: number): void => {
		cases.push({ id: `${group}-${cases.length}-${kind}-${w}x${h}-${dw}x${dh}`, group, kind, seed: seed++, w, h, dw, dh });
	};
	// Engine grids: a source of 4,096 pixels and one of 1,600, four palettes, the enlarged axis against the shrinking one.
	for (const size of [64, 40]) for (const kind of ['k3', 'k27', 'k100', 'noise'] as SourceKind[]) {
		for (const e of [1.25, 1.5, 2, 4]) for (const r of [0.95, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.5]) {
			add('grid', kind, size, size, Math.round(size * e), Math.round(size * r));
		}
		for (const r of [0.9, 0.75, 0.6]) add('grid', kind, size, size, Math.round(size * r), Math.round(size * 2.5));
	}
	// The 1.5x boundary: 2 * src - 3 * dst reaches 2 (taken) or stays 1 or less (not taken), in several sizes.
	for (const [src, dst] of [[100, 66], [100, 67], [50, 33], [50, 34], [112, 74], [112, 75], [56, 37], [56, 38], [64, 42], [64, 43],
		[60, 39], [60, 40], [47, 31], [47, 30], [89, 59], [89, 58], [120, 79], [120, 80], [33, 21], [33, 22]]) {
		add('cap', 'k100', 80, src, 200, dst);
		add('cap', 'k100', src, 80, dst, 200);
	}
	// The area boundary: destination pixels just below, equal to and just above the source's.
	const next = lcg(4);
	for (let i = 0; i < 160; i++) {
		const w = 40 + Math.floor(next() * 70), h = 40 + Math.floor(next() * 70);
		const dw = Math.round(w * (1.03 + next() * 0.4));
		const base = Math.floor((w * h) / dw);
		const dh = base + [-1, 0, 1][i % 3];
		if (dh >= h || dh < 2 || 2 * h - 3 * dh >= 2) continue;
		add('area', i % 5 === 0 ? 'k27' : 'k100', w, h, dw, dh);
	}
	// The despeckle bands around 2,304 and 16,384 source pixels (uniform 2x of a checker-dense source).
	for (const [w, h] of [[47, 49], [48, 48], [48, 49], [49, 48], [55, 42], [64, 64], [72, 72], [100, 100], [127, 129], [128, 128], [128, 129],
		[129, 128], [100, 164], [101, 163], [8, 2049], [300, 60], [130, 130]]) add('band', 'check', w, h, w * 2, h * 2);
	for (const [w, h] of [[72, 72], [48, 48], [130, 130]]) {
		add('band', 'k27', w, h, w * 2, h * 2);
		add('band', 'k3', w, h, Math.round(w * 1.5), Math.round(h * 1.5));
	}
	// Held-out random stretches of every kind across the three size bands.
	const rnd = lcg(99);
	const band = (): [number, number] => {
		const b = ['s', 'm', 'm', 'l'][Math.floor(rnd() * 4)];
		for (;;) {
			const w = 8 + Math.floor(rnd() * (b === 'l' ? 220 : 130)), h = 8 + Math.floor(rnd() * (b === 'l' ? 220 : 130)), n = w * h;
			if ((b === 's' && n <= 2304) || (b === 'm' && n > 2304 && n <= 16384) || (b === 'l' && n > 16384 && n < 26000)) return [w, h];
		}
	};
	const kinds: SourceKind[] = ['check', 'k3', 'k27', 'k100', 'noise', 'smooth'];
	const enlargement = (): number => 1.03 + rnd() * rnd() * 7;
	const reduction = (): number => 0.3 + rnd() * 0.69;
	for (let made = 0; made < 160;) {
		const [w, h] = band();
		const kind = kinds[Math.floor(rnd() * kinds.length)];
		const t = rnd();
		let dw: number, dh: number;
		if (t < 0.25) { dw = Math.round(w * enlargement()); dh = Math.round(h * enlargement()); }
		else if (t < 0.7) {
			const horizontal = rnd() < 0.5;
			const grown = Math.round((horizontal ? w : h) * enlargement()), shrunk = Math.round((horizontal ? h : w) * reduction());
			dw = horizontal ? grown : shrunk; dh = horizontal ? shrunk : grown;
		} else if (t < 0.85) { const horizontal = rnd() < 0.5; dw = horizontal ? Math.round(w * enlargement()) : w; dh = horizontal ? h : Math.round(h * enlargement()); }
		else { dw = Math.round(w * reduction()); dh = Math.round(h * reduction()); }
		dw = Math.max(1, dw); dh = Math.max(1, dh);
		if (dw * dh > 90000) continue;
		add('random', kind, w, h, dw, dh);
		made++;
	}
	// Reductions of both axes of checker-dense and few-colour sources in the three size bands, with and without an
	// axis that loses 1.5 pixels per pixel (the despeckle precedes the reduction only when neither does).
	const reduceRnd = lcg(2024);
	for (let made = 0; made < 120;) {
		const [w, h] = (() => {
			const b = ['s', 'm', 'l'][made % 3];
			for (;;) {
				const w = 6 + Math.floor(reduceRnd() * (b === 'l' ? 220 : 120)), h = 6 + Math.floor(reduceRnd() * (b === 'l' ? 220 : 120)), n = w * h;
				if ((b === 's' && n <= 2304) || (b === 'm' && n > 2304 && n <= 16384) || (b === 'l' && n > 16384 && n < 40000)) return [w, h] as [number, number];
			}
		})();
		const fx = 0.3 + reduceRnd() * 0.69, fy = reduceRnd() < 0.5 ? fx : 0.3 + reduceRnd() * 0.69;
		const dw = Math.max(1, Math.round(w * fx)), dh = Math.max(1, Math.round(h * fy));
		if (dw >= w || dh >= h) continue;
		add('reduce', (['check', 'k3', 'k27'] as SourceKind[])[Math.floor(reduceRnd() * 3)], w, h, dw, dh);
		made++;
	}
	return cases;
}
