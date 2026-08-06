# VulnDB Interfaces
**WebUI and CLI**

A catalog and editor for the scripted vulnerabilities, misconfigurations, and
services used to provision vulnerable lab/range machines. It's a small
Express API backed by MySQL (reached over an SSH tunnel) with a vanilla-JS
frontend for browsing, editing, and wiring up dependencies between entries.

## How it works

- `server.js` — Express API. On startup it opens an SSH connection to the DB
  host and forwards a local port to the remote MySQL instance (`setupDatabase`),
  so the app only needs SSH access, not a direct DB connection. All CRUD
  lives under `/api/configurations`. It also connects to a MinIO instance
  for file attachments (`setupMinio`).
- `public/` — static frontend (Tailwind via CDN, CodeMirror for script
  editing, highlight.js for script preview). `app.js` fetches the full
  configuration list and renders/filters/edits it client-side.

## Setup

```
cp .env.example .env   # fill in DB_*, SSH_*, and MINIO_* credentials
npm install
node server.js
```

`schema.sql` recreates the table structure on a fresh database.

## Documentation

- [`docs/api.md`](docs/api.md) — HTTP API reference: configurations and
  attachments endpoints, the `configurations` data model, `depends_on`
  syntax, and the reusable "basic block" configurations.
- [`docs/cli.md`](docs/cli.md) — `vulndb-cli` command reference.
- [`docs/agents.md`](docs/agents.md) — for agents or scripts integrating
  with vulndb-ui programmatically (nakon, vulndb-client, or anything else
  reading/writing the catalog).
- [`docs/vulndb-client-attachments.md`](docs/vulndb-client-attachments.md) —
  how a provisioning client fetches and stages a configuration's attachments.
