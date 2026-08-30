# Shelfmark — Self-Hosted E-Book Library Manager
## Architecture, Roadmap, Data Model & Security Design

*Working title: **Shelfmark**. Design brief v1.0.*

---

## 1. Recommended Architecture

```
                          ┌────────────┐
   browsers / readers ───▶│   Caddy    │  TLS (Let's Encrypt), CSP/HSTS headers,
   KOReader / Moon+ (OPDS)│  (reverse  │  256 MiB body limit
                          │   proxy)   │
                          └─────┬──────┘
                                │ internal network (no internet route)
                ┌───────────────┼─────────────────────────────┐
                ▼               ▼                             ▼
          ┌──────────┐   ┌────────────┐   ┌──────────┐  ┌─────────┐
          │   web    │   │   worker   │   │  enrich  │  │  db     │
          │ Fastify  │   │ conversion │   │ metadata │  │ Postgres│
          │ + React  │   │ thumbnails │   │ fetcher  │  │   16    │
          │ PWA      │   │ (Calibre)  │   │ (has     │  └─────────┘
          └────┬─────┘   └─────┬──────┘   │ egress!) │   ┌─────────┐
               │               │          └──────────┘   │ clamav  │
               ▼               ▼                          └─────────┘
        blobs (content-addressed volume, read-only to web)
```

### Stack choices and trade-offs

| Layer | Choice | Why / trade-off |
|---|---|---|
| **Language** | TypeScript end-to-end (Bun runtime) | One language across API, workers, PWA; huge ecosystem (epub.js, react-pdf). Trade-off: less raw CPU perf than Go/Rust — irrelevant here; heavy lifting (conversion) is delegated to native tools in the worker. |
| **API** | Fastify 5 REST, OpenAPI-generated types | REST is simpler to secure/audit/cache than GraphQL and serves OPDS naturally. Trade-off: no client-driven field selection; acceptable for a fixed set of first-party clients. |
| **Database** | PostgreSQL 16 | One store for relational data + full-text (`tsvector`, generated column) + fuzzy dedupe (`pg_trgm`) + JSONB smart rules. Avoids Elasticsearch/Meilisearch as a *required* dependency for tens of thousands of books — Postgres handles that trivially. Pluggable search backend stays an option for 100k+ libraries. |
| **Frontend** | React + Vite + Tailwind + shadcn/ui, PWA (Workbox) | Fast iteration, mature a11y primitives, offline-capable. |
| **Reader** | epub.js for reflowable EPUB; react-pdf (PDF.js) for PDF; custom paged/scroller for CBx & image folders | epub.js already renders in an iframe and understands CFI locators, which we reuse as our annotation/anchor format. |
| **Job queue** | Postgres-backed queue (SKIP LOCKED), SSE for live progress | No Redis required for small deployments; `jobs` table doubles as the audit-friendly task history. Trade-off: slightly higher DB load vs. Redis — fine at this scale. |
| **File storage** | Local volume, **content-addressed by SHA-256** (`blobs/ab/cd/abcd…`) | Deduplication is free, integrity is verifiable (re-hash on backup/restore), and path traversal is *structurally impossible*: stored paths are derived from a hash we compute, never from user-supplied filenames. S3-compatible backend can be added later behind the same interface. |
| **Conversion** | Calibre's `ebook-convert` inside the dedicated `worker` container | Calibre is the most complete open-source converter (EPUB↔MOBI/AZW3/FB2…). It never runs in the web process. Trade-off: fat image (~1 GB) — isolated to one service that has no internet route and a read-only-ish sandbox. |
| **Reverse proxy** | Caddy 2 (bundled) | Automatic Let's Encrypt, 5-line config, secure headers. Docs also cover Nginx/Traefik for users with an existing proxy. |
| **OPDS** | OPDS 1.2 (Acquisition) + OPDS 2.0 (JSON) | 1.2 keeps KOReader/Moon+ compatibility; 2.0 for modern clients. Same REST backend generates both. |
| **Metadata sources** | Open Library (primary, open API, no key), Google Books (optional, user-supplied API key) | Respect ToS: per-server, not per-user, rate limiting; honest `User-Agent`; results cached. Hardcover/Libib considered later — their ToS are more restrictive. |

### The worker trust boundary (the heart of §3.2)

Three separate services with **different network privileges**:

