/**
 * A tiny, framework-agnostic SVG document model plus its serialisers.
 *
 * The SVG backend (`svg-context.ts`) records a metafile's drawing into an
 * {@link SvgNode} tree rather than straight into markup, so the same result
 * can be handed to whichever consumer needs it:
 *
 * - {@link svgTreeToString}: standalone SVG markup (`<svg xmlns=...>...</svg>`)
 * - {@link svgTreeToDataUrl}: a `data:image/svg+xml;base64,...` URL, usable
 *   anywhere an image URL is (`<img src>`, CSS `background-image`, ...)
 * - {@link svgTreeToReact}: live elements for React (or Preact, Solid's
 *   `h`, Vue's `h`, ...), built through a caller-supplied `createElement`,
 *   so this package never depends on a UI framework
 * - {@link svgTreeToJsx}: JSX/TSX component source code, for build-time code
 *   generation in the style of SVGR
 *
 * Attribute names are stored in their SVG (kebab-case) spelling; the React
 * and JSX serialisers convert them to the camelCase property names React
 * expects (`stroke-width` → `strokeWidth`, `clip-path` → `clipPath`, and a
 * `style` string becomes a style object).
 *
 * @module svg-tree
 */

/** One SVG element. Text content (for `<text>`) lives in {@link SvgNode.text}. */
export interface SvgNode {
	/** Element name, e.g. `path`, `g`, `linearGradient`. */
	tag: string;
	/** Attributes in SVG spelling (`stroke-width`, `clip-path`, `style`). */
	attrs: Record<string, string | number>;
	/** Child elements, in paint order. */
	children?: SvgNode[];
	/** Character data for text-bearing elements. Mutually exclusive with children. */
	text?: string;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
	return value
		// Characters XML 1.0 forbids outright (C0 controls other than tab/LF/CR,
		// U+FFFE/U+FFFF) are dropped; unpaired surrogates become U+FFFD.
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function writeNode(node: SvgNode, out: string[]): void {
	out.push('<', node.tag);
	for (const key of Object.keys(node.attrs)) {
		out.push(' ', key, '="', escapeXml(String(node.attrs[key])), '"');
	}
	if (node.text !== undefined) {
		out.push('>', escapeXml(node.text), '</', node.tag, '>');
		return;
	}
	if (!node.children || node.children.length === 0) {
		out.push('/>');
		return;
	}
	out.push('>');
	for (const child of node.children) {
		writeNode(child, out);
	}
	out.push('</', node.tag, '>');
}

/** Serialises a tree to SVG markup. The root should be an `<svg>` element. */
export function svgTreeToString(node: SvgNode): string {
	const out: string[] = [];
	writeNode(node, out);
	return out.join('');
}

// ---------------------------------------------------------------------------
// Base64 (portable: no Buffer / btoa dependency, works on any byte length)
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-encodes raw bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
	const parts: string[] = [];
	const CHUNK = 3 * 4096;
	for (let start = 0; start < bytes.length; start += CHUNK) {
		const end = Math.min(bytes.length, start + CHUNK);
		let s = '';
		let i = start;
		for (; i + 2 < end; i += 3) {
			const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
			s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
		}
		if (i < end) {
			const n = (bytes[i] << 16) | ((i + 1 < end ? bytes[i + 1] : 0) << 8);
			s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < end ? B64[(n >> 6) & 63] : '=') + '=';
		}
		parts.push(s);
	}
	return parts.join('');
}

/** UTF-8 encodes a string (TextEncoder when present, manual fallback otherwise). */
function utf8(text: string): Uint8Array {
	if (typeof TextEncoder !== 'undefined') {
		return new TextEncoder().encode(text);
	}
	const bytes: number[] = [];
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) {
			bytes.push(cp);
		} else if (cp < 0x800) {
			bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
		} else if (cp < 0x10000) {
			bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
		} else {
			bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
		}
	}
	return Uint8Array.from(bytes);
}

/** Encodes SVG markup as a base64 `data:image/svg+xml` URL. */
export function svgMarkupToDataUrl(markup: string): string {
	return `data:image/svg+xml;base64,${bytesToBase64(utf8(markup))}`;
}

/** Serialises a tree to a base64 `data:image/svg+xml` URL. */
export function svgTreeToDataUrl(node: SvgNode): string {
	return svgMarkupToDataUrl(svgTreeToString(node));
}

// ---------------------------------------------------------------------------
// React / JSX
// ---------------------------------------------------------------------------

/** Attributes whose React name is not a plain camelCase of the SVG name. */
const REACT_ATTR_EXCEPTIONS: Record<string, string> = {
	class: 'className',
	'xml:space': 'xmlSpace',
	'xlink:href': 'xlinkHref',
	'xmlns:xlink': 'xmlnsXlink',
};

/**
 * The React prop name for an SVG attribute: `stroke-width` → `strokeWidth`.
 * `data-*` / `aria-*` attributes and already-camelCase SVG attributes
 * (`viewBox`, `gradientUnits`, `preserveAspectRatio`) pass through.
 */
