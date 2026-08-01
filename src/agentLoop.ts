import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { EnrichedIdea, FeasibilityAssessment, ProjectPlan, SalesPlan, runBusinessAgentPipeline } from './businessAgents.js';
import { ApiPricing, estimateMaximumTokenUsage, estimateTokenCostCents } from './apiBudget.js';
import { apiProviderBlockedMessage, ApiPausedError, getApiErrorDetails, importantLinksFooter } from './apiStatus.js';
import { AgentWorker } from './agentWorker.js';
import { AutonomousStateStore } from './autonomousStateMachine.js';
import { ControlPlane } from './controlPlane.js';
import { AgentTask, TaskQueue } from './taskQueue.js';

type IdeaSource = 'agent' | 'manual';

interface BusinessIdea {
    id: string;
    title: string;
    summary: string;
    targetMarkets: string[];
    businessModel: string;
    scalability: string;
    nextSteps: string[];
    source: IdeaSource;
    createdAt: string;
    processedAt?: string;
    feasibility?: FeasibilityAssessment;
    salesPlan?: SalesPlan;
    project?: ProjectPlan;
}

interface IdeasDocument {
    ideas: BusinessIdea[];
    updatedAt: string;
}

interface GeneratedIdea {
    title: string;
    summary: string;
    targetMarkets: string[];
    businessModel: string;
    scalability: string;
    nextSteps: string[];
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDirectory, '..');
const ideasFile = path.join(workspaceRoot, 'data', 'ideas.json');
const ideasLock = `${ideasFile}.lock`;
const controlPlane = new ControlPlane(workspaceRoot);
const taskQueue = new TaskQueue(workspaceRoot);
const autonomousState = new AutonomousStateStore(workspaceRoot);

dotenv.config({ path: path.join(workspaceRoot, '.env') });
dotenv.config({ path: path.join(workspaceRoot, 'guardrails.env'), override: true });

function readPositiveInteger(name: string, fallback: number): number {
    const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} muss eine positive ganze Zahl sein.`);
    }
    return value;
}

function readGuardrails() {
    const allowGitPush = (process.env.ALLOW_GIT_PUSH ?? 'false').toLowerCase();
    if (allowGitPush !== 'false') {
        throw new Error('Guardrail verletzt: ALLOW_GIT_PUSH muss false sein.');
    }

    return {
        ideasPerRun: Math.max(5, readPositiveInteger('IDEAS_PER_RUN', 5)),
        sleepTimeMs: readPositiveInteger('SLEEP_TIME_MS', 300_000),
        maximumCompletionTokens: readPositiveInteger('OPENAI_MAX_COMPLETION_TOKENS', 4_000),
        apiCheckIntervalMs: readPositiveInteger('API_STATUS_CHECK_INTERVAL_MS', 60_000),
        apiPricing: {
            inputCentsPerMillionTokens: readPositiveInteger('OPENAI_INPUT_CENTS_PER_MILLION_TOKENS', 250),
            outputCentsPerMillionTokens: readPositiveInteger('OPENAI_OUTPUT_CENTS_PER_MILLION_TOKENS', 1_000),
        } satisfies ApiPricing,
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        disallowedKeywords: (process.env.DISALLOWED_KEYWORDS ?? '')
            .split(',')
            .map(keyword => keyword.trim().toLowerCase())
            .filter(Boolean),
    };
}

const guardrails = readGuardrails();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let stopping = false;
let lastBlockedReason: string | null = null;

async function markProviderBlocked(error: unknown): Promise<never> {
    const details = getApiErrorDetails(error);
    if (!details) throw error;
    const nextCheckAt = new Date(Date.now() + guardrails.apiCheckIntervalMs).toISOString();
    await controlPlane.markApiBlocked(details.code || `HTTP ${details.status ?? 'unbekannt'}`, nextCheckAt);
    throw new ApiPausedError(apiProviderBlockedMessage(details.code || details.message));
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function replaceFile(source: string, destination: string): Promise<void> {
    const deadline = Date.now() + 10_000;

    while (true) {
        try {
            await fs.rename(source, destination);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) {
                throw error;
            }
            await delay(100);
        }
    }
}

async function acquireIdeasLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(ideasFile), { recursive: true });
    const deadline = Date.now() + 10_000;
    const staleAfterMs = 30_000;

    while (true) {
        try {
            await fs.mkdir(ideasLock);
            return async () => fs.rm(ideasLock, { recursive: true, force: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') {
                const lock = await fs.stat(ideasLock).catch(() => null);
                if (lock && Date.now() - lock.mtimeMs > staleAfterMs) {
                    await fs.rm(ideasLock, { recursive: true, force: true });
                    continue;
                }
            }
            if (code !== 'EEXIST' || Date.now() >= deadline) {
                throw error;
            }
            await delay(50);
        }
    }
}

async function readIdeas(): Promise<IdeasDocument> {
    try {
        const contents = await fs.readFile(ideasFile, 'utf8');
        const document = JSON.parse(contents) as Partial<IdeasDocument>;
        return {
            ideas: Array.isArray(document.ideas) ? document.ideas : [],
            updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : new Date(0).toISOString(),
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { ideas: [], updatedAt: new Date(0).toISOString() };
        }
        throw error;
    }
}

async function updateIdeas(update: (ideas: BusinessIdea[]) => BusinessIdea[]): Promise<void> {
    const release = await acquireIdeasLock();
    try {
        const document = await readIdeas();
        const ideas = update(document.ideas);
        const temporaryFile = `${ideasFile}.${process.pid}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify({ ideas, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
        await replaceFile(temporaryFile, ideasFile);
    } finally {
        await release();
    }
}

