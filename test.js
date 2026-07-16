#!/usr/bin/env node
/**
 * E2E test for vulndb-ui.
 * Starts the server as a child process in TEST_MODE, exercises all API
 * endpoints via raw http, and exits 0 on success or 1 on failure.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const SERVER_PORT = 3456;
const SERVER_PATH = path.join(__dirname, 'server.js');
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

let serverProcess;
let passed = 0;
let failed = 0;

function assert(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function fetch(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForServer(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${SERVER_PORT}/api/configurations`, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error('Server did not start within timeout'));
        } else {
          setTimeout(tryConnect, 300);
        }
      });
      req.end();
    };
    tryConnect();
  });
}

async function run() {
  console.log('Starting vulndb-ui server in test mode...');

  serverProcess = spawn('node', [SERVER_PATH], {
    env: {
      ...process.env,
      TEST_MODE: 'true',
      PORT: String(SERVER_PORT)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (d) => {
    console.log(`[server] ${d.toString().trim()}`);
  });
  serverProcess.stderr.on('data', (d) => {
    console.error(`[server:err] ${d.toString().trim()}`);
  });

  try {
    await waitForServer();
    console.log('Server is ready.\n');
  } catch (err) {
    console.error('Failed to start server:', err.message);
    serverProcess.kill();
    process.exit(1);
  }

  console.log('E2E Tests\n');

  // ---- 1. GET /api/configurations (empty) ----
  {
    const r = await fetch('GET', '/api/configurations');
    assert('GET /api/configurations returns 200', r.status === 200);
    assert('  returns empty array', Array.isArray(r.body) && r.body.length === 0);
  }

  // ---- 2. POST /api/configurations (create) ----
  {
    const r = await fetch('POST', '/api/configurations', {
      name: 'test-config',
      platform: 'linux',
      category: 'vulnerability',
      type: 'bash',
      script: 'echo hello',
      run_as: 'root',
      depends_on: []
    });
    assert('POST /api/configurations returns 201', r.status === 201);
    assert('  returns id', r.body && typeof r.body.id === 'number');
    assert('  returns name', r.body && r.body.name === 'test-config');
  }

  // ---- 3. POST validation (missing name) ----
  {
    const r = await fetch('POST', '/api/configurations', {
      platform: 'linux',
      category: 'vulnerability',
      type: 'bash',
      script: 'echo hello',
      run_as: 'root'
    });
    assert('POST rejects missing name with 400', r.status === 400);
    assert('  error message mentions name', r.body && r.body.error && r.body.error.toLowerCase().includes('name'));
  }

  // ---- 4. POST validation (missing script) ----
  {
    const r = await fetch('POST', '/api/configurations', {
      name: 'no-script',
      platform: 'linux',
      category: 'vulnerability',
      type: 'bash',
      run_as: 'root'
    });
    assert('POST rejects missing script with 400', r.status === 400);
    assert('  error message mentions script', r.body && r.body.error && r.body.error.toLowerCase().includes('script'));
  }

  // ---- 5. GET /api/configurations (with data) ----
  {
    const r = await fetch('GET', '/api/configurations');
    assert('GET /api/configurations has data', r.status === 200);
    assert('  has 1 config', Array.isArray(r.body) && r.body.length === 1);
    assert('  has depends_on as array', Array.isArray(r.body[0].depends_on));
    assert('  has attachments as array', Array.isArray(r.body[0].attachments));
  }

  // ---- 6. PUT /api/configurations/:id (update) ----
  {
    const r = await fetch('PUT', '/api/configurations/1', {
      name: 'updated-config',
      platform: 'windows',
      category: 'misconfiguration',
      type: 'powershell',
      script: 'Write-Host "updated"',
      run_as: 'admin',
      depends_on: []
    });
    assert('PUT /api/configurations/1 returns 200', r.status === 200);
    assert('  name updated', r.body && r.body.name === 'updated-config');
    assert('  platform updated', r.body && r.body.platform === 'windows');
  }

  // ---- 7. PUT validation (missing name) ----
  {
    const r = await fetch('PUT', '/api/configurations/1', {
      platform: 'linux',
      category: 'vulnerability',
      type: 'bash',
      script: 'echo hello',
      run_as: 'root'
    });
    assert('PUT rejects missing name with 400', r.status === 400);
  }

  // ---- 8. GET (verify update persisted) ----
  {
    const r = await fetch('GET', '/api/configurations');
    assert('GET after update works', r.status === 200);
    assert('  first config name is updated-config', r.body[0].name === 'updated-config');
  }

  // ---- 9. POST a second config with dependency ----
  {
    const r = await fetch('POST', '/api/configurations', {
      name: 'dependent-config',
      platform: 'linux',
      category: 'service',
      type: 'bash',
      script: 'echo dep',
      run_as: 'root',
      depends_on: ['updated-config']
    });
    assert('POST second config returns 201', r.status === 201);
    assert('  id is 2', r.body && r.body.id === 2);
  }

  // ---- 10. DELETE blocked by dependency (409) ----
  {
    const r = await fetch('DELETE', '/api/configurations/1');
    assert('DELETE blocked by dependency returns 409', r.status === 409);
    assert('  body has dependents list', r.body && Array.isArray(r.body.dependents));
    assert('  dependent-config is listed', r.body.dependents.includes('dependent-config'));
  }

  // ---- 11. DELETE non-dependent config (204) ----
  {
    const r = await fetch('DELETE', '/api/configurations/2');
    assert('DELETE config 2 returns 204', r.status === 204);
  }

  // ---- 12. DELETE original config now (204) ----
  {
    const r = await fetch('DELETE', '/api/configurations/1');
    assert('DELETE config 1 now returns 204', r.status === 204);
  }

  // ---- 13. DELETE nonexistent (404) ----
  {
    const r = await fetch('DELETE', '/api/configurations/999');
    assert('DELETE nonexistent returns 404', r.status === 404);
  }

  // ---- 14. Attachment: upload without file (400) ----
  {
    const c = await fetch('POST', '/api/configurations', {
      name: 'attach-test',
      platform: 'linux',
      category: 'vulnerability',
      type: 'bash',
      script: 'echo attach',
      run_as: 'root'
    });
    const configId = c.body.id;
    const r2 = await fetch('POST', `/api/configurations/${configId}/attachments`);
    assert('POST attachment without file returns 400', r2.status === 400);
    assert('  error message mentions file', r2.body && r2.body.error && r2.body.error.toLowerCase().includes('file'));
  }

  // ---- 15. GET / serves index.html ----
  {
    const r = await fetch('GET', '/');
    assert('GET / serves index.html', r.status === 200);
    assert('  Content-Type is HTML', r.headers['content-type'] && r.headers['content-type'].includes('text/html'));
  }

  // ---- 16. Dependency with vars ----
  {
    const r = await fetch('POST', '/api/configurations', {
      name: 'config-with-vars',
      platform: 'linux',
      category: 'service',
      type: 'bash',
      script: 'echo vars',
      run_as: 'root',
      depends_on: [{ name: 'some-config', vars: { PORT: '8080', HOST: 'localhost' } }]
    });
    assert('POST config with dependency vars returns 201', r.status === 201);

    const r2 = await fetch('GET', '/api/configurations');
    const found = r2.body.find(c => c.name === 'config-with-vars');
    assert('  config found in list', found !== undefined);
    assert('  depends_on is array', Array.isArray(found.depends_on));
    assert('  depends_on[0] has name', found.depends_on[0].name === 'some-config');
    assert('  depends_on[0] has vars.PORT', found.depends_on[0].vars && found.depends_on[0].vars.PORT === '8080');
  }

  // ---- Summary ----
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed\n`);

  serverProcess.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  if (serverProcess) serverProcess.kill();
  process.exit(1);
});