- **`web`** — no internet, blobs mounted **read-only**. Handles auth, API, OPDS, UI.
- **`worker`** — no internet (`internal: true` network), non-root UID, `read_only` rootfs, `no-new-privileges`, dropped caps, CPU/RAM limits. Runs `ebook-convert`, thumbnail extraction, and the **zip-slip-guarded, XXE-disabled** metadata parser. A malicious EPUB can at worst crash an ephemeral, network-isolated, non-root process with no credentials beyond a scoped DB role.
- **`enrich`** — the *only* service with internet egress besides Caddy (ACME) and ClamAV (signatures). It talks to Open Library/Google Books and **cannot see the blob volume at all**. A compromised metadata API response can never reach a book file.

Progress is reported via the `jobs` table → Server-Sent Events, so scans/imports show a live progress bar and never freeze the UI.

---

## 2. Prioritized Roadmap

### MVP — "a single user can trust it with their library" (≈ weeks 1–6)
1. **Ingest pipeline**: magic-byte validation → SHA-256 dedupe → guarded metadata parse (EPUB OPF, PDF, CBZ ComicInfo.xml) → cover/thumbnail in worker → book record. Formats: EPUB, PDF, CBZ (CBR/CB7/MOBI/AZW3/FB2 arrive with conversion in v1).
2. **Auth core**: argon2id passwords, sessions (httpOnly+Secure+SameSite cookies), CSRF tokens, rate limiting + lockout, single `admin` bootstrap account, audit log.
3. **Library UI**: cover grid, paginated list, sort/filter by core fields, book detail page, manual metadata edit (every field + custom cover upload).
4. **EPUB web reader**: sandboxed iframe (scripting off), themes (light/dark/sepia), font size/line spacing, TOC, reading-progress sync.
5. **Docker Compose deployment** (the file in this repo) + backup script (pg_dump + restic, encrypted).
6. **Tests**: upload pipeline (incl. malicious-fixture suite), auth flows, metadata parse.

### v1 — "the household shares it" (≈ weeks 7–14)
- Metadata enrichment via `enrich` service (Open Library/Google Books) with conflict-resolution UI; **write-back to EPUB OPF** (Dublin Core) on save/export.
- **Duplicate detection** (ISBN exact + trigram title/author) with merge tool; **bulk edit/tagging**.
- **Roles & multi-user**: admin/user/guest/kid, per-library membership, shared household library, kid content-rating filter. Enforced server-side on every endpoint.
- **2FA (TOTP)** + recovery codes; session/device management ("see & revoke").
- **Collections & shelves**, series tracking with reading order, saved/smart searches (rules JSONB).
- **Conversion** (Calibre worker) incl. comic format handling; **CBR/CB7/FB2/MOBI/AZW3/image-folder** ingest; layout auto-detect; **RTL & vertical-scroll comic reader**.
- **OPDS 1.2 + 2.0** feeds with per-user API tokens.
- **Send-to-device** (email-to-Kindle/Kobo via user-configured SMTP).
- **Annotations**: bookmarks, highlights, notes (CFI-anchored), in-book full-text search.
- **PWA offline reading** (Workbox precache + IndexedDB for open books).
- Folder watch / bulk scan import; CSV import/export; full-library export + portable backup/restore flow.
- **Accessibility pass**: semantic HTML/ARIA, full keyboard nav, dyslexia font (OpenDyslexic), contrast controls; i18n framework (English + one more locale, ICU messages, non-Latin metadata handling).

### Later — "power features"
- WebAuthn/passkeys; OIDC SSO (Authelia/Authentik).
- Lending workflow (check-out, due dates, holds) — schema already in place.
- Reading analytics (per-user streaks/goals; admin aggregates **computed from anonymized counts only**, never per-user reading history).
- Text-to-speech (server-side Piper, opt-in; falls back to browser SpeechSynthesis).
- Kobo/Kindle direct sync plugins; Calibre-compatible metadata.opf interop for migrations.
- Optional managed/hosted offering built on the same images.

---

## 3. Concrete Data Model

Full SQL lives in [`schema.sql`](./schema.sql) (validated against PostgreSQL 15/16 — applies cleanly; smoke test in [`tests/smoke.sql`](./tests/smoke.sql) exercises FKs, generated full-text search, and trigram fuzzy matching).

