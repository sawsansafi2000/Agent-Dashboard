import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import test from 'node:test';
import { TaskQueue } from '../src/taskQueue.js';

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-tasks-'));
    return { root, queue: new TaskQueue(root) };
}

test('deduplicates tasks by idempotency key', async t => {
    const { root, queue } = await fixture();
    t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
    const input = { idempotencyKey: 'project:research', projectId: 'project', role: 'researcher', type: 'research', payload: {} };
    const first = await queue.enqueue(input);
    const second = await queue.enqueue(input);
    assert.equal(second.id, first.id);
    assert.equal((await queue.list()).length, 1);
});

test('allows only one parallel worker to claim a task', async t => {
    const { root, queue } = await fixture();
    t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
    await queue.enqueue({ idempotencyKey: 'project:test', projectId: 'project', role: 'tester', type: 'test', payload: {} });
    const claims = await Promise.all([
        queue.claim('tester', 'worker-a'),
        queue.claim('tester', 'worker-b'),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
});

test('requeues failed work and stops after the attempt limit', async t => {
    const { root, queue } = await fixture();
    t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
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

test('replays an expired in-progress lease from SQLite after a runner restart', async t => {
    const { root, queue } = await fixture();
    let activeQueue = queue;
    t.after(async () => { await activeQueue.close(); await rm(root, { recursive: true, force: true }); });
    const original = await queue.enqueue({
        idempotencyKey: 'local:restart',
        projectId: 'local',
        role: 'local-executor',
        type: 'local-execution',
        payload: { message: '/local status' },
        maxAttempts: 2,
    });
    const claimed = await queue.claim('local-executor', 'runner-before-restart', 1);
    assert.equal(claimed?.id, original.id);
    await queue.close();
    await new Promise(resolve => setTimeout(resolve, 10));

    activeQueue = new TaskQueue(root);
    const replayed = await activeQueue.claim('local-executor', 'runner-after-restart', 60_000);
    assert.equal(replayed?.id, original.id);
    assert.equal(replayed?.attempts, 2);
    assert.equal(replayed?.status, 'running');
    const completed = await activeQueue.complete(original.id, 'runner-after-restart', { ok: true });
    assert.equal(completed.status, 'completed');
    assert.deepEqual((await activeQueue.list())[0].result, { ok: true });
});

test('migrates a legacy JSON queue and requeues work interrupted during execution', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-tasks-migration-'));
    const queue = new TaskQueue(root);
    t.after(async () => { await queue.close(); await rm(root, { recursive: true, force: true }); });
    const now = new Date().toISOString();
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data', 'agent-tasks.json'), JSON.stringify({
        version: 1,
        tasks: [{
            id: 'legacy-task',
            idempotencyKey: 'legacy:task',
            projectId: 'legacy',
            role: 'worker',
            type: 'local-execution',
            payload: { message: '/local status' },
            status: 'running',
            attempts: 1,
            maxAttempts: 3,
            workerId: 'old-process',
            leaseExpiresAt: now,
            result: null,
            error: null,
            createdAt: now,
            updatedAt: now,
        }],
    }));

    const [migrated] = await queue.list();
    assert.equal(migrated.status, 'queued');
    assert.equal(migrated.workerId, null);
    assert.equal(migrated.attempts, 1);
    assert.equal((await queue.claim('worker', 'new-process'))?.id, 'legacy-task');
});

test('rolls back a task insert if its matching atomic event cannot be committed', async t => {
    const { root, queue } = await fixture();
    let activeQueue = queue;
    t.after(async () => { await activeQueue.close(); await rm(root, { recursive: true, force: true }); });
    await queue.list();
    await queue.close();

    const databasePath = path.join(root, 'database.sqlite');
    const database = await new Promise<sqlite3.Database>((resolve, reject) => {
        const opened = new sqlite3.Database(databasePath, error => error ? reject(error) : resolve(opened));
    });
    await new Promise<void>((resolve, reject) => {
        database.exec(`CREATE TRIGGER reject_task_events BEFORE INSERT ON agent_task_events
            BEGIN SELECT RAISE(ABORT, 'test event failure'); END;`, error => error ? reject(error) : resolve());
    });
    await new Promise<void>((resolve, reject) => database.close(error => error ? reject(error) : resolve()));

    activeQueue = new TaskQueue(root);
    await assert.rejects(() => activeQueue.enqueue({
        idempotencyKey: 'atomic:rollback',
        projectId: 'atomic',
        role: 'tester',
        type: 'test',
        payload: {},
    }), /test event failure/);
    assert.deepEqual(await activeQueue.list(), []);
});