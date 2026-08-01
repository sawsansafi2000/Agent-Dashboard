import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

export interface BusinessIdea {
    id: string;
    title: string;
    summary: string;
    targetMarkets: string[];
    businessModel: string;
    scalability: string;
    nextSteps: string[];
    source: 'agent' | 'manual';
    createdAt: string;
    processedAt?: string;
    feasibility?: {
        score: number;
        verdict: 'go' | 'validate' | 'hold';
        risks: string[];
        missingRequirements: string[];
        technicalApproach: string;
    };
    salesPlan?: {
        channels: string[];
        pricingModel: string;
        firstCustomerProfile: string;
        validationKpis: string[];
    };
    project?: {
        slug: string;
        stage: 'discovery' | 'validation' | 'on-hold';
        progress: number;
        ownerAgent: string;
        nextMilestone: string;
        sales: { revenue: number; orders: number; currency: 'EUR'; source: 'not-connected' };
    };
}

export interface ManualIdeaInput {
    title: string;
    summary: string;
    targetMarkets: string[];
    businessModel: string;
}

const workspaceRoot = path.resolve(__dirname, '../../..');
const ideasFile = path.join(workspaceRoot, 'data', 'ideas.json');
const ideasLock = `${ideasFile}.lock`;

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function acquireLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(ideasFile), { recursive: true });
    const deadline = Date.now() + 10_000;

    while (true) {
        try {
            await fs.mkdir(ideasLock);
            return async () => fs.rm(ideasLock, { recursive: true, force: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) {
                throw error;
            }
            await delay(50);
        }
    }
}

export async function getIdeas(): Promise<BusinessIdea[]> {
    try {
        const contents = await fs.readFile(ideasFile, 'utf8');
        const document = JSON.parse(contents) as { ideas?: BusinessIdea[] };
        return Array.isArray(document.ideas) ? document.ideas : [];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

export async function addManualIdea(input: ManualIdeaInput): Promise<BusinessIdea> {
    const release = await acquireLock();
    try {
        const ideas = await getIdeas();
        const idea: BusinessIdea = {
            id: randomUUID(),
            title: input.title,
            summary: input.summary,
            targetMarkets: input.targetMarkets,
            businessModel: input.businessModel,
            scalability: 'Wird im nächsten Agentenzyklus ausgearbeitet.',
            nextSteps: ['Im nächsten Agentenzyklus analysieren und konkretisieren.'],
            source: 'manual',
            createdAt: new Date().toISOString(),
        };
        const temporaryFile = `${ideasFile}.${process.pid}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify({
            ideas: [...ideas, idea],
            updatedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
        await fs.rename(temporaryFile, ideasFile);
        return idea;
    } finally {
        await release();
    }
}