### Entity overview

```
users ──┬── user_totp ── webauthn_credentials ── oidc_identities
        ├── sessions / api_tokens
        ├── reading_progress (per-user, PRIVATE)
        ├── annotations      (per-user, PRIVATE)
        ├── reading_events   (per-user, PRIVATE, analytics-opt-in)
        ├── loans / holds
        └── library_members ── libraries ──┬── books ──┬── book_files ── blobs (SHA-256 CAS)
                                           │           ├── book_authors ── authors
                                           │           ├── book_identifiers (ISBN…)
                                           │           ├── book_tags ── tags (tag/genre/shelf)
                                           │           ├── custom_field_values ── custom_fields
                                           │           └── series
                                           ├── collections (manual + smart rules) ── collection_items
                                           └── custom_fields

jobs (queue + history)      audit_log (append-only security events)
```

### Key design decisions (and trade-offs)

- **`books` vs `book_files` vs `blobs`.** A *book* is the bibliographic work; a *file* is one format of it (`UNIQUE(book_id, format)`); a *blob* is the physical bytes, keyed by SHA-256. Two users uploading the identical EPUB store it once. Trade-off: a "book" can't hold two *different* EPUB editions — same limitation as Calibre; acceptable, and keeps the UI simple.
- **Content-addressed storage.** `storage_path` derives from the hash, so the application never builds a filesystem path from user input — zip-slip/path-traversal at the *storage* layer is structurally impossible. Exports re-materialize nice filenames at zip-creation time.
- **Privacy by construction.** `reading_progress`, `annotations`, `reading_events` are keyed by `user_id`; every query on them carries `WHERE user_id = current_user` in a mandatory scope (an actual SQL row-security policy in production). Admin stats are served from pre-aggregated anonymous counters, so "most-read titles" never reveals *who* read what.
- **`audit_log` has no FK on `actor_id`.** Audit rows must outlive account deletion (GDPR erasure removes the *person*, not the security trail).
- **Full-text & fuzzy search without extra infra.** Generated `tsvector` column + GIN index for search; `pg_trgm` indexes on `books.title`/`authors.name` power duplicate detection (`similarity(title_a, title_b)`).
- **Series index is `NUMERIC(8,2)`** to represent 1.5-style interstitial novellas.
- **DRM is only ever a flag.** `books.drm_protected` is detected at ingest (EPUB `encryption.xml`, PDF encryption flags) so the UI can show the copyright notice; no code path attempts decryption.
- **Soft delete on books only** (recoverable mistakes); everything else hard-deletes on cascade.

---

## 4. Security Checklist (mapped to brief §3)

### §3.1 Authentication & Access Control
- [ ] **Passwords**: argon2id (memory-hard; `argon2` lib, OWASP parameters), zxcvbn-style strength meter, breached-password denylist on set. `password_hash` is never selected into API responses (dedicated `auth` DB schema view).
- [ ] **TOTP 2FA**: mandatory *support*; admin can enforce per-role (`users.totp_required`). Secrets AES-256-GCM encrypted under `SHELFMARK_MASTER_KEY`; 8 single-use recovery codes (hashed).
- [ ] **WebAuthn/passkeys** (v1+): `webauthn_credentials` table ready; platform authenticators + roaming keys.
- [ ] **OIDC SSO** (v1+): generic OIDC client, tested against Authelia & Authentik; `oidc_identities` maps provider+subject → user; group-claim → role mapping config.
- [ ] **Server-side RBAC**: every route passes an `authorize(action, resource)` guard that loads the caller's role + `library_members` row; there is no client-side "hide the button" security — UI hiding is cosmetic only. Postgres RLS policies as a second net on the per-user tables.
- [ ] **Rate limiting & lockout**: sliding-window limiter on `/auth/*` (per IP *and* per account); exponential backoff → temporary lockout after 10 failures; every attempt written to `audit_log` (`auth.login.fail`, `auth.lockout`).
- [ ] **Sessions**: opaque random token, only its SHA-256 stored; httpOnly + Secure + SameSite=Lax cookie; idle timeout configurable (`SHELFMARK_SESSION_IDLE_MIN`, default 60); absolute lifetime 30 days with rotation; `/settings/sessions` lists devices (UA, IP, last-seen) with per-device and "log out everywhere" revoke.
- [ ] **CSRF**: synchronizer token on all mutating non-API-token routes; SameSite=Lax as defense-in-depth.

