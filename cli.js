#!/usr/bin/env node
// vulndb-cli — thin wrapper around vulndb-ui's own HTTP API (server.js), for scripting
// attachment uploads/downloads and browsing the catalog without opening the web UI.
//
// Usage:
//   node cli.js list
//   node cli.js get <id>
//   node cli.js upload <id> <file>
//   node cli.js download <attachmentId> <outfile>
//   node cli.js delete-attachment <attachmentId>
//
// Base URL: --url <url>, or $VULNDB_UI_URL, or http://127.0.0.1:3000 (same env var name
// nakon itself uses, so a single VULNDB_UI_URL in the environment covers both tools).

const fs = require('fs');
const path = require('path');

function baseUrl(args) {
    const flagIndex = args.indexOf('--url');
    if (flagIndex !== -1 && args[flagIndex + 1]) {
        const url = args[flagIndex + 1];
        args.splice(flagIndex, 2);
        return url.replace(/\/$/, '');
    }
    return (process.env.VULNDB_UI_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
}

async function apiJson(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${method} ${url} -> ${res.status} ${res.statusText}\n${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

async function cmdList(base) {
    const configs = await apiJson('GET', `${base}/api/configurations`);
    configs.sort((a, b) => a.id - b.id);
    for (const c of configs) {
        const attCount = (c.attachments || []).length;
        const attSuffix = attCount ? `  [${attCount} attachment${attCount === 1 ? '' : 's'}]` : '';
        console.log(`${String(c.id).padStart(4)}  ${c.platform.padEnd(8)} ${c.category.padEnd(16)} ${c.name}${attSuffix}`);
    }
}

async function cmdGet(base, id) {
    const configs = await apiJson('GET', `${base}/api/configurations`);
    const c = configs.find(x => String(x.id) === String(id));
    if (!c) throw new Error(`no configuration with id ${id}`);
    console.log(JSON.stringify(c, null, 2));
}

async function cmdUpload(base, id, filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`${filePath} is not a file`);

    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buffer]), path.basename(filePath));

    const res = await fetch(`${base}/api/configurations/${id}/attachments`, {
        method: 'POST',
        body: form,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`upload -> ${res.status} ${res.statusText}\n${text}`);
    }
    const attachment = await res.json();
    console.log(`uploaded ${path.basename(filePath)} (${stat.size} bytes) -> configuration ${id}`);
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

async function main() {
    const args = process.argv.slice(2);
    const base = baseUrl(args);
    const [cmd, ...rest] = args;

    switch (cmd) {
        case 'list':
            return cmdList(base);
        case 'get':
            if (!rest[0]) throw new Error('usage: get <id>');
            return cmdGet(base, rest[0]);
        case 'upload':
            if (!rest[0] || !rest[1]) throw new Error('usage: upload <id> <file>');
            return cmdUpload(base, rest[0], rest[1]);
        case 'download':
            if (!rest[0] || !rest[1]) throw new Error('usage: download <attachmentId> <outfile>');
            return cmdDownload(base, rest[0], rest[1]);
        case 'delete-attachment':
            if (!rest[0]) throw new Error('usage: delete-attachment <attachmentId>');
            return cmdDeleteAttachment(base, rest[0]);
        default:
            console.error(
                'usage: node cli.js [--url <vulndb-ui url>] <command> [args]\n\n' +
                'commands:\n' +
                '  list                                list all configurations\n' +
                '  get <id>                             show one configuration (incl. attachments)\n' +
                '  upload <id> <file>                   upload a file as an attachment on configuration <id>\n' +
                '  download <attachmentId> <outfile>    download an attachment by id\n' +
                '  delete-attachment <attachmentId>     delete an attachment by id'
            );
            process.exit(cmd ? 1 : 0);
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
