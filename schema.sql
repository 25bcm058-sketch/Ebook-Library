-- ═══════════════════════════════════════════════════════════════════════════
-- Shelfmark — self-hosted e-book library manager
-- PostgreSQL 16 schema, v0.1 (covers MVP + v1 tables)
-- Conventions: UUID PKs, TIMESTAMPTZ everywhere, soft-delete only where a
-- user could regret a deletion (books). App sets updated_at (no triggers yet).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive usernames/emails/tags
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy title/author duplicate detection

-- ─────────────────────────────────────────────────────── identity & access ──

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username           CITEXT NOT NULL UNIQUE,
  email              CITEXT UNIQUE,
  password_hash      TEXT,                    -- argon2id PHC string; NULL = SSO-only account
  role               TEXT NOT NULL DEFAULT 'user'
                       CHECK (role IN ('admin','user','guest','kid')),
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','disabled','pending')),
  totp_required      BOOLEAN NOT NULL DEFAULT false,  -- admin-enforced 2FA
  quota_bytes        BIGINT,                  -- NULL = unlimited
  content_rating_max SMALLINT,                -- kid profiles: hide items rated above this
  locale             TEXT NOT NULL DEFAULT 'en',
  prefs              JSONB NOT NULL DEFAULT '{}'::jsonb,  -- reader theme, fonts, etc.
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE TABLE user_totp (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc           BYTEA NOT NULL,         -- AES-256-GCM under SHELFMARK_MASTER_KEY
  confirmed_at         TIMESTAMPTZ,
  recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}'  -- single-use, hashed
);

