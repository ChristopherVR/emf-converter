/**
 * Measures the node table of the Windows ICM module's 8-bit CMYK -> sRGB transform against every possible 8-bit ink.
 *
 * What the native 8-bit routine is (read from icm32.dll!LHCalc4to3_Di8_Do8_Lut16_G16): the nodes are UNSIGNED 16-bit words, the
 * five nodes of the tetrahedron are weighted with integers that sum to 4096, and the result is the high byte of a 16-bit output
 * table entry looked up with `S >> 18` (the table is the 1,025-entry curve of `jpeg-cmyk.ts`, whose high byte is `S >> 20`).
 * So the result of an ink is `S >> 20` with `S = sum(weight * node)`, and every native conversion is an exact interval
 * constraint `t * 2^20 <= S < (t + 1) * 2^20` on at most five nodes of one channel. A table is correct when the sweep below
 * finds no ink it gets wrong; the nodes are any integer table that satisfies the constraints collected from the sweeps (a
 * counterexample-guided search, so the table is proven exact on all 2^32 inks, not fitted to a sample).
 *
 *   bun cmyk-8bit-nodes.ts init   <dir>                      <dir>/nodes.u16: the 16-bit-path table of src/jpeg-cmyk-data.ts plus one, clamped
 *   bun cmyk-8bit-nodes.ts sweep  <dir> [first [last]]       all 2^32 inks (chunk c = C value; default 0..255) through
 *                                                            `generate.ps1 icm-cmyk-srgb8`; writes <dir>/wrong<first>.bin
 *                                                            (C, M, Y, K, native R, G, B per ink the table gets wrong) and
 *                                                            <dir>/tight<first>.bin (inks within `margin` of a boundary)
 *   bun cmyk-8bit-nodes.ts solve  <dir> [maxStep]            moves nodes (unsigned, 0..65535) until every constraint of
 *                                                            <dir>/train.bin (the concatenated wrong*.bin and tight*.bin)
 *                                                            holds; writes <dir>/nodes.u16
 *   bun cmyk-8bit-nodes.ts patch  <dir>                      prints NODE_DELTA_8BIT for src/jpeg-cmyk.ts
 *   bun cmyk-8bit-nodes.ts regenerate <dir>                  init, then sweep and solve until a sweep finds nothing, then patch
 *
 * Loop: sweep, append the wrong inks to train.bin, solve, sweep again, until a sweep finds none. Needs Windows (64-bit
 * PowerShell, RSWOP.icm) and about 300 MB of free disk for one chunk batch.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cmykInputPositions, cmykNodeTable } from '../../src/jpeg-cmyk';

const N = 16;
const ST = [N ** 3, N ** 2, N, 1];
const [cmd, dir] = [process.argv[2], process.argv[3]];
const MARGIN = 8192;
const CHUNK = 1 << 24;
/** Also keep a sixteenth of the inks within two node steps of a boundary (about 12 million, 7 bytes each); `regenerate` sets it for its first sweep, or set TIGHT=1. */
let TIGHT = !!process.env.TIGHT;

/** A fixed pseudo-random sixteenth of the inks. */
function sampled(ink: Uint8Array, j: number): boolean {
	return (Math.imul(ink[j * 4] + 1, 73856093) ^ Math.imul(ink[j * 4 + 1] + 1, 19349663) ^ Math.imul(ink[j * 4 + 2] + 1, 83492791) ^ Math.imul(ink[j * 4 + 3] + 1, 2654435761)) >>> 28 === 0;
}

const fr = new Int32Array(4);
const ord = new Int32Array(4);

