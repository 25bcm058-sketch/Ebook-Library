/**
 * server.ts — the embedded local API.
 *
 * Same "API-first" shape as the server edition (DESIGN.md §1), collapsed
 * into a single in-process Fastify instance bound to 127.0.0.1 on a random
 * high port. There is no reverse proxy and no TLS: the trust boundary that
 * matters on desktop is not network exposure (there is none — the port is
 * loopback-only and never advertised) but the fact that *imported files are
 * still untrusted input*, so the zip-slip/zip-bomb/XXE guards (epub.ts) and
 * magic-byte validation (magic.ts) from the server edition are kept in full.
 *
 * Every /api/* route requires `Authorization: Bearer <per-launch token>`,
 * generated fresh in src/main/index.ts and handed to the renderer only via
 * contextBridge (never embedded in the page or the URL), so a second local
 * process (or a stray <img> tag) can't call the API just by knowing the port.
 */
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from './db';
import { nextId } from './db';
import { formatFromExtension, validateMagicBytes, type BookFormat } from './magic';
import { parseEpubMetadata, parseCbzMetadata, parseFb2Metadata, type ParsedBookMetadata } from './epub';

export interface ServerOptions {
  db: Db;
  userDataDir: string;
  token: string;
  rendererDir: string;
}

interface BookRow {
  id: string;
  title: string;
  sort_title: string | null;
  subtitle: string | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  published_on: string | null;
  page_count: number | null;
  series_id: string | null;
  series_index: number | null;
  kind: string;
  reading_direction: string;
  content_rating: number | null;
  cover_sha256: string | null;
  drm_protected: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface BookFileRow {
  id: string;
  book_id: string;
  blob_sha256: string;
  format: string;
  layout: string | null;
  source: string;
  original_filename: string | null;
  page_count: number | null;
  created_at: string;
}

function blobDir(userDataDir: string): string {
  return path.join(userDataDir, 'library', 'blobs');
}

function blobPathFor(userDataDir: string, sha256: string): string {
  return path.join(blobDir(userDataDir), sha256.slice(0, 2), sha256);
}

function sha256Of(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Writes `buf` to the content-addressed store and records it, idempotently. */
function storeBlob(db: Db, userDataDir: string, buf: Buffer, mediaType: string): string {
  const sha256 = sha256Of(buf);
  const existing = db.prepare('SELECT sha256 FROM blobs WHERE sha256 = ?').get(sha256);
  if (!existing) {
    const dest = blobPathFor(userDataDir, sha256);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Content-addressed path is derived from a hash *we* computed — never
    // from the uploaded filename — so path traversal at the storage layer
    // is structurally impossible (DESIGN.md §3, "Content-addressed storage").
    fs.writeFileSync(dest, buf, { mode: 0o600 });
    db.prepare(
      'INSERT INTO blobs (sha256, size_bytes, media_type, storage_path) VALUES (?, ?, ?, ?)',
    ).run(sha256, buf.length, mediaType, dest);
  }
  return sha256;
}

function findOrCreateAuthor(db: Db, name: string): string {
  const trimmed = name.trim();
  const existing = db.prepare('SELECT id FROM authors WHERE name = ?').get(trimmed) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = nextId();
  db.prepare('INSERT INTO authors (id, name, sort_name) VALUES (?, ?, ?)').run(id, trimmed, trimmed);
  return id;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

interface DuplicateMatch {
  bookId: string;
  reason: 'sha256' | 'title+author';
  title: string;
}

function findDuplicates(db: Db, sha256: string | null, title: string, authors: string[]): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];

  if (sha256) {
    const exact = db
      .prepare(
        `SELECT b.id, b.title FROM books b
         JOIN book_files f ON f.book_id = b.id
         WHERE f.blob_sha256 = ? AND b.deleted_at IS NULL`,
      )
      .all(sha256) as { id: string; title: string }[];
    for (const m of exact) matches.push({ bookId: m.id, reason: 'sha256', title: m.title });
  }

  if (title) {
    const normTitle = normalizeTitle(title);
    const candidates = db
      .prepare(`SELECT id, title FROM books WHERE deleted_at IS NULL`)
      .all() as { id: string; title: string }[];
    for (const c of candidates) {
      if (matches.some((m) => m.bookId === c.id)) continue;
      if (normalizeTitle(c.title) !== normTitle) continue;
      if (authors.length === 0) {
        matches.push({ bookId: c.id, reason: 'title+author', title: c.title });
        continue;
      }
      const bookAuthors = db
        .prepare(
          `SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ?`,
        )
        .all(c.id) as { name: string }[];
      const overlap = bookAuthors.some((a) => authors.some((x) => x.toLowerCase() === a.name.toLowerCase()));
      if (overlap) matches.push({ bookId: c.id, reason: 'title+author', title: c.title });
    }
  }

  return matches;
}

function parseMetadataFor(format: BookFormat, filePath: string): ParsedBookMetadata {
  switch (format) {
    case 'epub':
      return parseEpubMetadata(filePath);
    case 'cbz':
      return parseCbzMetadata(filePath);
    case 'fb2':
      return parseFb2Metadata(filePath);
    default:
      // PDF/MOBI/AZW3/CBR/CB7: no safe, dependency-free metadata parser
      // wired up yet — title falls back to the filename. See README TODOs.
      return { authors: [], identifiers: [] };
  }
}

const importSchema = z.object({ path: z.string().min(1) });
const coverSchema = z.object({ path: z.string().min(1) });
const patchBookSchema = z
  .object({
    title: z.string().min(1).optional(),
    sortTitle: z.string().nullable().optional(),
    subtitle: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    publisher: z.string().nullable().optional(),
    publishedOn: z.string().nullable().optional(),
    pageCount: z.number().int().nonnegative().nullable().optional(),
    seriesName: z.string().nullable().optional(),
    seriesIndex: z.number().nullable().optional(),
    kind: z.enum(['book', 'comic', 'manga', 'magazine']).optional(),
    readingDirection: z.enum(['ltr', 'rtl', 'vertical']).optional(),
    contentRating: z.number().int().min(0).max(18).nullable().optional(),
    authors: z.array(z.string().min(1)).optional(),
  })
  .strict();

export function buildServer(opts: ServerOptions): FastifyInstance {
  const { db, userDataDir, token, rendererDir } = opts;
  const app = Fastify({ logger: false });

  // Serve the single-page vanilla UI (index.html/app.js/styles.css).
  app.register(fastifyStatic, { root: rendererDir, prefix: '/' });

  // Bearer-token auth on every /api/* route. The static UI is intentionally
  // left reachable without the token (it's static assets, no data), but it
  // cannot *do* anything without the token, which it only ever gets from
  // the preload bridge, in-process, never over the network.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return;
    const header = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    const ok =
      header.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    if (!ok) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // ── import ──────────────────────────────────────────────────────────
  app.post('/api/books/import', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });

