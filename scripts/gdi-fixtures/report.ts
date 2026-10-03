/**
 * Writes a parity table for every GDI fixture (not part of `bun run test`)
 * to GDI_REPORT (default gdi-report.txt).
 *
 *   bun scripts/gdi-fixtures/report.ts
 *
 * Uses the fixture's Windows fonts when available. Set GDI_FONTS=host to
 * inspect host text rendering instead. Both exact and >8-level RGB differences
 * are reported; comparisons cover the common device area, including its edges.
 * Set GDI_DUMP=<dir> to also write each converter render as a PNG.
 */
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { diffImages, fixturePath, inkOutside, loadReference, renderFixture, windowsFonts } from '../../src/__fixtures__/gdi-parity-harness';

async function main(): Promise<void> {
	const dir = fixturePath('');
	const files = readdirSync(dir).filter((f) => f.endsWith('.emf') || f.endsWith('.wmf'));
	const dump = process.env.GDI_DUMP;
	const filter = process.env.GDI_FILTER;
	const fonts = process.env.GDI_FONTS === 'host' ? null : windowsFonts();
	const options = fonts ? { fonts } : {};
	const rows: string[] = [
		`Fonts: ${fonts ? 'Windows fixture fonts' : 'host canvas (text results are not font-engine parity)'}`,
		'Comparison: RGB over the common device area, no edge inset; dimensions may differ.',
		'Outside: reference ink missing from the render / rendered ink with no captured reference; white margins ignored.',
		'References: validated expanded native playback where available, original captures otherwise.',
	];
	let total = 0;
	let exact = 0;
	let failed = 0;
	let missingInk = 0;
	let uncapturedInk = 0;
	for (const f of files.sort()) {
		const name = f.replace(/\.(emf|wmf)$/, '');
		if (!existsSync(join(dir, `${name}.png`))) continue;
		if (filter && !name.includes(filter)) {
			continue;
		}
		total++;
		const rendered = await renderFixture(f, options);
		if (!rendered) {
			failed++;
			rows.push(`${name.padEnd(40)} RENDER FAILED`);
			continue;
		}
		const reference = await loadReference(name, true);
		const strict = diffImages(rendered, reference, 0, 0);
		const d = diffImages(rendered, reference, 8, 0);
		const missing = inkOutside(reference, rendered);
		const uncaptured = inkOutside(rendered, reference);
		if (missing > 0) missingInk++;
		if (uncaptured > 0) uncapturedInk++;
		if (strict.compared > 0 && strict.mismatched === 0) exact++;
		if (dump) {
			mkdirSync(dump, { recursive: true });
			const napi = await import('@napi-rs/canvas');
			const c = napi.createCanvas(rendered.width, rendered.height);
			const ctx = c.getContext('2d');
			const id = ctx.createImageData(rendered.width, rendered.height);
			id.data.set(rendered.data);
			ctx.putImageData(id, 0, 0);
			writeFileSync(join(dump, `${name}.png`), c.toBuffer('image/png'));
		}
		rows.push(`${name.padEnd(40)} mismatch>0: ${(strict.mismatchRatio * 100).toFixed(4).padStart(8)}% (${strict.mismatched}/${strict.compared})  mismatch>8: ${(d.mismatchRatio * 100).toFixed(4).padStart(8)}%  mean: ${d.meanAbsDiff.toFixed(4)}  max: ${d.maxDiff}  size: ${rendered.width}x${rendered.height}/${reference.width}x${reference.height}  outside: ${missing}/${uncaptured}`);
	}
	rows.push(`Summary: ${exact}/${total} exact RGB comparisons in the common area; ${failed} render failures.`);
	rows.push(`Extent coverage: ${missingInk} comparisons omit reference ink; ${uncapturedInk} comparisons have rendered ink beyond the captured reference.`);
	writeFileSync(process.env.GDI_REPORT ?? 'gdi-report.txt', `${rows.join('\n')}\n`);
}

await main();