export function reactAttrName(name: string): string {
	const special = REACT_ATTR_EXCEPTIONS[name];
	if (special) {
		return special;
	}
	if (name.startsWith('data-') || name.startsWith('aria-')) {
		return name;
	}
	return name.replace(/[-:]([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Parses an inline `style` string into a React style object (camelCase keys). */
export function parseStyle(style: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const decl of style.split(';')) {
		const idx = decl.indexOf(':');
		if (idx <= 0) {
			continue;
		}
		const key = decl.slice(0, idx).trim();
		const value = decl.slice(idx + 1).trim();
		if (!key) {
			continue;
		}
		const prop = key.startsWith('--') ? key : key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
		out[prop] = value;
	}
	return out;
}

function reactProps(attrs: SvgNode['attrs']): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	for (const key of Object.keys(attrs)) {
		const value = attrs[key];
		if (key === 'style') {
			props.style = parseStyle(String(value));
		} else {
			props[reactAttrName(key)] = value;
		}
	}
	return props;
}

/**
 * A `createElement`-compatible factory: `React.createElement`, Preact's `h`,
 * and most hyperscript-style factories fit this shape.
 */
export type CreateElement<E> = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => E;

/**
 * Builds live framework elements from a tree via `createElement`.
 *
 * ```tsx
 * import { createElement } from 'react';
 * const tree = await convertMetafileToSvgTree(buffer);
 * return tree ? svgTreeToReact(tree, createElement, { className: 'figure', width: '100%' }) : null;
 * ```
 *
 * @param node          - The tree (normally the root `<svg>`).
 * @param createElement - `React.createElement` or a compatible factory.
 * @param rootProps     - Extra props merged onto the root element (override
 *                        `width`/`height`, add `className`, `role`, ...).
 */
export function svgTreeToReact<E>(
	node: SvgNode,
	createElement: CreateElement<E>,
	rootProps?: Record<string, unknown>,
): E {
	let key = 0;
	const build = (n: SvgNode, extra?: Record<string, unknown>): E => {
		const props: Record<string, unknown> = { key: key++, ...reactProps(n.attrs), ...extra };
		if (n.text !== undefined) {
			return createElement(n.tag, props, n.text);
		}
		const children = (n.children ?? []).map((c) => build(c));
		return createElement(n.tag, props, ...children);
	};
	const { key: _omit, ...rest } = rootProps ?? {};
	return build(node, rest);
}

/** Options for {@link svgTreeToJsx}. */
export interface SvgJsxOptions {
	/** Component name. Default `Metafile`. */
	componentName?: string;
	/** Emit TypeScript (`SVGProps<SVGSVGElement>` typing). Default `true`. */
	typescript?: boolean;
	/**
	 * Spread the component's props onto the root `<svg>` (after the recorded
	 * attributes, so callers can override `width`/`height`). Default `true`.
	 */
	spreadProps?: boolean;
}

function jsxString(value: string): string {
	return JSON.stringify(value);
}

function jsxAttrValue(key: string, value: string | number): string {
	if (key === 'style') {
		const obj = parseStyle(String(value));
		const body = Object.keys(obj)
			.map((k) => `${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : jsxString(k)}: ${jsxString(obj[k])}`)
			.join(', ');
		return `{{ ${body} }}`;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? `{${value}}` : '{0}';
	}
	// JSX string attributes have no escape syntax (a backslash is literal)
	// and decode HTML entities, so any value that could end the string or be
	// reinterpreted goes in an expression container as a JS string literal.
	// Metafile text such as font names is untrusted input.
	return /^[^"\\{}<>&\r\n]*$/.test(value) ? `"${value}"` : `{${jsxString(value)}}`;
}

function jsxText(text: string): string {
	return `{${JSON.stringify(text)}}`;
}

function writeJsx(node: SvgNode, depth: number, out: string[], rootSpread: boolean): void {
	const pad = '\t'.repeat(depth);
	const attrs = Object.keys(node.attrs).map((k) => `${reactAttrName(k)}=${jsxAttrValue(k, node.attrs[k])}`);
	if (rootSpread) {
		attrs.push('{...props}');
	}
	const open = `${pad}<${node.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
	if (node.text !== undefined) {
		out.push(`${open}>${jsxText(node.text)}</${node.tag}>`);
		return;
	}
	if (!node.children || node.children.length === 0) {
		out.push(`${open} />`);
		return;
	}
	out.push(`${open}>`);
	for (const child of node.children) {
		writeJsx(child, depth + 1, out, false);
	}
	out.push(`${pad}</${node.tag}>`);
}

/**
 * Generates JSX/TSX source for a React component rendering the tree, for
 * build-time code generation (write it to a `.tsx` file and import it).
 *
 * ```ts
 * const tree = await convertMetafileToSvgTree(buffer, { idPrefix: 'logo-' });
 * writeFileSync('Logo.tsx', svgTreeToJsx(tree!, { componentName: 'Logo' }));
 * ```
 *
 * The output uses the automatic JSX runtime (no `import React` needed); with
 * `typescript: true` it imports only the `SVGProps` type from `react`.
 */
export function svgTreeToJsx(node: SvgNode, options: SvgJsxOptions = {}): string {
	const name = options.componentName ?? 'Metafile';
	if (!/^[A-Z][A-Za-z0-9_$]*$/.test(name)) {
		throw new TypeError(`svgTreeToJsx: componentName must be a PascalCase identifier, got ${JSON.stringify(name)}`);
	}
	const ts = options.typescript ?? true;
	const spread = options.spreadProps ?? true;
	const body: string[] = [];
	writeJsx(node, 2, body, spread);
	const params = spread ? (ts ? 'props: SVGProps<SVGSVGElement>' : 'props') : '';
	const lines = [
		...(ts && spread ? ["import type { SVGProps } from 'react';", ''] : []),
		`export function ${name}(${params}) {`,
		'\treturn (',
		...body,
		'\t);',
		'}',
		'',
		`export default ${name};`,
		'',
	];
	return lines.join('\n');
}
