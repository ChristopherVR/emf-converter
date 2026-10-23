/**
 * A tiny parser for the SVG markup this package itself writes
 * ({@link svgTreeToString}), the inverse of that serialiser: elements,
 * double- or single-quoted attributes, character data, and the five
 * predefined entities plus numeric references. It exists so a nested
 * metafile (embedded in the tree as a base64 SVG data URL) can be turned
 * back into an {@link SvgNode} tree. It is not a general XML parser
 * (no DTDs, namespaces, CDATA beyond skipping, or external entities).
 *
 * @module svg-parse
 */

import type { SvgNode } from './svg-tree';

function unescapeXml(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, ent: string) => {
		switch (ent.toLowerCase()) {
			case 'amp':
				return '&';
			case 'lt':
				return '<';
			case 'gt':
				return '>';
			case 'quot':
				return '"';
			case 'apos':
				return "'";
		}
		const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
		return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
	});
}

/** Parses SVG markup into a tree, or `null` when it is not well-formed enough to read. */
export function parseSvgMarkup(markup: string): SvgNode | null {
	const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	const stack: SvgNode[] = [];
	let root: SvgNode | null = null;
	let m: RegExpExecArray | null;
	let consumed = 0;
	while ((m = tokens.exec(markup))) {
		if (m.index !== consumed) {
			return null; // something the token grammar could not read
		}
		consumed = tokens.lastIndex;
		const [whole, closing, name, rawAttrs, selfClose, text] = m;
		if (text !== undefined) {
			const top = stack[stack.length - 1];
			if (top && text.trim() !== '') {
				top.text = (top.text ?? '') + unescapeXml(text);
			} else if (top && top.tag === 'text') {
				top.text = (top.text ?? '') + unescapeXml(text);
			}
			continue;
		}
		if (!name) {
			void whole;
			continue; // comment / declaration
		}
		if (closing) {
			const done = stack.pop();
			if (!done || done.tag !== name) {
				return null;
			}
			if (stack.length === 0) {
				root = done;
			}
			continue;
		}
		const attrs: SvgNode['attrs'] = {};
		attrRe.lastIndex = 0;
		let a: RegExpExecArray | null;
		while ((a = attrRe.exec(rawAttrs))) {
			attrs[a[1]] = unescapeXml(a[2] ?? a[3] ?? '');
		}
		const node: SvgNode = { tag: name, attrs };
		const parent = stack[stack.length - 1];
		if (parent) {
			(parent.children ??= []).push(node);
		}
		if (selfClose) {
			if (!parent) {
				root = node;
			}
		} else {
			stack.push(node);
		}
	}
	if (stack.length > 0 || consumed !== markup.length) {
		return null;
	}
	return root;
}
