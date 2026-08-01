import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type AutonomousPhase = 'diagnose' | 'select-next-task' | 'execute' | 'verify' | 'done';

export interface AutonomousState {
    version: 1;
    phase: AutonomousPhase;
    selectedAction: 'worker-task' | 'generate-ideas' | null;
    selectedTaskId: string | null;
    lastOutcome: string | null;
    updatedAt: string;
}

export class AutonomousStateStore {
    private readonly file: string;

    constructor(rootDirectory: string) {
        this.file = path.join(rootDirectory, 'data', 'autonomous-state.json');
    }

    async read(): Promise<AutonomousState> {
        try {
            const stored = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<AutonomousState>;
            if ((stored.phase as string) === 'wait-for-approval/done') stored.phase = 'done';
            return { ...this.initial(), ...stored, version: 1 };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.write(this.initial());
            throw error;
        }
    }

    async transition(phase: AutonomousPhase, patch: Partial<AutonomousState> = {}): Promise<AutonomousState> {
        const current = await this.read();
        return this.write({ ...current, ...patch, version: 1, phase, updatedAt: new Date().toISOString() });
    }

    private initial(): AutonomousState {
        return {
            version: 1,
            phase: 'diagnose',
            selectedAction: null,
            selectedTaskId: null,
            lastOutcome: null,
            updatedAt: new Date().toISOString(),
        };
    }

    private async write(state: AutonomousState): Promise<AutonomousState> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporaryFile = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
        await fs.rename(temporaryFile, this.file);
        return state;
    }
}