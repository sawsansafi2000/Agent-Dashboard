import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { AgentWorker, runWorkerRound } from '../src/agentWorker.js';
import { ApiPausedError } from '../src/apiStatus.js';
import { TaskQueue } from '../src/taskQueue.js';

test('runs different agent roles concurrently and persists their results', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-workers-'));
    const queue = new TaskQueue(root);
    t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
    await queue.enqueue({ idempotencyKey: 'infra:architecture', projectId: 'infrastructure', role: 'architect', type: 'review', payload: {} });
    await queue.enqueue({ idempotencyKey: 'infra:test', projectId: 'infrastructure', role: 'tester', type: 'verify', payload: {} });

    const processed = await runWorkerRound([
        new AgentWorker(queue, { id: 'architect-1', role: 'architect', handler: async () => ({ approved: true }) }),
        new AgentWorker(queue, { id: 'tester-1', role: 'tester', handler: async () => ({ passed: true }) }),
    ]);

    assert.equal(processed, 2);
    const tasks = await queue.list('infrastructure');
    assert.deepEqual(tasks.map(task => task.status), ['completed', 'completed']);
    assert.deepEqual(tasks.map(task => task.result), [{ approved: true }, { passed: true }]);
});

test('returns handler failures to the queue retry path', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-workers-'));
    const queue = new TaskQueue(root);
    t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
    await queue.enqueue({ idempotencyKey: 'infra:deploy', projectId: 'infrastructure', role: 'deployer', type: 'deploy', payload: {} });
    const worker = new AgentWorker(queue, {
        id: 'deployer-1',
        role: 'deployer',
        handler: async () => { throw new Error('deployment unavailable'); },
    });

    assert.equal(await worker.runOnce(), true);
    const [task] = await queue.list();
    assert.equal(task.status, 'queued');
    assert.equal(task.error, 'deployment unavailable');
});

test('defers API-paused tasks without consuming a retry attempt', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-workers-'));
    const queue = new TaskQueue(root);
    t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
    await queue.enqueue({ idempotencyKey: 'api:paused', projectId: 'project', role: 'master', type: 'chat', payload: {} });
    const worker = new AgentWorker(queue, {
        id: 'master-1', role: 'master', handler: async () => { throw new ApiPausedError('API blockiert'); },
    });
    await worker.runOnce();
    const [task] = await queue.list();
    assert.equal(task.status, 'queued');
    assert.equal(task.attempts, 0);
});