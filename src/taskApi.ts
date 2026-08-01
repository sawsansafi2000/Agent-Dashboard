import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { TaskQueue } from './taskQueue.js';
import { ControlPlane, ControlState } from './controlPlane.js';
import { apiBudgetAlertMessage, apiBudgetWarningMessage } from './apiStatus.js';

const MAX_BODY_BYTES = 32_768;
const BUDGET_WARNING_CENTS = Number.parseInt(process.env.API_BUDGET_WARNING_CENTS || '1000', 10);
const OPENAI_API_KEYS_URL = 'https://platform.openai.com/api-keys';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Anfrage ist zu groß.');
    }
    return JSON.parse(body || '{}') as Record<string, unknown>;
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
                sendJson(response, 200, { tasks: recentTasks, apiAlert: apiAlert(controlState) });
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
                const task = await queue.enqueue({
                    idempotencyKey: `chat:${input.clientRequestId || crypto.randomUUID()}`,
                    projectId: 'social-media-challenge',
                    role: 'master-orchestrator',
                    type: 'user-command',
                    payload: { message, targetAgent, source: 'mobile-dashboard' },
                });
                sendJson(response, 201, { task });
                return;
            }

            sendJson(response, 404, { error: 'Nicht gefunden.' });
        } catch (error) {
            sendJson(response, 500, { error: error instanceof Error ? error.message : 'Interner Fehler.' });
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