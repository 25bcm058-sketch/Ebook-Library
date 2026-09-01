# Shelfmark — Self-Hosted E-Book Library Manager

Design and deployment foundation for a modern, security-first, self-hostable e-book
library manager (EPUB/PDF/MOBI/AZW3/CBZ/CBR/FB2 + comics), inspired by the best of
Calibre-Web, Kavita, and Komga — with the category-specific security failures
(zip slip, XXE, embedded JavaScript, malicious conversions) designed out from the start.

**Two editions, one philosophy:**

- 🖥️ **[Desktop](desktop/)** — a local PC app (Electron): no Docker, no server, no account
  needed. Embedded API + SQLite, files in your user data folder. Working scaffold included.
- 🌐 **Server** — the multi-user self-hosted web app (design complete, MVP in progress).

## What's here

| Path | What it is |
|---|---|
| [`desktop/`](desktop/) | **Desktop edition** — Electron app with embedded Fastify API + SQLite, magic-byte-validated imports, FTS5 search, dark-themed library UI. Type-checked and smoke-tested. |
| [`DESIGN.md`](DESIGN.md) | Server-edition architecture (with trade-offs), roadmap (MVP → v1 → later), data-model walkthrough, security checklist, deployment & operations guide |
| [`schema.sql`](schema.sql) | Server-edition PostgreSQL 16 schema — 27 tables, validated against a live database |
| [`tests/smoke.sql`](tests/smoke.sql) | Smoke test for the Postgres schema (FKs, full-text search, trigram fuzzy-duplicate matching) |
| [`docker-compose.yml`](docker-compose.yml) | Server-edition 7-service hardened deployment |
| [`Caddyfile`](Caddyfile) | Automatic Let's Encrypt TLS + security headers |
| [`.env.example`](.env.example) | Server configuration template |

## Desktop edition — quick start

```bash
cd desktop
npm install
npm run dev        # run locally
npm run dist       # package: Windows NSIS / macOS dmg / Linux AppImage
```

Security is retained even on a single-user PC: magic-byte validation (a file named
`book.epub.exe` is rejected), zip-slip and XXE guards on EPUB/CBZ parsing, a random
localhost port with a per-launch auth token, and a sandboxed renderer. See
[desktop/README.md](desktop/README.md) for the architecture and the honest
Desktop-vs-Server comparison.

## Server edition — architecture at a glance

- **Backend:** Fastify (Node/TypeScript), REST API-first — web UI, OPDS feed, and future mobile apps all consume one backend.
- **Frontend:** React + Vite PWA with sandboxed-iframe book rendering on a cookieless origin.
- **Security pipeline:** magic-byte validation → ClamAV → zip-slip/XXE-safe parsing → content-addressed (SHA-256) storage. Conversion in a non-root, network-restricted worker; metadata fetching is the *only* internet path and it never sees book files.
- **Auth:** argon2id passwords, mandatory TOTP 2FA support, optional WebAuthn/OIDC, server-side RBAC on every endpoint, session/device management, append-only audit log.

```bash
cp .env.example .env   # fill in secrets
docker compose up -d
```

## License

MIT
