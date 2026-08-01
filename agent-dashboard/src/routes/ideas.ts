import { NextFunction, Request, Response, Router } from 'express';
import { addManualIdea, getIdeas, ManualIdeaInput } from '../services/ideaStore';

const router = Router();

function normalizeInput(body: unknown): ManualIdeaInput | null {
    if (!body || typeof body !== 'object') {
        return null;
    }

    const input = body as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    const businessModel = typeof input.businessModel === 'string' ? input.businessModel.trim() : '';
    const targetMarkets = Array.isArray(input.targetMarkets)
        ? input.targetMarkets.filter((market): market is string => typeof market === 'string').map(market => market.trim()).filter(Boolean)
        : typeof input.targetMarkets === 'string'
            ? input.targetMarkets.split(',').map(market => market.trim()).filter(Boolean)
            : [];

    const disallowedKeywords = (process.env.DISALLOWED_KEYWORDS ?? '')
        .split(',')
        .map(keyword => keyword.trim().toLowerCase())
        .filter(Boolean);
    const combinedText = [title, summary, businessModel, ...targetMarkets].join(' ').toLowerCase();

    if (!title || !summary || !businessModel || targetMarkets.length === 0
        || disallowedKeywords.some(keyword => combinedText.includes(keyword))) {
        return null;
    }

    return { title, summary, businessModel, targetMarkets };
}

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        res.json({ ideas: await getIdeas() });
    } catch (error) {
        next(error);
    }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const input = normalizeInput(req.body);
    if (!input) {
        res.status(400).json({ error: 'Titel, Beschreibung, Zielmarkt und Geschäftsmodell sind erforderlich.' });
        return;
    }

    try {
        const idea = await addManualIdea(input);
        res.status(201).json({ idea });
    } catch (error) {
        next(error);
    }
});

export default router;