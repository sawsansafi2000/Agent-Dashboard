import { randomUUID } from 'crypto';
import { Request as ExpressRequest, Response as ExpressResponse, Router } from 'express';

const router = Router();

const targetAgents = [
    { id: 'master-orchestrator', name: 'Master-Orchestrator' },
    { id: 'research-agent', name: 'Research & Marktanalyse' },
    { id: 'content-agent', name: 'Content Creation' },
    { id: 'distribution-agent', name: 'Social Distribution' },
    { id: 'growth-agent', name: 'Growth & Conversion' },
    { id: 'compliance-agent', name: 'Compliance & Risiko' },
];

function internalApiUrl(path: string): string {
    const port = process.env.INTERNAL_AGENT_API_PORT || '3101';
    return `http://127.0.0.1:${port}${path}`;
}

async function callAgentApi(path: string, init?: RequestInit) {
    const token = process.env.INTERNAL_AGENT_API_TOKEN;
    if (!token) throw new Error('Interne Agenten-API ist nicht konfiguriert.');
    return fetch(internalApiUrl(path), {
        ...init,
        headers: {
            ...init?.headers,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
    });
}

function publicLinks() {
    const baseUrl = (process.env.PRODUCTION_APP_URL || '').replace(/\/$/, '');
    const links = [
        { name: 'Agenten-Chat', url: `${baseUrl}/dashboard/chat`, group: 'System' },
        { name: 'Operations-Dashboard', url: `${baseUrl}/dashboard`, group: 'System' },
        { name: 'Health Check', url: `${baseUrl}/health`, group: 'System' },
        { name: 'Live-Status API', url: `${baseUrl}/api/status`, group: 'System' },
        { name: 'Stripe Dashboard', url: 'https://dashboard.stripe.com/', group: 'Dienste' },
        { name: 'OpenAI Nutzung', url: 'https://platform.openai.com/usage', group: 'API-Status' },
        { name: 'OpenAI Abrechnung', url: 'https://platform.openai.com/settings/organization/billing/overview', group: 'API-Status' },
        { name: 'OpenAI Systemstatus', url: 'https://status.openai.com/', group: 'API-Status' },
        { name: 'Hetzner Cloud Console', url: 'https://console.hetzner.cloud/', group: 'Dienste' },
    ];
    if (process.env.YOUTUBE_CHANNEL_URL) {
        links.push({ name: 'YouTube-Kanal', url: process.env.YOUTUBE_CHANNEL_URL, group: 'Social Media' });
    }
    if (process.env.X_USERNAME) {
        links.push({ name: 'X-Profil', url: `https://x.com/${encodeURIComponent(process.env.X_USERNAME)}`, group: 'Social Media' });
    }
    return links.filter(link => /^https:\/\//.test(link.url));
}

router.get('/', (_req, res) => {
    res.render('chat', {
        targetAgents,
        links: publicLinks(),
        dashboardUsername: process.env.DASHBOARD_USERNAME || 'nicht konfiguriert',
    });
});

router.get('/tasks', async (_req: ExpressRequest, res: ExpressResponse) => {
    try {
        const response = await callAgentApi('/tasks');
        res.status(response.status).json(await response.json());
    } catch (error) {
        res.status(503).json({ error: error instanceof Error ? error.message : 'Agenten-API nicht erreichbar.' });
    }
});

router.post('/tasks', async (req: ExpressRequest, res: ExpressResponse) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const targetAgent = typeof req.body.targetAgent === 'string' ? req.body.targetAgent : 'master-orchestrator';
    if (!message || message.length > 4_000 || !targetAgents.some(agent => agent.id === targetAgent)) {
        res.status(400).json({ error: 'Nachricht oder Zielagent ist ungültig.' });
        return;
    }
    try {
        const response = await callAgentApi('/tasks', {
            method: 'POST',
            body: JSON.stringify({ message, targetAgent, clientRequestId: randomUUID() }),
        });
        res.status(response.status).json(await response.json());
    } catch (error) {
        res.status(503).json({ error: error instanceof Error ? error.message : 'Agenten-API nicht erreichbar.' });
    }
});

export default router;