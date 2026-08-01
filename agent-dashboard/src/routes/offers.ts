import { Request, Response, Router } from 'express';
import { getIdeas } from '../services/ideaStore';
import { getPortfolioProjects, PortfolioProject } from '../services/operations';
import { createProjectCheckout, getCheckoutResult, isStripeConfigured } from '../services/paymentService';

const PILOT_SESSION_PRICE_CENTS = 4_900;

export function createOfferRouter(loadIdeas: typeof getIdeas = getIdeas): Router {
    const router = Router();

    async function getPublicProjects(): Promise<PortfolioProject[]> {
        return getPortfolioProjects(await loadIdeas())
            .filter(project => project.stage !== 'on-hold' && project.verdict !== 'hold');
    }

    async function findProject(slug: string): Promise<PortfolioProject | undefined> {
        return (await getPublicProjects()).find(project => project.slug === slug);
    }

function renderOffer(res: Response, project: PortfolioProject, options: {
    paymentCancelled?: boolean;
    checkoutError?: string | null;
} = {}): void {
    res.render('offer-detail', {
        project,
        price: '49,00 EUR',
        stripeConfigured: isStripeConfigured(),
        paymentCancelled: options.paymentCancelled ?? false,
        checkoutError: options.checkoutError ?? null,
    });
}

    router.get('/', async (_req: Request, res: Response) => {
        res.render('offers-index', { projects: await getPublicProjects() });
    });

    router.get('/offers/payments/success', async (req: Request, res: Response) => {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    if (!sessionId) {
        res.status(400).render('public-payment-result', { paid: false, amount: null, project: null });
        return;
    }
    try {
        const result = await getCheckoutResult(sessionId);
        const project = result.projectSlug ? await findProject(result.projectSlug) ?? null : null;
        res.status(result.paid ? 200 : 202).render('public-payment-result', { ...result, project });
    } catch (_error) {
        res.status(400).render('public-payment-result', { paid: false, amount: null, project: null });
    }
    });

    router.get('/offers/:slug', async (req: Request, res: Response) => {
    const project = await findProject(req.params.slug);
    if (!project) {
        res.status(404).send('Angebot nicht gefunden.');
        return;
    }
    renderOffer(res, project, { paymentCancelled: req.query.payment === 'cancelled' });
    });

    router.post('/offers/:slug/checkout', async (req: Request, res: Response) => {
    const project = await findProject(req.params.slug);
    if (!project) {
        res.status(404).send('Angebot nicht gefunden.');
        return;
    }
    if (req.body.terms !== 'accepted') {
        res.status(400);
        renderOffer(res, project, { checkoutError: 'Bitte bestaetige den Leistungsumfang vor dem Checkout.' });
        return;
    }
    try {
        const configuredOrigin = process.env.PRODUCTION_APP_URL?.trim().replace(/\/$/, '');
        const origin = configuredOrigin || `${req.protocol}://${req.get('host')}`;
        const checkoutUrl = await createProjectCheckout({
            projectSlug: project.slug,
            projectTitle: project.title,
            amountCents: PILOT_SESSION_PRICE_CENTS,
            origin,
            successPath: '/offers/payments/success',
            cancelPath: `/offers/${encodeURIComponent(project.slug)}`,
        });
        res.redirect(303, checkoutUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Checkout konnte nicht gestartet werden.';
        res.status(message.includes('STRIPE_SECRET_KEY') ? 503 : 400);
        renderOffer(res, project, { checkoutError: message });
    }
    });

    return router;
}

export default createOfferRouter();