function isCompliant(idea: GeneratedIdea): boolean {
    const requiredText = [idea.title, idea.summary, idea.businessModel, idea.scalability];
    const allText = [...requiredText, ...(idea.targetMarkets ?? []), ...(idea.nextSteps ?? [])]
        .join(' ')
        .toLowerCase();

    return requiredText.every(value => typeof value === 'string' && value.trim().length > 0)
        && Array.isArray(idea.targetMarkets) && idea.targetMarkets.length > 0
        && Array.isArray(idea.nextSteps) && idea.nextSteps.length > 0
        && !guardrails.disallowedKeywords.some(keyword => allText.includes(keyword));
}

async function generateIdeas(contextIdeas: BusinessIdea[]): Promise<GeneratedIdea[] | null> {
    const context = contextIdeas.slice(-25).map(idea => ({
        title: idea.title,
        summary: idea.summary,
        source: idea.source,
    }));
    const userContent = `Vorhandene Ideen und manuelle Impulse:\n${JSON.stringify(context)}`;
    const systemContent = `Du bist der autonome Business-Innovation-Agent von Natur Vitale. Erzeuge pro Durchlauf ${guardrails.ideasPerRun} unterschiedliche, praktisch umsetzbare und international skalierbare Geschäftsideen. Berücksichtige regulatorische Realisierbarkeit, klare Monetarisierung und konkrete erste Validierungsschritte. Mache keine Heilversprechen. Nutze vorhandene manuelle Ideen als Inspiration oder Ausgangspunkt, ohne sie lediglich zu wiederholen.`;
    const maximumCostCents = estimateTokenCostCents(
        estimateMaximumTokenUsage(systemContent.length + userContent.length, guardrails.maximumCompletionTokens),
        guardrails.apiPricing,
    );
    const decision = await controlPlane.getRunDecision(maximumCostCents);
    if (!decision.allowed) {
        console.log(`[AgentLoop] Sauber pausiert: ${decision.reason}`);
        return null;
    }
    const response = await openai.chat.completions.create({
        model: guardrails.model,
        temperature: 0.8,
        max_completion_tokens: guardrails.maximumCompletionTokens,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'natur_vitale_business_ideas',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['ideas'],
                    properties: {
                        ideas: {
                            type: 'array',
                            minItems: guardrails.ideasPerRun,
                            maxItems: guardrails.ideasPerRun,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['title', 'summary', 'targetMarkets', 'businessModel', 'scalability', 'nextSteps'],
                                properties: {
                                    title: { type: 'string' },
                                    summary: { type: 'string' },
                                    targetMarkets: { type: 'array', items: { type: 'string' }, minItems: 2 },
                                    businessModel: { type: 'string' },
                                    scalability: { type: 'string' },
                                    nextSteps: { type: 'array', items: { type: 'string' }, minItems: 2 },
                                },
                            },
                        },
                    },
                },
            },
        },
        messages: [
            {
                role: 'system',
                content: systemContent,
            },
            {
                role: 'user',
                content: userContent,
            },
        ],
    }).catch(markProviderBlocked);

    const costCents = response.usage
        ? estimateTokenCostCents({
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
        }, guardrails.apiPricing)
        : maximumCostCents;
    await controlPlane.recordApiCost(costCents);

    const content = response.choices[0]?.message.content;
    if (!content) {
        throw new Error('Das Modell hat keine Ideen geliefert.');
    }

    const parsed = JSON.parse(content) as { ideas?: GeneratedIdea[] };
    const ideas = (parsed.ideas ?? []).filter(isCompliant);
    if (ideas.length < guardrails.ideasPerRun) {
        throw new Error(`Nur ${ideas.length} von ${guardrails.ideasPerRun} Ideen erfüllen die Guardrails.`);
    }
    return ideas.slice(0, guardrails.ideasPerRun);
}

