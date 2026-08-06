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

## Backups

The server takes a `mysqldump` backup of the database automatically on a
schedule (daily by default), gzips it into `BACKUP_DIR` (defaults to
`~/.vulndb-backups`, mode `700` — never inside `public/`), and keeps the most
recent `BACKUP_RETENTION` copies (default 30). This requires `mysqldump` and
`mysql` (or `mariadb-dump`/`mariadb`) to be installed on the same host as
`server.js`, since the DB and the server are expected to run on the same
machine in production (the SSH tunnel above is a dev-time convenience).

Backups can be listed, triggered on demand, downloaded, uploaded, restored,
and deleted from the webui's "Backups" panel or via `vulndb-cli` (`backup`,
`list-backups`, `restore-backup`, `download-backup`, `upload-backup`,
`delete-backup` — see [`docs/cli.md`](docs/cli.md)). Uploading accepts a
previously-downloaded `.sql.gz` file back in — handy for moving a backup
between hosts — and rejects anything that isn't actually a gzip'd
`mysqldump`/`mariadb-dump`. Restoring overwrites the live database, so
both the webui and CLI require an explicit confirmation, and the server takes
a fresh safety backup of the current database immediately before overwriting
it. See `BACKUP_DIR`/`BACKUP_CRON`/`BACKUP_RETENTION` in `.env.example`.

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
