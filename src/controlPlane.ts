import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { apiProviderBlockedMessage } from './apiStatus.js';

export interface ControlState {
    version: 1;
    infrastructureReady: boolean;
    paused: boolean;
    activeProjectId: string | null;
    apiBudgetCents: number;
    apiSpentCents: number;
    apiStatus: 'unknown' | 'healthy' | 'blocked';
    apiBlockReason: string | null;
    apiTokenLabel: string;
    lastApiCheckAt: string | null;
    nextApiCheckAt: string | null;
    lastHeartbeatAt: string | null;
    lastCycleAt: string | null;
    consecutiveFailures: number;
    updatedAt: string;
}

export interface RunDecision {
    allowed: boolean;
    reason: string;
}

function initialState(): ControlState {
    return {
        version: 1,
        infrastructureReady: false,
        paused: true,
        activeProjectId: null,
        apiBudgetCents: 0,
        apiSpentCents: 0,
        apiStatus: 'unknown',
        apiBlockReason: null,
        apiTokenLabel: process.env.API_TOKEN_LABEL || 'OPENAI_API_KEY',
        lastApiCheckAt: null,
        nextApiCheckAt: null,
        lastHeartbeatAt: null,
        lastCycleAt: null,
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString(),
    };
}

export class ControlPlane {
    private readonly stateFile: string;
    private readonly lockDirectory: string;
    private readonly eventFile: string;
    private readonly stopFile: string;

    constructor(private readonly rootDirectory: string) {
        this.stateFile = path.join(rootDirectory, 'data', 'control-plane.json');
        this.lockDirectory = `${this.stateFile}.lock`;
        this.eventFile = path.join(rootDirectory, 'data', 'control-events.ndjson');
        this.stopFile = path.join(rootDirectory, 'STOP.txt');
    }

    async initialize(): Promise<ControlState> {
        const release = await this.acquireLock();
        try {
            return await this.readOrInitialize();
        } finally {
            await release();
        }
    }

    async read(): Promise<ControlState> {
        const stored = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<ControlState>;
        return { ...initialState(), ...stored, version: 1 };
    }

    async update(patch: Partial<ControlState>, eventType: string): Promise<ControlState> {
        return this.mutate(eventType, current => ({ ...current, ...patch }));
    }

    async getRunDecision(requiredBudgetCents = 1): Promise<RunDecision> {
        if (!Number.isSafeInteger(requiredBudgetCents) || requiredBudgetCents <= 0) {
            throw new Error('Erforderliches API-Budget muss eine positive ganze Cent-Zahl sein.');
        }
        const state = await this.initialize();
        if (await this.isKillSwitchActive()) return { allowed: false, reason: 'Not-Aus ist aktiv.' };
        if (state.paused) return { allowed: false, reason: 'System ist pausiert.' };
        if (!state.infrastructureReady) return { allowed: false, reason: 'Infrastruktur ist nicht freigegeben.' };
        if (state.apiStatus === 'blocked') {
            return { allowed: false, reason: apiProviderBlockedMessage(state.apiBlockReason, state.apiTokenLabel) };
        }
        if (process.env.BYPASS_BUDGET_CHECK === 'true') {
            return { allowed: true, reason: 'Kontrollprüfungen bestanden; lokale Budgetreservierung ist explizit umgangen.' };
        }
        if (state.apiBudgetCents <= 0) return { allowed: false, reason: 'Kein API-Budget freigegeben.' };
        if (state.apiBudgetCents - state.apiSpentCents < requiredBudgetCents) {
            return { allowed: false, reason: `Verbleibendes API-Budget reicht nicht für die reservierten ${requiredBudgetCents} Cent.` };
        }
        return { allowed: true, reason: 'Kontrollprüfungen bestanden.' };
    }

