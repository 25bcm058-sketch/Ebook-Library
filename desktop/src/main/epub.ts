/**
 * epub.ts — safe archive reading + metadata extraction for EPUB / CBZ / FB2.
 *
 * Archive library choice: **adm-zip**, not yauzl.
 *   - adm-zip's synchronous, whole-entries-list API is a much better fit
 *     for a local desktop tool than yauzl's streaming/event-based one: we
 *     already read the whole (small, few-MB) ebook file into memory to
 *     hash it for content-addressing, so there is no memory-pressure
 *     reason to prefer a streaming unzip here. The synchronous API also
 *     makes the zip-slip and zip-bomb guards below trivial to write
 *     correctly (inspect the whole central directory before decompressing
 *     anything), whereas yauzl would need careful backpressure handling
 *     for the same guarantee. Trade-off: adm-zip is less suited to *huge*
 *     archives — irrelevant for ebook/comic files.
 *
 * XXE note: fast-xml-parser is a pure string tokenizer with no DTD/external
 * entity resolution and no network access at all (unlike libxml2-backed
 * parsers), so classic XXE ("read /etc/passwd via an external entity") is
 * structurally impossible here, not just disabled. We additionally set
 * `processEntities: false` so even in-document numeric/named entities are
 * left as literal text rather than substituted, and we never feed the
 * parser anything but a string already decoded from the guarded zip read
 * below.
 */
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs';
import { resolveZipPath, zipDirOf } from './sanitize';

const MAX_ENTRIES = 10_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MiB
const MAX_COMPRESSION_RATIO = 200; // guards against zip-bomb style entries

export class UnsafeArchiveError extends Error {}

/** Rejects '..' segments, absolute paths, and Windows drive letters. */
function isSafeEntryName(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(name)) return false; // C:\...
  const parts = name.split(/[\\/]/);
  return !parts.some((p) => p === '..');
}

/**
 * Opens a zip-family archive and validates it before returning it:
 * entry-name traversal guard (zip-slip) + entry-count/uncompressed-size/
 * compression-ratio caps (zip-bomb guard). Throws UnsafeArchiveError on
 * any violation; callers must not extract from an archive that failed
 * this check.
 */
export function openZipSafely(filePath: string): AdmZip {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  if (entries.length > MAX_ENTRIES) {
    throw new UnsafeArchiveError(`Archive has too many entries (${entries.length} > ${MAX_ENTRIES}).`);
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isSafeEntryName(entry.entryName)) {
      throw new UnsafeArchiveError(`Unsafe archive entry path: "${entry.entryName}".`);
    }
    const uncompressed = entry.header.size;
    const compressed = Math.max(entry.header.compressedSize, 1);
    totalUncompressed += uncompressed;
    if (uncompressed / compressed > MAX_COMPRESSION_RATIO) {
      throw new UnsafeArchiveError(`Suspicious compression ratio on entry "${entry.entryName}" (possible zip bomb).`);
    }
  }
  if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new UnsafeArchiveError(`Archive uncompressed size too large (${totalUncompressed} bytes).`);
  }

  return zip;
}

function readEntryText(zip: AdmZip, entryName: string): string | null {
  const entry = zip.getEntry(entryName);
  if (!entry || !isSafeEntryName(entry.entryName)) return null;
  return zip.readAsText(entry, 'utf8');
}

function readEntryBuffer(zip: AdmZip, entryName: string): Buffer | null {
  const entry = zip.getEntry(entryName);
  if (!entry || !isSafeEntryName(entry.entryName)) return null;
  return zip.readFile(entry);
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false, // do not substitute XML entities — see file header
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
});

export interface ParsedBookMetadata {
  title?: string;
  authors: string[];
  description?: string;
  language?: string;
  publisher?: string;
  publishedOn?: string;
  identifiers: { scheme: string; value: string }[];
  coverBuffer?: Buffer;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(node: unknown): string | undefined {
  if (node == null) return undefined;
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim() || undefined;
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return textOf((node as Record<string, unknown>)['#text']);
  }
  return undefined;
}

