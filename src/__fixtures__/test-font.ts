/**
 * A tiny synthetic TrueType font for unit tests of the GDI font engine
 * (`ttf-font.ts`, `ttf-hinting.ts`, `ttf-raster.ts`, `gdi-font-engine.ts`,
 * `gdi-text-render.ts`), built in memory so the tests need no system fonts.
 *
 * unitsPerEm 2048, family "Test Sans". Glyphs:
 * - 0 `.notdef` and 1 space: empty, advances 1024 / 512.
 * - 2 `I`: a stem x 100..300, y 0..1400, advance 400, whose program calls
 *   `fpgm` function 0 (SVTCA[x], MDAP[r] on point 0, SVTCA[y], MDAP[r] on
 *   point 0, IUP[x], IUP[y]): point 0 snaps to the pixel grid and the other
 *   points follow by interpolation.
 * - 3 `l`: a hairline stem x 1000..1040 (unhinted), advance 1200, far
 *   thinner than a pixel at small sizes, for dropout control.
 * - 4 `o`: a diamond with quadratic (off-curve) points, advance 1200.
 *
 * `prep` turns dropout control on (SCANCTRL 0x1FF, SCANTYPE 1) and `hdmx`
 * carries advances for ppem 10. Test-only; never exported by the package.
 */

