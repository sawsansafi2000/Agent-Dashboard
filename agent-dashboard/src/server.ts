import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { createServer } from 'http';
import path from 'path';
import { Server } from 'socket.io';
import app from './app';
import { isDashboardAuthorizationValid } from './dashboardAccess';
import { getIdeas } from './services/ideaStore';
import { agentCatalog, getPortfolioProjects } from './services/operations';
import { startSocialAutomation } from './services/socialAutomation';
import { SocialPublicationStore } from './services/socialPublisher';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://localhost:${PORT}/dashboard`;
const workspaceRoot = path.resolve(__dirname, '../..');
const heartbeatTimeoutMs = Number.parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '660000', 10);
const budgetWarningCents = Number.parseInt(process.env.API_BUDGET_WARNING_CENTS || '1000', 10);
const openAiBillingUrl = 'https://platform.openai.com/settings/organization/billing/overview';
const openAiApiKeysUrl = 'https://platform.openai.com/api-keys';

function apiBudgetMessage(remainingCents: number, tokenLabel?: string, blockReason?: string | null): string {
    if (blockReason) {
        return `OpenAI-API blockiert (${blockReason}). Token ${tokenLabel || process.env.API_TOKEN_LABEL || 'OPENAI_API_KEY'} unter ${openAiApiKeysUrl} prüfen; Guthaben und Zahlungsdaten unter ${openAiBillingUrl} verwalten.`;
    }
    if (remainingCents <= 0) {
        return `API-Budget leer – bitte Token ${tokenLabel || process.env.API_TOKEN_LABEL || 'OPENAI_API_KEY'} unter ${openAiBillingUrl} aufladen`;
    }
    const remainingEuros = (remainingCents / 100).toFixed(2).replace('.', ',');
    return `API-Budget wird knapp: noch ${remainingEuros} EUR verfügbar. Jetzt Guthaben unter ${openAiBillingUrl} aufladen, damit die Agenten ohne Unterbrechung weiterlaufen.`;
}

process.env.INTERNAL_AGENT_API_TOKEN ||= randomBytes(32).toString('hex');

interface HealthControlState {
    paused: boolean;
    infrastructureReady: boolean;
    lastHeartbeatAt: string | null;
    apiBudgetCents: number;
    apiSpentCents: number;
    apiStatus?: 'unknown' | 'healthy' | 'blocked';
    apiBlockReason?: string | null;
    apiTokenLabel?: string;
    nextApiCheckAt?: string | null;
    consecutiveFailures: number;
}

interface HealthTaskDocument {
    tasks?: Array<{ status?: string }>;
}

const server = createServer(app);
const io = new Server(server);
io.use((socket, next) => {
    if (isDashboardAuthorizationValid(socket.handshake.headers.authorization)) {
        next();
        return;
    }
    next(new Error('Nicht autorisiert.'));
});
let agentProcess: ChildProcessWithoutNullStreams | null = null;
let stopping = false;
let restartCount = 0;
let startedAt: string | null = null;
let lastMessage = 'Agenten-Loop wird gestartet.';
let lastError: string | null = null;

