import { AgentTask, TaskQueue } from './taskQueue.js';
import { ApiPausedError } from './apiStatus.js';

export type TaskHandler = (task: AgentTask) => Promise<unknown>;

export interface WorkerDefinition {
    id: string;
    role: string;
    handler: TaskHandler;
}

export class AgentWorker {
    constructor(
        private readonly queue: TaskQueue,
        private readonly definition: WorkerDefinition,
        private readonly leaseMilliseconds = 60_000,
    ) {}

    async runOnce(): Promise<boolean> {
        const task = await this.queue.claim(
            this.definition.role,
            this.definition.id,
            this.leaseMilliseconds,
        );
        if (!task) return false;

        const heartbeatInterval = setInterval(() => {
            void this.queue.heartbeat(task.id, this.definition.id, this.leaseMilliseconds)
                .catch(error => console.error(`[Worker:${this.definition.id}] Heartbeat fehlgeschlagen:`, error));
        }, Math.max(100, Math.floor(this.leaseMilliseconds / 3)));

        try {
            const result = await this.definition.handler(task);
            await this.queue.complete(task.id, this.definition.id, result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof ApiPausedError) {
                await this.queue.defer(task.id, this.definition.id, message);
            } else {
                await this.queue.fail(task.id, this.definition.id, message);
            }
        } finally {
            clearInterval(heartbeatInterval);
        }
        return true;
    }
}

export async function runWorkerRound(workers: AgentWorker[]): Promise<number> {
    const outcomes = await Promise.all(workers.map(worker => worker.runOnce()));
    return outcomes.filter(Boolean).length;
}