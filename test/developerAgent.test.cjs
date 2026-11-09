'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    submitDeveloperTask,
    validateDeveloperTask,
} = require('../src/developerAgent.cjs');

test('accepts only bounded deterministic local task commands', () => {
    assert.deepEqual(validateDeveloperTask({ command: ' /local status ' }), { command: '/local status' });
    assert.deepEqual(validateDeveloperTask({ command: '/local read agent-input/source.txt' }), {
        command: '/local read agent-input/source.txt',
    });
    assert.deepEqual(validateDeveloperTask({ command: '/local draft marketing -- Handwerk' }), {
        command: '/local draft marketing -- Handwerk',
    });
    assert.throws(() => validateDeveloperTask({ command: `/local draft development -- ${'x'.repeat(501)}` }), /Entwurfsthema/);
    assert.throws(() => validateDeveloperTask({ command: '' }), /Befehl muss/);
    assert.throws(() => validateDeveloperTask({ command: 'x'.repeat(4_001) }), /Befehl muss/);
    assert.throws(() => validateDeveloperTask({ command: 'npm test' }), /Unterstützt werden nur/);
    assert.throws(() => validateDeveloperTask({ command: '/local unknown' }), /Unterstützt werden nur/);
    assert.throws(() => validateDeveloperTask(null), /Ungültige lokale Task-Anfrage/);
});

test('submits the validated command to the native task queue', async () => {
    let submittedCommand;
    const task = { id: 'task-1', status: 'queued' };
    const result = await submitDeveloperTask(
        { command: '/local status' },
        async command => {
            submittedCommand = command;
            return task;
        },
    );

    assert.equal(submittedCommand, '/local status');
    assert.equal(result, task);
});

test('surfaces unavailable queues and queue failures without fallback', async () => {
    await assert.rejects(
        () => submitDeveloperTask({ command: '/local status' }),
        { statusCode: 503 },
    );
    await assert.rejects(
        () => submitDeveloperTask({ command: '/local status' }, async () => {
            throw new Error('queue unavailable');
        }),
        /queue unavailable/,
    );
});