function cleanOutput(value: Buffer): string {
    const lines = value.toString('utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.find(line => /error|fehlgeschlagen/i.test(line)) || lines.pop() || '';
}

function startAgentLoop(): void {
    const tsxEntry = path.join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    agentProcess = spawn(process.execPath, [tsxEntry, path.join(workspaceRoot, 'src', 'runAgentLoop.ts')], {
        cwd: workspaceRoot,
        env: process.env,
        windowsHide: true,
    });
    startedAt = new Date().toISOString();
    lastError = null;

    agentProcess.stdout.on('data', output => {
        lastMessage = cleanOutput(output) || lastMessage;
        console.log(`[Agent] ${lastMessage}`);
    });
    agentProcess.stderr.on('data', output => {
        lastError = cleanOutput(output) || lastError;
        console.error(`[Agent] ${lastError}`);
    });
    agentProcess.once('error', error => {
        lastError = `Agenten-Loop konnte nicht gestartet werden: ${error.message}`;
        console.error(`[Agent] ${lastError}`);
    });
    agentProcess.once('close', (code, signal) => {
        agentProcess = null;
        lastError ||= `Agenten-Loop beendet (Code ${code ?? 'n/a'}, Signal ${signal ?? 'n/a'}).`;
        if (!stopping) {
            restartCount += 1;
            setTimeout(startAgentLoop, 5000);
        }
    });
}

async function getSnapshot() {
    const [ideas, control] = await Promise.all([
        getIdeas(),
        fs.readFile(path.join(workspaceRoot, 'data', 'control-plane.json'), 'utf8')
            .then(contents => JSON.parse(contents) as HealthControlState),
    ]);
    const projects = getPortfolioProjects(ideas);
    const remainingBudgetCents = Math.max(0, control.apiBudgetCents - control.apiSpentCents);
    const apiAlertActive = remainingBudgetCents <= budgetWarningCents || control.apiStatus === 'blocked';
    return {
        timestamp: new Date().toISOString(),
        apiAlert: {
            active: apiAlertActive,
            message: apiAlertActive
                ? apiBudgetMessage(remainingBudgetCents, control.apiTokenLabel, control.apiBlockReason)
                : '',
            reason: control.apiBlockReason || null,
            nextCheckAt: control.nextApiCheckAt || null,
        },
        agents: agentCatalog.map(agent => ({
            ...agent,
            status: agentProcess ? 'working' : 'restarting',
            pid: agentProcess?.pid ?? null,
            startedAt,
            restartCount,
            lastMessage,
            lastError,
        })),
        ideas,
        projects,
        metrics: {
            totalIdeas: ideas.length,
            generatedIdeas: ideas.filter(idea => idea.source === 'agent').length,
            manualIdeas: ideas.filter(idea => idea.source === 'manual').length,
            processedIdeas: ideas.filter(idea => Boolean(idea.processedAt)).length,
            activeProjects: projects.filter(project => project.stage !== 'on-hold').length,
            revenue: projects.reduce((sum, project) => sum + project.revenue, 0),
            orders: projects.reduce((sum, project) => sum + project.orders, 0),
        },
    };
}

app.get('/health', async (_req, res) => {
    try {
        const controlState = JSON.parse(
            await fs.readFile(path.join(workspaceRoot, 'data', 'control-plane.json'), 'utf8'),
        ) as HealthControlState;
        const taskDocument = await fs.readFile(path.join(workspaceRoot, 'data', 'agent-tasks.json'), 'utf8')
            .then(contents => JSON.parse(contents) as HealthTaskDocument)
            .catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [] };
                throw error;
            });
        const heartbeatAgeMs = controlState.lastHeartbeatAt
            ? Date.now() - Date.parse(controlState.lastHeartbeatAt)
            : null;
        const heartbeatStale = heartbeatAgeMs === null || heartbeatAgeMs > heartbeatTimeoutMs;
        const processRunning = Boolean(agentProcess);
        const healthy = processRunning && !heartbeatStale;
        const remainingBudgetCents = Math.max(0, controlState.apiBudgetCents - controlState.apiSpentCents);
        res.status(healthy ? 200 : 503).json({
            status: healthy ? 'ok' : 'degraded',
            agentProcess: processRunning ? 'running' : 'stopped',
            heartbeat: {
                lastAt: controlState.lastHeartbeatAt,
                ageMs: heartbeatAgeMs,
                stale: heartbeatStale,
                timeoutMs: heartbeatTimeoutMs,
            },
            control: controlState,
            apiAlert: {
                active: remainingBudgetCents <= budgetWarningCents
                    || controlState.apiStatus === 'blocked',
                message: apiBudgetMessage(remainingBudgetCents, controlState.apiTokenLabel, controlState.apiBlockReason),
                reason: controlState.apiBlockReason || null,
                nextCheckAt: controlState.nextApiCheckAt || null,
            },
            tasks: {
                queued: taskDocument.tasks?.filter(task => task.status === 'queued').length ?? 0,
                running: taskDocument.tasks?.filter(task => task.status === 'running').length ?? 0,
                failed: taskDocument.tasks?.filter(task => task.status === 'failed').length ?? 0,
            },
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            res.status(503).json({ status: 'initializing', agentProcess: agentProcess ? 'running' : 'stopped' });
            return;
        }
        res.status(500).json({ status: 'error' });
    }
});

app.get('/api/status', (_req, res, next) => {
    void getSnapshot()
        .then(snapshot => res.json(snapshot))
        .catch(next);
});

io.on('connection', (socket) => {
    void getSnapshot().then(snapshot => socket.emit('system:update', snapshot));
});

const broadcastInterval = setInterval(() => {
    void getSnapshot()
        .then(snapshot => io.emit('system:update', snapshot))
        .catch(error => console.error('[Dashboard] Snapshot fehlgeschlagen:', error));
}, 2000);
const stopSocialAutomation = startSocialAutomation(new SocialPublicationStore(workspaceRoot));

function shutdown(): void {
    stopping = true;
    clearInterval(broadcastInterval);
    stopSocialAutomation();
    agentProcess?.kill();
    server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

startAgentLoop();
server.listen(PORT, HOST, () => {
    console.log(`Developer-Dashboard: ${DASHBOARD_URL}`);
});

export { getSnapshot };