/** Fills `at` (five node indices) and `w` (their weights) for an ink of four bytes. */
function path(c: number, m: number, y: number, k: number, at: Int32Array, w: Int32Array): void {
	const ink = [c, m, y, k];
	let base = 0;
	for (let d = 0; d < 4; d++) {
		const p = cmykInputPositions[ink[d]];
		const j = Math.min(p >> 12, N - 2);
		fr[d] = p - (j << 12);
		ord[d] = d;
		base += j * ST[d];
	}
	for (let a = 1; a < 4; a++) {
		const o = ord[a];
		let j = a - 1;
		while (j >= 0 && fr[ord[j]] < fr[o]) {
			ord[j + 1] = ord[j];
			j--;
		}
		ord[j + 1] = o;
	}
	at[0] = base;
	w[0] = 4096 - fr[ord[0]];
	for (let s = 0; s < 4; s++) {
		base += ST[ord[s]];
		at[s + 1] = base;
		w[s + 1] = fr[ord[s]] - (s < 3 ? fr[ord[s + 1]] : 0);
	}
}

const nodesFile = (): string => `${dir}/nodes.u16`;
const loadNodes = (): Uint16Array => {
	const b = readFileSync(nodesFile());
	return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
};

function sweep(first: number, last: number): number {
	const nodes = loadNodes();
	const work = `${dir}/work${first}`;
	mkdirSync(work, { recursive: true });
	const at = new Int32Array(5);
	const w = new Int32Array(5);
	const wrongFile = `${dir}/wrong${first}.bin`;
	const tightFile = `${dir}/tight${first}.bin`;
	let wrong = 0;
	let total = 0;
	for (let c0 = first; c0 <= last; c0 += 2) {
		const chunks = [c0, ...(c0 + 1 <= last ? [c0 + 1] : [])];
		for (const c of chunks) {
			const b = new Uint8Array(CHUNK * 4);
			for (let j = 0; j < CHUNK; j++) {
				b[j * 4] = c;
				b[j * 4 + 1] = j >> 16;
				b[j * 4 + 2] = (j >> 8) & 255;
				b[j * 4 + 3] = j & 255;
			}
			writeFileSync(`${work}/c${c}.ink`, b);
		}
		// PowerShell now and then fails to start a module command under load (seen once in 100 runs): try again.
		for (let attempt = 0; ; attempt++) {
			const run = spawnSync(
				'powershell.exe',
				['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./generate.ps1', import.meta.url)), 'icm-cmyk-srgb8', '-TablesDir', work],
				{ stdio: 'inherit' },
			);
			if (run.status === 0) break;
			if (attempt >= 4) throw new Error('generate.ps1 icm-cmyk-srgb8 failed');
		}
		for (const c of chunks) {
			const ink = readFileSync(`${work}/c${c}.ink`);
			const nat = readFileSync(`${work}/c${c}.srgb8`);
			const bad: number[] = [];
			const tight: number[] = [];
			for (let j = 0; j < CHUNK; j++) {
				path(ink[j * 4], ink[j * 4 + 1], ink[j * 4 + 2], ink[j * 4 + 3], at, w);
				let isWrong = false;
				let isTight = false;
				for (let ch = 0; ch < 3; ch++) {
					const s = w[0] * nodes[at[0] * 3 + ch] + w[1] * nodes[at[1] * 3 + ch] + w[2] * nodes[at[2] * 3 + ch] + w[3] * nodes[at[3] * 3 + ch] + w[4] * nodes[at[4] * 3 + ch];
					const t = nat[j * 4 + 2 - ch];
					if (s >> 20 !== t) isWrong = true;
					if (TIGHT && sampled(ink, j) && (s - (t << 20) < MARGIN || ((t + 1) << 20) - s <= MARGIN)) isTight = true;
				}
				if (isWrong || isTight) {
					const rec = [ink[j * 4], ink[j * 4 + 1], ink[j * 4 + 2], ink[j * 4 + 3], nat[j * 4 + 2], nat[j * 4 + 1], nat[j * 4]];
					if (isWrong) {
						bad.push(...rec);
						wrong++;
					} else tight.push(...rec);
				}
			}
			total += CHUNK;
			if (bad.length) appendFileSync(wrongFile, Buffer.from(bad));
			if (tight.length) appendFileSync(tightFile, Buffer.from(tight));
			rmSync(`${work}/c${c}.ink`);
			rmSync(`${work}/c${c}.srgb8`);
			console.log(`chunk ${c}: ${wrong} wrong of ${total} so far`);
		}
	}
	return wrong;
}

