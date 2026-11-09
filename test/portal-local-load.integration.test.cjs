'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { generateLocalContent } = require('../portal/local-generation.cjs');

test('local generation rejects unknown operations without a provider fallback', () => {
    assert.throws(() => generateLocalContent('unknown_provider_request', {}), /nicht verfügbar/);
});

async function unusedPort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function seedAccount(databasePath, token) {
    const db = new sqlite3.Database(databasePath);
    const run = (sql, params) => new Promise((resolve, reject) => {
        db.run(sql, params, error => error ? reject(error) : resolve());
    });
    const now = Date.now();
    try {
        await run('INSERT INTO portal_users(id, email, password_salt, password_hash, created_at, email_verified_at) VALUES (1, ?, ?, ?, ?, ?)',
            ['load@example.test', 'test-salt', 'test-hash', now, now]);
        await run('INSERT INTO portal_sessions(token_hash, user_id, expires_at) VALUES (?, 1, ?)',
            [createHash('sha256').update(token).digest('hex'), now + 600_000]);
        await run('INSERT INTO portal_access_grants(user_id, product_id, source_type, source_id, activated_at) VALUES (1, ?, ?, ?, ?)',
            ['premium', 'test', 'load-test', now]);
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

test('100 parallel local portal generations never contact the configured model endpoint', { timeout: 60_000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-portal-load-'));
    const databasePath = path.join(directory, 'portal.sqlite');
    const port = await unusedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let modelRequests = 0;
    const model = http.createServer((_request, response) => {
        modelRequests += 1;
        response.writeHead(500).end();
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const child = spawn(process.execPath, [path.join(__dirname, '../portal/server.cjs')], {
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            PORTAL_DATABASE_PATH: databasePath,
            PUBLIC_BASE_URL: baseUrl,
            PORTAL_API_RATE_LIMIT: '1000',
            PORTAL_LLM_RATE_LIMIT: '1000',
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
            PORTAL_MARKET_DATA_URL: '',
            PORTAL_TAX_PROFILES_JSON: '[]',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    try {
        let ready = false;
        for (let attempt = 0; attempt < 300; attempt += 1) {
            if (child.exitCode !== null) throw new Error(`Portal exited early:\n${output}`);
            try {
                if ((await fetch(`${baseUrl}/health`)).ok) {
                    ready = true;
                    break;
                }
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(ready, `Portal did not become ready:\n${output}`);
        const token = randomBytes(32).toString('hex');
        await seedAccount(databasePath, token);
        const headers = { 'content-type': 'application/json', origin: baseUrl, cookie: `nv_portal_session=${token}` };
        const ideaInput = {
            topic: 'T'.repeat(120), audience: 'A'.repeat(120), marketCountry: 'Deutschland',
            currency: 'EUR', industry: 'gastronomy', unitPrice: 49, expectedMonthlySales: 10,
            variableCostPerSale: 10, monthlyFixedCosts: 100,
        };
        const initial = await fetch(`${baseUrl}/api/ideas/generate`, {
            method: 'POST', headers, body: JSON.stringify(ideaInput),
        });
        const initialBody = await initial.json();
        assert.equal(initial.status, 201, JSON.stringify(initialBody));
        const ideaId = initialBody.idea.id;
        const industries = ['gastronomy', 'craft', 'ecommerce', 'services', 'software', 'other'];
        const platforms = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x'];
        const start = performance.now();
        const results = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
            const type = index % 3;
            const endpoint = type === 0 ? '/api/ideas/generate'
                : type === 1 ? '/api/workflows/generate' : `/api/ideas/${ideaId}/social-drafts`;
            const body = type === 0 ? { ...ideaInput, industry: industries[Math.floor(index / 3) % industries.length] }
                : type === 1 ? { goal: 'G'.repeat(300), audience: 'A'.repeat(120) }
                    : { platforms: [platforms[Math.floor(index / 3) % platforms.length]] };
            const requestStart = performance.now();
            const response = await fetch(`${baseUrl}${endpoint}`, {
                method: 'POST', headers, body: JSON.stringify(body),
            });
            return { type, status: response.status, body: await response.json(), ms: performance.now() - requestStart };
        }));
        const elapsed = performance.now() - start;
        for (const result of results) {
            assert.equal(result.status, 201, `${JSON.stringify(result)}\n${output}`);
            const content = result.type === 0 ? result.body.idea.idea
                : result.type === 1 ? result.body.workflow.workflow : result.body.drafts[0];
            assert.equal(content.generationMethod, 'local_template');
        }
        assert.equal(modelRequests, 0);
        assert.ok(elapsed < 30_000, `100 requests took ${elapsed.toFixed(0)} ms`);
        t.diagnostic(`100 requests: ${elapsed.toFixed(0)} ms total, max ${Math.max(...results.map(result => result.ms)).toFixed(0)} ms, ${modelRequests} observed model requests`);
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await once(child, 'exit');
        }
        model.closeAllConnections();
        await new Promise(resolve => model.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
