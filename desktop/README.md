# Shelfmark Desktop Edition

A local, single-user, single-PC e-book library manager. No Docker, no
Postgres, no reverse proxy, no accounts — just an Electron app with an
embedded API and a SQLite file in your OS user-data directory.

This scaffold is the desktop sibling of the [server edition](../DESIGN.md):
same API-first shape, same file-handling security posture (imported ebooks
are still untrusted input, wherever the app runs), radically simpler
operations story.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron app (one process tree, one machine)                    │
│                                                                   │
│  ┌───────────────┐   contextBridge    ┌───────────────────────┐ │
│  │  main process │ ── (apiUrl,token) ─▶│  BrowserWindow         │ │
│  │  index.ts     │    via preload      │  contextIsolation: on  │ │
│  │               │                     │  nodeIntegration: off  │ │
│  │  - random     │                     │  sandbox: true         │ │
│  │    loopback   │      loads          │                        │ │
│  │    port       │ ───http://127.0.0.1:PORT/ ──▶ index.html      │ │
│  │  - per-launch │                     │  + app.js (vanilla UI) │ │
│  │    bearer     │◀── fetch() with ────┤  + styles.css          │ │
│  │    token      │    Authorization:                            │ │
│  │               │    Bearer <token>   └───────────────────────┘ │
│  └───────┬───────┘                                                │
│          │ in-process                                             │
│          ▼                                                        │
│  ┌───────────────┐        ┌──────────────────────────────────┐  │
│  │ Fastify API   │──────▶│ better-sqlite3 (WAL)               │  │
│  │ server.ts     │        │ {userData}/library/shelfmark.sqlite3│  │
│  │ /api/books... │        └──────────────────────────────────┘  │
│  └───────┬───────┘                                                │
│          │ content-addressed blobs                                │
│          ▼                                                        │
│  {userData}/library/blobs/<sha256[0:2]>/<sha256>                  │
└─────────────────────────────────────────────────────────────────┘
```

`{userData}` is Electron's per-OS app-data directory (`app.getPath('userData')`
— e.g. `%APPDATA%\Shelfmark`, `~/Library/Application Support/Shelfmark`,
`~/.config/Shelfmark`).

## Dev

```bash
cd desktop
npm install        # or: bun install
npm run typecheck  # tsc --noEmit over src/main + src/preload
npm run build       # tsc -> dist/, then copies src/renderer -> dist/renderer
npm run dev         # build + launch electron .
```

## Package

```bash
npm run dist        # electron-builder, using electron-builder.yml
```

Produces an NSIS installer on Windows, a `.dmg` on macOS, and an AppImage
on Linux, under `release/`. Not run as part of this scaffold — config only.

## What's actually implemented vs. TODO

Implemented and working end-to-end: import (magic-byte validated, SHA-256
content-addressed, EPUB/CBZ/FB2 metadata extraction, duplicate detection),
library list with FTS5 search + pagination + sort, book detail/edit/delete,
cover override, range-request file streaming (so a `<video>`/PDF-viewer-style
client can seek), a plain HTML/JS/CSS UI with drag-and-drop import, and an
**in-app EPUB reader** (see below).

Explicitly **not** implemented (marked `TODO` in code/UI):
- In-app reading for non-EPUB formats (PDF via PDF.js, CBx comic viewer).
  Their "Open raw file" button still just streams the file to a new window.
- PDF/MOBI/AZW3/CBR/CB7 metadata extraction (title falls back to filename).
  EPUB, CBZ (`ComicInfo.xml`), and FB2 are fully parsed.
- The optional app-lock (password-gate the whole app on launch): the DB
  schema and the `argon2` dependency are in place (`settings` table), but
  there's no lock-screen UI or enforcement yet.
- Format conversion (would need a bundled Calibre-equivalent; the server
  edition's `worker` container doesn't have a desktop analogue here).

## In-app EPUB reader

EPUB 3 content documents can legally embed JavaScript, and a downloaded
e-book is attacker-controlled input even in a single-user desktop app. The
reader therefore uses a **two-window model**:

1. **Library window** (existing, sandboxed) — never renders book markup.
   Its "Read" button sends `shelfmark:open-reader` over IPC.
2. **Reader window** — a separate `BrowserWindow`, hardened identically
   (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
   same strict CSP), loading `reader.html` from the same loopback origin.
   It gets the API URL + bearer token through the *same* preload bridge
   (`getConfig()`); only the non-secret book id travels in the query string.
   Book content cannot touch the library window's DOM or anything Node.

**All book HTML is sanitized server-side** before it reaches the reader
window (`src/main/sanitize.ts`, invoked by `GET /api/books/:id/read/:spineIndex`
in `server.ts`): `<script>`, `<style>`, `<iframe>`/`<object>`/`<embed>`,
form controls, `<svg>`/`<math>` and other active elements are dropped with
their contents; every `on*` handler and inline `style` attribute is
removed; `javascript:`/`vbscript:`/`data:`/`file:` URLs are rejected;
internal `<img src>` is rewritten to the media endpoint
(`GET /api/books/:id/media/<zip-entry-path>`, itself zip-slip-guarded) and
internal cross-chapter `<a href>` becomes a `data-href` the reader turns
into spine navigation. Since `<img>` cannot send the bearer token, the
reader fetches media via `fetch()` + `Authorization` and swaps in `blob:`
URLs.

Features: spine-ordered chapters with next/prev + keyboard navigation
(←/→ chapters, PgUp/PgDn paging, smooth in-chapter scrolling), typography
controls (serif/sans/dyslexia-friendly font stacks, size, line height,
margins — persisted globally and per-book), light/dark/sepia themes,
table of contents from the EPUB 3 nav document or NCX (new `readEpubStructure`
in `epub.ts`), reading progress (`GET`/`PUT /api/books/:id/progress`, saved
on a 5 s interval and on exit, restored on open), and bookmarks
(`bookmarks` table + `GET`/`POST`/`DELETE /api/books/:id/bookmarks…`).

Verification: `test/sanitize.test.ts` builds a synthetic hostile EPUB in
/tmp and asserts the sanitizer strips scripts/handlers/`javascript:` URLs
while rewriting images to the media endpoint — run it with
`bun test/sanitize.test.ts` from `desktop/`.

## Desktop vs. Server edition

| Aspect | Server edition | Desktop edition |
|---|---|---|
| Users | Multi-user, roles, `library_members` | **One user.** No accounts, no roles. |
| Auth | argon2id + sessions + CSRF + optional TOTP/WebAuthn/OIDC | **Optional local app-lock only** (schema ready, UI TODO). No network auth needed — nothing but loopback is exposed. |
| Transport | Caddy/TLS, public hostname, CSP at the proxy | **127.0.0.1 only**, random ephemeral port per launch, never advertised. CSP set directly by the main process on the `BrowserWindow`'s session. |
| API access control | Session cookies + CSRF tokens | **Per-launch random bearer token**, handed to the renderer only via `contextBridge` (never in the URL/history/logs), checked with `crypto.timingSafeEqual`. |
| Database | PostgreSQL 16, row-level security | **SQLite (better-sqlite3)**, WAL mode, FTS5 instead of `tsvector`/GIN. No RLS needed — one user. |
| Storage | Docker volume, S3-ready interface | OS user-data directory; same content-addressed `blobs/xx/yyyy…` layout. |
| Conversion | Dedicated network-isolated `worker` container running Calibre | **Not implemented.** No bundled Calibre; out of scope for this scaffold. |
| Metadata enrichment | `enrich` service with the only internet egress (Open Library/Google Books) | **Not implemented.** Desktop app currently only reads metadata embedded in the file itself; it does not call out to the internet at all — arguably a feature for a "self-hosted, private" tool. |
| Malware scanning | Optional ClamAV sidecar | **Not implemented.** No sidecar process makes sense for a single-PC app; magic-byte + archive-safety checks are the remaining line of defense. |
| OPDS (KOReader/Moon+ etc.) | OPDS 1.2 + 2.0 feeds | **Not implemented.** Nothing to sync to on a single machine; could be added later bound to the loopback API for LAN-only use, deliberately out of scope now. |
| Multi-device sync / lending / analytics | v1+/later roadmap items, all inherently multi-user | **Not applicable.** |
| Reading progress / annotations | Per-`user_id`, row-security scoped | **Un-keyed** (one row per book/annotation) — there is no other user to isolate from. |
| Audit log | Append-only `audit_log` table | **Not implemented** — no privilege boundary to audit. Import rejections are logged to the local app log only. |

### Desktop-specific security notes

Even with no network exposure and no other users, a downloaded/copied
e-book file is still attacker-controlled input, so the file-handling
guards from the server edition are kept, not relaxed:

- **Magic-byte validation** (`src/main/magic.ts`): the claimed format (from
  the file extension) must match the actual content family detected from
  the file's bytes. A `.epub` that's really a `PE`/`ELF` binary, or any
  other extension/content mismatch, is rejected before it ever touches the
  zip/XML parsers.
- **Zip-slip guard** (`src/main/epub.ts`): every archive entry path is
  checked for `..` traversal, absolute paths, and drive letters before any
  entry is read.
- **Zip-bomb guard**: entry-count cap, total-uncompressed-size cap, and a
  per-entry compression-ratio cap, checked from the central directory
  *before* decompressing anything.
- **XXE**: OPF/ComicInfo/FB2 XML is parsed with `fast-xml-parser`, a pure
  tokenizer with no DTD/external-entity resolution and no network access —
  XXE is structurally impossible here, not merely toggled off — and entity
  substitution is additionally disabled (`processEntities: false`).
- **Content-addressed storage**: imported files are written under a path
  derived from their own SHA-256, never from the original filename, so
  path traversal at the storage layer is impossible by construction.
- **Random loopback port + per-launch bearer token**: even though nothing
  else on the machine is expected to be malicious, a second local process
  (or a compromised, unrelated Electron app) cannot discover a fixed port
  and just start calling the API; both the port and the token change every
  launch and the token is never written to disk, a URL, or a log.
- **Renderer hardening**: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, and a strict `Content-Security-Policy` restricting
  `connect-src` to the app's own loopback origin — in *both* the library
  window and the separate reader window. On top of that, book HTML never
  reaches any window unsanitized (see "In-app EPUB reader" below), so even
  a "malicious EPUB" ships no scripts, event handlers, or active content
  into the renderer in the first place.

### Simplifications made in this scaffold

- The EPUB reader renders sanitized HTML with its own CSS themes rather
  than a full epub.js-style renderer: publisher stylesheets are dropped in
  favor of uniform reader-controlled typography, and fixed-layout EPUBs
  (and CBx comics) are not covered — they fall back to raw-file streaming.
- Only EPUB, CBZ, and FB2 get real metadata extraction; PDF/MOBI/AZW3/CBR/
  CB7 import and store correctly but fall back to filename-as-title.
- No conversion pipeline, no metadata enrichment, no OPDS — see the table
  above.
- Import takes a **file path** chosen via the native file picker or
  drag-and-drop (Electron gives dropped `File` objects a real `path`),
  not an HTTP multipart upload — the app already has direct filesystem
  access, so a multipart round-trip through its own local server would be
  pure overhead with no security benefit on a single-PC app.
