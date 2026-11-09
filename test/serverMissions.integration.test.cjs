const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

async function reservePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function removeTemporaryRoot(root) {
    const deadline = Date.now() + 5_000;
    while (true) {
        try {
            await rm(root, { recursive: true, force: true });
            return;
        } catch (error) {
            if (!['EBUSY', 'EPERM'].includes(error.code) || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

async function waitForServer(url, child) {
    const deadline = Date.now() + 60_000;
    let lastStatus = null;
    let lastBody = '';
    let lastError = '';
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('Dashboard-Server wurde vorzeitig beendet.');
        try {
            const response = await fetch(url);
            lastStatus = response.status;
            lastBody = await response.text();
            if (response.ok) return;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Dashboard-Server ist nicht rechtzeitig gestartet (HTTP ${lastStatus}: ${lastBody}; ${lastError}).`);
}

test('dispatches dashboard missions and reflects runner completion', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'dashboard-missions-'));
    const dbPath = path.join(root, 'test.sqlite');
    const dashboardPort = await reservePort();
    const taskApiPort = await reservePort();
    const token = 'integration-test-token';
    let task;
    let runnerControl = { paused: false, infrastructureReady: true, apiStatus: 'healthy' };
    let dispatchCount = 0;
    let acceptTasks = true;
    let acceptControl = true;
    const taskApi = createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        if (request.method === 'POST' && request.url === '/tasks') {
            if (!acceptTasks) {
                response.writeHead(503, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'temporary runner outage' }));
                return;
            }
            let body = '';
            for await (const chunk of request) body += chunk;
            const input = JSON.parse(body);
            dispatchCount += 1;
            task = {
                id: `runner-task-${dispatchCount}`,
                idempotencyKey: `chat:${input.clientRequestId}`,
                status: 'queued',
                result: null,
                error: null,
            };
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ task }));
            return;
        }
        if (request.method === 'POST' && request.url === '/control') {
            if (!acceptControl) {
                response.writeHead(503, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'temporary control outage' }));
                return;
            }
            let body = '';
            for await (const chunk of request) body += chunk;
            const input = JSON.parse(body);
            runnerControl = { ...runnerControl, paused: input.action === 'pause' };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ control: runnerControl }));
            return;
        }
        if (request.method === 'GET' && request.url === '/tasks') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                tasks: task ? [task] : [],
                control: runnerControl,
            }));
            return;
        }
        response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
        taskApi.once('error', reject);
        taskApi.listen(taskApiPort, '127.0.0.1', resolve);
    });
    const child = spawn(process.execPath, ['src/server.cjs'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(dashboardPort),
            DATABASE_PATH: dbPath,
            INTERNAL_AGENT_API_PORT: String(taskApiPort),
            INTERNAL_AGENT_API_TOKEN: token,
            APP_BASIC_AUTH: 'false',
            DASHBOARD_USERNAME: 'dashboard-test',
            DASHBOARD_PASSWORD: 'proxy-auth-test-password',
            DASHBOARD_PROXY_TOKEN: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLogs = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { serverLogs += chunk; });
    child.stderr.on('data', chunk => { serverLogs += chunk; });
    t.after(async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
        });
        await new Promise((resolve, reject) => taskApi.close(error => error ? reject(error) : resolve()));
        await removeTemporaryRoot(root);
    });

    const baseUrl = `http://127.0.0.1:${dashboardPort}`;
    try {
        await waitForServer(`${baseUrl}/api/dashboard-stats`, child);
    } catch (error) {
        throw new Error(`${error.message}${serverLogs ? `\n${serverLogs}` : ''}`);
    }
    const dashboardResponse = await fetch(baseUrl);
    assert.equal(dashboardResponse.status, 200);
    const dashboardHtml = await dashboardResponse.text();
    assert.match(dashboardHtml, /Agent-Ausführung/);
    assert.match(dashboardHtml, /`\/agenten-intern\$\{path\}`/);
    await waitForServer(`${baseUrl}/health`, child);
    const unauthenticatedControl = await fetch(`${baseUrl}/api/runner/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(unauthenticatedControl.status, 403);
    const proxyAuthenticatedControl = await fetch(`${baseUrl}/api/runner/control`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-dashboard-proxy-auth': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            'x-dashboard-actor': 'operator-test',
        },
        body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(proxyAuthenticatedControl.status, 200);
    assert.equal((await proxyAuthenticatedControl.json()).control.paused, true);
    const unauthenticatedAuditLog = await fetch(`${baseUrl}/api/audit-log`);
    assert.equal(unauthenticatedAuditLog.status, 403);
    const wrongProxyTokenAuditLog = await fetch(`${baseUrl}/api/audit-log`, {
        headers: { 'x-dashboard-proxy-auth': 'wrong-proxy-token' },
    });
    assert.equal(wrongProxyTokenAuditLog.status, 403);
    const proxyAuditLog = await fetch(`${baseUrl}/api/audit-log`, {
        headers: {
            'x-dashboard-proxy-auth': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            'x-dashboard-actor': 'operator-test',
        },
    });
    assert.equal(proxyAuditLog.status, 200);
    const auditEntries = (await proxyAuditLog.json()).entries;
    assert.ok(auditEntries.some(entry => entry.action === 'RUNNER_CONTROL_succeeded'
        && entry.details.includes('actor=operator-test')
        && entry.details.includes('action=pause')), JSON.stringify(auditEntries));
    acceptControl = false;
    const failedControl = await fetch(`${baseUrl}/api/runner/control`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-dashboard-proxy-auth': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            'x-dashboard-actor': 'operator-test',
        },
        body: JSON.stringify({ action: 'resume' }),
    });
    assert.equal(failedControl.status, 502);
    const updatedAuditLog = await fetch(`${baseUrl}/api/audit-log`, {
        headers: { 'x-dashboard-proxy-auth': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    });
    const updatedAuditEntries = (await updatedAuditLog.json()).entries;
    assert.ok(updatedAuditEntries.some(entry => entry.action === 'RUNNER_CONTROL_failed'
        && entry.details.includes('temporary control outage')
        && entry.details.includes('action=resume')));
    acceptControl = true;
    const authenticatedMissionStatus = await fetch(`${baseUrl}/api/missions`, {
        headers: {
            authorization: `Basic ${Buffer.from('dashboard-test:proxy-auth-test-password').toString('base64')}`,
        },
    });
    assert.equal((await authenticatedMissionStatus.json()).runnerControlAvailable, true);

    const submitResponse = await fetch(`${baseUrl}/api/kernel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'submit_mission', mission: 'Erstelle einen strukturierten Content-Entwurf.' }),
    });
    assert.equal(submitResponse.status, 201);
    const submitted = await submitResponse.json();
    assert.equal(submitted.mission.status, 'queued');
    assert.equal(dispatchCount, 1);
    assert.equal(task.idempotencyKey, `chat:dashboard-mission-${submitted.mission.id}`);

    const runningResponse = await fetch(`${baseUrl}/api/missions`);
    const runningData = await runningResponse.json();
    assert.equal(runningData.runnerAvailable, true);
    assert.equal(runningData.missions[0].status, 'queued');

    task = { ...task, status: 'completed', result: { message: 'Entwurf erstellt.' } };
    const completedResponse = await fetch(`${baseUrl}/api/missions`);
    const completedData = await completedResponse.json();
    assert.equal(completedData.missions[0].status, 'completed');
    assert.match(completedData.missions[0].result, /Entwurf erstellt/);
    assert.equal(dispatchCount, 1);

    const statsResponse = await fetch(`${baseUrl}/api/dashboard-stats`);
    const stats = await statsResponse.json();
    assert.equal(stats.stats.pendingMissions, 0);

    acceptTasks = false;
    const failedDispatchResponse = await fetch(`${baseUrl}/api/kernel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'submit_mission', mission: 'Erzeuge eine Marketinganalyse.' }),
    });
    assert.equal(failedDispatchResponse.status, 202);
    const failedDispatch = await failedDispatchResponse.json();
    assert.equal(failedDispatch.success, true);
    assert.equal(failedDispatch.mission.status, 'pending');
    assert.match(failedDispatch.dispatchError, /temporary runner outage/);

    const pendingResponse = await fetch(`${baseUrl}/api/missions`);
    const pendingData = await pendingResponse.json();
    assert.equal(pendingData.missions[0].status, 'pending');
    assert.match(pendingData.missions[0].error, /temporary runner outage/);

    acceptTasks = true;
    const retryDeadline = Date.now() + 30_000;
    let retriedMission;
    while (Date.now() < retryDeadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const retryResponse = await fetch(`${baseUrl}/api/missions`);
        const retryData = await retryResponse.json();
        retriedMission = retryData.missions.find(item => item.id === failedDispatch.mission.id);
        if (retriedMission?.status === 'queued') break;
    }
    assert.equal(retriedMission?.status, 'queued');
    assert.equal(dispatchCount, 2);
});
