import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutonomousStateStore } from '../src/autonomousStateMachine.js';

test('persists every autonomous state-machine phase', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-state-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new AutonomousStateStore(root);

    assert.equal((await store.read()).phase, 'diagnose');
    await store.transition('select-next-task');
    await store.transition('execute', { selectedAction: 'worker-task', selectedTaskId: 'task-1' });
    await store.transition('verify', { lastOutcome: 'completed' });
    const final = await store.transition('done');

    assert.equal(final.phase, 'done');
    assert.equal((await store.read()).selectedTaskId, 'task-1');
});

test('migrates the legacy approval-wait phase to done', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-state-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new AutonomousStateStore(root);
    await store.transition('done');
    const file = path.join(root, 'data', 'autonomous-state.json');
    const legacy = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    legacy.phase = 'wait-for-approval/done';
    await (await import('node:fs/promises')).writeFile(file, JSON.stringify(legacy), 'utf8');

    assert.equal((await store.read()).phase, 'done');
});