### §3.2 File Upload & Parsing Security — *the category-specific risk*
- [ ] **Magic-byte validation** on first bytes (`PK\x03\x04` ZIP family, `%PDF-`, RAR4/5, 7z, FB2 XML) — extension ignored; mismatches rejected and audited (`upload.rejected`). Files stored under hash names with no extension semantics.
- [ ] **Zip-slip guard**: extraction routine resolves every entry path and refuses anything escaping the target dir (`resolve(dest, entry).startsWith(resolve(dest))`), rejects absolute paths, drive letters, symlinks and hardlinks; entry-count and total-uncompressed-size caps (zip-bomb protection, e.g. 100× ratio limit).
- [ ] **XXE guard**: OPF/XML parsed with a hardened parser — DTDs disabled, external entities and parameter entities off (`noent: false, dtdload: false`), and a wrapper that fails closed if the parser lib changes.
- [ ] **EPUB 3 scripting**: reader renders content inside a **sandboxed iframe served from a separate cookieless origin** (`reader.` subdomain or distinct port) with `sandbox="allow-same-origin"` removed (opaque origin), CSP `script-src 'none'`, and zero access to parent cookies/localStorage. Book JS is dead on arrival. (Trade-off noted: scripted "interactive" EPUBs degrade to static content — the correct default; a per-book opt-in toggle may come later behind an explicit warning.)
- [ ] **Isolated conversion/extraction worker**: separate container, non-root, read-only rootfs, no internet route, dropped capabilities, resource limits, fresh tmpfs per job; the web container never executes a parser on user bytes.
- [ ] **Malware scanning**: optional ClamAV sidecar scans every blob on ingest (`book_files.scan_status`); flagged files are quarantined (unreadable) until an admin dispositions them. Enabled by default when multi-user is enabled.
- [ ] **Quotas & size limits**: per-user `quota_bytes` enforced at upload; per-file limit (default 256 MiB) enforced at proxy *and* app layers; per-library total visible to admins.

### §3.3 Data Protection & Privacy
- [ ] **At rest**: TOTP secrets, OIDC client secrets, SMTP/Kindle credentials encrypted with AES-256-GCM under `SHELFMARK_MASTER_KEY` (env or Docker secret; documented key-rotation procedure). Blob volume documented for filesystem-level encryption (LUKS/ZFS) where desired.
- [ ] **Backups**: restic (AES-256 encrypted, deduplicated) to a user-chosen repo; restore procedure is scripted and *tested in CI* (nightly job restores into a scratch container and asserts counts).
- [ ] **TLS**: Caddy terminates TLS with automatic Let's Encrypt; docs cover Nginx/Traefik alternatives and running behind Cloudflare/Tailscale. HSTS + preload headers set at proxy.
- [ ] **Telemetry**: none. No analytics, no phone-home, no third-party assets (fonts/CDNs self-hosted). The only outbound calls are the user's configured metadata sources and SMTP — all enumerated in a PRIVACY.md.
- [ ] **Data rights**: self-service account export (JSON + all blobs contributed) and permanent deletion with a 7-day soft window; deletion cascades through all per-user tables while audit log keeps anonymized actor IDs.

### §3.4 Infrastructure Hardening
- [ ] **Least privilege**: every container `user: 1000:1000`, `read_only: true`, `cap_drop: ALL`, `no-new-privileges`; Postgres gets its own unprivileged role with no superuser; DB listens only on the internal network (no published port).
- [ ] **Network segmentation**: `internal` network has no internet route; only `enrich` (metadata), `clamav` (signatures) and `caddy` (ACME) join `egress`. Firewall doc: expose only 80/443; fail2ban example jail for repeated 401s shipped in `docs/`.
- [ ] **Dependency/CVE process**: Dependabot/Renovate on the repo; `npm audit` + Trivy image scan as blocking CI gates; pinned base images by digest; parsing libs (epub/xml/archive) tracked on a security-watch list with a 7-day patch SLA for critical CVEs.
- [ ] **Audit logging**: structured JSON to stdout (12-factor) + `audit_log` table: logins/failures/lockouts, role & permission changes, uploads rejected, admin actions, export/delete events — **never** file contents, passwords, or tokens. Log shipping (e.g., to Loki) documented as opt-in.
- [ ] **Backup/DR**: documented RPO (daily) / RTO (< 1 h on fresh host), runbook with a quarterly restore drill, and the CI restore test above.

