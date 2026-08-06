# `vulndb-cli` reference

`cli.js` is a thin, dependency-free wrapper around vulndb-ui's own HTTP API ([`api.md`](api.md))
for scripting the catalog without opening the web UI. It's registered as the `vulndb-cli` bin
(see `package.json`), so after `npm install` (or `npm link` for local dev) it's available as
`vulndb-cli`; otherwise run it directly with `node cli.js`.

```
vulndb-cli [--url <vulndb-ui url>] <command> [args]
```

**Read:**

| Command | Description |
|---|---|
| `list [--platform P] [--category C] [--search TEXT] [--json]` | List configurations with their descriptions. `--search` matches name, description and script. `--json` prints full records. |
| `get <id\|name>` | Print one configuration as JSON, including its `attachments` array |

**Write** — every one of these prints what it's about to do and asks first; `--yes` skips the
prompt and is **required** when stdin isn't a terminal:

| Command | Description |
|---|---|
| `create --file <json\|->` | Create a configuration from a JSON document (`-` reads stdin) |
| `create --name X [--platform P] [--category C] [--type T] [--script-file F] [--description TEXT] [--run-as U] [--depends-on JSON]` | The same, from flags |
| `update <id\|name> [--file <json\|->] [--name X] [--description TEXT] …` | Change some fields, leaving the rest alone |
| `describe <id\|name> <text>` | Set just the description |
| `delete <id\|name>` | Delete a configuration and its attachments |

**Attachments:**

| Command | Description |
|---|---|
| `upload <id\|name> <file>` | Upload `<file>` as an attachment on that configuration |
| `download <attachmentId> <outfile>` | Download an attachment by id (follows the presigned MinIO redirect) |
| `rename-attachment <attachmentId> <newName>` | Rename an attachment (display name only) |
| `delete-attachment <attachmentId>` | Delete an attachment by id |

**Base URL** resolution, in order: the `--url <url>` flag, then `$VULNDB_UI_URL`, then
`http://127.0.0.1:3000`. `VULNDB_UI_URL` is the same env var name nakon itself uses, so setting
it once in the environment covers both tools.

```bash
vulndb-cli list --category misconfiguration
vulndb-cli list --search ssh --json
vulndb-cli get suid-find
vulndb-cli describe suid-find "Sets the SUID bit on find, so any user can read root-owned files." --yes
echo '{"name":"x","platform":"linux","category":"misconfiguration","type":"bash","script":"id"}' \
  | vulndb-cli create --file - --yes
vulndb-cli upload suid-find ./malicious.conf
vulndb-cli --url http://10.0.0.118:3000 list
```

`update` and `describe` do a read-modify-write, because `PUT /api/configurations/:id` is a full
replace — passing one field would otherwise blank every other one.

Errors from the API are printed with the response body and exit status 1. A `400` names the
field that was wrong; deleting a configuration something else depends on returns `409` and lists
the dependents.

**Note:** the API has no authentication and the catalog is shared team state, so a write here is
immediately live for everyone. That's what the confirmation prompt is for.