    async claimProject(projectId: string): Promise<ControlState> {
        return this.mutate('project.claimed', state => {
            if (state.activeProjectId && state.activeProjectId !== projectId) {
                throw new Error(`Projekt ${state.activeProjectId} ist bereits aktiv.`);
            }
            return { ...state, activeProjectId: projectId };
        });
    }

    async releaseProject(projectId: string): Promise<ControlState> {
        return this.mutate('project.released', state => {
            if (state.activeProjectId !== projectId) throw new Error(`Projekt ${projectId} ist nicht aktiv.`);
            return { ...state, activeProjectId: null };
        });
    }

    async recordApiCost(costCents: number): Promise<ControlState> {
        if (!Number.isSafeInteger(costCents) || costCents < 0) throw new Error('API-Kosten müssen ganze Cent sein.');
        return this.mutate('budget.debited', state => ({
            ...state,
            apiSpentCents: state.apiSpentCents + costCents,
        }));
    }

    async markApiBlocked(reason: string, nextCheckAt: string): Promise<ControlState> {
        return this.update({
            apiStatus: 'blocked',
            apiBlockReason: reason,
            apiTokenLabel: process.env.API_TOKEN_LABEL || 'OPENAI_API_KEY',
            lastApiCheckAt: new Date().toISOString(),
            nextApiCheckAt: nextCheckAt,
        }, 'api.blocked');
    }

    async markApiHealthy(): Promise<ControlState> {
        return this.update({
            apiStatus: 'healthy',
            apiBlockReason: null,
            lastApiCheckAt: new Date().toISOString(),
            nextApiCheckAt: null,
            consecutiveFailures: 0,
        }, 'api.recovered');
    }

    async heartbeat(lastCycleAt?: string): Promise<ControlState> {
        return this.update({
            lastHeartbeatAt: new Date().toISOString(),
            ...(lastCycleAt ? { lastCycleAt } : {}),
        }, 'system.heartbeat');
    }

    async recordFailure(message: string): Promise<ControlState> {
        await this.appendEvent('system.failure', { message });
        return this.mutate('system.failure-counted', state => ({
            ...state,
            consecutiveFailures: state.consecutiveFailures + 1,
        }));
    }

    private async mutate(eventType: string, update: (state: ControlState) => ControlState): Promise<ControlState> {
        const release = await this.acquireLock();
        try {
            const current = await this.readOrInitialize();
            const next: ControlState = {
                ...update(current),
                version: 1,
                updatedAt: new Date().toISOString(),
            };
            if (next.apiSpentCents > next.apiBudgetCents && process.env.BYPASS_BUDGET_CHECK !== 'true') {
                throw new Error('API-Budget würde überschritten.');
            }
            await this.write(next);
            await this.appendEvent(eventType, next);
            return next;
        } finally {
            await release();
        }
    }

    private async readOrInitialize(): Promise<ControlState> {
        try {
            return await this.read();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const state = initialState();
            await this.write(state);
            await this.appendEvent('control.initialized', { paused: true });
            return state;
        }
    }

    private async isKillSwitchActive(): Promise<boolean> {
        try {
            return (await fs.readFile(this.stopFile, 'utf8')).trim().toUpperCase().includes('ACTIVE');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        }
    }

    private async write(state: ControlState): Promise<void> {
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
        const temporaryFile = `${this.stateFile}.${process.pid}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
        const deadline = Date.now() + 10_000;
        while (true) {
            try {
                await fs.rename(temporaryFile, this.stateFile);
                return;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (!['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    private async acquireLock(): Promise<() => Promise<void>> {
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
        const deadline = Date.now() + 10_000;
        while (true) {
            try {
                await fs.mkdir(this.lockDirectory);
                return () => fs.rm(this.lockDirectory, { recursive: true, force: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
    }

    private async appendEvent(type: string, payload: unknown): Promise<void> {
        await fs.mkdir(path.dirname(this.eventFile), { recursive: true });
        await fs.appendFile(this.eventFile, `${JSON.stringify({ at: new Date().toISOString(), type, payload })}\n`, 'utf8');
    }
}