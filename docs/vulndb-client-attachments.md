# Fetching attachments from vulndb-ui (for vulndb-client / nakon)

vulndb-ui lets a configuration (vulnerability, misconfiguration, or service) carry file
attachments — payloads, installers, PoC binaries, etc. — alongside its script. This doc is for
whatever runs the actual provisioning (nakon / vulndb-client): how to discover, fetch, and stage
those files.

Use [`vulndb-cli`](https://github.com/DawgSecTeam/vulndb-cli) (`python3 -m vulndb_cli`) for both
steps below rather than calling the HTTP API directly. It's the same network calls either way, but
keeping discovery/fetch behind one interface means future catalog changes — e.g. misconfig
versioning — land once in the CLI instead of being reimplemented by every client that talks to
vulndb-ui. See its [command reference](https://github.com/DawgSecTeam/vulndb-cli/blob/main/docs/cli.md)
for setup/install; the raw endpoints are documented in [`api.md`](api.md) if you ever need them
directly.

## Network shape — why this isn't a one-step download

- vulndb-ui, the MySQL DB, and MinIO all live on the same box/network
  (`10.0.0.118`). Wherever nakon (and `vulndb-cli`) runs is assumed to be on **that** network
  too (reachable to vulndb-ui's API and directly to MinIO on port 9000) —
  that's the "quotient box" doing the deploying.
- The actual target/endpoint machines nakon provisions are on **separate
  subnets** and can't reach the DB/MinIO network at all.
- So attachments have to make two hops: MinIO → the box nakon runs on
  (download), then that box → the endpoint machine (transfer), using
  whatever transport nakon already uses to push the script over (SCP/SFTP,
  WinRM, etc.). There's no way for an endpoint machine to pull a file from
  MinIO directly — don't hand it a presigned URL and expect it to work.

## 1. Discover attachments for a configuration

```bash
python3 -m vulndb_cli get vsftpd-anon-write
```

Prints the full configuration as JSON (accepts an `id` too), with an `attachments` array:

```json
{
  "id": 7,
  "name": "vsftpd-anon-write",
  "description": "Enables anonymous write on the vsftpd upload directory ...",
  "category": "misconfiguration",
  "script": "...",
  "attachments": [
    {
      "id": 14,
      "configuration_id": 7,
      "original_name": "malicious.conf",
      "mime_type": "text/plain",
      "size_bytes": 482,
      "uploaded_at": "2026-06-25T05:49:58.000Z"
    }
  ]
}
```

Empty array if there are no attachments — most configurations won't have any, this is opt-in
per entry.

## 2. Download an attachment

```bash
python3 -m vulndb_cli download 14 ./staging/malicious.conf
```

This follows vulndb-ui's `302` redirect to a presigned MinIO URL and writes the bytes straight to
`./staging/malicious.conf` — vulndb-ui itself never proxies the file.

Notes:
- The presigned URL is only valid for **5 minutes**, so re-run `download` right before you need
  the file rather than queuing a batch of downloads too far ahead of when they're staged.
- Save the file under `original_name` from the `attachments` array (as in the example above),
  and use the attachment `id` if you need to disambiguate — two attachments on the same
  configuration could in theory share a name.
- There's no auth on the download beyond the presigned URL being time-limited and scoped to one
  object — treat it as a short-lived credential (don't log it, don't hand it to anything outside
  this one download).

## 3. Recommended flow when provisioning a configuration

For each configuration being deployed that has a non-empty `attachments`
array:

1. Download each attachment to a local staging directory on the box nakon
   runs on (keyed by attachment `id` to avoid name collisions, e.g.
   `staging/<configuration_id>/<id>-<original_name>`).
2. After staging, transfer the file(s) to the target endpoint machine
   using the same transport already used to push the script over, placing
   them wherever the script expects to find them (e.g. its own working
   directory, or a path supplied via a `depends_on` var / environment
   variable convention you already have).
3. The script itself is responsible for referencing the file by whatever
   relative/absolute path it ends up at on the endpoint — vulndb-ui has no
   opinion on that, it just stores the bytes and the original filename.

## Cleanup

Attachments are deleted along with their configuration server-side
(MinIO object + metadata row), so nakon doesn't need to do anything to
clean up the source — only clean up whatever copies it staged locally or
pushed to the endpoint, per its own conventions.
