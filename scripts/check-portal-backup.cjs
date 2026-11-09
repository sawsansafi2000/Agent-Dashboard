'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function checkBackup(directory, intervalMs, now = Date.now()) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
        throw new Error('PORTAL_BACKUP_INTERVAL_MS muss mindestens 60000 Millisekunden betragen.');
    }
    const maxAge = intervalMs + Math.max(10 * 60_000, Math.ceil(intervalMs * 0.1));
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || !/^portal-\d{8}T\d{6}Z-[a-f0-9-]+\.sqlite\.enc$/i.test(entry.name)) continue;
        const info = await fs.stat(path.join(directory, entry.name));
        if (info.size > 37 && info.mtimeMs <= now && now - info.mtimeMs <= maxAge) return;
    }
    throw new Error('Kein aktuelles verschlüsseltes Portal-Backup gefunden.');
}

if (require.main === module) {
    checkBackup(
        process.env.PORTAL_BACKUP_DIRECTORY || '/backups',
        Number(process.env.PORTAL_BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000),
    ).catch(error => {
        console.error('[Portal Backup Health]', error.message);
        process.exitCode = 1;
    });
}

module.exports = { checkBackup };