function u16(v: number): number[] {
	return [(v >> 8) & 0xff, v & 0xff];
}
function i16(v: number): number[] {
	return u16(v & 0xffff);
}
function u32(v: number): number[] {
	return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

interface SimpleGlyph {
	endPts: number[];
	pts: Array<[number, number, boolean]>;
	instructions: number[];
}

function encodeGlyph(g: SimpleGlyph | null): number[] {
	if (!g) {
		return [];
	}
	const xs = g.pts.map((p) => p[0]);
	const ys = g.pts.map((p) => p[1]);
	const out: number[] = [
		...i16(g.endPts.length),
		...i16(Math.min(...xs)),
		...i16(Math.min(...ys)),
		...i16(Math.max(...xs)),
		...i16(Math.max(...ys)),
	];
	for (const e of g.endPts) {
		out.push(...u16(e));
	}
	out.push(...u16(g.instructions.length), ...g.instructions);
	for (const p of g.pts) {
		out.push(p[2] ? 1 : 0);
	}
	let px = 0;
	for (const p of g.pts) {
		out.push(...i16(p[0] - px));
		px = p[0];
	}
	let py = 0;
	for (const p of g.pts) {
		out.push(...i16(p[1] - py));
		py = p[1];
	}
	while (out.length % 4) {
		out.push(0);
	}
	return out;
}

function utf16be(s: string): number[] {
	const out: number[] = [];
	for (const ch of s) {
		out.push(...u16(ch.charCodeAt(0)));
	}
	return out;
}

/** Builds the test font's bytes. */
export function buildTestFont(): Uint8Array {
	const glyphs: Array<SimpleGlyph | null> = [
		null,
		null,
		{
			endPts: [3],
			pts: [
				[100, 0, true],
				[100, 1400, true],
				[300, 1400, true],
				[300, 0, true],
			],
			// PUSHB[0] 0, CALL
			instructions: [0xb0, 0x00, 0x2b],
		},
		{
			endPts: [3],
			pts: [
				[1000, 0, true],
				[1000, 1400, true],
				[1040, 1400, true],
				[1040, 0, true],
			],
			instructions: [],
		},
		{
			endPts: [7],
			pts: [
				[600, 0, true],
				[200, 0, false],
				[200, 700, true],
				[200, 1400, false],
				[600, 1400, true],
				[1000, 1400, false],
				[1000, 700, true],
				[1000, 0, false],
			],
			instructions: [],
		},
	];
	const advances = [1024, 512, 400, 1200, 1200];
	const numGlyphs = glyphs.length;

	const glyf: number[] = [];
	const loca: number[] = [];
	for (const g of glyphs) {
		loca.push(...u32(glyf.length));
		glyf.push(...encodeGlyph(g));
	}
	loca.push(...u32(glyf.length));

	const hmtx: number[] = [];
	for (let i = 0; i < numGlyphs; i++) {
		const g = glyphs[i];
		hmtx.push(...u16(advances[i]), ...i16(g ? Math.min(...g.pts.map((p) => p[0])) : 0));
	}

	// cmap format 4: ' ' -> 1, 'I' -> 2, 'l' -> 3, 'o' -> 4.
	const segs = [
		{ start: 0x20, end: 0x20, delta: 1 - 0x20 },
		{ start: 0x49, end: 0x49, delta: 2 - 0x49 },
		{ start: 0x6c, end: 0x6c, delta: 3 - 0x6c },
		{ start: 0x6f, end: 0x6f, delta: 4 - 0x6f },
		{ start: 0xffff, end: 0xffff, delta: 1 },
	];
	const segX2 = segs.length * 2;
	const sub: number[] = [...u16(4), ...u16(16 + segs.length * 8), ...u16(0), ...u16(segX2), ...u16(8), ...u16(2), ...u16(segX2 - 8)];
	for (const s of segs) sub.push(...u16(s.end));
	sub.push(...u16(0));
	for (const s of segs) sub.push(...u16(s.start));
	for (const s of segs) sub.push(...i16(s.delta));
	for (let i = 0; i < segs.length; i++) sub.push(...u16(0));
	const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub];

	const head = [
		...u32(0x00010000), ...u32(0x00010000), ...u32(0), ...u32(0x5f0f3cf5),
		...u16(0x001b), ...u16(2048),
		...u32(0), ...u32(0), ...u32(0), ...u32(0),
		...i16(0), ...i16(-500), ...i16(1200), ...i16(1500),
		...u16(0), ...u16(8), ...i16(2), ...i16(1), ...i16(0),
	];
	const hhea = [
		...u32(0x00010000), ...i16(1600), ...i16(-400), ...i16(0), ...u16(1200),
		...i16(0), ...i16(0), ...i16(1200), ...i16(1), ...i16(0), ...i16(0),
		...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...u16(numGlyphs),
	];
	const maxp = [
		...u32(0x00010000), ...u16(numGlyphs), ...u16(16), ...u16(2), ...u16(0), ...u16(0),
		...u16(2), ...u16(4), ...u16(4), ...u16(4), ...u16(0), ...u16(64), ...u16(64), ...u16(0), ...u16(0),
	];
	const os2 = [
		...u16(1), ...i16(500), ...u16(400), ...u16(5), ...u16(0),
		...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(0),
		...i16(100), ...i16(600), ...i16(0),
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		...u32(0), ...u32(0), ...u32(0), ...u32(0),
		0x54, 0x45, 0x53, 0x54,
		...u16(0x40), ...u16(0x20), ...u16(0x6f),
		...i16(1500), ...i16(-500), ...i16(0), ...u16(1800), ...u16(400),
		...u32(1), ...u32(0),
	];
	const post = [...u32(0x00030000), ...u32(0), ...i16(-200), ...i16(100), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0)];
	const names: Array<[number, string]> = [
		[1, 'Test Sans'],
		[2, 'Regular'],
		[4, 'Test Sans Regular'],
	];
	const nameStrings: number[] = [];
	const nameRecs: number[] = [];
	for (const [id, s] of names) {
		const b = utf16be(s);
		nameRecs.push(...u16(3), ...u16(1), ...u16(0x409), ...u16(id), ...u16(b.length), ...u16(nameStrings.length));
		nameStrings.push(...b);
	}
	const name = [...u16(0), ...u16(names.length), ...u16(6 + nameRecs.length), ...nameRecs, ...nameStrings];
	// hdmx: one record for ppem 10.
	const recSize = (2 + numGlyphs + 3) & ~3;
	const hdmxRec = [10, 12, ...advances.map((a) => Math.round((a * 10) / 2048))];
	while (hdmxRec.length < recSize) hdmxRec.push(0);
	const hdmx = [...u16(0), ...i16(1), ...u32(recSize), ...hdmxRec];
	const gasp = [...u16(1), ...u16(1), ...u16(0xffff), ...u16(0x000f)];
	// fpgm: FDEF 0 { SVTCA[x]; PUSHB 0; MDAP[r]; SVTCA[y]; PUSHB 0; MDAP[r]; IUP[x]; IUP[y] } ENDF
	const fpgm = [0xb0, 0x00, 0x2c, 0x01, 0xb0, 0x00, 0x2f, 0x00, 0xb0, 0x00, 0x2f, 0x31, 0x30, 0x2d];
	// prep: PUSHW 0x01FF, SCANCTRL, PUSHB 1, SCANTYPE
	const prep = [0xb8, 0x01, 0xff, 0x85, 0xb0, 0x01, 0x8d];
	const cvt = [...i16(200)];

	const tables: Array<[string, number[]]> = [
		['OS/2', os2],
		['cmap', cmap],
		['cvt ', cvt],
		['fpgm', fpgm],
		['gasp', gasp],
		['glyf', glyf],
		['hdmx', hdmx],
		['head', head],
		['hhea', hhea],
		['hmtx', hmtx],
		['loca', loca],
		['maxp', maxp],
		['name', name],
		['post', post],
		['prep', prep],
	];
	const dirSize = 12 + tables.length * 16;
	const out: number[] = [...u32(0x00010000), ...u16(tables.length), ...u16(0), ...u16(0), ...u16(0)];
	let offset = dirSize;
	const body: number[] = [];
	for (const [tag, data] of tables) {
		out.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(offset), ...u32(data.length));
		body.push(...data);
		while (body.length % 4) body.push(0);
		offset = dirSize + body.length;
	}
	return new Uint8Array([...out, ...body]);
}
