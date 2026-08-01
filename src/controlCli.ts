import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlane } from './controlPlane.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const control = new ControlPlane(rootDirectory);
const command = process.argv[2] ?? 'status';

async function main(): Promise<void> {
    if (command === 'status') {
        console.log(JSON.stringify(await control.initialize(), null, 2));
        return;
    }
    if (command === 'pause') {
        console.log(JSON.stringify(await control.update({ paused: true }, 'control.paused'), null, 2));
        return;
    }
    if (command === 'approve') {
        const budgetCents = Number.parseInt(process.argv[3] ?? '', 10);
        if (!Number.isSafeInteger(budgetCents) || budgetCents <= 0) {
            throw new Error('Freigabe erfordert ein positives API-Budget in Cent.');
        }
        console.log(JSON.stringify(await control.update({
            infrastructureReady: true,
            paused: false,
            apiBudgetCents: budgetCents,
        }, 'control.infrastructure-approved'), null, 2));
        return;
    }
    if (command === 'claim') {
        const projectId = process.argv[3]?.trim();
        if (!projectId) throw new Error('Eine Projekt-ID ist erforderlich.');
        console.log(JSON.stringify(await control.claimProject(projectId), null, 2));
        return;
    }
    if (command === 'release') {
        const projectId = process.argv[3]?.trim();
        if (!projectId) throw new Error('Eine Projekt-ID ist erforderlich.');
        console.log(JSON.stringify(await control.releaseProject(projectId), null, 2));
        return;
    }
    if (command === 'stop') {
        await fs.writeFile(path.join(rootDirectory, 'STOP.txt'), 'ACTIVE\n', 'utf8');
        console.log('Not-Aus aktiviert.');
        return;
    }
    if (command === 'clear-stop') {
        await fs.rm(path.join(rootDirectory, 'STOP.txt'), { force: true });
        console.log('Not-Aus entfernt; Pause und Budget bleiben unverändert.');
        return;
    }
    throw new Error(`Unbekannter Befehl: ${command}`);
}

void main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});