/** Parses META-INF/container.xml + the OPF it points to, safely. */
export function parseEpubMetadata(filePath: string): ParsedBookMetadata {
  const zip = openZipSafely(filePath);

  const containerXml = readEntryText(zip, 'META-INF/container.xml');
  if (!containerXml) throw new UnsafeArchiveError('EPUB is missing META-INF/container.xml.');
  const container = xmlParser.parse(containerXml);
  const rootfile = container?.container?.rootfiles?.rootfile;
  const opfPath: string | undefined = Array.isArray(rootfile)
    ? rootfile[0]?.['@_full-path']
    : rootfile?.['@_full-path'];
  if (!opfPath || !isSafeEntryName(opfPath)) {
    throw new UnsafeArchiveError('EPUB container.xml has no safe rootfile reference.');
  }

  const opfXml = readEntryText(zip, opfPath);
  if (!opfXml) throw new UnsafeArchiveError(`EPUB OPF not found at "${opfPath}".`);
  const opf = xmlParser.parse(opfXml);
  const metadata = opf?.package?.metadata ?? {};
  const manifest = toArray(opf?.package?.manifest?.item);

  const authors = toArray(metadata['dc:creator']).map((c) => textOf(c)).filter((s): s is string => !!s);
  const identifiers = toArray(metadata['dc:identifier']).map((id) => ({
    scheme: 'uri',
    value: textOf(id) ?? '',
  })).filter((i) => i.value);

  // Cover: EPUB3 manifest item with properties="cover-image", or EPUB2
  // <meta name="cover" content="ID"> pointing at a manifest item id.
  let coverHref: string | undefined = manifest.find(
    (item: Record<string, unknown>) => String(item['@_properties'] ?? '').includes('cover-image'),
  )?.['@_href'];
  if (!coverHref) {
    const metas = toArray(metadata.meta);
    const coverMeta = metas.find((m: Record<string, unknown>) => m['@_name'] === 'cover');
    const coverId = coverMeta?.['@_content'];
    if (coverId) {
      coverHref = manifest.find((item: Record<string, unknown>) => item['@_id'] === coverId)?.['@_href'];
    }
  }

  let coverBuffer: Buffer | undefined;
  if (coverHref) {
    // href in OPF is relative to the OPF's directory.
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const resolved = opfDir + coverHref;
    if (isSafeEntryName(resolved)) {
      coverBuffer = readEntryBuffer(zip, resolved) ?? undefined;
    }
  }

  return {
    title: textOf(metadata['dc:title']),
    authors,
    description: textOf(metadata['dc:description']),
    language: textOf(metadata['dc:language']),
    publisher: textOf(metadata['dc:publisher']),
    publishedOn: textOf(metadata['dc:date']),
    identifiers,
    coverBuffer,
  };
}

/** ComicInfo.xml, if present, per the de-facto CBZ metadata convention. */
export function parseCbzMetadata(filePath: string): ParsedBookMetadata {
  const zip = openZipSafely(filePath);
  const xml = readEntryText(zip, 'ComicInfo.xml');
  if (!xml) return { authors: [], identifiers: [] };
  const doc = xmlParser.parse(xml);
  const info = doc?.ComicInfo ?? {};
  const authors = [textOf(info.Writer)].filter((s): s is string => !!s);
  return {
    title: textOf(info.Title) ?? textOf(info.Series),
    authors,
    description: textOf(info.Summary),
    language: textOf(info.LanguageISO),
    publisher: textOf(info.Publisher),
    publishedOn: info.Year ? String(info.Year) : undefined,
    identifiers: [],
  };
}

/** FictionBook2 is bare XML (not zipped); parsed directly, no archive guard needed. */
export function parseFb2Metadata(filePath: string): ParsedBookMetadata {
  const xml = fs.readFileSync(filePath, 'utf8');
  const doc = xmlParser.parse(xml);
  const titleInfo = doc?.FictionBook?.description?.['title-info'] ?? {};
  const authorsRaw = toArray(titleInfo.author);
  const authors = authorsRaw
    .map((a) => [textOf(a?.['first-name']), textOf(a?.['last-name'])].filter(Boolean).join(' '))
    .filter((s) => s.length > 0);
  return {
    title: textOf(titleInfo['book-title']),
    authors,
    description: textOf(titleInfo.annotation),
    language: textOf(titleInfo.lang),
    identifiers: [],
  };
}

