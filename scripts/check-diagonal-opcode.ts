// Reproduce the first exact Arial image lost by the global diagonal candidate.
// bun scripts/check-diagonal-opcode.ts [report.json]
// Traces our interpreter only; native evidence comes from public GDI+ captures.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GdiFontCollection } from '../src/gdi-font-engine';
import { gdiTextCoverage } from '../src/gdi-text-render';

const fixturePath = resolve('src/__fixtures__/gdi/text-coverage.json.gz');
const fontPath = resolve(process.env.WINDIR || 'C:/Windows', 'Fonts/arial.ttf');
const fontBytes = readFileSync(fontPath), nativeBytes = readFileSync(fixturePath);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const environment = JSON.parse(readFileSync('src/__fixtures__/gdi/environment-text-coverage.json', 'utf8'));
if (environment.fonts.find((f: any) => f.name.toLowerCase() === 'arial.ttf')?.sha256 !== hash(fontBytes)) {
	throw new Error('Arial differs from the independently captured reference font');
}
const captures = JSON.parse(gunzipSync(nativeBytes).toString()).filter((c: any) =>
	c.face === 'Arial' && c.size === 16 && c.style === 0 && c.hint === 4 && c.contrast === 0 && c.code === 121);
if (captures.length !== 16) throw new Error('Expected sixteen independently captured origins');
const dotProducts = (x: number, y: number, vx: number, vy: number) =>
	Math.floor((x * vx + 8192) / 16384) + Math.floor((y * vy + 8192) / 16384);
const traces: Record<string, any[]> = {}, results: Record<string, any[]> = {};
for (const variant of ['baseline', 'candidate']) {
	const fonts = new GdiFontCollection([fontBytes]);
	const font = fonts.realize({ face: 'Arial', height: -16, width: 0, weight: 400, italic: false,
		charSet: 1, pitchAndFamily: 0, quality: 4, unhinted: true, ignoreGasp: true, gdiPlus: true })!;
	// Diagnostic access to our own private interpreter avoids editing production.
	const hs = (font as any).hinted;
	if (variant === 'candidate') {
		hs.project = (x: number, y: number) => dotProducts(x, y, hs.gs.pvx, hs.gs.pvy);
		hs.dualProject = (x: number, y: number) => dotProducts(x, y, hs.gs.dvx, hs.gs.dvy);
		const compute = hs.computeFuncs.bind(hs);
		hs.computeFuncs = () => {
			compute();
			if (hs.gs.fvx === hs.gs.pvx && hs.gs.fvy === hs.gs.pvy) hs.fDotP = 16384;
		};
	}
	const trace: any[] = [], step = hs.step.bind(hs);
	hs.step = (op: number, code: Uint8Array, ip: number) => {
		const before = { gs: { ...hs.gs }, stack: hs.stack.slice(), x: Array.from(hs.pts.curX), y: Array.from(hs.pts.curY) };
		const result = step(op, code, ip);
		trace.push({ op, ip, before, fd: hs.fDotP, x: Array.from(hs.pts.curX), y: Array.from(hs.pts.curY) });
		return result;
	};
	results[variant] = captures.map((c: any) => {
		const mask = gdiTextCoverage(font, { codes: [c.code], glyphIndices: false, x: 8 + c.qx / 4, y: 48 + c.qy / 4,
			dx: null, dy: null, textAlign: 24, textColor: '#000000', bkColor: '#ffffff', bkMode: 1,
			options: 0, rect: null, matrix: null, underline: false, strikeOut: false }, { grayLevels: 15 })!;
		const native = Buffer.from(c.rgba, 'base64');
		let count = 0, sum = 0;
		for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
			const xx = x - mask.x, yy = y - mask.y;
			const actual = xx >= 0 && yy >= 0 && xx < mask.width && yy < mask.height ? 255 - mask.data[yy * mask.width + xx] : 255;
			const difference = Math.abs(actual - native[(y * 64 + x) * 4]);
			count += difference !== 0 ? 1 : 0; sum += difference;
		}
		return { qx: c.qx, qy: c.qy, count, sum };
	});
	traces[variant] = trace;
}
const first = traces.baseline.findIndex((step, i) => JSON.stringify([step.x, step.y]) !==
	JSON.stringify([traces.candidate[i].x, traces.candidate[i].y]));
if (first < 0) throw new Error('Expected the diagonal candidate to diverge');
const old = traces.baseline[first], changed = traces.candidate[first];
const p = old.before.stack.at(-1), ref = old.before.gs.rp0;
const dx = old.before.x[p] - old.before.x[ref], dy = old.before.y[p] - old.before.y[ref];
const pv = [old.before.gs.pvx, old.before.gs.pvy];
const product = dx * pv[0] + dy * pv[1];
const report = {
	fontSha256: hash(fontBytes), nativeSha256: hash(nativeBytes), results,
	firstDivergence: {
		step: first, opcode: old.op, byteOffset: old.ip, point: p, reference: ref,
		currentDifference: [dx, dy], projection: pv, freedom: [old.before.gs.fvx, old.before.gs.fvy],
		combinedProjection: Math.floor((product + 8192 + (product < 0 ? -1 : 0)) / 16384),
		perProductProjection: dotProducts(dx, dy, pv[0], pv[1]), fDotP: [old.fd, changed.fd],
		baselinePoint: [old.x[p], old.y[p]], candidatePoint: [changed.x[p], changed.y[p]],
	},
};
const output = resolve(process.argv[2] || `${tmpdir()}/diagonal-opcode-${Date.now()}.json`);
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, firstDivergence: report.firstDivergence,
	exact: Object.fromEntries(Object.entries(results).map(([key, cases]) => [key, cases.filter(c => c.count === 0).length])) }, null, 2));
