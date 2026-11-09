'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { restoreBackup } = require('./restore-portal-backup.cjs');

const databasePath = process.env.PORTAL_DATABASE_PATH || '/app/data/portal.sqlite';
const backupDirectory = process.env.PORTAL_BACKUP_DIRECTORY || '/backups';
const backupKeyHex = process.env.PORTAL_BACKUP_KEY || '';
const retentionCount = Number(process.env.PORTAL_BACKUP_RETENTION || 30);
const intervalMs = Number(process.env.PORTAL_BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000);
const once = process.env.PORTAL_BACKUP_ONCE === 'true';
const filePrefix = 'portal-';

if (!/^[a-f0-9]{64}$/i.test(backupKeyHex)) {
    throw new Error('PORTAL_BACKUP_KEY muss ein 32-Byte-Schlüssel als 64-stelliges Hex sein.');
}
if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
    throw new Error('PORTAL_BACKUP_RETENTION muss zwischen 1 und 365 liegen.');
}
if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
    throw new Error('PORTAL_BACKUP_INTERVAL_MS muss mindestens 60000 Millisekunden betragen.');
}

const key = Buffer.from(backupKeyHex, 'hex');

function createSqliteBackup(destination) {
    return new Promise((resolve, reject) => {
        const source = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, openError => {
            if (openError) {
                reject(openError);
                return;
            }
            const backup = source.backup(destination);
            backup.step(-1, stepError => {
                backup.finish(finishError => {
                    source.close(closeError => {
                        if (stepError) reject(stepError);
                        else if (finishError) reject(finishError);
                        else if (closeError) reject(closeError);
                        else resolve();
                    });
                });
            });
        });
    });
}

async function rotateBackups() {
    const entries = await fs.readdir(backupDirectory, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
        if (entry.isFile() && /^portal-\d{8}T\d{6}Z-[a-f0-9-]+\.sqlite\.enc\.tmp$/i.test(entry.name)) {
            const tempPath = path.join(backupDirectory, entry.name);
            const age = Date.now() - (await fs.stat(tempPath)).mtimeMs;
            if (age > intervalMs) await fs.unlink(tempPath);
            continue;
        }
        if (!entry.isFile() || !/^portal-\d{8}T\d{6}Z-[a-f0-9-]+\.sqlite\.enc$/i.test(entry.name)) continue;
        const fullPath = path.join(backupDirectory, entry.name);
        backups.push({ fullPath, modifiedAt: (await fs.stat(fullPath)).mtimeMs });
    }
    backups.sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const oldBackup of backups.slice(retentionCount)) {
        await fs.unlink(oldBackup.fullPath);
    }
}

async function createEncryptedBackup() {
    await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(backupDirectory, 0o700);
    const tempDatabasePath = path.join(os.tmpdir(), `portal-backup-${crypto.randomUUID()}.sqlite`);
    const verifyDatabasePath = path.join(os.tmpdir(), `portal-verify-${crypto.randomUUID()}.sqlite`);
    const iv = crypto.randomBytes(12);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const fileName = `${filePrefix}${timestamp}-${crypto.randomUUID()}.sqlite.enc`;
    const finalPath = path.join(backupDirectory, fileName);
    const tempEncryptedPath = `${finalPath}.tmp`;

    try {
        const tempDatabase = await fs.open(tempDatabasePath, 'wx', 0o600);
        await tempDatabase.close();
        await createSqliteBackup(tempDatabasePath);
        const plaintext = await fs.readFile(tempDatabasePath);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const encrypted = Buffer.concat([
            Buffer.from('NVBACKUP1'),
            iv,
            cipher.getAuthTag(),
            ciphertext,
        ]);
        await fs.writeFile(tempEncryptedPath, encrypted, { mode: 0o600, flag: 'wx' });
        await restoreBackup(tempEncryptedPath, verifyDatabasePath, backupKeyHex);
        await fs.rename(tempEncryptedPath, finalPath);
        await rotateBackups();
        console.log(`[Portal Backup] encrypted backup created: ${fileName}`);
    } finally {
        await fs.rm(tempDatabasePath, { force: true });
        await fs.rm(verifyDatabasePath, { force: true });
        await fs.rm(tempEncryptedPath, { force: true });
    }
}

async function main() {
    do {
        let nextDelay = intervalMs;
        try {
            await createEncryptedBackup();
        } catch (error) {
            console.error('[Portal Backup] backup failed:', error);
            if (once) process.exitCode = 1;
            else nextDelay = Math.min(intervalMs, 5 * 60 * 1000);
        }
        if (!once) await new Promise(resolve => setTimeout(resolve, nextDelay));
    } while (!once);
}

main().catch(error => {
    console.error('[Portal Backup] backup process failed:', error);
    process.exitCode = 1;
});
