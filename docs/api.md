# HTTP API reference

Base URL defaults to `http://127.0.0.1:3000`. There is no authentication — the catalog is
shared team state; anything with network access can read and write it.

**Prefer [`vulndb-cli`](cli.md) for programmatic access** rather than calling these endpoints
directly — it's the recommended integration point (see [`agents.md`](agents.md)) and keeps
future catalog changes (e.g. misconfig versioning) centralized in one place. This doc describes
the underlying contract that the CLI and the web UI are themselves built on.

## Configurations

| Endpoint | Description |
|---|---|
| `GET /api/configurations` | List all configurations, each with an `attachments` array (see below). |
| `POST /api/configurations` | Create a configuration. Body is a full configuration object (see [Data model](#data-model)). Returns `201` with the created row. |
| `PUT /api/configurations/:id` | Full replace — fields you omit are cleared, not left alone. Returns the updated row. |
| `DELETE /api/configurations/:id` | Delete a configuration and its attachments. Returns `204`, or `409 { error, dependents: [...] }` if another configuration still depends on it. |

`POST`/`PUT` validate `platform`, `category`, and `type` against the enums in
[Data model](#data-model) and return `400 { error }` naming the bad field. `name` is required and
unique; `script` is required but may be an empty string (see [Basic blocks](#basic-blocks)).

## Attachments

Each configuration can have file attachments (payloads, installers, PoC files) stored in a
MinIO bucket, with metadata in the `attachments` table. MinIO runs as a systemd service directly
on the DB box (no Docker), reachable directly at `MINIO_URL` (no SSH tunnel needed, unlike the
DB connection).

| Endpoint | Description |
|---|---|
| `POST /api/configurations/:id/attachments` | Multipart upload, field name `file`. Streams to MinIO, inserts the metadata row. Returns `201` with `{ id, configuration_id, original_name, mime_type, size_bytes }`. |
| `PUT /api/attachments/:attachmentId` | Rename: `{ "original_name": "..." }`. Metadata only — the underlying MinIO object key is untouched. |
| `DELETE /api/attachments/:attachmentId` | Removes the object from MinIO and its metadata row. |
| `GET /api/attachments/:attachmentId/download` | `302` redirect to a 5-minute presigned MinIO URL. The caller's network needs to reach MinIO directly to follow it — see [`vulndb-client-attachments.md`](vulndb-client-attachments.md) for the cross-subnet case. |

Deleting a configuration removes its attachments' MinIO objects before the row (and its
`attachments` rows, via `ON DELETE CASCADE`) is deleted.

vulndb-ui doesn't rewrite a configuration's `script` to reference its attachments — it only
stores the bytes and a display name. The convention is that whatever runs the script downloads
the attachments into the script's working directory, named by `original_name`, so the script can
reference them as a relative path (`cp ./malicious.conf /etc/vsftpd.conf`).

## Backups

The server takes a `mysqldump` backup automatically on a schedule (`BACKUP_CRON`, default daily)
and prunes old ones (`BACKUP_RETENTION`, default 30) — see the [README](../README.md#backups).
These endpoints are for on-demand use from the webui's "Backups" panel or `vulndb-cli`.

| Endpoint | Description |
|---|---|
| `GET /api/backups` | List backups, newest first: `{ filename, size_bytes, created_at }`. |
| `POST /api/backups` | Trigger a backup now. Returns `201` with the new backup's metadata. |
| `POST /api/backups/upload` | Upload a previously-downloaded backup file (multipart, field `file`). Rejects anything that isn't a gzip'd `mysqldump`/`mariadb-dump` with `400`. Returns `201` with the same metadata shape as `POST /api/backups` — the uploaded file is always given a fresh server-generated filename, never the client's. |
| `GET /api/backups/:filename/download` | Download a backup file (`.sql.gz`). |
| `POST /api/backups/:filename/restore` | **Overwrites the live database** with the backup's contents. Takes a fresh safety backup of the current database first. Returns `{ restored, safety_backup }`. |
| `DELETE /api/backups/:filename` | Delete a backup file. |

`:filename` is validated against the exact pattern the server generates (`vulndb-backup-<ISO
timestamp>.sql.gz`); anything else is rejected before touching the filesystem. Backup/restore
endpoints return `500` if `mysqldump`/`mysql` (or `mariadb-dump`/`mariadb`) aren't installed on
the server's host.

## Data model

Two tables: `configurations`, and `attachments` (see above).

`configurations`:

| Column | Type | Notes |
|---|---|---|
| `id` | `INT AUTO_INCREMENT PRIMARY KEY` | |
| `name` | `VARCHAR(255) UNIQUE` | referenced by other rows in `depends_on` |
| `description` | `TEXT`, nullable | prose: what it changes, why a real box would have it, what a defender notices — the only place difficulty, realism, and couplings are recorded |
| `platform` | `ENUM('linux','windows','other')` | |
| `category` | `ENUM('misconfiguration','service','vulnerability')` | drives the tab filter in the UI |
| `type` | `ENUM('bash','powershell','command')` | controls script syntax highlighting/editor mode |
| `script` | `TEXT` | the actual script to run |
| `run_as` | `VARCHAR(100)`, default `root` | user the script executes as |
| `depends_on` | `LONGTEXT`, nullable | JSON array, see below |

### `depends_on`

A JSON array of other configurations that must run before this one, **in array order** — order
is execution order, not just metadata. Each entry is either:

- a plain string — the dependency's `name`, run as-is, e.g. `"nginx"`
- an object `{ "name": "...", "vars": { "KEY": "value" } }` — the dependency is parameterized;
  `vars` are substituted into the dependency's own script (e.g. a dependency on `create-user`
  with `vars: { USERNAME: "splunk" }` supplies the `$USERNAME` that `create-user`'s script reads).

`DELETE /api/configurations/:id` refuses to delete a configuration another configuration still
depends on (`409` with the dependent list).

## Basic blocks

A few configurations exist purely as reusable building blocks, referenced via `depends_on` with
`vars` rather than duplicated inline:

- **`install-package`** — installs a package via whichever of `apt-get`/`dnf`/`yum`/`apk` is
  present. Takes `PACKAGE`.
- **`create-user`** — idempotently creates a user (`useradd -m`). Takes `USERNAME`.
- **`enable-service`** — enables and starts a service, supporting both systemd (`systemctl`) and
  OpenRC (`rc-update`/`rc-service`). Takes `SERVICE`.

Used wherever a dependency's package/service name is identical across distros (`postfix`,
`vsftpd`, `mysql`). Services whose package/service name differs per distro (`apache`, `bind`,
`dovecot`) or need multiple packages/repos (`roundcube`) keep their own self-contained install
script instead.
