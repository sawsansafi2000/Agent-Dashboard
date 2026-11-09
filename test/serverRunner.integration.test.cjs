const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
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

async function waitForHealth(url, child, readLogs) {
    const deadline = Date.now() + 60_000;
    let lastStatus = null;
    let lastBody = '';
    let lastError = '';
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Dashboard exited early.\n${readLogs()}`);
        try {
            const response = await fetch(url);
            lastStatus = response.status;
            lastBody = await response.text();
            if (response.ok) return;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Dashboard and runner did not become healthy (HTTP ${lastStatus}: ${lastBody}; ${lastError}).\n${readLogs()}`);
}

function modelResponse(content) {
    return {
        id: `chatcmpl-test-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
}

test('dispatches and completes a dashboard mission through the real runner process', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'dashboard-runner-e2e-'));
    const dataDirectory = path.join(root, 'data');
    await mkdir(dataDirectory);
    const dashboardPort = await reservePort();
    const taskApiPort = await reservePort();
    const modelApiPort = await reservePort();
    const token = 'runner-e2e-test-token';
    const now = new Date().toISOString();
    await writeFile(path.join(dataDirectory, 'control-plane.json'), JSON.stringify({
        version: 1,
        infrastructureReady: true,
        paused: false,
        activeProjectId: null,
        apiBudgetCents: 5000,
        apiSpentCents: 0,
        apiStatus: 'healthy',
        apiBlockReason: null,
        apiTokenLabel: 'OPENAI_API_KEY',
        lastApiCheckAt: now,
        nextApiCheckAt: null,
        lastHeartbeatAt: null,
        lastCycleAt: null,
        consecutiveFailures: 0,
        updatedAt: now,
    }));

    const ideas = Array.from({ length: 5 }, (_, index) => ({
        title: `Test Service Idee ${index + 1}`,
        summary: 'Ein klar begrenzter digitaler Service für kleine Teams.',
        targetMarkets: ['DACH KMU', 'Selbstständige'],
        businessModel: 'Monatliches Abonnement',
        scalability: 'Digital skalierbarer Service',
        nextSteps: ['Pilot mit Testkunden', 'Ergebnisse messen'],
    }));
    const modelServer = createServer(async (request, response) => {
        if (request.method === 'GET' && request.url === '/v1/models') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ object: 'list', data: [] }));
            return;
        }
        if (request.method === 'POST' && request.url === '/v1/chat/completions') {
            let body = '';
            for await (const chunk of request) body += chunk;
            const input = JSON.parse(body);
            const isIdeaCycle = input.messages?.some(message => message.content?.includes('Vorhandene Ideen'));
            const content = isIdeaCycle
                ? JSON.stringify({ ideas })
                : 'Mission processed by test model.';
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(modelResponse(content)));
            return;
        }
        response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
        modelServer.once('error', reject);
        modelServer.listen(modelApiPort, '127.0.0.1', resolve);
    });

    const child = spawn(process.execPath, ['src/server.cjs'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(dashboardPort),
            DATABASE_PATH: path.join(root, 'dashboard.sqlite'),
            INTERNAL_AGENT_API_PORT: String(taskApiPort),
            INTERNAL_AGENT_API_TOKEN: token,
            AGENT_WORKSPACE_ROOT: root,
            RUN_AGENT_WORKER: 'true',
            AGENT_AUTOSTART: 'false',
            AGENT_API_BUDGET_CENTS: '0',
            OPENAI_API_KEY: 'test-model-key',
            OPENAI_BASE_URL: `http://127.0.0.1:${modelApiPort}/v1`,
            OPENAI_MODEL: 'gpt-4o',
            ALLOW_GIT_PUSH: 'false',
            SLEEP_TIME_MS: '1000',
            API_STATUS_CHECK_INTERVAL_MS: '1000',
            OPENAI_MAX_COMPLETION_TOKENS: '128',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    t.after(async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
        });
        await new Promise((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve()));
        await removeTemporaryRoot(root);
    });

    const baseUrl = `http://127.0.0.1:${dashboardPort}`;
    await waitForHealth(`${baseUrl}/health`, child, () => logs);
    const submittedResponse = await fetch(`${baseUrl}/api/kernel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'submit_mission', mission: 'Erstelle einen Content-Entwurf und nenne das Ergebnis.' }),
    });
    assert.equal(submittedResponse.status, 201, logs);
    const submitted = await submittedResponse.json();

    const deadline = Date.now() + 30_000;
    let mission;
    while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/api/missions`);
        const data = await response.json();
        mission = data.missions.find(item => item.id === submitted.mission.id);
        if (mission?.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    assert.equal(mission?.status, 'completed', logs);
    assert.match(mission.result, /Mission processed by test model/);
    assert.equal(mission.error, null);
});

test('keeps the runner API healthy and paused when no model key is configured', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'dashboard-runner-paused-'));
    const dashboardPort = await reservePort();
    const taskApiPort = await reservePort();
    const child = spawn(process.execPath, ['src/server.cjs'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(dashboardPort),
            DATABASE_PATH: path.join(root, 'dashboard.sqlite'),
            INTERNAL_AGENT_API_PORT: String(taskApiPort),
            INTERNAL_AGENT_API_TOKEN: 'paused-runner-test-token',
            AGENT_WORKSPACE_ROOT: root,
            RUN_AGENT_WORKER: 'true',
            AGENT_AUTOSTART: 'false',
            AGENT_API_BUDGET_CENTS: '0',
            OPENAI_API_KEY: '',
            ALLOW_GIT_PUSH: 'false',
            SLEEP_TIME_MS: '1000',
            API_STATUS_CHECK_INTERVAL_MS: '1000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    t.after(async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        await new Promise(resolve => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
        });
        await removeTemporaryRoot(root);
    });

    const baseUrl = `http://127.0.0.1:${dashboardPort}`;
    await waitForHealth(`${baseUrl}/health`, child, () => logs);
    const developerResponse = await fetch(`${baseUrl}/api/developer/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: '/local status' }),
    });
    assert.equal(developerResponse.status, 503);
    assert.match((await developerResponse.json()).error, /lokalen Ausführungsmodus/);

    const response = await fetch(`${baseUrl}/health`);
    const health = await response.json();
    assert.equal(health.runnerAvailable, true);
    assert.equal(health.control.paused, true);
    assert.equal(health.control.infrastructureReady, false);
});
