'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const test = require('node:test');
const { restoreBackup } = require('../scripts/restore-portal-backup.cjs');
const { checkBackup } = require('../scripts/check-portal-backup.cjs');

function runSql(database, sql, ...params) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, error => error ? reject(error) : resolve());
    });
}

function getSql(database, sql) {
    return new Promise((resolve, reject) => {
        database.get(sql, [], (error, row) => error ? reject(error) : resolve(row));
    });
}

test('portal backup is encrypted, readable after decryption, and rotated', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-portal-backup-test-'));
    const databasePath = path.join(directory, 'portal.sqlite');
    const backupDirectory = path.join(directory, 'backups');
    const key = crypto.randomBytes(32);
    const database = new sqlite3.Database(databasePath);
    await runSql(database, 'CREATE TABLE sample (value TEXT NOT NULL)');
    await runSql(database, 'INSERT INTO sample(value) VALUES (?)', 'backup-content');
    await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));

    async function runBackup() {
        const child = spawn(process.execPath, [path.join(__dirname, '../scripts/backup-portal.cjs')], {
            env: {
                ...process.env,
                PORTAL_DATABASE_PATH: databasePath,
                PORTAL_BACKUP_DIRECTORY: backupDirectory,
                PORTAL_BACKUP_KEY: key.toString('hex'),
                PORTAL_BACKUP_RETENTION: '1',
                PORTAL_BACKUP_ONCE: 'true',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, output);
    }

    try {
        await runBackup();
        await new Promise(resolve => setTimeout(resolve, 10));
        await runBackup();
        const files = await fs.readdir(backupDirectory);
        assert.equal(files.length, 1);
        const encrypted = await fs.readFile(path.join(backupDirectory, files[0]));
        assert.equal(encrypted.subarray(0, 9).toString(), 'NVBACKUP1');
        const restoredPath = path.join(directory, 'restored.sqlite');
        const restore = spawn(process.execPath, [
            path.join(__dirname, '../scripts/restore-portal-backup.cjs'),
            path.join(backupDirectory, files[0]),
            restoredPath,
        ], {
            env: { ...process.env, PORTAL_BACKUP_KEY: key.toString('hex') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let restoreOutput = '';
        restore.stdout.on('data', chunk => { restoreOutput += chunk.toString(); });
        restore.stderr.on('data', chunk => { restoreOutput += chunk.toString(); });
        const [restoreCode] = await once(restore, 'exit');
        assert.equal(restoreCode, 0, restoreOutput);
        const restored = new sqlite3.Database(restoredPath, sqlite3.OPEN_READONLY);
        assert.equal((await getSql(restored, 'SELECT value FROM sample')).value, 'backup-content');
        await new Promise((resolve, reject) => restored.close(error => error ? reject(error) : resolve()));

        const wrongKeyPath = path.join(directory, 'wrong-key.sqlite');
        await assert.rejects(restoreBackup(path.join(backupDirectory, files[0]), wrongKeyPath, crypto.randomBytes(32).toString('hex')));
        await assert.rejects(fs.stat(wrongKeyPath), { code: 'ENOENT' });
        const damaged = Buffer.from(encrypted);
        damaged[damaged.length - 1] ^= 1;
        const damagedPath = path.join(directory, 'damaged.enc');
        await fs.writeFile(damagedPath, damaged);
        const damagedOutput = path.join(directory, 'damaged.sqlite');
        await assert.rejects(restoreBackup(damagedPath, damagedOutput, key.toString('hex')));
        await assert.rejects(fs.stat(damagedOutput), { code: 'ENOENT' });

        await fs.writeFile(databasePath, 'not a sqlite database');
        const failed = spawn(process.execPath, [path.join(__dirname, '../scripts/backup-portal.cjs')], {
            env: {
                ...process.env,
                PORTAL_DATABASE_PATH: databasePath,
                PORTAL_BACKUP_DIRECTORY: backupDirectory,
                PORTAL_BACKUP_KEY: key.toString('hex'),
                PORTAL_BACKUP_RETENTION: '1',
                PORTAL_BACKUP_ONCE: 'true',
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let failedOutput = '';
        failed.stderr.on('data', chunk => { failedOutput += chunk.toString(); });
        const [failedCode] = await once(failed, 'exit');
        assert.notEqual(failedCode, 0, failedOutput);
        assert.deepEqual(await fs.readdir(backupDirectory), files);
        await restoreBackup(path.join(backupDirectory, files[0]), path.join(directory, 'last-good.sqlite'), key.toString('hex'));
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('backup health respects the configured interval and ignores incomplete files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-backup-health-'));
    try {
        const now = Date.now();
        const file = path.join(directory, 'portal-20261108T000000Z-aabb.sqlite.enc');
        await fs.writeFile(`${file}.tmp`, Buffer.alloc(100));
        await assert.rejects(checkBackup(directory, 60_000, now), /Kein aktuelles/);
        await fs.writeFile(file, Buffer.alloc(100));
        await fs.utimes(file, new Date(now - 90_000), new Date(now - 90_000));
        await checkBackup(directory, 60_000, now);
        await assert.rejects(checkBackup(directory, 60_000, now + 11 * 60_000), /Kein aktuelles/);
        await checkBackup(directory, 24 * 60 * 60 * 1000, now + 11 * 60_000);
        await assert.rejects(checkBackup(directory, 10, now), /mindestens/);
        await fs.writeFile(file, Buffer.alloc(37));
        await assert.rejects(checkBackup(directory, 60_000), /Kein aktuelles/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
