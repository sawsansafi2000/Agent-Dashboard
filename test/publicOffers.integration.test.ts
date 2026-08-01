import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { requireDashboardAccess } from '../agent-dashboard/src/dashboardAccess.js';
import { createOfferRouter } from '../agent-dashboard/src/routes/offers.js';

const dashboardRequire = createRequire(path.resolve(process.cwd(), 'agent-dashboard/package.json'));
const ejs = dashboardRequire('ejs') as { __express: express.Application['engine'] extends (extension: string, callback: infer Engine) => void ? Engine : never };

test('serves public offers while keeping dashboard access protected', async t => {
    process.env.DASHBOARD_USERNAME = 'test-user';
    process.env.DASHBOARD_PASSWORD = 'test-password';
    process.env.STRIPE_SECRET_KEY = 'sk_test_render_only';
    t.after(() => {
        delete process.env.DASHBOARD_USERNAME;
        delete process.env.DASHBOARD_PASSWORD;
        delete process.env.STRIPE_SECRET_KEY;
    });

    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(requireDashboardAccess);
    app.engine('ejs', ejs.__express);
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(process.cwd(), 'agent-dashboard/src/views'));
    app.use('/', createOfferRouter(async () => [{
        id: 'pilot-offer-test',
        title: 'Pilot-Strategie-Sessions',
        summary: '45-minuetige Online-Strategie-Session',
        targetMarkets: ['DACH'],
        businessModel: 'Bezahlte Strategie-Session',
        scalability: 'Standardisierter Beratungsprozess',
        nextSteps: ['Pilot buchen'],
        source: 'agent',
        createdAt: new Date().toISOString(),
        feasibility: { score: 80, verdict: 'go', risks: [], missingRequirements: [], technicalApproach: 'Online-Session' },
        project: {
            slug: 'pilot-strategie-sessions',
            stage: 'validation',
            progress: 25,
            ownerAgent: 'project-delivery-agent',
            nextMilestone: 'Erste Session',
            sales: { revenue: 0, orders: 0, currency: 'EUR', source: 'not-connected' },
        },
    }]));
    app.get('/dashboard', (_req, res) => res.send('protected'));

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    }));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const indexResponse = await fetch(baseUrl);
    assert.equal(indexResponse.status, 200);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /Pilot-Strategie-Sessions/);
    const offerPath = indexHtml.match(/href="(\/offers\/[^"]+)"/)?.[1];
    assert(offerPath);

    const offerResponse = await fetch(`${baseUrl}${offerPath}`);
    assert.equal(offerResponse.status, 200);
    assert.match(await offerResponse.text(), /45-minuetige Online-Strategie-Session/);

    const unconfirmedCheckout = await fetch(`${baseUrl}${offerPath}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
    });
    assert.equal(unconfirmedCheckout.status, 400);
    assert.match(await unconfirmedCheckout.text(), /Leistungsumfang/);

    const protectedResponse = await fetch(`${baseUrl}/dashboard`);
    assert.equal(protectedResponse.status, 401);
});