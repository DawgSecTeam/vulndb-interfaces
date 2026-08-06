const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const Minio = require('minio');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { Client } = require('ssh2');
const net = require('net');

// These are all required to bring up the SSH tunnel, DB pool, and MinIO client below — a
// missing one used to surface as an opaque connection failure well after startup.
const REQUIRED_ENV = ['DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SSH_HOST', 'SSH_USER', 'SSH_PASSWORD', 'MINIO_URL', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
    console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
    console.error('See .env.example for the full list.');
    process.exit(1);
}

let pool;
let minioClient;
const upload = multer({ dest: os.tmpdir() });

// Backup config — all optional so existing deployments don't break. The DB runs on the same
// host as this server (the SSH tunnel above is only a dev-time convenience), so backups shell
// out to the real mysqldump/mysql client tools locally rather than hand-rolling a dump.
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(os.homedir(), '.vulndb-backups'));
const BACKUP_CRON = process.env.BACKUP_CRON || '0 3 * * *'; // daily at 3am; 'off' disables scheduling
const BACKUP_RETENTION = Number(process.env.BACKUP_RETENTION) || 30;

// public/ is served with express.static — backups must never be able to land there, or they'd
// be downloadable by anyone without going through the (validated) /api/backups routes.
if (BACKUP_DIR === PUBLIC_DIR || BACKUP_DIR.startsWith(PUBLIC_DIR + path.sep)) {
    console.error(`BACKUP_DIR (${BACKUP_DIR}) resolves inside the statically-served public/ directory — refusing to start.`);
    process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
try {
    const mode = fs.statSync(BACKUP_DIR).mode & 0o777;
    if (mode & 0o077) {
        console.warn(`Warning: BACKUP_DIR (${BACKUP_DIR}) is readable/writable beyond its owner (mode ${mode.toString(8)}) — consider chmod 700.`);
    }
} catch { /* best-effort check only */ }

const setupDatabase = () => {
    return new Promise((resolve, reject) => {
        const sshClient = new Client();
        
        // Start a local server to pipe to the SSH tunnel
        const server = net.createServer(socket => {
            sshClient.forwardOut(
                socket.remoteAddress || '127.0.0.1',
                socket.remotePort || 0,
                process.env.DB_HOST || '127.0.0.1',
                Number(process.env.DB_PORT) || 3306,
                (err, stream) => {
                    if (err) {
                        console.error('SSH forwardOut error:', err);
                        socket.end();
                        return;
                    }
                    socket.pipe(stream).pipe(socket);
                }
            );
        });

        sshClient.on('ready', () => {
            console.log('SSH tunnel established');
            
            // Listen on a random free port for the local port forwarder
            server.listen(0, '127.0.0.1', () => {
                const localPort = server.address().port;
                console.log(`Local port forwarder listening on port ${localPort}`);
                
                // Initialize the MySQL pool to connect to the local port forwarder
                pool = mysql.createPool({
                    host: '127.0.0.1',
                    port: localPort,
                    user: process.env.DB_USER,
                    password: process.env.DB_PASSWORD,
                    database: process.env.DB_NAME,
                    waitForConnections: true,
                    connectionLimit: 10,
                    queueLimit: 0
                });
                
                resolve();
            });
        }).on('error', err => {
            console.error('SSH connection error:', err);
            reject(err);
        });

        // Connect SSH using credentials from .env
        sshClient.connect({
            host: process.env.SSH_HOST,
            port: Number(process.env.SSH_PORT) || 22,
            username: process.env.SSH_USER,
            password: process.env.SSH_PASSWORD
        });
    });
};

const setupMinio = async () => {
    const url = new URL(process.env.MINIO_URL);
    minioClient = new Minio.Client({
        endPoint: url.hostname,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        useSSL: url.protocol === 'https:',
        accessKey: process.env.MINIO_ACCESS_KEY,
        secretKey: process.env.MINIO_SECRET_KEY
    });

    const bucket = process.env.MINIO_BUCKET;
    if (!(await minioClient.bucketExists(bucket))) {
        await minioClient.makeBucket(bucket);
        console.log(`Created MinIO bucket "${bucket}"`);
    }
};

// ---------------------------------------------------------------------------- backups

// MariaDB hosts sometimes only ship the newer mariadb-dump/mariadb names, so try the classic
// names first and fall back rather than hard-failing at startup — the rest of the app works
// fine without either, backups just won't until the client tools are installed.
let dumpTool = null;
let clientTool = null;

function checkTool(cmd) {
    return new Promise(resolve => execFile(cmd, ['--version'], err => resolve(!err)));
}

const resolveBackupTools = async () => {
    dumpTool = (await checkTool('mysqldump')) ? 'mysqldump' : (await checkTool('mariadb-dump')) ? 'mariadb-dump' : null;
    clientTool = (await checkTool('mysql')) ? 'mysql' : (await checkTool('mariadb')) ? 'mariadb' : null;
    if (!dumpTool || !clientTool) {
        console.warn('Warning: mysqldump/mysql (or mariadb-dump/mariadb) not found on PATH — DB backups and restores will fail until the MySQL/MariaDB client tools are installed on this host.');
    }
};

const BACKUP_FILENAME_RE = /^vulndb-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sql\.gz$/;

function backupFilename(date = new Date()) {
    return `vulndb-backup-${date.toISOString().replace(/[:.]/g, '-')}.sql.gz`;
}

// A short-lived credentials file beats `-p<password>` or MYSQL_PWD — neither should show up in
// `ps`, and MYSQL_PWD is also visible to anything that can read /proc/<pid>/environ.
function writeClientCnf() {
    const cnfPath = path.join(os.tmpdir(), `vulndb-backup-${crypto.randomUUID()}.cnf`);
    fs.writeFileSync(cnfPath, `[client]\nuser=${process.env.DB_USER}\npassword=${process.env.DB_PASSWORD}\n`, { mode: 0o600 });
    return cnfPath;
}

// Resolves a filename param to a real path inside BACKUP_DIR, or null if it doesn't look like a
// backup this server generated — the regex alone rules out traversal, the dirname check is
// defense in depth against a future looser regex.
function resolveBackupPath(filename) {
    if (typeof filename !== 'string' || !BACKUP_FILENAME_RE.test(filename)) return null;
    const resolved = path.join(BACKUP_DIR, filename);
    if (path.dirname(resolved) !== BACKUP_DIR) return null;
    return resolved;
}

async function listBackups() {
    const entries = await fs.promises.readdir(BACKUP_DIR).catch(() => []);
    const backups = await Promise.all(
        entries.filter(name => BACKUP_FILENAME_RE.test(name)).map(async name => {
            const stat = await fs.promises.stat(path.join(BACKUP_DIR, name));
            return { filename: name, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
        })
    );
    // Filenames are ISO-timestamp based, so a lexical sort is also a chronological one.
    backups.sort((a, b) => b.filename.localeCompare(a.filename));
    return backups;
}

async function pruneOldBackups() {
    const stale = (await listBackups()).slice(BACKUP_RETENTION);
    await Promise.all(stale.map(b => fs.promises.unlink(path.join(BACKUP_DIR, b.filename)).catch(() => {})));
}

function runBackup() {
    return new Promise((resolve, reject) => {
        if (!dumpTool) {
            return reject(new Error('mysqldump (or mariadb-dump) is not available on PATH — install MySQL/MariaDB client tools on this host'));
        }

        const filename = backupFilename();
        const destPath = path.join(BACKUP_DIR, filename);
        const cnfPath = writeClientCnf();

        let settled = false;
        const fail = err => {
            if (settled) return;
            settled = true;
            fs.unlink(cnfPath, () => {});
            fs.unlink(destPath, () => {});
            reject(err);
        };

        const dump = spawn(dumpTool, [
            `--defaults-extra-file=${cnfPath}`,
            '-h', process.env.DB_HOST || '127.0.0.1',
            '-P', String(process.env.DB_PORT || 3306),
            '--single-transaction', '--quick', '--routines', '--triggers',
            process.env.DB_NAME,
        ]);

        let stderr = '';
        dump.stderr.on('data', chunk => { stderr += chunk; });
        dump.on('error', fail);
        dump.on('close', code => {
            if (code !== 0) fail(new Error(`${dumpTool} exited with code ${code}: ${stderr.trim()}`));
        });

        const out = fs.createWriteStream(destPath, { mode: 0o600 });
        out.on('error', fail);
        dump.stdout.pipe(zlib.createGzip()).pipe(out);

        out.on('finish', async () => {
            if (settled) return;
            settled = true;
            fs.unlink(cnfPath, () => {});
            try {
                const stat = await fs.promises.stat(destPath);
                await pruneOldBackups();
                resolve({ filename, size_bytes: stat.size, created_at: stat.mtime.toISOString() });
            } catch (err) {
                reject(err);
            }
        });
    });
}

// Restores the DB from `filename`, taking a fresh safety backup first so a bad restore can
// itself be undone. mysqldump's default output includes `DROP TABLE IF EXISTS` before each
// `CREATE TABLE`, so importing it fully replaces both tables' schema and data.
async function restoreBackup(filename) {
    if (!clientTool) {
        throw new Error('mysql (or mariadb) client is not available on PATH — install MySQL/MariaDB client tools on this host');
    }
    const targetPath = resolveBackupPath(filename);
    if (!targetPath || !fs.existsSync(targetPath)) {
        const err = new Error('Backup not found');
        err.status = 404;
        throw err;
    }

    const safetyBackup = await runBackup();

    await new Promise((resolve, reject) => {
        const cnfPath = writeClientCnf();
        const client = spawn(clientTool, [
            `--defaults-extra-file=${cnfPath}`,
            '-h', process.env.DB_HOST || '127.0.0.1',
            '-P', String(process.env.DB_PORT || 3306),
            process.env.DB_NAME,
        ]);

        let stderr = '';
        client.stderr.on('data', chunk => { stderr += chunk; });
        client.on('error', err => { fs.unlink(cnfPath, () => {}); reject(err); });
        client.on('close', code => {
            fs.unlink(cnfPath, () => {});
            if (code !== 0) return reject(new Error(`${clientTool} exited with code ${code}: ${stderr.trim()}`));
            resolve();
        });

        fs.createReadStream(targetPath).pipe(zlib.createGunzip()).pipe(client.stdin);
    });

    return safetyBackup;
}

function parseDependsOn(row) {
    if (row.depends_on == null) return { ...row, depends_on: [] };
    if (typeof row.depends_on === 'string') {
        try {
            return { ...row, depends_on: JSON.parse(row.depends_on) };
        } catch {
            // Malformed JSON shouldn't be possible through the validated API, but a row edited
            // directly in the DB could have it — don't let that 500 every read of the table.
            return { ...row, depends_on: [] };
        }
    }
    return row;
}

// GET all configurations
app.get('/api/configurations', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM configurations');
        const [attachments] = await pool.query(
            'SELECT id, configuration_id, original_name, mime_type, size_bytes, uploaded_at FROM attachments'
        );

        const attachmentsByConfig = new Map();
        for (const attachment of attachments) {
            const list = attachmentsByConfig.get(attachment.configuration_id) || [];
            list.push(attachment);
            attachmentsByConfig.set(attachment.configuration_id, list);
        }

        res.json(rows.map(parseDependsOn).map(row => ({
            ...row,
            attachments: attachmentsByConfig.get(row.id) || []
        })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PLATFORMS = ['linux', 'windows', 'other'];
const CATEGORIES = ['misconfiguration', 'service', 'vulnerability'];
const TYPES = ['bash', 'powershell', 'command'];

// Returns an error string, or null if the body is acceptable.
//
// These columns are MySQL ENUMs, so a bad value used to surface as a bare driver error (or, on a
// non-strict server, a silently truncated row). Now that programs write here — vulndb-cli create,
// and agents through it — a malformed write should come back as a clear 400.
//
// Deliberately NOT enforced: a non-empty script. Some catalog rows legitimately carry an empty
// script and do all their work through depends_on (suid-vim is just install-package PACKAGE=vim),
// and rejecting those would make it impossible to edit their description. `nakon catalog check`
// warns about empty scripts, which is the right place for a judgement call rather than a hard 400.
function validateConfiguration(body) {
    if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
    if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
    if (!PLATFORMS.includes(body.platform)) return `platform must be one of ${PLATFORMS.join(', ')}`;
    if (!CATEGORIES.includes(body.category)) return `category must be one of ${CATEGORIES.join(', ')}`;
    if (!TYPES.includes(body.type)) return `type must be one of ${TYPES.join(', ')}`;
    if (typeof body.script !== 'string') return 'script must be a string';
    if (body.description != null && typeof body.description !== 'string') {
        return 'description must be a string or null';
    }
    if (body.depends_on != null && !Array.isArray(body.depends_on)) {
        return 'depends_on must be an array';
    }
    return null;
}

// POST a new configuration
app.post('/api/configurations', async (req, res) => {
    const invalid = validateConfiguration(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    const { name, description, platform, category, type, script, run_as, depends_on } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO configurations (name, description, platform, category, type, script, run_as, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, description ?? null, platform, category, type, script, run_as, JSON.stringify(depends_on || [])]
        );
        res.status(201).json({ id: result.insertId, name, description: description ?? null, platform, category, type, script, run_as, depends_on: depends_on || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT update a configuration
app.put('/api/configurations/:id', async (req, res) => {
    const invalid = validateConfiguration(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    const { name, description, platform, category, type, script, run_as, depends_on } = req.body;
    try {
        await pool.query(
            'UPDATE configurations SET name = ?, description = ?, platform = ?, category = ?, type = ?, script = ?, run_as = ?, depends_on = ? WHERE id = ?',
            [name, description ?? null, platform, category, type, script, run_as, JSON.stringify(depends_on || []), req.params.id]
        );
        res.json({ id: req.params.id, name, description: description ?? null, platform, category, type, script, run_as, depends_on: depends_on || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE a configuration — blocked if another configuration still depends on it
app.delete('/api/configurations/:id', async (req, res) => {
    try {
        const [[target]] = await pool.query('SELECT name FROM configurations WHERE id = ?', [req.params.id]);
        if (!target) {
            return res.status(404).json({ error: 'Configuration not found' });
        }

        const [rows] = await pool.query('SELECT name, depends_on FROM configurations WHERE id != ?', [req.params.id]);
        const dependents = rows
            .map(parseDependsOn)
            .filter(row => row.depends_on.some(dep => (typeof dep === 'string' ? dep : dep.name) === target.name))
            .map(row => row.name);

        if (dependents.length > 0) {
            return res.status(409).json({ error: 'Configuration is still depended on', dependents });
        }

        const [attachments] = await pool.query('SELECT object_key FROM attachments WHERE configuration_id = ?', [req.params.id]);
        if (attachments.length > 0) {
            await minioClient.removeObjects(process.env.MINIO_BUCKET, attachments.map(a => a.object_key));
        }

        await pool.query('DELETE FROM configurations WHERE id = ?', [req.params.id]);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST a new attachment for a configuration
app.post('/api/configurations/:id/attachments', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const originalName = path.basename(req.file.originalname);
    const objectKey = `${req.params.id}/${crypto.randomUUID()}-${originalName}`;

    try {
        await minioClient.fPutObject(process.env.MINIO_BUCKET, objectKey, req.file.path, {
            'Content-Type': req.file.mimetype || 'application/octet-stream'
        });

        const [result] = await pool.query(
            'INSERT INTO attachments (configuration_id, object_key, original_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)',
            [req.params.id, objectKey, originalName, req.file.mimetype, req.file.size]
        );

        res.status(201).json({
            id: result.insertId,
            configuration_id: Number(req.params.id),
            original_name: originalName,
            mime_type: req.file.mimetype,
            size_bytes: req.file.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// PUT rename an attachment
app.put('/api/attachments/:attachmentId', async (req, res) => {
    const originalName = path.basename(String(req.body.original_name || '').trim());
    if (!originalName) {
        return res.status(400).json({ error: 'original_name is required' });
    }

    try {
        const [result] = await pool.query(
            'UPDATE attachments SET original_name = ? WHERE id = ?',
            [originalName, req.params.attachmentId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Attachment not found' });
        }
        res.json({ id: Number(req.params.attachmentId), original_name: originalName });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE an attachment
app.delete('/api/attachments/:attachmentId', async (req, res) => {
    try {
        const [[attachment]] = await pool.query('SELECT object_key FROM attachments WHERE id = ?', [req.params.attachmentId]);
        if (!attachment) {
            return res.status(404).json({ error: 'Attachment not found' });
        }

        await minioClient.removeObject(process.env.MINIO_BUCKET, attachment.object_key);
        await pool.query('DELETE FROM attachments WHERE id = ?', [req.params.attachmentId]);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET a presigned download URL and redirect to it
app.get('/api/attachments/:attachmentId/download', async (req, res) => {
    try {
        const [[attachment]] = await pool.query('SELECT object_key, original_name FROM attachments WHERE id = ?', [req.params.attachmentId]);
        if (!attachment) {
            return res.status(404).json({ error: 'Attachment not found' });
        }

        const url = await minioClient.presignedGetObject(process.env.MINIO_BUCKET, attachment.object_key, 300, {
            'response-content-disposition': `attachment; filename="${attachment.original_name}"`
        });
        res.redirect(url);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET all backups
app.get('/api/backups', async (req, res) => {
    try {
        res.json(await listBackups());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST trigger a backup now
app.post('/api/backups', async (req, res) => {
    try {
        res.status(201).json(await runBackup());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET download a backup file
app.get('/api/backups/:filename/download', (req, res) => {
    const targetPath = resolveBackupPath(req.params.filename);
    if (!targetPath || !fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(targetPath, req.params.filename);
});

// POST restore the DB from a backup — destructive; takes a safety backup of the current DB first
app.post('/api/backups/:filename/restore', async (req, res) => {
    try {
        const safetyBackup = await restoreBackup(req.params.filename);
        res.json({ restored: req.params.filename, safety_backup: safetyBackup.filename });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

// DELETE a backup file
app.delete('/api/backups/:filename', async (req, res) => {
    const targetPath = resolveBackupPath(req.params.filename);
    if (!targetPath || !fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    try {
        await fs.promises.unlink(targetPath);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Global error handler — catches anything an async route handler forgot to try/catch itself
// (e.g. a thrown error before an await), so it comes back as a 500 instead of crashing the process.
app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
Promise.all([setupDatabase(), setupMinio(), resolveBackupTools()]).then(() => {
    if (BACKUP_CRON === 'off') {
        console.log('Scheduled backups disabled (BACKUP_CRON=off)');
    } else if (!cron.validate(BACKUP_CRON)) {
        console.warn(`Warning: BACKUP_CRON ("${BACKUP_CRON}") is not a valid cron expression — scheduled backups are disabled.`);
    } else {
        cron.schedule(BACKUP_CRON, () => {
            runBackup().catch(err => console.error('Scheduled backup failed:', err.message));
        });
        console.log(`Scheduled backups: "${BACKUP_CRON}" (retaining last ${BACKUP_RETENTION}) -> ${BACKUP_DIR}`);
    }

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