async function runIdeaCycle(): Promise<void> {
    const existing = await readIdeas();
    const generated = await generateIdeas(existing.ideas);
    if (!generated) {
        await controlPlane.heartbeat();
        return;
    }
    const processedAt = new Date().toISOString();
    const newIdeas: BusinessIdea[] = generated.map(idea => ({
        ...(runBusinessAgentPipeline(idea) as EnrichedIdea),
        id: randomUUID(),
        source: 'agent',
        createdAt: processedAt,
    }));

    await updateIdeas(ideas => [
        ...ideas.map(idea => {
            const enriched = idea.feasibility && idea.salesPlan && idea.project
                ? idea
                : { ...idea, ...runBusinessAgentPipeline(idea) };
            return enriched.source === 'manual' && !enriched.processedAt
                ? { ...enriched, processedAt }
                : enriched;
        }),
        ...newIdeas,
    ]);

    await controlPlane.heartbeat(processedAt);

    console.log(`[AgentLoop] ${newIdeas.length} Ideen gespeichert.`);
    newIdeas.forEach((idea, index) => console.log(`${index + 1}. ${idea.title}`));
}

async function runCycle(): Promise<void> {
    const state = await autonomousState.read();
    if (state.phase === 'diagnose') {
        const decision = await controlPlane.getRunDecision();
        await controlPlane.heartbeat();
        if (!decision.allowed) {
            await autonomousState.transition('diagnose', { lastOutcome: decision.reason });
            if (decision.reason !== lastBlockedReason) {
                console.log(`[AgentLoop] Blockiert: ${decision.reason}`);
                lastBlockedReason = decision.reason;
            }
            return;
        }
        lastBlockedReason = null;
        await autonomousState.transition('select-next-task', { lastOutcome: decision.reason });
        return;
    }

    if (state.phase === 'select-next-task') {
        const queuedTask = (await taskQueue.list()).find(task => task.role === 'master-orchestrator' && task.status === 'queued');
        await autonomousState.transition('execute', {
            selectedAction: queuedTask ? 'worker-task' : 'generate-ideas',
            selectedTaskId: queuedTask?.id || null,
            lastOutcome: queuedTask ? `Task ${queuedTask.id} ausgewählt.` : 'Ideenzyklus ausgewählt.',
        });
        return;
    }

    if (state.phase === 'execute') {
        if (state.selectedAction === 'worker-task') {
            const worker = new AgentWorker(taskQueue, {
                id: `state-machine-${process.pid}`,
                role: 'master-orchestrator',
                handler: processUserCommand,
            });
            await worker.runOnce();
        } else {
            await runIdeaCycle();
        }
        await autonomousState.transition('verify', { lastOutcome: 'Ausführung abgeschlossen.' });
        return;
    }

    if (state.phase === 'verify') {
        const selectedTask = state.selectedTaskId
            ? (await taskQueue.list()).find(task => task.id === state.selectedTaskId)
            : null;
        const outcome = selectedTask
            ? `Taskstatus: ${selectedTask.status}${selectedTask.error ? ` (${selectedTask.error})` : ''}.`
            : 'Ideenzyklus und Persistenz verifiziert.';
        await autonomousState.transition('done', { lastOutcome: outcome });
        return;
    }

    await autonomousState.transition('diagnose', {
        selectedAction: null,
        selectedTaskId: null,
        lastOutcome: state.lastOutcome || 'Zyklus abgeschlossen.',
    });
}

async function runCompleteCycle(): Promise<void> {
    for (let step = 0; step < 5 && !stopping; step += 1) {
        const before = await autonomousState.read();
        await runCycle();
        const after = await autonomousState.read();
        if (before.phase === 'diagnose' && after.phase === 'diagnose') return;
        if (after.phase === 'diagnose') return;
    }
}

export async function startAutonomousLoop(): Promise<void> {
    console.log(`[AgentLoop] Gestartet: ${guardrails.ideasPerRun} Ideen pro Zyklus, Pause ${guardrails.sleepTimeMs} ms.`);

    while (!stopping) {
        try {
            await runCompleteCycle();
        } catch (error) {
            if (error instanceof ApiPausedError) {
                console.log(`[AgentLoop] Sauber pausiert: ${error.message}`);
            } else {
                await controlPlane.recordFailure(error instanceof Error ? error.message : String(error));
                console.error('[AgentLoop] Zyklus fehlgeschlagen; der Prozess läuft weiter:', error);
            }
        }

        if (!stopping) {
            await delay(guardrails.sleepTimeMs);
        }
    }
}

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void startAutonomousLoop();
}

