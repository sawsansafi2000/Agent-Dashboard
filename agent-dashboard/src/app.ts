import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import dashboardRoutes from './routes/dashboard';
import ideasRoutes from './routes/ideas';
import chatRoutes from './routes/chat';
import socialRoutes from './routes/social';
import offerRoutes from './routes/offers';
import { createStripeWebhookHandler } from './routes/stripeWebhook';
import { requireDashboardAccess } from './dashboardAccess';
import { OrderStore } from './services/orderStore';

const app = express();
const workspaceRoot = path.resolve(__dirname, '../..');
const dashboardRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(workspaceRoot, '.env') });
dotenv.config({ path: path.join(workspaceRoot, 'guardrails.env'), override: true });

if ((process.env.ALLOW_GIT_PUSH ?? 'false').toLowerCase() !== 'false') {
    throw new Error('Guardrail verletzt: ALLOW_GIT_PUSH muss false sein.');
}

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// Middleware setup
app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), createStripeWebhookHandler(new OrderStore(workspaceRoot)));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requireDashboardAccess);
app.use(express.static(path.join(dashboardRoot, 'src', 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(dashboardRoot, 'src', 'views'));

// Routes
app.use('/', offerRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/dashboard/chat', chatRoutes);
app.use('/dashboard/social', socialRoutes);
app.use('/api/ideas', ideasRoutes);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Dashboard]', error);
    res.status(500).json({ error: 'Interner Serverfehler.' });
});

export default app;