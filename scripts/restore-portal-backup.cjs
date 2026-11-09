'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const sqlite3 = require('sqlite3');

async function assertDatabaseIntegrity(databasePath) {
    const database = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
    try {
        const integrity = await new Promise((resolve, reject) => {
            database.get('PRAGMA integrity_check', [], (error, row) => {
                if (error) reject(error);
                else resolve(row.integrity_check);
            });
        });
        if (integrity !== 'ok') throw new Error('Das entschlüsselte SQLite-Backup hat die Integritätsprüfung nicht bestanden.');
    } finally {
        await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
    }
}

async function restoreBackup(encryptedPath, outputPath, keyHex) {
    if (!encryptedPath || !outputPath || !/^[a-f0-9]{64}$/i.test(keyHex || '')) {
        throw new Error('Aufruf: node scripts/restore-portal-backup.cjs <backup.sqlite.enc> <neue-zieldatei.sqlite>; PORTAL_BACKUP_KEY muss gesetzt sein.');
    }
    const absoluteEncryptedPath = path.resolve(encryptedPath);
    const absoluteOutputPath = path.resolve(outputPath);
    const outputDirectory = path.dirname(absoluteOutputPath);
    await fs.mkdir(outputDirectory, { recursive: true });
    const input = await fs.open(absoluteEncryptedPath, 'r');
    const header = Buffer.alloc(37);
    try {
        const { bytesRead } = await input.read(header, 0, header.length, 0);
        if (bytesRead !== header.length || header.subarray(0, 9).toString() !== 'NVBACKUP1') {
            throw new Error('Die Backup-Datei hat ein ungültiges oder unvollständiges Format.');
        }
    } finally {
        await input.close();
    }

    const tempPath = path.join(outputDirectory, `.${path.basename(outputPath)}.${crypto.randomUUID()}.tmp`);
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(keyHex, 'hex'),
        header.subarray(9, 21),
    );
    decipher.setAuthTag(header.subarray(21, 37));
    try {
        await pipeline(
            nodeFs.createReadStream(absoluteEncryptedPath, { start: header.length }),
            decipher,
            nodeFs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
        );
        await assertDatabaseIntegrity(tempPath);
        await fs.link(tempPath, absoluteOutputPath);
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}

if (require.main === module) {
    restoreBackup(process.argv[2], process.argv[3], process.env.PORTAL_BACKUP_KEY || '').then(() => {
        console.log(`Portal-Backup wiederhergestellt und geprüft: ${path.resolve(process.argv[3])}`);
    }).catch(error => {
        console.error('[Portal Restore] Wiederherstellung fehlgeschlagen:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { restoreBackup };
