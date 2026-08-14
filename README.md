# vulndb-ui

**Catalog and editor** for the scripted vulnerabilities, misconfigurations, and services used to
provision vulnerable lab/range machines. A small Express API backed by MySQL (reached over an SSH
tunnel) with a vanilla-JS frontend for browsing, editing, and wiring up dependencies between
entries.

> The command-line client for this API lives in its own repo now:
> **[DawgSecTeam/vulndb-cli](https://github.com/DawgSecTeam/vulndb-cli)** (`python3 -m vulndb_cli`).
> For agent/integration context see **[AGENTS.md](AGENTS.md)**.

## How it works

- `server.js` — Express API. On startup it opens an SSH connection to the DB host and forwards a
  local port to the remote MySQL instance (`setupDatabase`), so the app only needs SSH access, not
  a direct DB connection. All CRUD lives under `/api/configurations`. It also connects to a MinIO
  instance for file attachments (`setupMinio`).
- `public/` — static frontend (Tailwind via CDN, CodeMirror for script editing, highlight.js for
  script preview). `app.js` fetches the configuration list and renders/filters/edits it
  client-side.

## Backups

The server takes a `mysqldump` backup of the database automatically on a schedule (daily by
default), gzips it into `BACKUP_DIR` (defaults to `~/.vulndb-backups`, mode `700` — never inside
`public/`), and keeps the most recent `BACKUP_RETENTION` copies (default 30). This requires
`mysqldump` and `mysql` (or `mariadb-dump`/`mariadb`) installed on the same host as `server.js`,
since the DB and the server run on the same machine in production (the SSH tunnel is a dev-time
convenience).

Backups can be listed, triggered on demand, downloaded, uploaded, restored, and deleted from the
webui's "Backups" panel or via `vulndb-cli` (`backup`, `list-backups`, `restore-backup`,
`download-backup`, `upload-backup`, `delete-backup` — see the
[vulndb-cli reference](https://github.com/DawgSecTeam/vulndb-cli/blob/main/docs/cli.md)). Restoring
overwrites the live database, so both the webui and CLI require explicit confirmation, and the
server takes a fresh safety backup of the current database immediately before overwriting it. See
`BACKUP_DIR`/`BACKUP_CRON`/`BACKUP_RETENTION` in `.env.example`.

## Setup

```
cp .env.example .env   # fill in DB_*, SSH_*, and MINIO_* credentials
npm install
npm start              # node server.js
```

`schema.sql` recreates the table structure on a fresh database.

## Documentation

- [`docs/api.md`](docs/api.md) — HTTP API reference: configurations and attachments endpoints, the
  `configurations` data model, `depends_on` syntax, and the reusable "basic block" configurations.
  This is the **authoritative contract** that `vulndb-cli`, nakon, and the web UI all build on.
- [`docs/agents.md`](docs/agents.md) — for agents or scripts integrating with vulndb-ui
  programmatically.
- [`docs/vulndb-client-attachments.md`](docs/vulndb-client-attachments.md) — how a provisioning
  client fetches and stages a configuration's attachments.
- [vulndb-cli](https://github.com/DawgSecTeam/vulndb-cli) — the sanctioned command-line client for
  this API (separate repo).

## Security note

The API has **no authentication** — the catalog is shared team state, and anything with network
access can read and write it. Keep vulndb-ui on a trusted network.
