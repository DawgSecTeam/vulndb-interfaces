# For agents integrating with vulndb-ui

vulndb-ui is the catalog of scripted vulnerabilities, misconfigurations, and services used to
provision vulnerable lab/range machines. This doc is for anything non-interactive that reads or
writes the catalog: an agent picking or authoring a competition's misconfig set, or a
provisioning tool like nakon.

## The shape of the data

A **configuration** is one vulnerability/misconfiguration/service: a `name`, a `script` that
applies it, and metadata (`platform`, `category`, `type`, `run_as`, `description`,
`depends_on`). Full schema and endpoints: [`api.md`](api.md).

- **`description`** is the only place difficulty, realism, and cross-config couplings are
  recorded in prose — read it before picking or generating a set, and write one for anything
  you create.
- **`depends_on`** orders prerequisite configurations (by `name`, optionally parameterized with
  `vars`) that must run first — see [`api.md`](api.md#depends_on). Reuse the basic-block
  configurations (`install-package`, `create-user`, `enable-service`) instead of inlining
  package-manager branching.
- **Attachments** are files (payloads, installers, PoCs) carried alongside a configuration but
  not referenced by the API itself — see
  [`vulndb-client-attachments.md`](vulndb-client-attachments.md) for how a provisioning client
  fetches and stages them.

## How to integrate

- **Prefer `vulndb-cli` ([`cli.md`](cli.md)) over hand-rolling HTTP calls, for reads as well as
  writes.** Routing through one interface means catalog changes on the roadmap — e.g. misconfig
  versioning — land once in the CLI instead of being reimplemented by every client. Use `list`
  for browsing/picking a set and `get <id|name>` for one configuration (including its
  `attachments`); write commands validate input client-side, do read-modify-write for partial
  updates, and print a human-readable summary of what a write will do before it happens.
- The raw HTTP contract ([`api.md`](api.md)) is still documented for cases the CLI doesn't cover
  — it's what the CLI and the web UI are themselves built on.
- **Non-interactive writes require `--yes`.** Every write command asks for confirmation on a
  TTY; `vulndb-cli` refuses to write without `--yes` when stdin isn't a terminal, which is the
  normal case for an agent. Compose and review the change, then pass `--yes` explicitly — don't
  work around the prompt by piping "y".

## Things to know before writing

- **No authentication.** Anything reachable on the network can read and write the whole catalog,
  and a write is immediately live for everyone. There's no draft/review state — be sure before
  you write.
- **`PUT` is a full replace, not a patch.** `vulndb-cli update`/`describe` handle this by reading
  the current row first; calling the HTTP API directly means sending every field, not just the
  one you're changing.
- **Deleting is blocked, not cascaded, by dependents.** `DELETE /api/configurations/:id` returns
  `409` with the dependent list if another configuration still depends on it — repoint or remove
  those first.
- **Errors are informative.** A `400` names the invalid field; use it rather than guessing at
  enum values (`platform`, `category`, `type` — see [`api.md`](api.md#data-model)).
