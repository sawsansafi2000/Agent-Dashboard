import { Request, Response, Router } from 'express';
import { getIdeas } from '../services/ideaStore';
import { agentCatalog, getPortfolioProjects } from '../services/operations';
import { createProjectCheckout, getCheckoutResult, isStripeConfigured, parseEuroAmount } from '../services/paymentService';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
	res.render('dashboard');
});

router.get('/agents/:id', async (req: Request, res: Response) => {
	const agent = agentCatalog.find(item => item.id === req.params.id);
	if (!agent) {
		res.status(404).send('Agent nicht gefunden.');
		return;
	}
	const projects = getPortfolioProjects(await getIdeas());
	res.render('agent-detail', { agent, projects });
});

router.get('/projects/:slug', async (req: Request, res: Response) => {
	const project = getPortfolioProjects(await getIdeas()).find(item => item.slug === req.params.slug);
	if (!project) {
		res.status(404).send('Projekt nicht gefunden.');
		return;
	}
	res.render('project-detail', {
		project,
		stripeConfigured: isStripeConfigured(),
		paymentCancelled: req.query.payment === 'cancelled',
	});
});

router.post('/projects/:slug/checkout', async (req: Request, res: Response) => {
	const project = getPortfolioProjects(await getIdeas()).find(item => item.slug === req.params.slug);
	if (!project) {
		res.status(404).send('Projekt nicht gefunden.');
		return;
	}
	try {
		const amountCents = parseEuroAmount(req.body.amount);
		const configuredOrigin = process.env.PRODUCTION_APP_URL?.trim().replace(/\/$/, '');
		const origin = configuredOrigin || `${req.protocol}://${req.get('host')}`;
		const checkoutUrl = await createProjectCheckout({
			projectSlug: project.slug,
			projectTitle: project.title,
			amountCents,
			origin,
		});
		res.redirect(303, checkoutUrl);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Checkout konnte nicht gestartet werden.';
		const status = message.includes('STRIPE_SECRET_KEY') ? 503 : 400;
		res.status(status).render('payment-result', { paid: false, amount: null, project, message });
	}
});

router.get('/payments/success', async (req: Request, res: Response) => {
	const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
	if (!sessionId) {
		res.status(400).send('Stripe-Session fehlt.');
		return;
	}
	try {
		const result = await getCheckoutResult(sessionId);
		const project = result.projectSlug
			? getPortfolioProjects(await getIdeas()).find(item => item.slug === result.projectSlug) ?? null
			: null;
		res.render('payment-result', {
			...result,
			project,
			message: result.paid ? 'Die Zahlung wurde von Stripe bestaetigt.' : 'Die Zahlung ist noch nicht abgeschlossen.',
		});
	} catch (_error) {
		res.status(400).render('payment-result', {
			paid: false,
			amount: null,
			project: null,
			message: 'Die Stripe-Zahlung konnte nicht verifiziert werden.',
		});
	}
});

export default router;