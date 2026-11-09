import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ControlPlane } from '../src/controlPlane.js';

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-control-'));
    return { root, control: new ControlPlane(root) };
}

test('starts paused and blocks execution', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await control.initialize();
    assert.equal(state.paused, true);
    assert.equal((await control.getRunDecision()).allowed, false);
});

test('only enables automatic startup with an API key and a positive explicit budget', async t => {
    const { root, control } = await fixture();
    const previousAutoStart = process.env.AGENT_AUTOSTART;
    const previousBudget = process.env.AGENT_API_BUDGET_CENTS;
    const previousApiKey = process.env.OPENAI_API_KEY;
    t.after(async () => {
        await rm(root, { recursive: true, force: true });
        if (previousAutoStart === undefined) delete process.env.AGENT_AUTOSTART;
        else process.env.AGENT_AUTOSTART = previousAutoStart;
        if (previousBudget === undefined) delete process.env.AGENT_API_BUDGET_CENTS;
        else process.env.AGENT_API_BUDGET_CENTS = previousBudget;
        if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousApiKey;
    });

    process.env.AGENT_AUTOSTART = 'true';
    process.env.AGENT_API_BUDGET_CENTS = '2500';
    process.env.OPENAI_API_KEY = 'test-key';
    const state = await control.initialize();
    assert.equal(state.paused, false);
    assert.equal(state.infrastructureReady, true);
    assert.equal(state.apiBudgetCents, 2500);

    const missingKeyRoot = await mkdtemp(path.join(tmpdir(), 'nv-control-'));
    t.after(() => rm(missingKeyRoot, { recursive: true, force: true }));
    const missingKeyControl = new ControlPlane(missingKeyRoot);
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(() => missingKeyControl.initialize(), /AGENT_AUTOSTART erfordert OPENAI_API_KEY/);
});

test('starts a configured local runner without API keys, budget or model calls', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-local-control-'));
    const previous = {
        executionMode: process.env.AGENT_EXECUTION_MODE,
        localAutostart: process.env.AGENT_LOCAL_AUTOSTART,
        autoStart: process.env.AGENT_AUTOSTART,
        budget: process.env.AGENT_API_BUDGET_CENTS,
        apiKey: process.env.OPENAI_API_KEY,
    };
    t.after(async () => {
        await rm(root, { recursive: true, force: true });
        if (previous.executionMode === undefined) delete process.env.AGENT_EXECUTION_MODE;
        else process.env.AGENT_EXECUTION_MODE = previous.executionMode;
        if (previous.localAutostart === undefined) delete process.env.AGENT_LOCAL_AUTOSTART;
        else process.env.AGENT_LOCAL_AUTOSTART = previous.localAutostart;
        if (previous.autoStart === undefined) delete process.env.AGENT_AUTOSTART;
        else process.env.AGENT_AUTOSTART = previous.autoStart;
        if (previous.budget === undefined) delete process.env.AGENT_API_BUDGET_CENTS;
        else process.env.AGENT_API_BUDGET_CENTS = previous.budget;
        if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous.apiKey;
    });

    process.env.AGENT_EXECUTION_MODE = 'local';
    process.env.AGENT_LOCAL_AUTOSTART = 'true';
    process.env.AGENT_AUTOSTART = 'true';
    process.env.AGENT_API_BUDGET_CENTS = '0';
    delete process.env.OPENAI_API_KEY;

    const control = new ControlPlane(root);
    const state = await control.initialize();
    assert.equal(state.paused, false);
    assert.equal(state.infrastructureReady, true);
    assert.equal(state.apiBudgetCents, 0);
    assert.equal((await control.getLocalRunDecision()).allowed, true);
    assert.equal((await control.getRunDecision()).allowed, false);
});

test('requires readiness and budget before execution', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await control.initialize();
    await control.update({ paused: false, infrastructureReady: true, apiBudgetCents: 500 }, 'test.ready');
    assert.deepEqual(await control.getRunDecision(), { allowed: true, reason: 'Kontrollprüfungen bestanden.' });
});

