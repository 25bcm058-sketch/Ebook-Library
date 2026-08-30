# Shelfmark — Self-Hosted E-Book Library Manager

Design and deployment foundation for a modern, security-first, self-hostable e-book
library manager (EPUB/PDF/MOBI/AZW3/CBZ/CBR/FB2 + comics), inspired by the best of
Calibre-Web, Kavita, and Komga — with the category-specific security failures
(zip slip, XXE, embedded JavaScript, malicious conversions) designed out from the start.

> Status: architecture validated, implementation starting on the MVP roadmap.

## What's here

| File | What it is |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Full architecture (with trade-offs), prioritized roadmap (MVP → v1 → later), data-model walkthrough, security checklist, and deployment & operations guide |
| [`schema.sql`](schema.sql) | Complete PostgreSQL 16 schema — 27 tables, validated against a live database |
| [`tests/smoke.sql`](tests/smoke.sql) | Smoke test exercising foreign keys, generated full-text search, and trigram fuzzy-duplicate matching |
| [`docker-compose.yml`](docker-compose.yml) | 7-service hardened deployment: web (read-only book store, no internet), isolated conversion worker (no network route), metadata enricher (internet but no file store), Postgres, ClamAV, Caddy TLS, restic backups |
| [`Caddyfile`](Caddyfile) | Automatic Let's Encrypt TLS + security headers (Nginx/Traefik guidance in DESIGN.md §5) |
| [`.env.example`](.env.example) | Configuration template |

## Architecture at a glance

- **Backend:** Fastify (Node/TypeScript), REST API-first — web UI, OPDS feed, and future mobile apps all consume one backend.
- **Frontend:** React + Vite PWA with sandboxed-iframe book rendering on a cookieless origin.
- **Security pipeline:** magic-byte validation → ClamAV → zip-slip/XXE-safe parsing →
  content-addressed (SHA-256) storage. Conversion and thumbnails run in a non-root,
  network-restricted worker; metadata fetching is the *only* internet path and it never
  sees book files.
- **Auth:** argon2id passwords, mandatory TOTP 2FA support, optional WebAuthn/OIDC,
  server-side RBAC on every endpoint, session/device management, append-only audit log.

## Deploy

```bash
cp .env.example .env   # fill in secrets
docker compose up -d
```

See DESIGN.md §5 for the full runbook, including backup/restore testing.

## License

MIT