// ── Reader support: spine, table of contents, raw entry access ────────
// Everything below reuses the same openZipSafely() guards as metadata
// extraction — reader content is exactly as untrusted as metadata.

export interface EpubSpineItem {
  /** Manifest id of the item. */
  id: string;
  /** Zip-entry path (already resolved against the OPF directory). */
  href: string;
  mediaType: string;
}

export interface EpubTocItem {
  label: string;
  /** Zip-entry path, possibly with a "#fragment" suffix. '' when the entry had no usable link. */
  href: string;
  children: EpubTocItem[];
}

export interface EpubStructure {
  opfPath: string;
  opfDir: string;
  spine: EpubSpineItem[];
  toc: EpubTocItem[];
}

interface ManifestItem {
  href: string; // resolved zip-entry path
  mediaType: string;
  properties: string;
}

interface OpfContext {
  zip: AdmZip;
  opfPath: string;
  opfDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opf: any;
  manifest: Map<string, ManifestItem>;
}

/** Shared container.xml → OPF resolution used by both metadata and reader paths. */
function loadOpfContext(zip: AdmZip): OpfContext {
  const containerXml = readEntryText(zip, 'META-INF/container.xml');
  if (!containerXml) throw new UnsafeArchiveError('EPUB is missing META-INF/container.xml.');
  const container = xmlParser.parse(containerXml);
  const rootfile = container?.container?.rootfiles?.rootfile;
  const opfPath: string | undefined = Array.isArray(rootfile)
    ? rootfile[0]?.['@_full-path']
    : rootfile?.['@_full-path'];
  if (!opfPath || !isSafeEntryName(opfPath)) {
    throw new UnsafeArchiveError('EPUB container.xml has no safe rootfile reference.');
  }

  const opfXml = readEntryText(zip, opfPath);
  if (!opfXml) throw new UnsafeArchiveError(`EPUB OPF not found at "${opfPath}".`);
  const opf = xmlParser.parse(opfXml);

  const opfDir = zipDirOf(opfPath);
  const manifest = new Map<string, ManifestItem>();
  for (const item of toArray(opf?.package?.manifest?.item)) {
    const id = item?.['@_id'];
    const href = item?.['@_href'];
    if (!id || !href) continue;
    const resolved = resolveZipPath(opfDir, String(href));
    if (!resolved || !isSafeEntryName(resolved)) continue;
    manifest.set(String(id), {
      href: resolved,
      mediaType: String(item?.['@_media-type'] ?? ''),
      properties: String(item?.['@_properties'] ?? ''),
    });
  }

  return { zip, opfPath, opfDir, opf, manifest };
}

/** Reads the spine (reading order) + TOC from an EPUB, archive-guarded. */
export function readEpubStructure(filePath: string): EpubStructure {
  const zip = openZipSafely(filePath);
  const ctx = loadOpfContext(zip);

  const spine: EpubSpineItem[] = [];
  for (const itemref of toArray(ctx.opf?.package?.spine?.itemref)) {
    const idref = itemref?.['@_idref'];
    if (!idref) continue;
    const item = ctx.manifest.get(String(idref));
    if (!item) continue;
    spine.push({ id: String(idref), href: item.href, mediaType: item.mediaType });
  }

  const toc = readEpubToc(ctx) ?? spineTocFallback(spine);
  return { opfPath: ctx.opfPath, opfDir: ctx.opfDir, spine, toc };
}

/** Reads one zip entry as UTF-8 text, path-traversal-guarded. For reader chapter/media serving. */
export function readEpubEntryText(filePath: string, entryPath: string): string | null {
  if (!isSafeEntryName(entryPath)) return null;
  const zip = openZipSafely(filePath);
  return readEntryText(zip, entryPath);
}

