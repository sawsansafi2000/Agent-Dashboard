import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AgentTask<T = unknown> {
    id: string;
    idempotencyKey: string;
    projectId: string;
    role: string;
    type: string;
    payload: T;
    status: TaskStatus;
    attempts: number;
    maxAttempts: number;
    workerId: string | null;
    leaseExpiresAt: string | null;
    result: unknown;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

interface TaskDocument {
    version: 1;
    tasks: AgentTask[];
}

export interface EnqueueTaskInput<T> {
    idempotencyKey: string;
    projectId: string;
    role: string;
    type: string;
    payload: T;
    maxAttempts?: number;
}

export class TaskQueue {
    private readonly taskFile: string;
    private readonly lockDirectory: string;
    private readonly eventFile: string;

    constructor(private readonly rootDirectory: string) {
        this.taskFile = path.join(rootDirectory, 'data', 'agent-tasks.json');
        this.lockDirectory = `${this.taskFile}.lock`;
        this.eventFile = path.join(rootDirectory, 'data', 'task-events.ndjson');
    }

    async enqueue<T>(input: EnqueueTaskInput<T>): Promise<AgentTask<T>> {
        if (!input.idempotencyKey.trim() || !input.projectId.trim() || !input.role.trim() || !input.type.trim()) {
            throw new Error('Task-Schlüssel, Projekt, Rolle und Typ sind erforderlich.');
        }
        const maxAttempts = input.maxAttempts ?? 3;
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
            throw new Error('Maximale Versuche müssen eine positive ganze Zahl sein.');
        }
        return this.mutate(async document => {
            const existing = document.tasks.find(task => task.idempotencyKey === input.idempotencyKey);
            if (existing) return { value: existing as AgentTask<T>, event: null };
            const now = new Date().toISOString();
            const task: AgentTask<T> = {
                ...input,
                id: randomUUID(),
                maxAttempts,
                status: 'queued',
                attempts: 0,
                workerId: null,
                leaseExpiresAt: null,
                result: null,
                error: null,
                createdAt: now,
                updatedAt: now,
            };
            document.tasks.push(task);
            return { value: task, event: { type: 'task.queued', taskId: task.id } };
        });
    }

    async claim(role: string, workerId: string, leaseMilliseconds = 60_000): Promise<AgentTask | null> {
        if (!role.trim() || !workerId.trim()) throw new Error('Rolle und Worker-ID sind erforderlich.');
        if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds <= 0) {
            throw new Error('Lease-Dauer muss eine positive ganze Zahl sein.');
        }
        return this.mutate(async document => {
            const now = Date.now();
            const task = document.tasks.find(candidate => candidate.role === role
                && candidate.attempts < candidate.maxAttempts
                && (candidate.status === 'queued'
                    || (candidate.status === 'running' && Date.parse(candidate.leaseExpiresAt ?? '') <= now)));
            if (!task) return { value: null, event: null };
            task.status = 'running';
            task.attempts += 1;
            task.workerId = workerId;
            task.leaseExpiresAt = new Date(now + leaseMilliseconds).toISOString();
            task.updatedAt = new Date(now).toISOString();
            return { value: task, event: { type: 'task.claimed', taskId: task.id, workerId } };
        });
    }

    async heartbeat(taskId: string, workerId: string, leaseMilliseconds = 60_000): Promise<AgentTask> {
        return this.updateOwnedTask(taskId, workerId, 'task.heartbeat', task => {
            task.leaseExpiresAt = new Date(Date.now() + leaseMilliseconds).toISOString();
        });
    }

    async complete(taskId: string, workerId: string, result: unknown): Promise<AgentTask> {
        return this.updateOwnedTask(taskId, workerId, 'task.completed', task => {
            task.status = 'completed';
            task.result = result;
            task.error = null;
            task.leaseExpiresAt = null;
        });
    }

    async fail(taskId: string, workerId: string, error: string): Promise<AgentTask> {
        return this.updateOwnedTask(taskId, workerId, 'task.failed', task => {
            task.status = task.attempts < task.maxAttempts ? 'queued' : 'failed';
            task.error = error;
            task.workerId = null;
            task.leaseExpiresAt = null;
        });
    }

    async defer(taskId: string, workerId: string, reason: string): Promise<AgentTask> {
        return this.updateOwnedTask(taskId, workerId, 'task.deferred', task => {
            task.status = 'queued';
            task.attempts = Math.max(0, task.attempts - 1);
            task.error = reason;
            task.workerId = null;
            task.leaseExpiresAt = null;
        });
    }

    async list(projectId?: string): Promise<AgentTask[]> {
        const document = await this.read();
        return document.tasks.filter(task => !projectId || task.projectId === projectId);
    }

    private async updateOwnedTask(
        taskId: string,
        workerId: string,
        eventType: string,
        update: (task: AgentTask) => void,
    ): Promise<AgentTask> {
        return this.mutate(async document => {
            const task = document.tasks.find(candidate => candidate.id === taskId);
            if (!task) throw new Error(`Task ${taskId} wurde nicht gefunden.`);
            if (task.status !== 'running' || task.workerId !== workerId) {
                throw new Error(`Task ${taskId} gehört nicht Worker ${workerId}.`);
            }
            update(task);
            task.updatedAt = new Date().toISOString();
            return { value: task, event: { type: eventType, taskId, workerId } };
        });
    }

    private async mutate<T>(
        operation: (document: TaskDocument) => Promise<{ value: T; event: Record<string, unknown> | null }>,
    ): Promise<T> {
        const release = await this.acquireLock();
        try {
            const document = await this.read();
            const outcome = await operation(document);
            await this.write(document);
            if (outcome.event) await this.appendEvent(outcome.event);
            return outcome.value;
        } finally {
            await release();
        }
    }

    private async read(): Promise<TaskDocument> {
        try {
            const document = JSON.parse(await fs.readFile(this.taskFile, 'utf8')) as Partial<TaskDocument>;
            return { version: 1, tasks: Array.isArray(document.tasks) ? document.tasks : [] };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tasks: [] };
            throw error;
        }
    }

    private async write(document: TaskDocument): Promise<void> {
        await fs.mkdir(path.dirname(this.taskFile), { recursive: true });
        const temporaryFile = `${this.taskFile}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify(document, null, 2), 'utf8');
        await fs.rename(temporaryFile, this.taskFile);
    }

    private async acquireLock(): Promise<() => Promise<void>> {
        await fs.mkdir(path.dirname(this.taskFile), { recursive: true });
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

    private async appendEvent(event: Record<string, unknown>): Promise<void> {
        await fs.appendFile(this.eventFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
    }
}