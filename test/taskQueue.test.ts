import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { TaskQueue } from '../src/taskQueue.js';

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-tasks-'));
    return { root, queue: new TaskQueue(root) };
}

test('deduplicates tasks by idempotency key', async t => {
    const { root, queue } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = { idempotencyKey: 'project:research', projectId: 'project', role: 'researcher', type: 'research', payload: {} };
    const first = await queue.enqueue(input);
    const second = await queue.enqueue(input);
    assert.equal(second.id, first.id);
    assert.equal((await queue.list()).length, 1);
});

test('allows only one parallel worker to claim a task', async t => {
    const { root, queue } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await queue.enqueue({ idempotencyKey: 'project:test', projectId: 'project', role: 'tester', type: 'test', payload: {} });
    const claims = await Promise.all([
        queue.claim('tester', 'worker-a'),
        queue.claim('tester', 'worker-b'),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
});

test('requeues failed work and stops after the attempt limit', async t => {
    const { root, queue } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await queue.enqueue({
        idempotencyKey: 'project:deploy', projectId: 'project', role: 'deployer', type: 'deploy', payload: {}, maxAttempts: 2,
    });
    const first = await queue.claim('deployer', 'worker');
    assert(first);
    assert.equal((await queue.fail(first.id, 'worker', 'first failure')).status, 'queued');
    const second = await queue.claim('deployer', 'worker');
    assert(second);
    assert.equal((await queue.fail(second.id, 'worker', 'second failure')).status, 'failed');
    assert.equal(await queue.claim('deployer', 'worker'), null);
});