/** Reads one zip entry as a buffer, path-traversal-guarded. For reader media serving. */
export function readEpubEntryBuffer(filePath: string, entryPath: string): Buffer | null {
  if (!isSafeEntryName(entryPath)) return null;
  const zip = openZipSafely(filePath);
  return readEntryBuffer(zip, entryPath);
}

/** EPUB 3 nav document first, EPUB 2 NCX second; null when neither exists. */
function readEpubToc(ctx: OpfContext): EpubTocItem[] | null {
  for (const item of ctx.manifest.values()) {
    if (item.properties.split(/\s+/).includes('nav') && item.mediaType === 'application/xhtml+xml') {
      const xml = readEntryText(ctx.zip, item.href);
      if (!xml) continue;
      const doc = xmlParser.parse(xml);
      const nav = findTocNav(doc);
      if (nav) {
        const items = navListToToc(nav, zipDirOf(item.href));
        if (items.length > 0) return items;
      }
    }
  }

  for (const item of ctx.manifest.values()) {
    if (item.mediaType === 'application/x-dtbncx+xml') {
      const xml = readEntryText(ctx.zip, item.href);
      if (!xml) continue;
      const doc = xmlParser.parse(xml);
      const items = ncxPointsToToc(doc?.ncx?.navMap?.navPoint, zipDirOf(item.href));
      if (items.length > 0) return items;
    }
  }

  return null;
}

/** Depth-first search for the <nav epub:type="toc"> element in a parsed nav document. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findTocNav(node: any): any | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTocNav(child);
      if (found) return found;
    }
    return null;
  }
  if ('nav' in node) {
    for (const nav of toArray(node.nav)) {
      const type = String(nav?.['@_epub:type'] ?? nav?.['@_type'] ?? '');
      if (type.split(/\s+/).includes('toc')) return nav;
      const found = findTocNav(nav);
      if (found) return found;
    }
  }
  for (const key of ['html', 'body', 'section', 'div']) {
    if (key in node) {
      const found = findTocNav(node[key]);
      if (found) return found;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function navListToToc(nav: any, baseDir: string): EpubTocItem[] {
  return olToToc(nav?.ol, baseDir);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function olToToc(ol: any, baseDir: string): EpubTocItem[] {
  if (!ol) return [];
  const items: EpubTocItem[] = [];
  for (const li of toArray(ol.li)) {
    const anchor = li?.a;
    const label = textOf(anchor) ?? textOf(li?.span) ?? 'Untitled';
    const rawHref = anchor?.['@_href'];
    let href = '';
    if (rawHref) {
      const resolved = resolveZipPath(baseDir, String(rawHref));
      const fragment = String(rawHref).includes('#') ? `#${String(rawHref).split('#').slice(1).join('#')}` : '';
      if (resolved !== null && resolved !== '') href = resolved + fragment;
    }
    items.push({ label, href, children: olToToc(li?.ol, baseDir) });
  }
  return items;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ncxPointsToToc(navPoints: any, baseDir: string): EpubTocItem[] {
  const items: EpubTocItem[] = [];
  for (const point of toArray(navPoints)) {
    const label = textOf(point?.navLabel?.text) ?? 'Untitled';
    const rawSrc = point?.content?.['@_src'];
    let href = '';
    if (rawSrc) {
      const resolved = resolveZipPath(baseDir, String(rawSrc));
      const fragment = String(rawSrc).includes('#') ? `#${String(rawSrc).split('#').slice(1).join('#')}` : '';
      if (resolved !== null && resolved !== '') href = resolved + fragment;
    }
    items.push({ label, href, children: ncxPointsToToc(point?.navPoint, baseDir) });
  }
  return items;
}

/** Books with no nav/NCX at all: one TOC entry per spine document. */
function spineTocFallback(spine: EpubSpineItem[]): EpubTocItem[] {
  return spine.map((item, i) => ({
    label: item.href.split('/').pop() ?? `Section ${i + 1}`,
    href: item.href,
    children: [],
  }));
}
