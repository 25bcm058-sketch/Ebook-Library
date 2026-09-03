/**
 * sanitize.ts — server-side XHTML sanitizer for the in-app EPUB reader.
 *
 * EPUB 3 content documents may legally embed JavaScript, and a downloaded
 * e-book is attacker-controlled input even on a single-user desktop app
 * (see README "Desktop-specific security notes"). The reader window is
 * sandboxed and CSP-locked, but defense in depth says the API must never
 * hand raw book markup to any window: every chapter is rewritten here, in
 * the Fastify handler, before it crosses the HTTP boundary.
 *
 * What the sanitizer does:
 *   - Whitelists a small set of presentational tags; everything else is
 *     unwrapped (kept text) or, for active/embedding elements, dropped
 *     *with its contents*: script, style, iframe, object, embed, applet,
 *     form controls, audio/video, svg, math, link, meta, base, template…
 *   - Whitelists attributes per tag; drops every `on*` event handler,
 *     every inline `style` (CSS can smuggle url() references), and any
 *     attribute not on the list.
 *   - Drops `javascript:`, `vbscript:`, `data:`, and `file:` URLs.
 *   - Rewrites internal <img src> to the authenticated media endpoint
 *     (`/api/books/:id/media/<zip-entry-path>`), resolved against the
 *     chapter's own directory inside the EPUB. Path traversal out of the
 *     archive root is rejected by resolveZipPath().
 *   - Rewrites internal cross-chapter <a href> to `#` + `data-href` so the
 *     reader JS can turn them into spine navigation instead of document
 *     navigations. External http(s) links lose their href (the reader
 *     window has nowhere safe to navigate to).
 *
 * Implementation is a single-pass tag tokenizer (no DOM dependency, no
 * native code, works fully offline). Input is XHTML, which is well-formed
 * by spec, so a regex-based tokenizer is reliable here; malformed input
 * degrades to unwrapping, never to letting markup through unsanitized.
 */

export interface SanitizeContext {
  /** Book id, used to build media-endpoint URLs. */
  bookId: string;
  /** Zip-entry path of the chapter being sanitized, e.g. "OEBPS/text/ch1.xhtml". */
  chapterPath: string;
}

const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub', 'small', 'mark', 'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'dfn', 'time',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'img', 'a', 'br', 'hr', 'nav', 'ruby', 'rt', 'rp', 'wbr',
]);

/** Dropped together with everything between the open and close tag. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'label', 'fieldset',
  'audio', 'video', 'source', 'track',
  'svg', 'math', 'canvas', 'template', 'noscript',
  'link', 'meta', 'base', 'title',
]);

/** Void elements: emitted self-closed, never wait for a closing tag. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'col']);

const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir']);
const TAG_ATTRS: Record<string, Set<string>> = {
  img: new Set(['src', 'alt', 'width', 'height']),
  a: new Set(['href']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  ol: new Set(['start', 'type']),
  col: new Set(['span']),
  time: new Set(['datetime']),
};

/** Directory portion of a zip-entry path ("OEBPS/text/ch1.xhtml" → "OEBPS/text/"). */
export function zipDirOf(entryPath: string): string {
  const idx = entryPath.lastIndexOf('/');
  return idx === -1 ? '' : entryPath.slice(0, idx + 1);
}

/**
 * Resolves `href` (possibly relative, possibly with fragment/query) against
 * `baseDir` inside a zip archive. Returns the normalized zip-entry path, or
 * null if the result would escape the archive root (path traversal). An
 * empty/fragment-only href resolves to ''.
 */
export function resolveZipPath(baseDir: string, href: string): string | null {
  const clean = href.split('#')[0].split('?')[0];
  if (!clean) return '';
  const out: string[] = [];
  for (const part of (baseDir + clean).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null; // would escape the archive root
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/** Minimal entity decode for attribute values before URL inspection. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, ent: string) => {
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const code = parseInt(ent.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (ent.startsWith('#')) {
      const code = parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DISALLOWED_SCHEME = /^(javascript|vbscript|data|file)\s*:/i;

/**
 * Inspects one URL attribute value. Returns the (possibly rewritten) value
 * to emit, or null to drop the attribute entirely.
 */
function sanitizeUrl(tag: string, raw: string, ctx: SanitizeContext): string | null {
  const trimmed = raw.trim();
  // Scheme detection on a whitespace/control-stripped lowercase copy, so
  // "java\tscript:" and "&#x6a;avascript:" (already entity-decoded) can't slip by.
  const probe = decodeEntities(trimmed).replace(/[- \u0000-\u001F]+/g, '');
  if (DISALLOWED_SCHEME.test(probe)) return null;

  if (tag === 'img') {
    if (/^https?:\/\//i.test(probe)) return null; // reader CSP is loopback-only; remote images are dropped
    const resolved = resolveZipPath(zipDirOf(ctx.chapterPath), trimmed);
    if (!resolved) return null;
    const encoded = resolved.split('/').map(encodeURIComponent).join('/');
    return `/api/books/${encodeURIComponent(ctx.bookId)}/media/${encoded}`;
  }

  // tag === 'a' (only other URL-bearing tag in the whitelist)
  if (trimmed.startsWith('#')) return trimmed; // same-chapter fragment
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe)) return null; // any absolute scheme (http, mailto, …) is dropped
  return trimmed; // internal relative reference; rewritten to data-href by the caller
}

interface Attr {
  name: string;
  value: string;
}

function parseAttrs(raw: string): Attr[] {
  const attrs: Attr[] = [];
  const ATTR_RE = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs.push({ name: m[1].toLowerCase(), value: m[3] ?? m[4] ?? m[5] ?? '' });
  }
  return attrs;
}