test('allows exactly one active project', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await control.claimProject('project-a');
    await assert.rejects(() => control.claimProject('project-b'), /project-a ist bereits aktiv/);
    await control.releaseProject('project-a');
    assert.equal((await control.read()).activeProjectId, null);
});

test('blocks cost that exceeds the approved budget', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await control.initialize();
    await control.update({ apiBudgetCents: 100 }, 'test.budget');
    await control.recordApiCost(75);
    await assert.rejects(() => control.recordApiCost(26), /Budget/);
});

test('reserves enough budget before allowing a cycle', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await control.initialize();
    await control.update({ paused: false, infrastructureReady: true, apiBudgetCents: 100, apiSpentCents: 75 }, 'test.ready');
    assert.equal((await control.getRunDecision(25)).allowed, true);
    assert.match((await control.getRunDecision(26)).reason, /reservierten 26 Cent/);
});

test('serializes concurrent budget debits', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await control.initialize();
    await control.update({ apiBudgetCents: 100 }, 'test.budget');
    const outcomes = await Promise.allSettled([
        control.recordApiCost(60),
        control.recordApiCost(60),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal((await control.read()).apiSpentCents, 60);
});

test('kill switch overrides an otherwise runnable state', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await control.initialize();
    await control.update({ paused: false, infrastructureReady: true, apiBudgetCents: 500 }, 'test.ready');
    await writeFile(path.join(root, 'STOP.txt'), 'ACTIVE', 'utf8');
    assert.deepEqual(await control.getRunDecision(), { allowed: false, reason: 'Not-Aus ist aktiv.' });
});

test('resume requires readiness, available provider budget and an inactive kill switch', async t => {
    const { root, control } = await fixture();
    const previousExecutionMode = process.env.AGENT_EXECUTION_MODE;
    const previousBudgetBypass = process.env.BYPASS_BUDGET_CHECK;
    t.after(async () => {
        await rm(root, { recursive: true, force: true });
        if (previousExecutionMode === undefined) delete process.env.AGENT_EXECUTION_MODE;
        else process.env.AGENT_EXECUTION_MODE = previousExecutionMode;
        if (previousBudgetBypass === undefined) delete process.env.BYPASS_BUDGET_CHECK;
        else process.env.BYPASS_BUDGET_CHECK = previousBudgetBypass;
    });

    process.env.AGENT_EXECUTION_MODE = 'model-backed';
    process.env.BYPASS_BUDGET_CHECK = 'false';
    await control.initialize();
    await assert.rejects(() => control.setPaused(false), /Infrastruktur ist nicht freigegeben/);
    await control.update({
        infrastructureReady: true,
        apiBudgetCents: 500,
        apiStatus: 'blocked',
    }, 'test.ready');
    await assert.rejects(() => control.setPaused(false), /API-Anbieter ist blockiert/);
    await writeFile(path.join(root, 'STOP.txt'), 'ACTIVE', 'utf8');
    await assert.rejects(() => control.setPaused(false), /Not-Aus ist aktiv/);
});

test('blocks on provider quota errors and resumes after a healthy check', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await control.initialize();
    await control.update({ paused: false, infrastructureReady: true, apiBudgetCents: 500 }, 'test.ready');
    await control.markApiBlocked('insufficient_quota', new Date(Date.now() + 60_000).toISOString());
    assert.match((await control.getRunDecision()).reason, /OpenAI-API blockiert \(insufficient_quota\)/);
    await control.markApiHealthy();
    assert.equal((await control.getRunDecision()).allowed, true);
    assert.equal((await control.read()).apiStatus, 'healthy');
});

test('bypasses only the local budget ceiling when explicitly configured', async t => {
    const { root, control } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => delete process.env.BYPASS_BUDGET_CHECK);
    await control.initialize();
    await control.update({ paused: false, infrastructureReady: true, apiBudgetCents: 1 }, 'test.ready');
    process.env.BYPASS_BUDGET_CHECK = 'true';

    assert.equal((await control.getRunDecision(5)).allowed, true);
    await control.recordApiCost(5);
    assert.equal((await control.read()).apiSpentCents, 5);
    await control.markApiBlocked('insufficient_quota', new Date(Date.now() + 60_000).toISOString());
    assert.equal((await control.getRunDecision()).allowed, false);
});