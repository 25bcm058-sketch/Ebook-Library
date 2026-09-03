/**
 * db.ts — SQLite storage for Shelfmark Desktop.
 *
 * Desktop-adapted subset of the server edition's schema.sql. Dropped
 * entirely: users/roles/sessions/api_tokens/oidc/webauthn/audit_log/loans/
 * holds/library_members (there is exactly one user: whoever is sitting at
 * the PC). Kept: the bibliographic model, per-book reading progress,
 * collections, and a `settings` table that holds the *optional* app-lock
 * password hash + auto-lock timeout, mirroring the server's TOTP-secret
 * pattern (a secret, encrypted/hashed, sitting next to the data it guards)
 * without needing a whole users table for it.
 *
 * `blobs` are content-addressed on disk (see server.ts `blobPathFor`); this
 * table is just bookkeeping (size/media type/path) so we can dedupe by
 * SHA-256 without re-hashing the whole library on every import.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export type Db = Database.Database;

export function openDatabase(userDataDir: string): Db {
  const dir = path.join(userDataDir, 'library');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'shelfmark.sqlite3');
  const db = new Database(dbPath);

  // WAL: readers (the reader window streaming a file) don't block writers
  // (an import running in the background), which matters even single-user
  // once we add background jobs (e.g. cover extraction).
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      sha256       TEXT PRIMARY KEY,
      size_bytes   INTEGER NOT NULL,
      media_type   TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS authors (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL UNIQUE,
      sort_name TEXT
    );

    CREATE TABLE IF NOT EXISTS series (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL UNIQUE,
      sort_name TEXT
    );

    CREATE TABLE IF NOT EXISTS books (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      sort_title        TEXT,
      subtitle          TEXT,
      description       TEXT,
      language          TEXT,
      publisher         TEXT,
      published_on      TEXT,
      page_count        INTEGER,
      series_id         TEXT REFERENCES series(id) ON DELETE SET NULL,
      series_index      REAL,
      kind              TEXT NOT NULL DEFAULT 'book'
                          CHECK (kind IN ('book','comic','manga','magazine')),
      reading_direction TEXT NOT NULL DEFAULT 'ltr'
                          CHECK (reading_direction IN ('ltr','rtl','vertical')),
      content_rating    INTEGER,
      cover_sha256      TEXT REFERENCES blobs(sha256) ON DELETE SET NULL,
      drm_protected     INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS books_series_idx ON books (series_id, series_index);

    -- One row per format, mirrors server's UNIQUE(book_id, format).
    CREATE TABLE IF NOT EXISTS book_files (
      id                TEXT PRIMARY KEY,
      book_id           TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      blob_sha256       TEXT NOT NULL REFERENCES blobs(sha256),
      format            TEXT NOT NULL CHECK (format IN
                          ('epub','pdf','mobi','azw3','cbz','cbr','cb7','fb2','txt','images')),
      layout            TEXT CHECK (layout IN ('reflowable','fixed','images')),
      source            TEXT NOT NULL DEFAULT 'import'
                          CHECK (source IN ('import','conversion')),
      original_filename TEXT,
      page_count        INTEGER,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (book_id, format)
    );

    CREATE TABLE IF NOT EXISTS book_authors (
      book_id   TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE RESTRICT,
      role      TEXT NOT NULL DEFAULT 'author'
                  CHECK (role IN ('author','illustrator','translator','editor','narrator')),
      position  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (book_id, author_id, role)
    );

    CREATE TABLE IF NOT EXISTS book_identifiers (
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      scheme  TEXT NOT NULL,
      value   TEXT NOT NULL,
      PRIMARY KEY (book_id, scheme)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'tag' CHECK (kind IN ('tag','genre','shelf')),
      UNIQUE (name, kind)
    );

    CREATE TABLE IF NOT EXISTS book_tags (
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (book_id, tag_id)
    );

    -- Manual or smart (rules JSON) shelves. Single-user, so no owner/visibility.
    CREATE TABLE IF NOT EXISTS collections (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      is_smart    INTEGER NOT NULL DEFAULT 0,
      rules       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      position      INTEGER,
      added_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (collection_id, book_id)
    );

    -- Single user, so no user_id column — one row per book (+ optional file).
    -- For the EPUB reader, locator holds a JSON object of the form:
    --   {"spineIndex": int, "scrollFraction": 0..1}
    CREATE TABLE IF NOT EXISTS reading_progress (
      book_id    TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      file_id    TEXT REFERENCES book_files(id) ON DELETE SET NULL,
      status     TEXT NOT NULL DEFAULT 'unread'
                   CHECK (status IN ('unread','reading','finished','abandoned')),
      locator    TEXT,
      percent    REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- EPUB reader bookmarks: a position is (spine_index, scroll_fraction),
    -- matching the locator JSON shape used by reading_progress.
    CREATE TABLE IF NOT EXISTS bookmarks (
      id              TEXT PRIMARY KEY,
      book_id         TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      spine_index     INTEGER NOT NULL,
      scroll_fraction REAL NOT NULL DEFAULT 0,
      label           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS bookmarks_book_idx ON bookmarks (book_id);

    -- Key/value app settings: optional app-lock password (argon2id hash),
    -- auto-lock timeout, last-used window bounds, etc.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Full-text search over title/description/author names. Not "external
    -- content" (content='books') to keep the sync triggers simple and
    -- obviously correct: we own every write to this table ourselves below.
    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      book_id UNINDEXED,
      title,
      description,
      authors
    );

    CREATE TRIGGER IF NOT EXISTS books_fts_ai AFTER INSERT ON books BEGIN
      INSERT INTO books_fts (book_id, title, description, authors)
      VALUES (new.id, new.title, coalesce(new.description, ''), '');
    END;

    CREATE TRIGGER IF NOT EXISTS books_fts_au AFTER UPDATE OF title, description ON books BEGIN
      UPDATE books_fts SET title = new.title, description = coalesce(new.description, '')
      WHERE book_id = new.id;
    END;

    CREATE TRIGGER IF NOT EXISTS books_fts_ad AFTER DELETE ON books BEGIN
      DELETE FROM books_fts WHERE book_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS book_authors_fts_ai AFTER INSERT ON book_authors BEGIN
      UPDATE books_fts SET authors = (
        SELECT coalesce(group_concat(a.name, ' '), '')
        FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = new.book_id
      ) WHERE book_id = new.book_id;
    END;

    CREATE TRIGGER IF NOT EXISTS book_authors_fts_ad AFTER DELETE ON book_authors BEGIN
      UPDATE books_fts SET authors = (
        SELECT coalesce(group_concat(a.name, ' '), '')
        FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = old.book_id
      ) WHERE book_id = old.book_id;
    END;

    CREATE TRIGGER IF NOT EXISTS authors_fts_au AFTER UPDATE OF name ON authors BEGIN
      UPDATE books_fts SET authors = (
        SELECT coalesce(group_concat(a.name, ' '), '')
        FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = books_fts.book_id
      )
      WHERE book_id IN (SELECT book_id FROM book_authors WHERE author_id = new.id);
    END;
  `);
}

export function nextId(): string {
  return randomUUID();
}
