/**
 * Writes a parity table for every GDI fixture (not part of `bun run test`)
 * to GDI_REPORT (default gdi-report.txt).
 *
 *   bun scripts/gdi-fixtures/report.ts
 *
 * Set GDI_DUMP=<dir> to also write each converter render as a PNG.
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { compareFixture, fixturePath, renderFixture } from '../../src/__fixtures__/gdi-parity-harness';

async function main(): Promise<void> {
	const dir = fixturePath('');
	const files = readdirSync(dir).filter((f) => f.endsWith('.emf') || f.endsWith('.wmf'));
	const dump = process.env.GDI_DUMP;
	const filter = process.env.GDI_FILTER;
	const rows: string[] = [];
	for (const f of files.sort()) {
		const name = f.replace(/\.(emf|wmf)$/, '');
		if (filter && !name.includes(filter)) {
			continue;
		}
		const ext = f.endsWith('.emf') ? 'emf' : 'wmf';
		const d = await compareFixture(name, ext, 8);
		if (dump) {
			mkdirSync(dump, { recursive: true });
			const napi = await import('@napi-rs/canvas');
			const r = await renderFixture(f);
			if (r) {
				const c = napi.createCanvas(r.width, r.height);
				const ctx = c.getContext('2d');
				const id = ctx.createImageData(r.width, r.height);
				id.data.set(r.data);
				ctx.putImageData(id, 0, 0);
				writeFileSync(join(dump, `${name}.png`), c.toBuffer('image/png'));
			}
		}
		rows.push(
			d
				? `${name.padEnd(40)} mismatch>8: ${(d.mismatchRatio * 100).toFixed(2).padStart(6)}%  mean: ${d.meanAbsDiff.toFixed(2).padStart(6)}  max: ${d.maxDiff}`
				: `${name.padEnd(40)} RENDER FAILED`,
		);
	}
	writeFileSync(process.env.GDI_REPORT ?? 'gdi-report.txt', `${rows.join('\n')}\n`);
}

await main();
