-- Smoke test: exercise FKs, generated tsvector, trgm, and core relations.
\set ON_ERROR_STOP on
BEGIN;

WITH u AS (
  INSERT INTO users (username, email, password_hash, role)
  VALUES ('admin', 'admin@example.com', '$argon2id$stub', 'admin') RETURNING id
), l AS (
  INSERT INTO libraries (name, kind, owner_id)
  SELECT 'Household', 'shared', id FROM u RETURNING id
), m AS (
  INSERT INTO library_members (library_id, user_id, role)
  SELECT l.id, u.id, 'manager' FROM l, u RETURNING library_id
), bl AS (
  INSERT INTO blobs (sha256, size_bytes, media_type, storage_path)
  VALUES (repeat('a', 64), 123456, 'application/epub+zip', 'blobs/aa/aa/stub')
  RETURNING sha256
), b AS (
  INSERT INTO books (library_id, title, subtitle, description, language, created_by)
  SELECT l.id, 'Dune', NULL, 'Melange, sandworms, prophecy.', 'en', u.id
  FROM l, u RETURNING id
), bf AS (
  INSERT INTO book_files (book_id, blob_sha256, format, layout, original_filename, uploaded_by)
  SELECT b.id, bl.sha256, 'epub', 'reflowable', 'dune.epub', u.id
  FROM b, bl, u RETURNING id
), a AS (
  INSERT INTO authors (name, sort_name) VALUES ('Frank Herbert', 'Herbert, Frank') RETURNING id
), ba AS (
  INSERT INTO book_authors (book_id, author_id) SELECT b.id, a.id FROM b, a RETURNING book_id
), ident AS (
  INSERT INTO book_identifiers (book_id, scheme, value)
  SELECT b.id, 'isbn13', '9780441172719' FROM b RETURNING book_id
), t AS (
  INSERT INTO tags (library_id, name, kind) SELECT l.id, 'sci-fi', 'genre' FROM l RETURNING id
), bt AS (
  INSERT INTO book_tags (book_id, tag_id) SELECT b.id, t.id FROM b, t RETURNING book_id
), c AS (
  INSERT INTO collections (library_id, owner_id, name, is_smart)
  SELECT l.id, u.id, 'To read', false FROM l, u RETURNING id
), ci AS (
  INSERT INTO collection_items (collection_id, book_id) SELECT c.id, b.id FROM c, b RETURNING book_id
), rp AS (
  INSERT INTO reading_progress (user_id, book_id, file_id, locator, percent)
  SELECT u.id, b.id, bf.id, '{"type":"cfi","value":"epubcfi(/6/4!/4/2)"}'::jsonb, 12.50
  FROM u, b, bf RETURNING user_id
), an AS (
  INSERT INTO annotations (user_id, book_id, file_id, kind, locator, excerpt, note)
  SELECT u.id, b.id, bf.id, 'highlight',
         '{"type":"cfi","value":"epubcfi(/6/4!/4/2,/1:0,/1:42)"}'::jsonb,
         'Fear is the mind-killer', 'iconic'
  FROM u, b, bf RETURNING id
)
SELECT 'inserts-ok' AS step;

-- Full-text search via generated column
SELECT title FROM books WHERE search @@ plainto_tsquery('simple', 'sandworms');

-- Fuzzy duplicate detection via pg_trgm
SELECT similarity('Dune', 'Dune Messiah') > 0.3 AS trgm_works;

-- Audit + job inserts
INSERT INTO audit_log (actor_ip, event, target_type, meta)
VALUES ('203.0.113.9', 'auth.login.fail', 'user', '{"reason":"bad_password"}'::jsonb);
INSERT INTO jobs (kind, payload) VALUES ('ingest', '{"upload":"stub"}'::jsonb);

ROLLBACK;
SELECT 'smoke-ok' AS result;
