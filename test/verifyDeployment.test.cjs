'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const path = require('node:path');
const test = require('node:test');

async function runVerifier(baseUrl, environment) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            path.join(process.cwd(), 'scripts', 'verify-deployment.mjs'),
            baseUrl,
        ], {
            cwd: process.cwd(),
            env: { ...process.env, ...environment },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('error', reject);
        child.once('close', code => resolve({ code, output }));
    });
}

async function startFixture(runnerAvailable) {
    const server = createServer((request, response) => {
        if (request.headers.authorization !== `Basic ${Buffer.from('admin:correct horse').toString('base64')}`) {
            response.writeHead(401).end();
            return;
        }
        if (request.url === '/') {
            response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>');
            return;
        }
        const body = request.url === '/health'
            ? { status: runnerAvailable ? 'ok' : 'degraded', runnerAvailable }
            : request.url === '/api/missions'
                ? { success: true, runnerAvailable }
                : { success: true };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
    };
}

test('deployment verifier authenticates and checks the live root app and runner', async t => {
    const fixture = await startFixture(true);
    t.after(() => new Promise((resolve, reject) => {
        fixture.server.close(error => error ? reject(error) : resolve());
    }));

    const result = await runVerifier(fixture.baseUrl, {
        DASHBOARD_USERNAME: 'admin',
        DASHBOARD_PASSWORD: 'correct horse',
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /OK \/api\/missions: HTTP 200/);
});

test('deployment verifier fails when the runner is disconnected', async t => {
    const fixture = await startFixture(false);
    t.after(() => new Promise((resolve, reject) => {
        fixture.server.close(error => error ? reject(error) : resolve());
    }));

    const result = await runVerifier(fixture.baseUrl, {
        DASHBOARD_USERNAME: 'admin',
        DASHBOARD_PASSWORD: 'correct horse',
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /FEHLER \/health: HTTP 200/);
    assert.match(result.output, /FEHLER \/api\/missions: HTTP 200/);
});