function solve(maxStep: number): void {
	if (!existsSync(`${dir}/train.bin`)) return;
	const nodes = Int32Array.from(loadNodes());
	const data = readFileSync(`${dir}/train.bin`);
	const M = data.length / 7;
	const idx = new Int32Array(M * 5);
	const wt = new Int32Array(M * 5);
	const at = new Int32Array(5);
	const w = new Int32Array(5);
	for (let i = 0; i < M; i++) {
		path(data[i * 7], data[i * 7 + 1], data[i * 7 + 2], data[i * 7 + 3], at, w);
		for (let k = 0; k < 5; k++) {
			idx[i * 5 + k] = at[k];
			wt[i * 5 + k] = w[k];
		}
	}
	for (let ch = 0; ch < 3; ch++) {
		const lo = new Int32Array(M);
		const hi = new Int32Array(M);
		const v = new Int32Array(M);
		for (let i = 0; i < M; i++) {
			const t = data[i * 7 + 4 + ch];
			lo[i] = t << 20;
			hi[i] = (t + 1) << 20;
			let s = 0;
			for (let k = 0; k < 5; k++) s += wt[i * 5 + k] * nodes[idx[i * 5 + k] * 3 + ch];
			v[i] = s;
		}
		const cnt = new Int32Array(65537);
		for (let i = 0; i < M; i++) for (let k = 0; k < 5; k++) if (wt[i * 5 + k]) cnt[idx[i * 5 + k] + 1]++;
		for (let n = 0; n < 65536; n++) cnt[n + 1] += cnt[n];
		const fill = cnt.slice(0, 65536);
		const ref = new Int32Array(cnt[65536]);
		for (let i = 0; i < M; i++) for (let k = 0; k < 5; k++) if (wt[i * 5 + k]) ref[fill[idx[i * 5 + k]]++] = i * 5 + k;
		const viol = (i: number, val: number): number => (val < lo[i] || val >= hi[i] ? 1 : 0);
		const count = (): number => {
			let bad = 0;
			for (let i = 0; i < M; i++) bad += viol(i, v[i]);
			return bad;
		};
		const start = count();
		for (let pass = 0; pass < 60; pass++) {
			const cand = new Set<number>();
			for (let i = 0; i < M; i++) if (viol(i, v[i])) for (let k = 0; k < 5; k++) if (wt[i * 5 + k]) cand.add(idx[i * 5 + k]);
			let improved = 0;
			for (const n of cand) {
				let bestD = 0;
				let bestGain = 0;
				for (let ad = 1; ad <= maxStep; ad++) {
					for (const d of [ad, -ad]) {
						const to = nodes[n * 3 + ch] + d;
						if (to < 0 || to > 65535) continue;
						let gain = 0;
						for (let r = cnt[n]; r < cnt[n + 1]; r++) {
							const e = ref[r];
							const i = (e / 5) | 0;
							gain += viol(i, v[i]) - viol(i, v[i] + d * wt[e]);
						}
						if (gain > bestGain) {
							bestGain = gain;
							bestD = d;
						}
					}
				}
				if (bestD) {
					for (let r = cnt[n]; r < cnt[n + 1]; r++) v[(ref[r] / 5) | 0] += bestD * wt[ref[r]];
					nodes[n * 3 + ch] += bestD;
					improved++;
				}
			}
			if (!improved) {
				// Pair moves from the constraints still violated.
				for (let i = 0; i < M; i++) {
					if (!viol(i, v[i])) continue;
					const ns = [0, 1, 2, 3, 4].filter(k => wt[i * 5 + k]).map(k => idx[i * 5 + k]);
					let done = false;
					for (let a = 0; a < ns.length && !done; a++) {
						for (let b = a + 1; b < ns.length && !done; b++) {
							for (const da of [-2, -1, 1, 2]) {
								for (const db of [-2, -1, 1, 2]) {
									if (done) break;
									const ta = nodes[ns[a] * 3 + ch] + da;
									const tb = nodes[ns[b] * 3 + ch] + db;
									if (ta < 0 || ta > 65535 || tb < 0 || tb > 65535) continue;
									const saved = new Map<number, number>();
									for (const [n, d] of [[ns[a], da], [ns[b], db]]) {
										for (let r = cnt[n]; r < cnt[n + 1]; r++) {
											const j = (ref[r] / 5) | 0;
											if (!saved.has(j)) saved.set(j, v[j]);
											v[j] += d * wt[ref[r]];
										}
									}
									let before = 0;
									let after = 0;
									for (const [j, old] of saved) {
										before += viol(j, old);
										after += viol(j, v[j]);
									}
									if (after < before) {
										nodes[ns[a] * 3 + ch] = ta;
										nodes[ns[b] * 3 + ch] = tb;
										improved++;
										done = true;
									} else for (const [j, old] of saved) v[j] = old;
								}
							}
						}
					}
				}
			}
			if (!improved) break;
		}
		console.log(`channel ${ch}: ${start} constraints violated before, ${count()} after, of ${M}`);
	}
	writeFileSync(nodesFile(), Buffer.from(Uint16Array.from(nodes).buffer));
}

