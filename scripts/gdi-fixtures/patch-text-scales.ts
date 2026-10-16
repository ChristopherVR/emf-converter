/**
 * Writes a copy of an EMF whose EMR_EXTTEXTOUTW / EMR_EXTTEXTOUTA records have their stored `eyScale` set to their
 * `exScale` (mode `equal`), so a GM_COMPATIBLE text record no longer asks native playback for a horizontal stretch of
 * eyScale / exScale. Playing the copy and the original with `play-metafile.ps1`-style `PlayEnhMetaFile` shows where the
 * playback stretch comes from: `textpb-segoeui-cell-q3.emf` patched this way plays back as exactly the direct drawing
 * (`textpb-segoeui-cell-q3.direct.png`, 0 of 2,102,400 pixels differ) while the original differs from it by 4,050
 * pixels, so the stretch is read from the record, not taken from the playing device (16 October 2026).
 *
 *   bun scripts/gdi-fixtures/patch-text-scales.ts <in.emf> <out.emf> [equal]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, mode = 'equal'] = process.argv.slice(2);
if (!input || !output) {
	throw new Error('usage: bun patch-text-scales.ts <in.emf> <out.emf> [equal]');
}
const bytes = Buffer.from(readFileSync(input));
let patched = 0;
for (let offset = 0; offset + 8 <= bytes.length; ) {
	const type = bytes.readUInt32LE(offset);
	const size = bytes.readUInt32LE(offset + 4);
	if (type === 83 || type === 84) {
		// bounds (16 bytes), iGraphicsMode, exScale, eyScale follow the record header.
		const exScale = bytes.readFloatLE(offset + 8 + 16 + 4);
		if (mode === 'equal') bytes.writeFloatLE(exScale, offset + 8 + 16 + 8);
		patched++;
	}
	if (size === 0) break;
	offset += size;
}
writeFileSync(output, bytes);
console.log(`${patched} text records patched`);