async function processUserCommand(task: AgentTask): Promise<{ message: string; targetAgent: string }> {
    const payload = task.payload as { message?: unknown; targetAgent?: unknown };
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const targetAgent = typeof payload.targetAgent === 'string' ? payload.targetAgent : 'master-orchestrator';
    if (!message) throw new Error('Task enthält keine Nachricht.');

    const systemContent = `Du bist der Master-Orchestrator des Natur-Vitale-Agentensystems. Bearbeite den Nutzerauftrag für die Social-Media-Challenge konkret und ergebnisorientiert. Zielagent: ${targetAgent}. Beachte: genau ein aktives Projekt, keine eigenmächtigen Veröffentlichungen, keine Geheimnisse ausgeben, keine Rechts- oder Heilversprechen. Antworte knapp auf Deutsch mit Status, Ergebnis und nächstem ausführbaren Schritt.`;
    const maximumCostCents = estimateTokenCostCents(
        estimateMaximumTokenUsage(systemContent.length + message.length, guardrails.maximumCompletionTokens),
        guardrails.apiPricing,
    );
    const decision = await controlPlane.getRunDecision(maximumCostCents);
    if (!decision.allowed) throw new ApiPausedError(decision.reason);

    const response = await openai.chat.completions.create({
        model: guardrails.model,
        temperature: 0.3,
        max_completion_tokens: guardrails.maximumCompletionTokens,
        messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: message },
        ],
    }).catch(markProviderBlocked);
    const costCents = response.usage
        ? estimateTokenCostCents({
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
        }, guardrails.apiPricing)
        : maximumCostCents;
    await controlPlane.recordApiCost(costCents);
    const answer = response.choices[0]?.message.content?.trim();
    if (!answer) throw new Error('Der Master-Orchestrator hat keine Antwort geliefert.');
    return { message: `${answer}${importantLinksFooter()}`, targetAgent };
}

async function checkApiRecovery(): Promise<void> {
    const state = await controlPlane.initialize();
    if (state.nextApiCheckAt && Date.parse(state.nextApiCheckAt) > Date.now()) return;
    if (state.apiStatus !== 'blocked' && state.lastApiCheckAt
        && Date.parse(state.lastApiCheckAt) + guardrails.apiCheckIntervalMs > Date.now()) return;

    if (state.apiStatus !== 'blocked') {
        try {
            await openai.models.list();
            await controlPlane.markApiHealthy();
        } catch (error) {
            const details = getApiErrorDetails(error);
            if (details) {
                const nextCheckAt = new Date(Date.now() + guardrails.apiCheckIntervalMs).toISOString();
                await controlPlane.markApiBlocked(details.code || details.message, nextCheckAt);
            }
        }
        return;
    }

    if (state.apiBudgetCents - state.apiSpentCents < 1 && process.env.BYPASS_BUDGET_CHECK !== 'true') return;

    try {
        const response = await openai.chat.completions.create({
            model: guardrails.model,
            temperature: 0,
            max_completion_tokens: 1,
            messages: [{ role: 'user', content: 'Antworte nur mit OK.' }],
        });
        const costCents = response.usage
            ? estimateTokenCostCents({
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
            }, guardrails.apiPricing)
            : 1;
        await controlPlane.recordApiCost(costCents);
        await controlPlane.markApiHealthy();
        console.log('[ApiMonitor] API wieder verfügbar; Agenten laufen automatisch weiter.');
    } catch (error) {
        const details = getApiErrorDetails(error);
        const nextCheckAt = new Date(Date.now() + guardrails.apiCheckIntervalMs).toISOString();
        await controlPlane.markApiBlocked(details?.code || details?.message || 'API weiterhin nicht verfügbar', nextCheckAt);
        console.log(`[ApiMonitor] API weiterhin blockiert; nächste Prüfung ${nextCheckAt}.`);
    }
}

export async function startApiMonitorLoop(): Promise<void> {
    console.log(`[ApiMonitor] Gestartet: Prüfung alle ${guardrails.apiCheckIntervalMs} ms bei API-Sperre.`);
    while (!stopping) {
        try {
            await checkApiRecovery();
        } catch (error) {
            console.error('[ApiMonitor] Prüfzyklus fehlgeschlagen; Monitor läuft weiter:', error);
        }
        if (!stopping) await delay(Math.min(guardrails.apiCheckIntervalMs, 10_000));
    }
}

export async function startTaskWorkerLoop(): Promise<void> {
    const worker = new AgentWorker(taskQueue, {
        id: `master-orchestrator-${process.pid}`,
        role: 'master-orchestrator',
        handler: processUserCommand,
    });
    console.log('[TaskWorker] Master-Orchestrator gestartet.');

    while (!stopping) {
        try {
            const decision = await controlPlane.getRunDecision();
            if (decision.allowed) await worker.runOnce();
        } catch (error) {
            await controlPlane.recordFailure(error instanceof Error ? error.message : String(error));
            console.error('[TaskWorker] Verarbeitung fehlgeschlagen:', error);
        }
        if (!stopping) await delay(2_000);
    }
}