    const srcPath = parsed.data.path;
    if (!fs.existsSync(srcPath)) return reply.code(400).send({ error: 'file_not_found' });

    const format = formatFromExtension(srcPath);
    if (!format) return reply.code(415).send({ error: 'unsupported_extension' });

    const buf = fs.readFileSync(srcPath);
    const magic = await validateMagicBytes(buf, format);
    if (!magic.ok) {
      // Rejected: content does not match the extension-implied format.
      // A server edition would write this to audit_log; here we at least
      // surface it to the caller and log it locally.
      app.log.warn({ srcPath, format, magic }, 'import rejected: magic-byte mismatch');
      return reply.code(415).send({ error: 'magic_byte_mismatch', reason: magic.reason });
    }

    let metadata: ParsedBookMetadata;
    try {
      metadata = parseMetadataFor(format, srcPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.warn({ srcPath, format, message }, 'import rejected: unsafe or unparseable archive');
      return reply.code(422).send({ error: 'unsafe_or_invalid_archive', reason: message });
    }

    const sha256 = sha256Of(buf);
    const title = metadata.title?.trim() || path.basename(srcPath, path.extname(srcPath));
    const duplicates = findDuplicates(db, sha256, title, metadata.authors);
    const exactDuplicate = duplicates.find((d) => d.reason === 'sha256');
    if (exactDuplicate) {
      return reply.code(200).send({ duplicate: true, existingBookId: exactDuplicate.bookId, duplicates });
    }

    const mediaType =
      format === 'epub'
        ? 'application/epub+zip'
        : format === 'pdf'
          ? 'application/pdf'
          : format === 'cbz'
            ? 'application/vnd.comicbook+zip'
            : 'application/octet-stream';
    const blobSha = storeBlob(db, userDataDir, buf, mediaType);

    let coverSha256: string | null = null;
    if (metadata.coverBuffer && metadata.coverBuffer.length > 0) {
      coverSha256 = storeBlob(db, userDataDir, metadata.coverBuffer, 'image/*');
    }

    const bookId = nextId();
    const now = new Date().toISOString();
    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO books (id, title, description, language, publisher, published_on, cover_sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bookId,
        title,
        metadata.description ?? null,
        metadata.language ?? null,
        metadata.publisher ?? null,
        metadata.publishedOn ?? null,
        coverSha256,
        now,
        now,
      );

      let position = 0;
      for (const authorName of metadata.authors) {
        const authorId = findOrCreateAuthor(db, authorName);
        db.prepare(
          `INSERT OR IGNORE INTO book_authors (book_id, author_id, role, position) VALUES (?, ?, 'author', ?)`,
        ).run(bookId, authorId, position++);
      }

      for (const ident of metadata.identifiers) {
        db.prepare(
          `INSERT OR IGNORE INTO book_identifiers (book_id, scheme, value) VALUES (?, ?, ?)`,
        ).run(bookId, ident.scheme, ident.value);
      }

      db.prepare(
        `INSERT INTO book_files (id, book_id, blob_sha256, format, original_filename, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(nextId(), bookId, blobSha, format, path.basename(srcPath), now);
    });
    insert();

    const fuzzyDuplicates = duplicates.filter((d) => d.reason !== 'sha256');
    return reply.code(201).send({ bookId, duplicate: false, possibleDuplicates: fuzzyDuplicates });
  });

  // ── list / search ───────────────────────────────────────────────────
  app.get('/api/books', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string | undefined>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));
    const sort = query.sort === 'added' ? 'created_at' : query.sort === 'author' ? 'author_name' : 'sort_title';
    const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
    const q = (query.q ?? '').trim();

    const baseSelect = `
      SELECT b.*, (
        SELECT group_concat(a.name, ', ') FROM book_authors ba
        JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id
      ) AS author_name
      FROM books b`;

    let rows: (BookRow & { author_name: string | null })[];
    let total: number;

    if (q) {
      const ftsQuery = q
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => `"${term.replace(/"/g, '""')}"*`)
        .join(' ');
      total = (
        db.prepare(
          `SELECT count(*) AS c FROM books_fts JOIN books b ON b.id = books_fts.book_id
           WHERE books_fts MATCH ? AND b.deleted_at IS NULL`,
        ).get(ftsQuery) as { c: number }
      ).c;
      rows = db
        .prepare(
          `${baseSelect}
           JOIN books_fts ON books_fts.book_id = b.id
           WHERE books_fts MATCH ? AND b.deleted_at IS NULL
           ORDER BY ${sort === 'author_name' ? 'author_name' : `b.${sort}`} ${dir}
           LIMIT ? OFFSET ?`,
        )
        .all(ftsQuery, pageSize, (page - 1) * pageSize) as (BookRow & { author_name: string | null })[];
    } else {
      total = (db.prepare('SELECT count(*) AS c FROM books WHERE deleted_at IS NULL').get() as { c: number }).c;
      rows = db
        .prepare(
          `${baseSelect}
           WHERE b.deleted_at IS NULL
           ORDER BY ${sort === 'author_name' ? 'author_name' : `b.${sort}`} ${dir}
           LIMIT ? OFFSET ?`,
        )
        .all(pageSize, (page - 1) * pageSize) as (BookRow & { author_name: string | null })[];
    }

    return reply.send({ page, pageSize, total, books: rows });
  });

  // ── single book ─────────────────────────────────────────────────────
  app.get('/api/books/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL').get(id) as
      | BookRow
      | undefined;
    if (!book) return reply.code(404).send({ error: 'not_found' });

    const authors = db
      .prepare(
        `SELECT a.id, a.name, ba.role FROM book_authors ba JOIN authors a ON a.id = ba.author_id
         WHERE ba.book_id = ? ORDER BY ba.position`,
      )
      .all(id);
    const files = db.prepare('SELECT * FROM book_files WHERE book_id = ?').all(id) as BookFileRow[];
    const progress = db.prepare('SELECT * FROM reading_progress WHERE book_id = ?').get(id);

    return reply.send({ ...book, authors, files, progress: progress ?? null });
  });

  app.patch('/api/books/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const existing = db.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const parsed = patchBookSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', details: parsed.error.issues });
    const body = parsed.data;

    const columnMap: Record<string, string> = {
      title: 'title',
      sortTitle: 'sort_title',
      subtitle: 'subtitle',
      description: 'description',
      language: 'language',
      publisher: 'publisher',
      publishedOn: 'published_on',
      pageCount: 'page_count',
      seriesIndex: 'series_index',
      kind: 'kind',
      readingDirection: 'reading_direction',
      contentRating: 'content_rating',
    };

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columnMap)) {
      if (key in body) {
        sets.push(`${column} = ?`);
        values.push((body as Record<string, unknown>)[key]);
      }
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);
      db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    if (body.authors) {
      const authors = body.authors;
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM book_authors WHERE book_id = ?').run(id);
        authors.forEach((name, i) => {
          const authorId = findOrCreateAuthor(db, name);
          db.prepare(
            `INSERT OR IGNORE INTO book_authors (book_id, author_id, role, position) VALUES (?, ?, 'author', ?)`,
          ).run(id, authorId, i);
        });
      });
      tx();
    }

    const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
    return reply.send(updated);
  });

  app.delete('/api/books/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const result = db
      .prepare('UPDATE books SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(new Date().toISOString(), id);
    if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // ── cover override ──────────────────────────────────────────────────
  app.post('/api/books/:id/cover', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare('SELECT id FROM books WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!book) return reply.code(404).send({ error: 'not_found' });

    const parsed = coverSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    if (!fs.existsSync(parsed.data.path)) return reply.code(400).send({ error: 'file_not_found' });

    const buf = fs.readFileSync(parsed.data.path);
    const ext = path.extname(parsed.data.path).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return reply.code(415).send({ error: 'unsupported_image_type' });
    }
    const sha256 = storeBlob(db, userDataDir, buf, `image/${ext.replace('.', '')}`);
    db.prepare('UPDATE books SET cover_sha256 = ?, updated_at = ? WHERE id = ?').run(
      sha256,
      new Date().toISOString(),
      id,
    );
    return reply.send({ cover_sha256: sha256 });
  });

  app.get('/api/books/:id/cover', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare('SELECT cover_sha256 FROM books WHERE id = ?').get(id) as
      | { cover_sha256: string | null }
      | undefined;
    if (!book?.cover_sha256) return reply.code(404).send({ error: 'no_cover' });
    const blob = db.prepare('SELECT storage_path, media_type FROM blobs WHERE sha256 = ?').get(
      book.cover_sha256,
    ) as { storage_path: string; media_type: string } | undefined;
    if (!blob || !fs.existsSync(blob.storage_path)) return reply.code(404).send({ error: 'no_cover' });
    reply.header('Content-Type', blob.media_type);
    return reply.send(fs.createReadStream(blob.storage_path));
  });

  // ── file streaming (range-aware, for the reader) ───────────────────
  app.get('/api/books/:id/file', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { format?: string };
    const file = (
      query.format
        ? db.prepare('SELECT * FROM book_files WHERE book_id = ? AND format = ?').get(id, query.format)
        : db.prepare('SELECT * FROM book_files WHERE book_id = ? ORDER BY created_at LIMIT 1').get(id)
    ) as BookFileRow | undefined;
    if (!file) return reply.code(404).send({ error: 'not_found' });

    const blob = db.prepare('SELECT storage_path, media_type, size_bytes FROM blobs WHERE sha256 = ?').get(
      file.blob_sha256,
    ) as { storage_path: string; media_type: string; size_bytes: number } | undefined;
    if (!blob || !fs.existsSync(blob.storage_path)) return reply.code(404).send({ error: 'file_missing' });

    const range = req.headers.range;
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', blob.media_type);
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const start = match ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : blob.size_bytes - 1;
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${blob.size_bytes}`);
      reply.header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(blob.storage_path, { start, end }));
    }
    reply.header('Content-Length', blob.size_bytes);
    return reply.send(fs.createReadStream(blob.storage_path));
  });

  // ── duplicate lookup (used by the UI before/independent of import) ──
  app.get('/api/books/duplicates', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { title?: string; author?: string; sha256?: string };
    const matches = findDuplicates(db, query.sha256 ?? null, query.title ?? '', query.author ? [query.author] : []);
    return reply.send({ matches });
  });

  return app;
}
