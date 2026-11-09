const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
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
    throw new Error(`Dashboard did not become healthy (HTTP ${lastStatus}: ${lastBody}; ${lastError}).\n${readLogs()}`);
}

async function waitForMission(baseUrl, missionId, child, readLogs, authorization) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Dashboard exited early.\n${readLogs()}`);
        const response = await fetch(`${baseUrl}/api/missions`, {
            headers: { authorization },
        });
        const data = await response.json();
        const mission = data.missions.find(item => item.id === missionId);
        if (mission?.status === 'completed' || mission?.status === 'failed') return { mission, data };
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Mission did not finish in time.\n${readLogs()}`);
}

async function waitForTask(taskApiUrl, taskId, child, readLogs) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Dashboard exited early.\n${readLogs()}`);
        const response = await fetch(`${taskApiUrl}/tasks`, {
            headers: { authorization: 'Bearer local-runner-test-token' },
        });
        const data = await response.json();
        const task = data.tasks.find(item => item.id === taskId);
        if (task?.status === 'completed' || task?.status === 'failed') return task;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Task did not finish in time.\n${readLogs()}`);
}

async function submitMission(baseUrl, mission, authorization) {
    const response = await fetch(`${baseUrl}/api/kernel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ action: 'submit_mission', mission }),
    });
    assert.equal(response.status, 201);
    return response.json();
}

test('runs dashboard missions with local deterministic actions and no model API requests', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'dashboard-local-runner-'));
    await mkdir(path.join(root, 'data', 'agent-input'), { recursive: true });
    const inputFile = path.join(root, 'data', 'agent-input', 'source.txt');
    await writeFile(inputFile, 'local fixture data', 'utf8');

    const dashboardPort = await reservePort();
    const taskApiPort = await reservePort();
    const modelApiPort = await reservePort();
    const taskApiToken = 'local-runner-test-token';
    let modelRequests = 0;
    const modelServer = createServer((request, response) => {
        modelRequests += 1;
        response.writeHead(500).end('Model API must not be used in local mode.');
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
            INTERNAL_AGENT_API_TOKEN: taskApiToken,
            AGENT_WORKSPACE_ROOT: root,
            RUN_AGENT_WORKER: 'true',
            APP_BASIC_AUTH: 'true',
            DASHBOARD_USERNAME: 'dashboard-test',
            DASHBOARD_PASSWORD: 'local-test-password',
            AGENT_EXECUTION_MODE: 'local',
            AGENT_LOCAL_AUTOSTART: 'true',
            AGENT_AUTOSTART: 'false',
            AGENT_API_BUDGET_CENTS: '0',
            OPENAI_API_KEY: '',
            OPENAI_BASE_URL: `http://127.0.0.1:${modelApiPort}/v1`,
            ALLOW_GIT_PUSH: 'false',
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
    const dashboardAuthorization = `Basic ${Buffer.from('dashboard-test:local-test-password').toString('base64')}`;

    const unauthenticatedDashboardResponse = await fetch(baseUrl);
    assert.equal(unauthenticatedDashboardResponse.status, 401);
    const authenticatedDashboardResponse = await fetch(baseUrl, {
        headers: { authorization: dashboardAuthorization },
    });
    assert.equal(authenticatedDashboardResponse.status, 200);
    const internalControl = await fetch(`http://127.0.0.1:${taskApiPort}/control`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${taskApiToken}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ action: 'pause' }),
    });
    const internalControlData = await internalControl.json();
    assert.equal(internalControl.status, 200, `${JSON.stringify(internalControlData)}\n${logs}`);
    assert.equal(internalControlData.control.paused, true);
    const unauthenticatedControl = await fetch(`${baseUrl}/api/runner/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
    });
    assert.equal(unauthenticatedControl.status, 401);
    const pauseRunner = await fetch(`${baseUrl}/api/runner/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: dashboardAuthorization },
        body: JSON.stringify({ action: 'pause' }),
    });
    const pausedRunnerData = await pauseRunner.json();
    assert.equal(pauseRunner.status, 200, JSON.stringify(pausedRunnerData));
    assert.equal(pausedRunnerData.control.paused, true);
    const resumeRunner = await fetch(`${baseUrl}/api/runner/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: dashboardAuthorization },
        body: JSON.stringify({ action: 'resume' }),
    });
    const resumedRunnerData = await resumeRunner.json();
    assert.equal(resumeRunner.status, 200, JSON.stringify(resumedRunnerData));
    assert.equal(resumedRunnerData.control.paused, false);

    const invalidJsonResponse = await fetch(`http://127.0.0.1:${taskApiPort}/tasks`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${taskApiToken}`,
            'content-type': 'application/json',
        },
        body: '{invalid',
    });
    assert.equal(invalidJsonResponse.status, 400);
    assert.match((await invalidJsonResponse.json()).error, /gültiges JSON/);

    const rejectedDeveloperCommand = await fetch(`${baseUrl}/api/developer/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: dashboardAuthorization },
        body: JSON.stringify({ command: 'git status' }),
    });
    assert.equal(rejectedDeveloperCommand.status, 400);

    const developerResponse = await fetch(`${baseUrl}/api/developer/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: dashboardAuthorization },
        body: JSON.stringify({ command: '/local status' }),
    });
    assert.equal(developerResponse.status, 202);
    const developerData = await developerResponse.json();
    assert.equal(developerData.mode, 'local-deterministic');
    assert.equal(developerData.externalModelCalls, false);
    const developerTask = await waitForTask(
        `http://127.0.0.1:${taskApiPort}`,
        developerData.task.id,
        child,
        () => logs,
    );
    assert.equal(developerTask.status, 'completed', logs);
    assert.equal(developerTask.result.mode, 'local-deterministic');

    const draftResponse = await fetch(`${baseUrl}/api/developer/task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: dashboardAuthorization },
        body: JSON.stringify({ command: '/local draft marketing -- Handwerk' }),
    });
    assert.equal(draftResponse.status, 202);
    const draftData = await draftResponse.json();
    const draftTask = await waitForTask(`http://127.0.0.1:${taskApiPort}`, draftData.task.id, child, () => logs);
    assert.equal(draftTask.status, 'completed', logs);
    assert.equal(draftTask.result.generatedBy, 'local-template');
    assert.equal(draftTask.result.published, false);
    assert.match(draftTask.result.copyTemplate, /Handwerk/);

    const development = await submitMission(baseUrl, '/local draft development -- Anmeldung', dashboardAuthorization);
    const developmentOutcome = await waitForMission(baseUrl, development.mission.id, child, () => logs, dashboardAuthorization);
    assert.equal(developmentOutcome.mission.status, 'completed', logs);
    const developmentResult = JSON.parse(developmentOutcome.mission.result);
    assert.equal(developmentResult.kind, 'development');
    assert.equal(developmentResult.executed, false);
    assert.equal(developmentResult.topic, 'Anmeldung');

    const submittedRead = await submitMission(baseUrl, '/local read agent-input/source.txt', dashboardAuthorization);
    const readOutcome = await waitForMission(baseUrl, submittedRead.mission.id, child, () => logs, dashboardAuthorization);
    assert.equal(readOutcome.mission.status, 'completed', logs);
    assert.equal(JSON.parse(readOutcome.mission.result).content, 'local fixture data');
    assert.equal(readOutcome.data.runnerExecutionMode, 'local-deterministic');

    const submittedWrite = await submitMission(baseUrl, '/local write agent-output/result.txt -- completed locally', dashboardAuthorization);
    const writeOutcome = await waitForMission(baseUrl, submittedWrite.mission.id, child, () => logs, dashboardAuthorization);
    assert.equal(writeOutcome.mission.status, 'completed', logs);
    assert.equal(await readFile(path.join(root, 'data', 'agent-output', 'result.txt'), 'utf8'), 'completed locally');
    assert.equal(modelRequests, 0);
});