CREATE TABLE webauthn_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id BYTEA NOT NULL UNIQUE,
  public_key    BYTEA NOT NULL,
  sign_count    BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[],
  nickname      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE TABLE oidc_identities (
  provider TEXT NOT NULL,
  subject  TEXT NOT NULL,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   BYTEA NOT NULL UNIQUE,          -- SHA-256 of opaque cookie token
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ip           INET,
  user_agent   TEXT,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE api_tokens (                      -- OPDS clients, scripts, integrations
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   BYTEA NOT NULL UNIQUE,
  scopes       TEXT[] NOT NULL DEFAULT '{opds}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────── libraries & membership ──

CREATE TABLE libraries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','shared')),
  owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE library_members (
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'reader'
               CHECK (role IN ('manager','contributor','reader')),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, user_id)
);

-- ───────────────────────────────────────────────── bibliographic entities ──

CREATE TABLE authors (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL UNIQUE,
  sort_name TEXT
);
CREATE INDEX authors_name_trgm ON authors USING GIN (name gin_trgm_ops);

CREATE TABLE publishers (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE series (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_name  TEXT,
  UNIQUE (library_id, name)
);

-- Content-addressed blob store: one row per unique file on disk.
-- Identical uploads dedupe for free; integrity is verifiable by re-hashing.
CREATE TABLE blobs (
  sha256       CHAR(64) PRIMARY KEY,
  size_bytes   BIGINT NOT NULL,
  media_type   TEXT NOT NULL,
  storage_path TEXT NOT NULL,               -- e.g. blobs/3f/a1/3fa1…
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE books (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id        UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  sort_title        TEXT,
  subtitle          TEXT,
  description       TEXT,
  language          TEXT,                    -- BCP-47
  publisher_id      UUID REFERENCES publishers(id) ON DELETE SET NULL,
  published_on      DATE,
  page_count        INTEGER,
  series_id         UUID REFERENCES series(id) ON DELETE SET NULL,
  series_index      NUMERIC(8,2),            -- supports 1.5-style interstitials
  kind              TEXT NOT NULL DEFAULT 'book'
                      CHECK (kind IN ('book','comic','manga','magazine')),
  reading_direction TEXT NOT NULL DEFAULT 'ltr'
                      CHECK (reading_direction IN ('ltr','rtl','vertical')),
  content_rating    SMALLINT,                -- 0 = everyone … 18 = adult
  cover_sha256      CHAR(64) REFERENCES blobs(sha256),
  drm_protected     BOOLEAN NOT NULL DEFAULT false,  -- flagged, never circumvented
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  search            TSVECTOR GENERATED ALWAYS AS (
                      setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                      setweight(to_tsvector('simple', coalesce(subtitle,'')), 'B') ||
                      setweight(to_tsvector('simple', coalesce(description,'')), 'C')
                    ) STORED
);
CREATE INDEX books_library_idx ON books (library_id) WHERE deleted_at IS NULL;
CREATE INDEX books_search_idx  ON books USING GIN (search);
CREATE INDEX books_title_trgm  ON books USING GIN (title gin_trgm_ops);
CREATE INDEX books_series_idx  ON books (series_id, series_index);

-- A book can hold several formats (EPUB + AZW3 + …), one file per format.
-- Trade-off: disallows two EPUB "editions" under one book; keeps UX simple
-- (Calibre model). Metadata-only books (no files) are allowed → CSV imports.
CREATE TABLE book_files (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id           UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  blob_sha256       CHAR(64) NOT NULL REFERENCES blobs(sha256),
  format            TEXT NOT NULL CHECK (format IN
                      ('epub','pdf','mobi','azw3','cbz','cbr','cb7','fb2','txt','images')),
  layout            TEXT CHECK (layout IN ('reflowable','fixed','images')),
  source            TEXT NOT NULL DEFAULT 'upload'
                      CHECK (source IN ('upload','conversion','watch','import')),
  original_filename TEXT,
  page_count        INTEGER,
  uploaded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  scan_status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (scan_status IN ('pending','clean','flagged','skipped')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (book_id, format)
);

CREATE TABLE book_authors (
  book_id   UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES authors(id) ON DELETE RESTRICT,
  role      TEXT NOT NULL DEFAULT 'author'
              CHECK (role IN ('author','illustrator','translator','editor','narrator')),
  position  SMALLINT NOT NULL DEFAULT 0,     -- display order
  PRIMARY KEY (book_id, author_id, role)
);

CREATE TABLE book_identifiers (
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scheme  TEXT NOT NULL,   -- 'isbn13','isbn10','openlibrary','googlebooks','asin','uri'
  value   TEXT NOT NULL,
  PRIMARY KEY (book_id, scheme)
);
CREATE INDEX book_identifiers_lookup ON book_identifiers (scheme, value);

CREATE TABLE tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name       CITEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'tag' CHECK (kind IN ('tag','genre','shelf')),
  UNIQUE (library_id, name, kind)
);

CREATE TABLE book_tags (
  book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);

-- Typed user-defined fields ("My rating", "Signed copy", "Location"…).
CREATE TABLE custom_fields (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  field_type TEXT NOT NULL
               CHECK (field_type IN ('text','number','bool','date','enum','rating')),
  options    JSONB,                          -- enum choices, min/max, etc.
  UNIQUE (library_id, name)
);

CREATE TABLE custom_field_values (
  book_id  UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value    JSONB NOT NULL,
  PRIMARY KEY (book_id, field_id)
);

-- ──────────────────────────────────────────────── collections & discovery ──

CREATE TABLE collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id  UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  owner_id    UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = library-wide
  name        TEXT NOT NULL,
  description TEXT,
  is_smart    BOOLEAN NOT NULL DEFAULT false,
  rules       JSONB,                         -- smart-collection criteria AST
  visibility  TEXT NOT NULL DEFAULT 'private'
                CHECK (visibility IN ('private','library')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE collection_items (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  book_id       UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position      INTEGER,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, book_id)
);

-- ───────────────────────────────── per-user reading state (PRIVATE by design) ──
-- These tables are keyed by user and are never joined into another user's
-- responses. Admin analytics may read only pre-aggregated, anonymous counts.

CREATE TABLE reading_progress (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  file_id    UUID REFERENCES book_files(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'reading'
               CHECK (status IN ('unread','reading','finished','abandoned')),
  locator    JSONB NOT NULL,   -- {"type":"cfi","value":…} | {"type":"page","value":41}
  percent    NUMERIC(5,2) NOT NULL DEFAULT 0,
  device     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE annotations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  file_id    UUID REFERENCES book_files(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('bookmark','highlight','note')),
  locator    JSONB NOT NULL,
  excerpt    TEXT,              -- quoted text; aids re-anchoring after conversion
  note       TEXT,
  color      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX annotations_user_book_idx ON annotations (user_id, book_id);

CREATE TABLE reading_events (   -- optional analytics (later phase); per-user private
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at   TIMESTAMPTZ NOT NULL,
  pct_start  NUMERIC(5,2),
  pct_end    NUMERIC(5,2)
);
CREATE INDEX reading_events_user_idx ON reading_events (user_id, started_at);

-- ─────────────────────────────────────────────────── lending & circulation ──

CREATE TABLE loans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id        UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  borrower_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  checked_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at         TIMESTAMPTZ,
  returned_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX loans_one_active ON loans (book_id) WHERE returned_at IS NULL;

CREATE TABLE holds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id      UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ,
  canceled_at  TIMESTAMPTZ,
  UNIQUE (book_id, user_id)
);

-- ───────────────────────────────────────────────────── jobs & audit trail ──

CREATE TABLE jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN
                ('ingest','convert','metadata_fetch','scan_folder','thumbnail',
                 'malware_scan','export','send_to_device')),
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','canceled')),
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress    SMALLINT NOT NULL DEFAULT 0,   -- 0–100
  error       TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX jobs_status_idx ON jobs (status, created_at);

-- Append-only. Security-relevant events only; never file contents.
-- actor_id has no FK on purpose: audit rows outlive deleted accounts.
CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    UUID,
  actor_ip    INET,
  event       TEXT NOT NULL,   -- 'auth.login.ok','auth.login.fail','auth.lockout',
                               -- 'user.role.change','perm.change','book.delete',
                               -- 'upload.rejected','admin.settings.change',…
  target_type TEXT,
  target_id   TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_event_idx ON audit_log (event, at);

COMMIT;
