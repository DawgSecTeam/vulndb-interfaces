# AGENTS.md — vulndb-ui

Guidance for agents (and humans) working in or against this repo.

## What this is

**vulndb-ui** is the catalog: a MySQL database of `configurations` (scripted vulnerabilities,
misconfigurations, services), an Express HTTP API over it, a MinIO-backed attachment store, and a
vanilla-JS web UI for browsing/editing. Everything else in the ecosystem reads or writes this
catalog.

## Ecosystem position

```
vulndb-ui (this repo: MySQL + HTTP API + MinIO media + web UI)
   ▲
   ├── HTTP API ── vulndb-cli (sanctioned client; CRUD/attachments/backups)
   ├── HTTP/MySQL (build-time data source) ── nakon (read + build + randomize)
   └── HTTP ── huitzilopochtli (via vulndb-cli), tezcatlipoca (transitively via nakon)
```

This repo is the **source of truth for the catalog contract** (`docs/api.md`). Clients (`vulndb-cli`,
nakon) code against that contract; the enum/validate constants are duplicated between this repo's
`server.js` (Node) and `vulndb-cli` (Python) by necessity — if the two disagree, the server wins and
the client has a bug.

## Layout

```
server.js        Express API: CRUD under /api/configurations, /api/attachments/*, /api/backups/*;
                 SSH-tunnel DB setup, MinIO setup, scheduled mysqldump backups, static frontend.
public/          static web UI (index.html + app.js; Tailwind/CodeMirror/highlight.js via CDN)
schema.sql       MySQL DDL (configurations, attachments)
docs/            api.md (the contract), agents.md, vulndb-client-attachments.md
.env.example     DB_* / SSH_* / MINIO_* / BACKUP_* config
```

The CLI no longer lives here — it moved to [DawgSecTeam/vulndb-cli](https://github.com/DawgSecTeam/vulndb-cli).

## Run / build / test

```bash
cp .env.example .env     # fill in DB_*, SSH_*, MINIO_*
npm install
npm start                # node server.js  (default http://127.0.0.1:3000)
```

`schema.sql` recreates the tables on a fresh DB. No build step, no test suite. To verify a change,
start the server and exercise the API (or the web UI), and/or drive it with `vulndb-cli`.

## Conventions & gotchas

- **No authentication.** Anything on the network can read/write the whole catalog; a write is live
  immediately for everyone. No draft/review state.
- **`PUT` is a full replace, not a patch** — omitting a field clears it. The web UI and `vulndb-cli`
  do read-modify-write; raw API callers must send every field.
- **`name` is the join key** across the ecosystem (depends_on, nakon config.json, tezcatlipoca
  box_vulns.json). `id` only appears in URLs. Deleting a configuration another depends on returns
  `409 { error, dependents }` — it does not cascade.
- **Attachments** are stored in MinIO with metadata in `attachments`; the script is never rewritten
  to reference them. Convention: the provisioning client downloads attachments into the script's
  working directory named by `original_name`, so the script uses a relative path. `GET
  /api/attachments/:id/download` returns a `302` to a 5-minute presigned MinIO URL — the caller's
  network must reach MinIO directly.
- **Backups** run on a schedule (`mysqldump` gzipped to `BACKUP_DIR`, retention `BACKUP_RETENTION`).
  Restore overwrites the live DB; the server takes a safety backup first. Requires `mysqldump`/`mysql`
  on the server host.
- **Basic blocks** (`install-package`, `create-user`, `enable-service`) are reusable rows meant to be
  pulled in via `depends_on` with `vars`, not selected directly.

## Integration contract (for clients)

See [`docs/api.md`](docs/api.md) for the full HTTP contract. Prefer
[vulndb-cli](https://github.com/DawgSecTeam/vulndb-cli) for programmatic read/write; nakon reads the
catalog at build time (HTTP or MySQL). Base URL: `http://127.0.0.1:3000` by default.
