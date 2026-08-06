#!/usr/bin/env node
// vulndb-cli — thin wrapper around vulndb-ui's own HTTP API (server.js), for scripting the
// catalog and its attachments without opening the web UI.
//
// Usage:
//   node cli.js list [--platform linux] [--category misconfiguration] [--search TEXT] [--json]
//   node cli.js get <id|name>
//   node cli.js create --file <json|-> [--yes]
//   node cli.js create --name X --platform linux --category misconfiguration \
//                      --type bash --script-file F [--description TEXT] [--yes]
//   node cli.js update <id|name> [--file <json|->] [--name X] [--description TEXT] ... [--yes]
//   node cli.js describe <id|name> <text> [--yes]
//   node cli.js delete <id|name> [--yes]
//   node cli.js upload <id|name> <file>
//   node cli.js download <attachmentId> <outfile>
//   node cli.js rename-attachment <attachmentId> <newName>
//   node cli.js delete-attachment <attachmentId>
//
// Base URL: --url <url>, or $VULNDB_UI_URL, or http://127.0.0.1:3000 (same env var name
// nakon itself uses, so a single VULNDB_UI_URL in the environment covers both tools).
//
// The catalog is shared team state and the API has no authentication, so every command that
// writes prints what it is about to do and asks first. Pass --yes to skip the prompt (required
// when stdin isn't a terminal, which is how an agent or a script will be running this).

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PLATFORMS = ['linux', 'windows', 'other'];
const CATEGORIES = ['misconfiguration', 'service', 'vulnerability'];
const TYPES = ['bash', 'powershell', 'command'];

// ---------------------------------------------------------------------------- arg handling

// Pull `--name value` out of args wherever it appears and return the value (null if absent).
function takeOption(args, name) {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return null;
    const value = args[i + 1];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    args.splice(i, 2);
    return value;
}

// Pull a valueless `--name` out of args and return whether it was there.
function takeFlag(args, name) {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
}

function baseUrl(args) {
    const url = takeOption(args, 'url');
    return (url || process.env.VULNDB_UI_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
}

function readInput(spec) {
    // "-" means stdin, so `… | vulndb-cli create --file -` works.
    const raw = spec === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(spec, 'utf8');
    return raw;
}

function readJsonInput(spec) {
    const raw = readInput(spec);
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`${spec === '-' ? 'stdin' : spec} is not valid JSON: ${err.message}`);
    }
}

