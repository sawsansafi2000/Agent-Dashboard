import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';

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

interface TaskRow {
    id: string;
    idempotency_key: string;
    project_id: string;
    role: string;
    type: string;
    payload_json: string;
    status: TaskStatus;
    attempts: number;
    max_attempts: number;
    worker_id: string | null;
    lease_expires_at: string | null;
    result_json: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
}

interface LegacyTaskDocument {
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

function run(database: sqlite3.Database, sql: string, parameters: unknown[] = []): Promise<sqlite3.RunResult> {
    return new Promise((resolve, reject) => {
        database.run(sql, parameters, function (error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function get<T>(database: sqlite3.Database, sql: string, parameters: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        database.get<T>(sql, parameters, (error, row) => error ? reject(error) : resolve(row));
    });
}

function all<T>(database: sqlite3.Database, sql: string, parameters: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
        database.all<T>(sql, parameters, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function serialize(value: unknown, label: string): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`${label} ist nicht als JSON speicherbar.`);
    return encoded;
}

function fromRow<T = unknown>(row: TaskRow): AgentTask<T> {
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        projectId: row.project_id,
        role: row.role,
        type: row.type,
        payload: JSON.parse(row.payload_json) as T,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        workerId: row.worker_id,
        leaseExpiresAt: row.lease_expires_at,
        result: row.result_json === null ? null : JSON.parse(row.result_json),
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export class TaskQueue {
    private readonly databasePath: string;
    private readonly legacyTaskFile: string;
    private databasePromise: Promise<sqlite3.Database> | null = null;
    private operationTail: Promise<void> = Promise.resolve();

    constructor(private readonly rootDirectory: string) {
        this.databasePath = path.resolve(process.env.DATABASE_PATH || path.join(rootDirectory, 'database.sqlite'));
        this.legacyTaskFile = path.join(rootDirectory, 'data', 'agent-tasks.json');
    }

    async enqueue<T>(input: EnqueueTaskInput<T>): Promise<AgentTask<T>> {
        if (!input.idempotencyKey.trim() || !input.projectId.trim() || !input.role.trim() || !input.type.trim()) {
            throw new Error('Task-Schlüssel, Projekt, Rolle und Typ sind erforderlich.');
        }
        const maxAttempts = input.maxAttempts ?? 3;
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
            throw new Error('Maximale Versuche müssen eine positive ganze Zahl sein.');
        }
        const payload = serialize(input.payload, 'Task-Payload');
        return this.transaction(async database => {
            const existing = await get<TaskRow>(
                database,
                'SELECT * FROM agent_tasks WHERE idempotency_key = ?',
                [input.idempotencyKey],
            );
            if (existing) return fromRow<T>(existing);

            const now = new Date().toISOString();
            const task: AgentTask<T> = {
                id: randomUUID(),
                idempotencyKey: input.idempotencyKey,
                projectId: input.projectId,
                role: input.role,
                type: input.type,
                payload: input.payload,
                status: 'queued',
                attempts: 0,
                maxAttempts,
                workerId: null,
                leaseExpiresAt: null,
                result: null,
                error: null,
                createdAt: now,
                updatedAt: now,
            };
            await run(database, `INSERT INTO agent_tasks (
                id, idempotency_key, project_id, role, type, payload_json, status, attempts, max_attempts,
                worker_id, lease_expires_at, result_json, error, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                task.id, task.idempotencyKey, task.projectId, task.role, task.type, payload, task.status,
                task.attempts, task.maxAttempts, task.workerId, task.leaseExpiresAt, null, task.error,
                task.createdAt, task.updatedAt,
            ]);
            await this.appendEvent(database, 'task.queued', task);
            return task;
        });
    }

    async claim(role: string, workerId: string, leaseMilliseconds = 60_000): Promise<AgentTask | null> {
        if (!role.trim() || !workerId.trim()) throw new Error('Rolle und Worker-ID sind erforderlich.');
        if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds <= 0) {
            throw new Error('Lease-Dauer muss eine positive ganze Zahl sein.');
        }
        return this.transaction(async database => {
            const now = Date.now();
            const nowIso = new Date(now).toISOString();
            const expired = await all<TaskRow>(database, `SELECT * FROM agent_tasks
                WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts`, [nowIso]);
            for (const row of expired) {
                const error = row.error || 'Worker-Lease nach maximalen Versuchen abgelaufen.';
                await run(database, `UPDATE agent_tasks SET status = 'failed', worker_id = NULL,
                    lease_expires_at = NULL, error = ?, updated_at = ? WHERE id = ?`, [error, nowIso, row.id]);
                const updated = await this.getTask(database, row.id);
                if (updated) await this.appendEvent(database, 'task.failed', updated);
            }

            const row = await get<TaskRow>(database, `SELECT * FROM agent_tasks
                WHERE role = ? AND attempts < max_attempts
                  AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?))
                ORDER BY created_at ASC LIMIT 1`, [role, nowIso]);
            if (!row) return null;

            const leaseExpiresAt = new Date(now + leaseMilliseconds).toISOString();
            await run(database, `UPDATE agent_tasks SET status = 'running', attempts = attempts + 1,
                worker_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`, [
                workerId, leaseExpiresAt, nowIso, row.id,
            ]);
            const claimed = await this.getTask(database, row.id);
            if (!claimed) throw new Error(`Task ${row.id} ist nach dem Claim nicht mehr vorhanden.`);
            await this.appendEvent(database, 'task.claimed', claimed);
            return claimed;
        });
    }

    async heartbeat(taskId: string, workerId: string, leaseMilliseconds = 60_000): Promise<AgentTask> {
        if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds <= 0) {
            throw new Error('Lease-Dauer muss eine positive ganze Zahl sein.');
        }
        return this.updateOwnedTask(taskId, workerId, 'task.heartbeat', async (database, task) => {
            const leaseExpiresAt = new Date(Date.now() + leaseMilliseconds).toISOString();
            await run(database, 'UPDATE agent_tasks SET lease_expires_at = ? WHERE id = ?', [leaseExpiresAt, task.id]);
        });
    }

    async complete(taskId: string, workerId: string, result: unknown): Promise<AgentTask> {
        const encodedResult = serialize(result, 'Task-Ergebnis');
        return this.updateOwnedTask(taskId, workerId, 'task.completed', async (database, task) => {
            await run(database, `UPDATE agent_tasks SET status = 'completed', result_json = ?,
                error = NULL, lease_expires_at = NULL WHERE id = ?`, [encodedResult, task.id]);
        });
    }

    async fail(taskId: string, workerId: string, error: string): Promise<AgentTask> {
        return this.updateOwnedTask(taskId, workerId, 'task.failed', async (database, task) => {
            const status = task.attempts < task.maxAttempts ? 'queued' : 'failed';
            await run(database, `UPDATE agent_tasks SET status = ?, error = ?, worker_id = NULL,
                lease_expires_at = NULL WHERE id = ?`, [status, error, task.id]);
        });
    }

    async defer(taskId: string, workerId: string, reason: string): Promise<AgentTask> {
        return this.updateOwnedTask(taskId, workerId, 'task.deferred', async (database, task) => {
            await run(database, `UPDATE agent_tasks SET status = 'queued', attempts = MAX(0, attempts - 1),
                error = ?, worker_id = NULL, lease_expires_at = NULL WHERE id = ?`, [reason, task.id]);
        });
    }

    async list(projectId?: string): Promise<AgentTask[]> {
        return this.withDatabase(async database => {
            const rows = projectId
                ? await all<TaskRow>(database, 'SELECT * FROM agent_tasks WHERE project_id = ? ORDER BY created_at ASC', [projectId])
                : await all<TaskRow>(database, 'SELECT * FROM agent_tasks ORDER BY created_at ASC');
            return rows.map(row => fromRow(row));
        });
    }

    async close(): Promise<void> {
        await this.withDatabase(async database => new Promise<void>((resolve, reject) => {
            database.close(error => error ? reject(error) : resolve());
        }));
        this.databasePromise = null;
    }

    private async updateOwnedTask(
        taskId: string,
        workerId: string,
        eventType: string,
        update: (database: sqlite3.Database, task: AgentTask) => Promise<void>,
    ): Promise<AgentTask> {
        return this.transaction(async database => {
            const task = await this.getTask(database, taskId);
            if (!task) throw new Error(`Task ${taskId} wurde nicht gefunden.`);
            if (task.status !== 'running' || task.workerId !== workerId) {
                throw new Error(`Task ${taskId} gehört nicht Worker ${workerId}.`);
            }
            await update(database, task);
            await run(database, 'UPDATE agent_tasks SET updated_at = ? WHERE id = ?', [new Date().toISOString(), task.id]);
            const updated = await this.getTask(database, task.id);
            if (!updated) throw new Error(`Task ${task.id} ist nach der Aktualisierung nicht mehr vorhanden.`);
            await this.appendEvent(database, eventType, updated);
            return updated;
        });
    }

    private async getTask(database: sqlite3.Database, taskId: string): Promise<AgentTask | null> {
        const row = await get<TaskRow>(database, 'SELECT * FROM agent_tasks WHERE id = ?', [taskId]);
        return row ? fromRow(row) : null;
    }

    private async appendEvent(database: sqlite3.Database, eventType: string, task: AgentTask): Promise<void> {
        const event = {
            id: task.id,
            projectId: task.projectId,
            role: task.role,
            type: task.type,
            status: task.status,
            attempts: task.attempts,
            maxAttempts: task.maxAttempts,
            workerId: task.workerId,
            leaseExpiresAt: task.leaseExpiresAt,
            updatedAt: task.updatedAt,
        };
        await run(database, `INSERT INTO agent_task_events (task_id, event_type, occurred_at, worker_id, payload_json)
            VALUES (?, ?, ?, ?, ?)`, [
            task.id,
            eventType,
            new Date().toISOString(),
            task.workerId,
            serialize(event, 'Task-Ereignis'),
        ]);
    }

    private async transaction<T>(operation: (database: sqlite3.Database) => Promise<T>): Promise<T> {
        return this.withExclusiveDatabase(async database => {
            await run(database, 'BEGIN IMMEDIATE');
            try {
                const result = await operation(database);
                await run(database, 'COMMIT');
                return result;
            } catch (error) {
                await run(database, 'ROLLBACK').catch(rollbackError => {
                    console.error('[TaskQueue] Rollback fehlgeschlagen:', rollbackError);
                });
                throw error;
            }
        });
    }

    private async withDatabase<T>(operation: (database: sqlite3.Database) => Promise<T>): Promise<T> {
        return this.withExclusiveDatabase(operation);
    }

    private async withExclusiveDatabase<T>(operation: (database: sqlite3.Database) => Promise<T>): Promise<T> {
        const previous = this.operationTail;
        let release!: () => void;
        this.operationTail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            const database = await this.getDatabase();
            return await operation(database);
        } finally {
            release();
        }
    }

    private async getDatabase(): Promise<sqlite3.Database> {
        if (!this.databasePromise) {
            this.databasePromise = this.openDatabase();
        }
        return this.databasePromise;
    }

    private async openDatabase(): Promise<sqlite3.Database> {
        await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
        const database = await new Promise<sqlite3.Database>((resolve, reject) => {
            const opened = new sqlite3.Database(this.databasePath, error => error ? reject(error) : resolve(opened));
        });
        database.configure('busyTimeout', 10_000);
        try {
            await new Promise<void>((resolve, reject) => {
                database.exec(`PRAGMA journal_mode = WAL;
                    PRAGMA synchronous = FULL;
                    CREATE TABLE IF NOT EXISTS agent_tasks (
                        id TEXT PRIMARY KEY,
                        idempotency_key TEXT NOT NULL UNIQUE,
                        project_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        type TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
                        attempts INTEGER NOT NULL,
                        max_attempts INTEGER NOT NULL,
                        worker_id TEXT,
                        lease_expires_at TEXT,
                        result_json TEXT,
                        error TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS agent_tasks_claim_idx
                        ON agent_tasks(role, status, created_at);
                    CREATE TABLE IF NOT EXISTS agent_task_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        task_id TEXT NOT NULL,
                        event_type TEXT NOT NULL,
                        occurred_at TEXT NOT NULL,
                        worker_id TEXT,
                        payload_json TEXT NOT NULL,
                        FOREIGN KEY(task_id) REFERENCES agent_tasks(id)
                    );
                    CREATE INDEX IF NOT EXISTS agent_task_events_task_idx
                        ON agent_task_events(task_id, id);`, error => error ? reject(error) : resolve());
            });
            await this.migrateLegacyQueue(database);
            return database;
        } catch (error) {
            await new Promise<void>(resolve => database.close(() => resolve()));
            throw error;
        }
    }

    private async migrateLegacyQueue(database: sqlite3.Database): Promise<void> {
        await run(database, `CREATE TABLE IF NOT EXISTS agent_queue_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);
        await run(database, 'BEGIN IMMEDIATE');
        try {
            const migrated = await get<{ value: string }>(
                database,
                "SELECT value FROM agent_queue_metadata WHERE key = 'legacy_json_migrated'",
            );
            if (migrated) {
                await run(database, 'COMMIT');
                return;
            }

            let legacy: LegacyTaskDocument = { version: 1, tasks: [] };
            try {
                const parsed = JSON.parse(await fs.readFile(this.legacyTaskFile, 'utf8')) as Partial<LegacyTaskDocument>;
                if (!Array.isArray(parsed.tasks)) throw new Error('tasks muss ein Array sein.');
                legacy = { version: 1, tasks: parsed.tasks };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw new Error(`Alte Task-Queue kann nicht sicher migriert werden: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            for (const task of legacy.tasks) {
                if (!task || typeof task.id !== 'string' || typeof task.idempotencyKey !== 'string'
                    || typeof task.projectId !== 'string' || typeof task.role !== 'string'
                    || typeof task.type !== 'string' || !['queued', 'running', 'completed', 'failed'].includes(task.status)) {
                    throw new Error('Alte Task-Queue enthält einen ungültigen Task; Migration wurde abgebrochen.');
                }
                const attempts = Number.isSafeInteger(task.attempts) && task.attempts >= 0 ? task.attempts : 0;
                const maxAttempts = Number.isSafeInteger(task.maxAttempts) && task.maxAttempts > 0 ? task.maxAttempts : 3;
                const normalizedStatus = task.status === 'running'
                    ? attempts < maxAttempts ? 'queued' : 'failed'
                    : task.status;
                const updatedAt = typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString();
                await run(database, `INSERT OR IGNORE INTO agent_tasks (
                    id, idempotency_key, project_id, role, type, payload_json, status, attempts, max_attempts,
                    worker_id, lease_expires_at, result_json, error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    task.id, task.idempotencyKey, task.projectId, task.role, task.type,
                    serialize(task.payload, 'Alte Task-Payload'), normalizedStatus, attempts,
                    maxAttempts, normalizedStatus === 'queued' || normalizedStatus === 'failed' ? null : task.workerId,
                    normalizedStatus === 'queued' || normalizedStatus === 'failed' ? null : task.leaseExpiresAt,
                    task.result == null ? null : serialize(task.result, 'Altes Task-Ergebnis'),
                    task.error, task.createdAt || updatedAt, updatedAt,
                ]);
                const migratedTask = await this.getTask(database, task.id);
                if (migratedTask) await this.appendEvent(database, 'task.migrated', migratedTask);
            }
            await run(database, "INSERT INTO agent_queue_metadata (key, value) VALUES ('legacy_json_migrated', ?)", [
                new Date().toISOString(),
            ]);
            await run(database, 'COMMIT');
        } catch (error) {
            await run(database, 'ROLLBACK').catch(rollbackError => {
                console.error('[TaskQueue] Rollback der Alt-Queue-Migration fehlgeschlagen:', rollbackError);
            });
            throw error;
        }
    }
}
