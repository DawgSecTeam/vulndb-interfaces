const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
require('dotenv').config();

const app = express();

// ---------------------------------------------------------------------------
// Determine mode
// ---------------------------------------------------------------------------
const IS_TEST = process.env.TEST_MODE === 'true' || process.env.NODE_ENV === 'test';

// ---- cors ----------------------------------------------------------------
app.use(require('cors')());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let pool;            // MySQL pool (normal mode) or in-memory store (test mode)
let minioClient;     // MinIO client (normal mode) or fs-backed shim (test mode)
let nextConfigId = 1;
let nextAttachmentId = 1;

const upload = multer({ dest: os.tmpdir() });

// ================================ NORMAL MODE ==============================

if (!IS_TEST) {
    const mysql = require('mysql2/promise');
    const Minio = require('minio');
    const { Client } = require('ssh2');
    const net = require('net');

    // ---- Validate required environment variables ---------------------------
    const REQUIRED = ['DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SSH_HOST', 'SSH_USER', 'SSH_PASSWORD', 'MINIO_URL', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET'];
    const missing = REQUIRED.filter(k => !process.env[k]);
    if (missing.length) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        console.error('See .env.example for the full list.');
        process.exit(1);
    }

    const setupDatabase = () => {
        return new Promise((resolve, reject) => {
            const sshClient = new Client();

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
                server.listen(0, '127.0.0.1', () => {
                    const localPort = server.address().port;
                    console.log(`Local port forwarder listening on port ${localPort}`);
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

    module.exports = { app }; // exported for testing
    Promise.all([setupDatabase(), setupMinio()]).then(() => {
        const PORT = Number(process.env.PORT) || 3000;
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    }).catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}

// ================================ TEST MODE ================================

// In-memory data store (replaces MySQL + MinIO)
const configs = [];
const attachStore = [];

const testDbQuery = (sql, params) => {
    // Minimal SQL parser for SELECT, INSERT, UPDATE, DELETE on our two tables
    const upper = sql.trim().toUpperCase();

    if (upper.includes('FROM CONFIGURATIONS') && upper.startsWith('SELECT')) {
        const whereMatch = sql.match(/WHERE\s+id\s*!=\s*\?/i);
        if (whereMatch) {
            const excludeId = Number(params[0]);
            return [configs.filter(c => c.id !== excludeId)];
        }
        const idMatch = sql.match(/WHERE\s+id\s*=\s*\?/i);
        if (idMatch) {
            const found = configs.filter(c => c.id === Number(params[0]));
            return [found];
        }
        return [configs];
    }

    if (upper.startsWith('SELECT ID, CONFIGURATION_ID, ORIGINAL_NAME, MIME_TYPE, SIZE_BYTES, UPLOADED_AT FROM ATTACHMENTS')) {
        const idMatch = sql.match(/WHERE\s+id\s*=\s*\?/i);
        if (idMatch) {
            const found = attachStore.filter(a => a.id === Number(params[0]));
            return [[found.length ? found[0] : undefined]];
        }
        const configMatch = sql.match(/WHERE\s+configuration_id\s*=\s*\?/i);
        if (configMatch) {
            return [attachStore.filter(a => a.configuration_id === Number(params[0]))];
        }
        return [attachStore];
    }

    if (upper.startsWith('INSERT INTO CONFIGURATIONS')) {
        // name, platform, category, type, script, run_as, depends_on
        const row = {
            id: nextConfigId++,
            name: params[0],
            platform: params[1],
            category: params[2],
            type: params[3],
            script: params[4],
            run_as: params[5],
            depends_on: params[6]
        };
        configs.push(row);
        return [{ insertId: row.id }];
    }

    if (upper.startsWith('UPDATE CONFIGURATIONS')) {
        // name = ?, platform = ?, category = ?, type = ?, script = ?, run_as = ?, depends_on = ? WHERE id = ?
        const id = Number(params[7]);
        const idx = configs.findIndex(c => c.id === id);
        if (idx !== -1) {
            configs[idx].name = params[0];
            configs[idx].platform = params[1];
            configs[idx].category = params[2];
            configs[idx].type = params[3];
            configs[idx].script = params[4];
            configs[idx].run_as = params[5];
            configs[idx].depends_on = params[6];
        }
        return [{ affectedRows: idx !== -1 ? 1 : 0 }];
    }

    if (upper.startsWith('DELETE FROM CONFIGURATIONS')) {
        const idMatch = sql.match(/WHERE\s+id\s*=\s*\?/i);
        if (idMatch) {
            const id = Number(params[0]);
            const idx = configs.findIndex(c => c.id === id);
            if (idx !== -1) {
                configs.splice(idx, 1);
                // cascade: remove attachments
                for (let i = attachStore.length - 1; i >= 0; i--) {
                    if (attachStore[i].configuration_id === id) attachStore.splice(i, 1);
                }
            }
            return [{ affectedRows: idx !== -1 ? 1 : 0 }];
        }
        return [{ affectedRows: 0 }];
    }

    if (upper.startsWith('INSERT INTO ATTACHMENTS')) {
        // configuration_id, object_key, original_name, mime_type, size_bytes
        const a = {
            id: nextAttachmentId++,
            configuration_id: Number(params[0]),
            object_key: params[1],
            original_name: params[2],
            mime_type: params[3],
            size_bytes: Number(params[4]),
            uploaded_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
        };
        attachStore.push(a);
        return [{ insertId: a.id }];
    }

    if (upper.startsWith('UPDATE ATTACHMENTS')) {
        // UPDATE attachments SET original_name = ? WHERE id = ?
        const id = Number(params[1]);
        const idx = attachStore.findIndex(a => a.id === id);
        if (idx !== -1) {
            attachStore[idx].original_name = params[0];
        }
        return [{ affectedRows: idx !== -1 ? 1 : 0 }];
    }

    if (upper.startsWith('DELETE FROM ATTACHMENTS')) {
        const idMatch = sql.match(/WHERE\s+id\s*=\s*\?/i);
        if (idMatch) {
            const id = Number(params[0]);
            const idx = attachStore.findIndex(a => a.id === id);
            if (idx !== -1) {
                // remove from fs
                const objKey = attachStore[idx].object_key;
                if (objKey && objKey.startsWith('test:')) {
                    const fpath = objKey.slice(5);
                    fs.unlink(fpath, () => {});
                }
                attachStore.splice(idx, 1);
            }
            return [{ affectedRows: idx !== -1 ? 1 : 0 }];
        }
        return [{ affectedRows: 0 }];
    }

    // Fallback: return empty
    return [[]];
};

// Mock pool.query that returns { rows } in the same shape as mysql2
pool = {
    query: async (...args) => {
        // Support both pool.query(sql, params) and pool.query({sql, values})
        let sql, params;
        if (typeof args[0] === 'object' && args[0].sql) {
            sql = args[0].sql;
            params = args[0].values || [];
        } else {
            sql = args[0];
            params = args[1] || [];
        }
        const result = testDbQuery(sql, params);
        return result;
    }
};

// MinIO shim: store files in a temp directory
const TEST_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vulndb-test-attach-'));
minioClient = {
    fPutObject: async (bucket, key, filePath) => {
        const dest = path.join(TEST_ATTACH_DIR, path.basename(key));
        await fs.promises.copyFile(filePath, dest);
        return dest;
    },
    removeObject: async (bucket, key) => {
        const fpath = path.join(TEST_ATTACH_DIR, path.basename(key));
        fs.unlink(fpath, () => {});
    },
    removeObjects: async (bucket, keys) => {
        for (const key of keys) {
            const fpath = path.join(TEST_ATTACH_DIR, path.basename(key));
            fs.unlink(fpath, () => {});
        }
    },
    presignedGetObject: async (bucket, key) => {
        // Return a local file URL for test mode
        const fpath = path.join(TEST_ATTACH_DIR, path.basename(key));
        // Check if it exists and return as data URI or just a path
        if (fs.existsSync(fpath)) {
            return `file://${fpath}`;
        }
        return `file://${fpath}`;
    },
    bucketExists: async () => true,
    makeBucket: async () => {}
};

console.log('Running in TEST MODE — using in-memory store and local file storage.');
module.exports = { app };
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
    console.log(`Test server running on port ${PORT}`);
});

// ================================ SHARED MIDDLEWARE =========================

function parseDependsOn(row) {
    if (row.depends_on == null) return { ...row, depends_on: [] };
    if (typeof row.depends_on === 'string') {
        try {
            return { ...row, depends_on: JSON.parse(row.depends_on) };
        } catch {
            // If JSON is malformed, treat as empty
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

// POST a new configuration
app.post('/api/configurations', async (req, res) => {
    const { name, platform, category, type, script, run_as, depends_on } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
    }
    if (!script || !script.trim()) {
        return res.status(400).json({ error: 'script is required' });
    }
    try {
        const [result] = await pool.query(
            'INSERT INTO configurations (name, platform, category, type, script, run_as, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, platform, category, type, script, run_as, JSON.stringify(depends_on || [])]
        );
        res.status(201).json({ id: result.insertId, name, platform, category, type, script, run_as, depends_on: depends_on || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT update a configuration
app.put('/api/configurations/:id', async (req, res) => {
    const { name, platform, category, type, script, run_as, depends_on } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
    }
    if (!script || !script.trim()) {
        return res.status(400).json({ error: 'script is required' });
    }
    try {
        await pool.query(
            'UPDATE configurations SET name = ?, platform = ?, category = ?, type = ?, script = ?, run_as = ?, depends_on = ? WHERE id = ?',
            [name, platform, category, type, script, run_as, JSON.stringify(depends_on || []), req.params.id]
        );
        res.json({ id: req.params.id, name, platform, category, type, script, run_as, depends_on: depends_on || [] });
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

// Global error handler
app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});


