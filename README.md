# VulnDB UI

A web-based catalog and editor for the scripted vulnerabilities, misconfigurations, and
services used to provision vulnerable lab/range machines. Built for CTF teams, red teams, and
cyber range operators who manage fleets of deliberately vulnerable machines.

It's a small Express API backed by MySQL (reached over an SSH tunnel) with a vanilla-JS
frontend for browsing, editing, and wiring up dependencies between entries.

## Ecosystem

VulnDB UI is the **authoring interface**. It stores configuration definitions in a MySQL
database and file attachments in MinIO. A separate client — **nakon** — pulls these
configurations from the database and applies them to target machines. The data flow:

```
vulndb-ui (this repo) ──stores──▶ MySQL + MinIO ──reads──▶ nakon (client) ──applies──▶ target machine
```

## How it works

- `server.js` — Express API. On startup it opens an SSH connection to the DB
  host and forwards a local port to the remote MySQL instance (`setupDatabase`
  in `server.js:17`), so the app only needs SSH access, not a direct DB
  connection. All CRUD lives under `/api/configurations`. It also connects to
  a MinIO instance for file attachments (`setupMinio`).
- `public/` — static frontend (Tailwind via CDN, CodeMirror for script
  editing, highlight.js for script preview). `app.js` fetches the full
  configuration list and renders/filters/edits it client-side.

### Setup

```
cp .env.example .env   # fill in DB_*, SSH_*, and MINIO_* credentials
npm install
node server.js
```

`schema.sql` recreates the table structure on a fresh database.

### Attachments / MinIO

Each configuration can have file attachments (payloads, installers, PoC
files) stored in a MinIO bucket, with metadata in the `attachments` table.
MinIO runs as a systemd service directly on the DB box (no Docker — see
`/etc/systemd/system/minio.service` on that host), reachable directly at
`MINIO_URL` (no SSH tunnel needed, unlike the DB connection).

- `GET /api/configurations` — each configuration now includes an
  `attachments: [{ id, configuration_id, original_name, mime_type,
  size_bytes, uploaded_at }]` array.
- `POST /api/configurations/:id/attachments` — multipart upload (field name
  `file`), streams to MinIO, inserts the metadata row.
- `PUT /api/attachments/:attachmentId` — rename an attachment (`{
  "original_name": "..." }`). Only updates the display name/metadata; the
  underlying MinIO object key is untouched.
- `DELETE /api/attachments/:attachmentId` — removes the object from MinIO
  and its metadata row.
- `GET /api/attachments/:attachmentId/download` — `302` redirect to a
  5-minute presigned MinIO URL (the caller's network needs to reach MinIO
  directly to follow it — see `docs/vulndb-client-attachments.md` for the
  cross-subnet case).

Deleting a configuration (`DELETE /api/configurations/:id`) also removes any
attachments' MinIO objects before the row (and its `attachments` rows, via
`ON DELETE CASCADE`) is deleted.

#### Referencing an attachment from a script

vulndb-ui doesn't rewrite a configuration's `script` to point at its
attachments — it only stores the bytes and a display name. The convention
is that whatever runs the script (vulndb-client / nakon) downloads a
configuration's attachments and places them in the same working directory
the script executes from, named by `original_name`. A script can then just
reference an attachment as a relative path:

```bash
cp ./malicious.conf /etc/vsftpd.conf
```

There's currently no templating/placeholder syntax for attachments in the
script editor (unlike `depends_on` vars) — this is purely a filesystem
convention between vulndb-ui and the client that runs the scripts.

## Database structure

Two tables: `configurations`, and `attachments` (files attached to a
configuration, see [Attachments / MinIO](#attachments--minio) above).

`configurations`:

| Column       | Type                                              | Notes                                  |
|--------------|----------------------------------------------------|-----------------------------------------|
| `id`         | `INT AUTO_INCREMENT PRIMARY KEY`                   |                                         |
| `name`       | `VARCHAR(255) UNIQUE`                              | referenced by other rows in `depends_on` |
| `platform`   | `ENUM('linux','windows','other')`                  |                                         |
| `category`   | `ENUM('misconfiguration','service','vulnerability')` | drives the tab filter in the UI     |
| `type`       | `ENUM('bash','powershell','command')`              | controls script syntax highlighting/editor mode |
| `script`     | `TEXT`                                             | the actual script to run               |
| `run_as`     | `VARCHAR(100)`, default `root`                     | user the script executes as            |
| `depends_on` | `LONGTEXT`, nullable                                | JSON array, see below                  |

### `depends_on`

A JSON array of other configurations that must run before this one, **in
array order** — order is execution order, not just metadata. Each entry is
either:

- a plain string — the dependency's `name`, run as-is, e.g. `"nginx"`
- an object `{ "name": "...", "vars": { "KEY": "value" } }` — the dependency
  is parameterized; `vars` are substituted into the dependency's own script
  (e.g. a dependency on `create-user` with `vars: { USERNAME: "splunk" }`
  supplies the `$USERNAME` that `create-user`'s script reads).

The UI's dependency editor (in the configuration modal) lets you add/remove
dependencies, attach vars to each, and reorder them with the up/down arrows —
the saved order is whatever order the rows are in when you hit Save.

The API refuses to delete a configuration that another configuration still
depends on (`DELETE /api/configurations/:id` returns `409` with the list of
dependents).

## Basic blocks

A few configurations exist purely as reusable building blocks, meant to be
referenced via `depends_on` with `vars` rather than duplicated inline:

- **`install-package`** — installs a package via whichever of
  `apt-get`/`dnf`/`yum`/`apk` is present. Takes `PACKAGE`.
- **`create-user`** — idempotently creates a user (`useradd -m`). Takes
  `USERNAME`.
- **`enable-service`** — enables and starts a service, supporting both
  systemd (`systemctl`) and OpenRC (`rc-update`/`rc-service`). Takes
  `SERVICE`.

These are used wherever a dependency's package/service name is identical
across distros — e.g. `postfix`, `vsftpd`, and `mysql` (which installs
`mariadb-server` and enables the `mariadb` service) depend on
`install-package` + `enable-service` instead of carrying their own
apt/dnf/yum branching. Services whose package or service name actually
differs per distro (`apache`, `bind`, `dovecot`) or that need multiple
packages/extra repos (`roundcube`) keep their own self-contained install
script, since forcing them through a single-package generic block would lose
correctness.