async function confirm(summary, assumeYes) {
    console.error(summary);
    if (assumeYes) return;
    if (!process.stdin.isTTY) {
        throw new Error('refusing to write without confirmation — re-run with --yes');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise(resolve => rl.question('proceed? (y/N) ', resolve));
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') throw new Error('aborted');
}

// ---------------------------------------------------------------------------- api helpers

async function apiJson(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        // The API answers 400 with {error} for a bad enum and 409 with {error, dependents} when
        // something still depends on the row; both are worth showing as-is rather than as a status.
        const text = await res.text().catch(() => '');
        let detail = text;
        try {
            const parsed = JSON.parse(text);
            if (parsed.error) {
                detail = parsed.error;
                if (parsed.dependents) detail += `\ndepended on by: ${parsed.dependents.join(', ')}`;
            }
        } catch { /* not JSON — show the raw body */ }
        throw new Error(`${method} ${url} -> ${res.status} ${res.statusText}\n${detail}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

const allConfigs = base => apiJson('GET', `${base}/api/configurations`);

// `name` is the key every other repo joins on (nakon config.json, depends_on, tezcatlipoca's
// box_vulns.json); `id` only appears in URLs. Accept either.
async function resolveRef(base, ref) {
    const configs = await allConfigs(base);
    const found = configs.find(c => String(c.id) === String(ref) || c.name === ref);
    if (!found) throw new Error(`no configuration with id or name ${JSON.stringify(ref)}`);
    return found;
}

function validate(config) {
    if (!config.name || !String(config.name).trim()) return 'name is required';
    if (!PLATFORMS.includes(config.platform)) return `platform must be one of ${PLATFORMS.join(', ')}`;
    if (!CATEGORIES.includes(config.category)) return `category must be one of ${CATEGORIES.join(', ')}`;
    if (!TYPES.includes(config.type)) return `type must be one of ${TYPES.join(', ')}`;
    if (typeof config.script !== 'string') return 'script is required (use --script-file or --file)';
    return null;
}

// ---------------------------------------------------------------------------- read commands

async function cmdList(base, args) {
    const platform = takeOption(args, 'platform');
    const category = takeOption(args, 'category');
    const search = (takeOption(args, 'search') || '').toLowerCase();
    const asJson = takeFlag(args, 'json');

    let configs = await allConfigs(base);
    if (platform) configs = configs.filter(c => c.platform === platform);
    if (category) configs = configs.filter(c => c.category === category);
    if (search) {
        configs = configs.filter(c =>
            `${c.name} ${c.description || ''} ${c.script || ''}`.toLowerCase().includes(search));
    }
    configs.sort((a, b) => a.id - b.id);

    if (asJson) {
        console.log(JSON.stringify(configs, null, 2));
        return;
    }

    for (const c of configs) {
        const attCount = (c.attachments || []).length;
        const attSuffix = attCount ? `  [${attCount} attachment${attCount === 1 ? '' : 's'}]` : '';
        console.log(`${String(c.id).padStart(4)}  ${c.platform.padEnd(8)} ${c.category.padEnd(16)} ${c.name}${attSuffix}`);
        console.log(`        ${c.description ? c.description.replace(/\s+/g, ' ') : '(no description)'}`);
    }
    console.log(`\n${configs.length} configuration(s)`);
}

async function cmdGet(base, ref) {
    console.log(JSON.stringify(await resolveRef(base, ref), null, 2));
}

// ---------------------------------------------------------------------------- write commands

// Assemble a configuration from --file and/or individual flags. Flags win over the file, so
// `create --file base.json --name other` works the way you'd expect.
function configFromArgs(args, seed = {}) {
    const file = takeOption(args, 'file');
    const scriptFile = takeOption(args, 'script-file');
    const name = takeOption(args, 'name');
    const description = takeOption(args, 'description');
    const platform = takeOption(args, 'platform');
    const category = takeOption(args, 'category');
    const type = takeOption(args, 'type');
    const runAs = takeOption(args, 'run-as');
    const dependsOn = takeOption(args, 'depends-on');

    const config = { ...seed };
    if (file) Object.assign(config, readJsonInput(file));
    if (name !== null) config.name = name;
    if (description !== null) config.description = description === '' ? null : description;
    if (platform !== null) config.platform = platform;
    if (category !== null) config.category = category;
    if (type !== null) config.type = type;
    if (runAs !== null) config.run_as = runAs;
    if (scriptFile !== null) config.script = readInput(scriptFile);
    if (dependsOn !== null) {
        try {
            config.depends_on = JSON.parse(dependsOn);
        } catch (err) {
            throw new Error(`--depends-on must be a JSON array: ${err.message}`);
        }
    }
    return config;
}

function summarize(config) {
    const lines = [
        `  name        ${config.name}`,
        `  platform    ${config.platform}`,
        `  category    ${config.category}`,
        `  type        ${config.type}`,
        `  run_as      ${config.run_as || 'root'}`,
        `  description ${config.description ? String(config.description).slice(0, 120) : '(none)'}`,
        `  depends_on  ${JSON.stringify(config.depends_on || [])}`,
        `  script      ${(config.script || '').split('\n').length} line(s), ${(config.script || '').length} bytes`,
    ];
    return lines.join('\n');
}

async function cmdCreate(base, args, assumeYes) {
    const config = configFromArgs(args, {
        platform: 'linux', category: 'misconfiguration', type: 'bash', run_as: 'root',
        script: '', depends_on: [],
    });

    const invalid = validate(config);
    if (invalid) throw new Error(invalid);

    await confirm(`create configuration on ${base}:\n${summarize(config)}`, assumeYes);
    const created = await apiJson('POST', `${base}/api/configurations`, config);
    console.log(JSON.stringify(created, null, 2));
}

async function cmdUpdate(base, ref, args, assumeYes) {
    const existing = await resolveRef(base, ref);
    // PUT is a full replace, so start from the current row and lay the changes on top —
    // otherwise updating one field would blank every field that wasn't passed.
    const { attachments, id, ...current } = existing;
    const config = configFromArgs(args, current);

    const invalid = validate(config);
    if (invalid) throw new Error(invalid);

    const changed = Object.keys(config)
        .filter(k => JSON.stringify(config[k]) !== JSON.stringify(current[k]));
    if (!changed.length) {
        console.error(`no changes for ${existing.name} (id ${existing.id})`);
        return;
    }

    const diff = changed.map(k =>
        `  ${k}: ${JSON.stringify(current[k])?.slice(0, 80)} -> ${JSON.stringify(config[k])?.slice(0, 80)}`
    ).join('\n');
    await confirm(`update ${existing.name} (id ${existing.id}) on ${base}:\n${diff}`, assumeYes);

    const updated = await apiJson('PUT', `${base}/api/configurations/${existing.id}`, config);
    console.log(JSON.stringify(updated, null, 2));
}

async function cmdDescribe(base, ref, text, assumeYes) {
    // Sugar for `update --description`, because backfilling descriptions across the catalog is
    // the one bulk edit anyone actually does.
    const existing = await resolveRef(base, ref);
    const { attachments, id, ...current } = existing;
    const config = { ...current, description: text };

    await confirm(
        `describe ${existing.name} (id ${existing.id}) on ${base}:\n` +
        `  was: ${existing.description || '(none)'}\n  now: ${text}`,
        assumeYes,
    );
    await apiJson('PUT', `${base}/api/configurations/${existing.id}`, config);
    console.log(`described ${existing.name}`);
}

async function cmdDelete(base, ref, assumeYes) {
    const existing = await resolveRef(base, ref);
    await confirm(
        `delete configuration ${existing.name} (id ${existing.id}) from ${base}, ` +
        `along with its ${(existing.attachments || []).length} attachment(s)`,
        assumeYes,
    );
    await apiJson('DELETE', `${base}/api/configurations/${existing.id}`);
    console.log(`deleted ${existing.name}`);
}

// ---------------------------------------------------------------------------- attachments

async function cmdUpload(base, ref, filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`${filePath} is not a file`);

    const config = await resolveRef(base, ref);
    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buffer]), path.basename(filePath));

    const res = await fetch(`${base}/api/configurations/${config.id}/attachments`, {
        method: 'POST',
        body: form,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`upload -> ${res.status} ${res.statusText}\n${text}`);
    }
    const attachment = await res.json();
    console.log(`uploaded ${path.basename(filePath)} (${stat.size} bytes) -> ${config.name}`);
    console.log(JSON.stringify(attachment, null, 2));
}

async function cmdDownload(base, attachmentId, outFile) {
    const res = await fetch(`${base}/api/attachments/${attachmentId}/download`, { redirect: 'follow' });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`download -> ${res.status} ${res.statusText}\n${text}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outFile, buffer);
    console.log(`saved ${buffer.length} bytes to ${outFile}`);
}

async function cmdDeleteAttachment(base, attachmentId) {
    await apiJson('DELETE', `${base}/api/attachments/${attachmentId}`);
    console.log(`deleted attachment ${attachmentId}`);
}

async function cmdRenameAttachment(base, attachmentId, newName) {
    const trimmed = String(newName).trim();
    if (!trimmed) throw new Error('usage: rename-attachment <attachmentId> <newName>');
    const renamed = await apiJson('PUT', `${base}/api/attachments/${attachmentId}`, { original_name: trimmed });
    console.log(`renamed attachment ${attachmentId} -> ${renamed.original_name}`);
    console.log(JSON.stringify(renamed, null, 2));
}

// ---------------------------------------------------------------------------- entry point

const USAGE = `usage: vulndb-cli [--url <vulndb-ui url>] <command> [args]

read:
  list [--platform P] [--category C] [--search TEXT] [--json]
                                       list configurations with their descriptions
  get <id|name>                        show one configuration (incl. attachments) as JSON

write (ask before applying; --yes to skip):
  create --file <json|->                       create a configuration from a JSON document
  create --name X [--platform P] [--category C] [--type T]
         [--script-file F] [--description TEXT] [--run-as U] [--depends-on JSON]
  update <id|name> [--file <json|->] [--name X] [--description TEXT] [...]
                                       change some fields, leaving the rest alone
  describe <id|name> <text>            set just the description
  delete <id|name>                     delete a configuration and its attachments

attachments:
  upload <id|name> <file>              attach a file to a configuration
  download <attachmentId> <outfile>    download an attachment by id
  rename-attachment <attachmentId> <newName>
                                       rename an attachment
  delete-attachment <attachmentId>     delete an attachment by id`;

async function main() {
    const args = process.argv.slice(2);
    const base = baseUrl(args);
    const assumeYes = takeFlag(args, 'yes');
    const [cmd, ...rest] = args;

    switch (cmd) {
        case 'list':
            return cmdList(base, rest);
        case 'get':
            if (!rest[0]) throw new Error('usage: get <id|name>');
            return cmdGet(base, rest[0]);
        case 'create':
            return cmdCreate(base, rest, assumeYes);
        case 'update':
            if (!rest[0]) throw new Error('usage: update <id|name> [flags]');
            return cmdUpdate(base, rest[0], rest.slice(1), assumeYes);
        case 'describe':
            if (!rest[0] || rest[1] === undefined) throw new Error('usage: describe <id|name> <text>');
            return cmdDescribe(base, rest[0], rest.slice(1).join(' '), assumeYes);
        case 'delete':
            if (!rest[0]) throw new Error('usage: delete <id|name>');
            return cmdDelete(base, rest[0], assumeYes);
        case 'upload':
            if (!rest[0] || !rest[1]) throw new Error('usage: upload <id|name> <file>');
            return cmdUpload(base, rest[0], rest[1]);
        case 'download':
            if (!rest[0] || !rest[1]) throw new Error('usage: download <attachmentId> <outfile>');
            return cmdDownload(base, rest[0], rest[1]);
        case 'rename-attachment':
            if (!rest[0] || !rest[1]) throw new Error('usage: rename-attachment <attachmentId> <newName>');
            return cmdRenameAttachment(base, rest[0], rest[1]);
        case 'delete-attachment':
            if (!rest[0]) throw new Error('usage: delete-attachment <attachmentId>');
            return cmdDeleteAttachment(base, rest[0]);
        default:
            console.error(USAGE);
            process.exit(cmd ? 1 : 0);
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