### §3.5 Legal & Content Boundaries
- [ ] **No DRM circumvention**: no decryption code paths, ever. DRM detection (EPUB `encryption.xml` / PDF `/Encrypt`) only sets `drm_protected`; opening such a file shows: *"This file appears to be DRM-protected. Shelfmark does not remove DRM. Please ensure you own this content and comply with copyright law in your jurisdiction."*
- [ ] **Metadata API ToS**: per-instance (not per-user) rate limiting, honest `User-Agent` with admin contact, result caching, no bulk re-distribution of fetched data, attribution where required.

---

## 5. Deployment Instructions

### 5.1 Prerequisites
- Docker Engine 24+ with the Compose plugin.
- A hostname pointed at the host (for automatic HTTPS), or LAN-only testing.
- Ports **80** and **443** only. Everything else stays internal.

### 5.2 Configure
```bash
git clone <repo> && cd shelfmark/deploy
cp .env.example .env
```

`.env`:
```bash
PUBLIC_URL=https://books.example.com        # your hostname
ADMIN_EMAIL=you@example.com                 # Let's Encrypt + metadata UA contact
POSTGRES_PASSWORD=…                          # openssl rand -hex 32
SHELFMARK_MASTER_KEY=…                       # openssl rand -hex 32 (back THIS up — it seals 2FA/OIDC secrets)
WORKER_JWT_SECRET=…                          # openssl rand -hex 32
RESTIC_PASSWORD=…                            # encrypts backups
BACKUP_REPO=/srv/backups/shelfmark           # local path, or s3:… / rest:… URL
```

### 5.3 Launch
```bash
docker compose up -d                     # web, worker, enrich, db, clamav, caddy
docker compose --profile ops up -d       # + nightly encrypted backup (restic)
docker compose exec web shelfmark create-admin --username admin
```
First boot applies `schema.sql` automatically via the migration runner. The admin
bootstrap forces a strong password and offers TOTP enrollment on first login.

### 5.4 Reverse-proxy alternatives
- **Nginx / Traefik / NPM**: point the proxy at `http://shelfmark-web:8080`, forward `Host` and `X-Forwarded-Proto`, set `client_max_body_size 256m`, add the security headers from the bundled `Caddyfile`, terminate TLS yourself. A ready `nginx.conf` ships in `deploy/examples/`.
- **Tailscale-only** setups: set `PUBLIC_URL=http://shelfmark.local`, skip port 443 exposure entirely.

### 5.5 Backup & restore (tested process)
```bash
# nightly, via the backup service (restic: encrypted + deduplicated)
docker compose exec backup restic snapshots
# restore drill:
docker compose exec backup ./restore.sh <snapshot-id>   # restores DB + blobs, verifies hashes
```
Restoration re-hashes every blob against its address, so a corrupted backup fails loudly instead of silently serving damaged books.

### 5.6 Upgrades & CVE response
- Images are pinned by digest; `docker compose pull && up -d` after reviewing release notes.
- CI gates: unit/integration tests (upload, metadata, conversion, auth), `npm audit`, Trivy scan. Critical parser-library CVEs trigger a patch release within 7 days.

---

## Appendix A — Reader sandbox detail
Book content is requested by the iframe from `reader.<host>` (separate origin ⇒ same-origin policy isolates it from the app's cookies and storage). Responses for book markup carry:
```
Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'
Cross-Origin-Opener-Policy: same-origin
X-Content-Type-Options: nosniff
```
…so even a fully weaponized EPUB gets no script execution, no network, no cookies, no storage. The parent app communicates with the iframe only through a narrow `postMessage` protocol (locator updates, theme changes) with strict origin and schema checks.

## Appendix B — Duplicate detection & merge
1. Exact ISBN-13/ISBN-10 hit → flagged pair.
2. Else `similarity(books.title, candidate.title) > 0.55 AND author trigram > 0.6` (tuned; thresholds in settings).
3. Merge UI shows field-level diff, keeps the union of files/identifiers/tags, redirects annotations and progress of the loser to the winner, and writes an audit event.