/** Rebuilds the attribute string for one whitelisted tag. */
function buildAttrs(tag: string, rawAttrs: string, ctx: SanitizeContext): string {
  let out = '';
  for (const attr of parseAttrs(rawAttrs)) {
    const local = attr.name.split(':').pop() ?? attr.name;
    if (local.startsWith('on')) continue; // event handlers
    if (local === 'style') continue; // inline CSS can smuggle url()s; themes are applied by the reader instead
    if (local === 'srcset' || local === 'ping' || local === 'formaction') continue;

    const allowed = GLOBAL_ATTRS.has(local) || (TAG_ATTRS[tag]?.has(local) ?? false);
    if (!allowed) continue;

    if (local === 'src' || local === 'href') {
      const value = sanitizeUrl(tag, attr.value, ctx);
      if (value === null) continue;
      if (tag === 'a' && local === 'href' && !value.startsWith('#')) {
        // Internal cross-chapter link: neutralize the navigation and hand
        // the *resolved* zip-entry path (matching spine hrefs) to the
        // reader JS, which turns it into a spine navigation instead of a
        // document navigation.
        const resolved = resolveZipPath(zipDirOf(ctx.chapterPath), value);
        if (!resolved) continue;
        const fragment = value.includes('#') ? `#${value.split('#').slice(1).join('#')}` : '';
        out += ` href="#" data-href="${escapeAttr(resolved + fragment)}"`;
        continue;
      }
      out += ` ${local}="${escapeAttr(value)}"`;
      continue;
    }
    out += ` ${local}="${escapeAttr(decodeEntities(attr.value))}"`;
  }
  return out;
}

// One token: comment, doctype/CDATA-ish, processing instruction, or a tag.
// Attribute values may contain ">" inside quotes, which the alternation handles.
const TOKEN_RE = /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/**
 * Sanitizes one XHTML chapter. Returns an HTML fragment safe to inject via
 * innerHTML in the sandboxed reader window. Never throws on malformed input
 * — worst case it returns escaped/partial content.
 */
export function sanitizeChapter(xhtml: string, ctx: SanitizeContext): string {
  // Restrict to <body> content when present: everything in <head> (styles,
  // external links, metadata) is reader-injected or irrelevant.
  const bodyMatch = /<body\b(?:"[^"]*"|'[^']*'|[^>"'])*>([\s\S]*?)<\/body>/i.exec(xhtml);
  const source = bodyMatch ? bodyMatch[1] : xhtml;

  const out: string[] = [];
  const dropStack: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;

  while ((m = TOKEN_RE.exec(source)) !== null) {
    const text = source.slice(lastIndex, m.index);
    if (dropStack.length === 0) out.push(text);
    lastIndex = m.index + m[0].length;

    const isClosing = m[1] === '/';
    const rawName = m[2];
    if (!rawName) continue; // comment / doctype / PI — dropped
    const name = (rawName.toLowerCase().split(':').pop() ?? rawName).toLowerCase();
    const selfClosing = /\/\s*>$/.test(m[0]);

    if (dropStack.length > 0) {
      if (isClosing) {
        const idx = dropStack.lastIndexOf(name);
        if (idx !== -1) dropStack.length = idx; // pops the match and anything (malformed) above it
      } else if (!selfClosing && !VOID_TAGS.has(name)) {
        dropStack.push(name);
      }
      continue;
    }

    if (isClosing) {
      if (ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) out.push(`</${name}>`);
      continue;
    }

    if (DROP_WITH_CONTENT.has(name)) {
      if (!selfClosing) dropStack.push(name);
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // unwrap unknown tags, keep their text content

    const attrs = buildAttrs(name, m[3] ?? '', ctx);
    out.push(VOID_TAGS.has(name) || selfClosing ? `<${name}${attrs} />` : `<${name}${attrs}>`);
  }

  if (dropStack.length === 0) out.push(source.slice(lastIndex));
  return out.join('');
}