/** Prints `NODE_DELTA_8BIT` of src/jpeg-cmyk.ts: the table in nodes.u16 against the 16-bit-path table plus one, clamped. */
function patch(): void {
	const nodes = loadNodes();
	const legacy = cmykNodeTable();
	const flat: number[] = [];
	let prev = 0;
	for (let i = 0; i < nodes.length; i++) {
		const base = Math.min(65535, Math.max(0, legacy[i] + 1));
		if (nodes[i] !== base) {
			flat.push(i - prev, nodes[i] - base);
			prev = i;
		}
	}
	console.log(`// ${flat.length / 2} values`);
	for (let i = 0, line = '	'; i <= flat.length; i += 2) {
		const token = i < flat.length ? `${flat[i]}, ${flat[i + 1]}, ` : '';
		if (!token || line.length + token.length > 118) {
			console.log(line.trimEnd());
			line = '	';
		}
		line += token;
	}
}

/**
 * The whole procedure from nothing: seed (init), one sweep that also keeps every ink near a boundary, then solve and sweep
 * again until a sweep finds no wrong ink. Sweeps run one at a time (about 20 minutes each); about four are needed.
 */
function regenerate(): void {
	mkdirSync(dir, { recursive: true });
	rmSync(`${dir}/train.bin`, { force: true });
	writeFileSync(nodesFile(), Buffer.from(Uint16Array.from(cmykNodeTable(), v => Math.min(65535, Math.max(0, v + 1))).buffer));
	TIGHT = true;
	for (let round = 0; ; round++) {
		rmSync(`${dir}/wrong0.bin`, { force: true });
		rmSync(`${dir}/tight0.bin`, { force: true });
		const wrong = sweep(0, 255);
		console.log(`round ${round}: ${wrong} wrong inks`);
		if (!wrong) break;
		for (const f of ['wrong0.bin', 'tight0.bin']) if (existsSync(`${dir}/${f}`)) appendFileSync(`${dir}/train.bin`, readFileSync(`${dir}/${f}`));
		TIGHT = false;
		solve(3);
	}
	patch();
}

if (cmd === 'init') {
	mkdirSync(dir, { recursive: true });
	writeFileSync(nodesFile(), Buffer.from(Uint16Array.from(cmykNodeTable(), v => Math.min(65535, Math.max(0, v + 1))).buffer));
} else if (cmd === 'sweep') sweep(+(process.argv[4] ?? 0), +(process.argv[5] ?? 255));
else if (cmd === 'solve') solve(+(process.argv[4] ?? 3));
else if (cmd === 'patch') patch();
else if (cmd === 'regenerate') regenerate();
else console.log('usage: see the header of this file');
