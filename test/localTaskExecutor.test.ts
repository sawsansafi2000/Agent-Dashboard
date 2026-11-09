import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { executeLocalTaskCommand, parseLocalTaskCommand } from '../src/localTaskExecutor.js';

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-local-executor-'));
    await mkdir(path.join(root, 'data', 'agent-input'), { recursive: true });
    await mkdir(path.join(root, 'data', 'agent-output'), { recursive: true });
    await mkdir(path.join(root, 'data', 'reports'), { recursive: true });
    return root;
}

test('accepts only explicit deterministic local commands', () => {
    assert.deepEqual(parseLocalTaskCommand('/local status'), { operation: 'status' });
    assert.deepEqual(parseLocalTaskCommand('/local read agent-input/source.txt'), {
        operation: 'read',
        path: 'agent-input/source.txt',
    });
    assert.throws(() => parseLocalTaskCommand('Führe diesen beliebigen Befehl aus'), /unterstützt nur/);
    assert.throws(() => parseLocalTaskCommand('/local read agent-input/../../.env'), /Backslashes|übergeordnete|versteckte/);
    assert.throws(() => parseLocalTaskCommand('/local write agent-input/source.txt -- Inhalt'), /ausschließlich unter agent-output/);
});

test('reads only bounded input files and writes new files atomically to agent-output', async t => {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'data', 'agent-input', 'source.txt'), 'lokaler Inhalt', 'utf8');

    const readResult = await executeLocalTaskCommand('/local read agent-input/source.txt', root);
    assert.equal(readResult.content, 'lokaler Inhalt');

    const writeResult = await executeLocalTaskCommand('/local write agent-output/result.txt -- sicherer Bericht', root);
    assert.equal(writeResult.bytesWritten, Buffer.byteLength('sicherer Bericht'));
    assert.equal(await readFile(path.join(root, 'data', 'agent-output', 'result.txt'), 'utf8'), 'sicherer Bericht');
    await assert.rejects(
        () => executeLocalTaskCommand('/local write agent-output/result.txt -- überschreiben', root),
        /existiert bereits/,
    );
    await assert.rejects(
        () => executeLocalTaskCommand('/local read reports/missing.txt', root),
        { code: 'ENOENT' },
    );
});

test('reports the local zero-provider execution mode without contacting a model', async t => {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const status = await executeLocalTaskCommand('/local status', root);
    assert.equal(status.mode, 'local-deterministic');
    assert.equal(status.externalModelCalls, false);
    assert.equal(status.tokenUsage, 0);
});

test('creates bounded rule-based draft results without file or network operations', async t => {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Unexpected network request'); };
    try {
        const development = await executeLocalTaskCommand('/local draft development -- Anmeldung verbessern', root);
        assert.equal(development.kind, 'development');
        assert.equal(development.topic, 'Anmeldung verbessern');
        assert.equal(development.generatedBy, 'local-template');
        assert.equal(development.executed, false);
        assert.equal(development.published, false);
        assert.ok(Array.isArray(development.steps));
        const marketing = await executeLocalTaskCommand('/local draft marketing -- Handwerksbetriebe', root);
        assert.equal(marketing.kind, 'marketing');
        assert.match(String(marketing.copyTemplate), /Handwerksbetriebe/);
        assert.equal(marketing.externalModelCalls, false);
        assert.equal(marketing.published, false);
        assert.throws(() => parseLocalTaskCommand('/local draft marketing -- '), /Entwurfsthema|unterstützt nur/);
        assert.throws(() => parseLocalTaskCommand(`/local draft marketing -- ${'a'.repeat(501)}`), /Entwurfsthema/);
        assert.throws(() => parseLocalTaskCommand('/local draft marketing -- Thema\nanderes'), /Entwurfsthema/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
