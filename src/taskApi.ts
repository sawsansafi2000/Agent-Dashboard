import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { TaskQueue } from './taskQueue.js';
import { ControlPlane, ControlState } from './controlPlane.js';
import { apiBudgetAlertMessage, apiBudgetWarningMessage } from './apiStatus.js';

const MAX_BODY_BYTES = 32_768;
const BUDGET_WARNING_CENTS = Number.parseInt(process.env.API_BUDGET_WARNING_CENTS || '1000', 10);
const OPENAI_API_KEYS_URL = 'https://platform.openai.com/api-keys';

class TaskApiRequestError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message);
    }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > MAX_BODY_BYTES) {
            throw new TaskApiRequestError(413, 'Anfrage ist zu groß.');
        }
        chunks.push(bytes);
    }
    let input: unknown;
    try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
        throw new TaskApiRequestError(400, 'Anfrage enthält kein gültiges JSON.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TaskApiRequestError(400, 'Anfrage muss ein JSON-Objekt enthalten.');
    }
    return input as Record<string, unknown>;
}

function apiAlert(state: ControlState): { active: boolean; message: string; reason: string | null; nextCheckAt: string | null } {
    const remainingCents = Math.max(0, state.apiBudgetCents - state.apiSpentCents);
    const active = remainingCents <= BUDGET_WARNING_CENTS || state.apiStatus === 'blocked';
    const message = state.apiStatus === 'blocked'
        ? `OpenAI-API blockiert (${state.apiBlockReason || 'unbekannter Grund'}). Token ${state.apiTokenLabel} unter ${OPENAI_API_KEYS_URL} prüfen.`
        : remainingCents <= 0
            ? apiBudgetAlertMessage(state.apiTokenLabel)
            : remainingCents <= BUDGET_WARNING_CENTS
                ? apiBudgetWarningMessage(remainingCents)
                : '';
    return {
        active,
        message,
        reason: state.apiBlockReason,
        nextCheckAt: state.nextApiCheckAt,
    };
}

export function startTaskApi(queue: TaskQueue, control: ControlPlane): Promise<ReturnType<typeof createServer>> {
    const token = process.env.INTERNAL_AGENT_API_TOKEN;
    if (!token) throw new Error('INTERNAL_AGENT_API_TOKEN ist nicht konfiguriert.');
    const port = Number.parseInt(process.env.INTERNAL_AGENT_API_PORT || '3101', 10);

    const server = createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer ${token}`) {
            sendJson(response, 401, { error: 'Nicht autorisiert.' });
            return;
        }

        try {
            if (request.method === 'GET' && request.url === '/tasks') {
                const [tasks, controlState] = await Promise.all([
                    queue.list('social-media-challenge'),
                    control.initialize(),
                ]);
                const recentTasks = tasks
                    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                    .slice(0, 100);
                sendJson(response, 200, {
                    tasks: recentTasks,
                    executionMode: process.env.AGENT_EXECUTION_MODE === 'local' ? 'local-deterministic' : 'model-backed',
                    apiAlert: apiAlert(controlState),
                    control: {
                        paused: controlState.paused,
                        infrastructureReady: controlState.infrastructureReady,
                        apiStatus: controlState.apiStatus,
                        apiBudgetCents: controlState.apiBudgetCents,
                        apiSpentCents: controlState.apiSpentCents,
                    },
                });
                return;
            }

            if (request.method === 'POST' && request.url === '/tasks') {
                const input = await readJson(request);
                const message = typeof input.message === 'string' ? input.message.trim() : '';
                const targetAgent = typeof input.targetAgent === 'string' ? input.targetAgent.trim() : 'master-orchestrator';
                if (!message || message.length > 4_000) {
                    sendJson(response, 400, { error: 'Nachricht muss zwischen 1 und 4.000 Zeichen lang sein.' });
                    return;
                }
                const clientRequestId = input.clientRequestId === undefined
                    ? crypto.randomUUID()
                    : typeof input.clientRequestId === 'string'
                        && /^[A-Za-z0-9._:-]{1,128}$/.test(input.clientRequestId)
                        ? input.clientRequestId
                        : null;
                if (!clientRequestId) {
                    sendJson(response, 400, { error: 'clientRequestId darf höchstens 128 sichere Zeichen enthalten.' });
                    return;
                }
                const localExecution = process.env.AGENT_EXECUTION_MODE === 'local';
                const task = await queue.enqueue({
                    idempotencyKey: `chat:${clientRequestId}`,
                    projectId: 'social-media-challenge',
                    role: 'master-orchestrator',
                    type: localExecution ? 'local-execution' : 'user-command',
                    payload: {
                        message,
                        targetAgent,
                        source: 'mobile-dashboard',
                        executionMode: localExecution ? 'local-deterministic' : 'model-backed',
                    },
                });
                sendJson(response, 201, { task });
                return;
            }

            if (request.method === 'POST' && request.url === '/control') {
                const input = await readJson(request);
                if (input.action !== 'pause' && input.action !== 'resume') {
                    sendJson(response, 400, { error: 'Aktion muss pause oder resume sein.' });
                    return;
                }
                try {
                    const state = await control.setPaused(input.action === 'pause');
                    sendJson(response, 200, {
                        control: {
                            paused: state.paused,
                            infrastructureReady: state.infrastructureReady,
                            apiStatus: state.apiStatus,
                            apiBudgetCents: state.apiBudgetCents,
                            apiSpentCents: state.apiSpentCents,
                        },
                    });
                } catch (error) {
                    throw new TaskApiRequestError(409, error instanceof Error ? error.message : 'Runner-Steuerung nicht möglich.');
                }
                return;
            }

            sendJson(response, 404, { error: 'Nicht gefunden.' });
        } catch (error) {
            const statusCode = error instanceof TaskApiRequestError ? error.statusCode : 500;
            if (statusCode >= 500) {
                console.error('[TaskAPI] Anfrage fehlgeschlagen:', error);
            }
            sendJson(response, statusCode, {
                error: error instanceof Error ? error.message : 'Interner Fehler.',
            });
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            console.log(`[TaskAPI] Bereit auf 127.0.0.1:${port}.`);
            resolve(server);
        });
    });
}