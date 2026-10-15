/**
 * Checks `cmykInputCurve` in `src/jpeg-cmyk.ts` against the input tables of the profile Windows converts CMYK JPEG with.
 * The node table itself is built by `generate-cmyk-nodes.py` (which replaced the least-squares fit that lived here).
 *
 *   bun scripts/gdi-fixtures/generate-cmyk-lut.ts curve
 */
import { readFileSync } from 'node:fs';
import { cmykInputCurve } from '../../src/jpeg-cmyk';

{
	// The closed form against the A2B0 input tables (4 x 256 entries after the 52-byte lut16 header) of the profile.
	const profile = readFileSync('C:\\Windows\\System32\\spool\\drivers\\color\\RSWOP.icm');
	const view = new DataView(profile.buffer, profile.byteOffset, profile.length);
	let a2b0 = -1;
	for (let i = 0, n = view.getUint32(128); i < n; i++) if (profile.toString('latin1', 132 + i * 12, 136 + i * 12) === 'A2B0') a2b0 = view.getUint32(136 + i * 12);
	if (a2b0 < 0 || profile.toString('latin1', a2b0, a2b0 + 4) !== 'mft2' || view.getUint16(a2b0 + 48) !== 256) throw new Error('unexpected A2B0 layout');
	let mismatches = 0;
	for (let c = 0; c < 4; c++) for (let k = 0; k < 256; k++) if (view.getUint16(a2b0 + 52 + (c * 256 + k) * 2) !== cmykInputCurve(k)) mismatches++;
	console.log(`input curve: ${mismatches} of 1024 table entries differ from cmykInputCurve`);
	process.exit(mismatches ? 1 : 0);
}

