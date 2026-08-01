import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createStripeWebhookHandler } from '../agent-dashboard/src/routes/stripeWebhook.js';
import { OrderStore } from '../agent-dashboard/src/services/orderStore.js';

test('validates Stripe signatures and processes checkout events idempotently', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-orders-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const secret = 'whsec_test_secret';
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    t.after(() => delete process.env.STRIPE_WEBHOOK_SECRET);
    const store = new OrderStore(root);
    const confirmations: Array<{ customerEmail: string; amountTotal: number; currency: string; projectSlug: string | null }> = [];
    const app = express();
    app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), createStripeWebhookHandler(store, async input => {
        confirmations.push(input);
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    assert(address && typeof address === 'object');
    const payload = JSON.stringify({
        id: 'evt_checkout_1', type: 'checkout.session.completed', created: 1_700_000_000,
        data: { object: { id: 'cs_test_1', payment_status: 'paid', amount_total: 1299, currency: 'eur', metadata: { projectSlug: 'challenge' }, customer_details: { email: 'buyer@example.com' } } },
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}/webhooks/stripe`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload,
        });
        assert.equal(response.status, 200);
    }
    const orders = await store.list();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].paymentStatus, 'paid');
    assert.equal(orders[0].amountTotal, 1299);
    assert.deepEqual(confirmations, [{
        customerEmail: 'buyer@example.com',
        amountTotal: 1299,
        currency: 'eur',
        projectSlug: 'challenge',
    }]);
});

test('retries checkout confirmation after an email delivery failure', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-orders-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const secret = 'whsec_retry_secret';
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    t.after(() => delete process.env.STRIPE_WEBHOOK_SECRET);
    const store = new OrderStore(root);
    let attempts = 0;
    const app = express();
    app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), createStripeWebhookHandler(store, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Brevo ist vorübergehend nicht erreichbar.');
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    assert(address && typeof address === 'object');
    const payload = JSON.stringify({
        id: 'evt_checkout_retry', type: 'checkout.session.completed', created: 1_700_000_000,
        data: { object: { id: 'cs_test_retry', payment_status: 'paid', amount_total: 2499, currency: 'eur', customer_details: { email: 'buyer@example.com' } } },
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;
    const sendWebhook = () => fetch(`http://127.0.0.1:${address.port}/webhooks/stripe`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload,
    });

    assert.equal((await sendWebhook()).status, 500);
    assert.equal((await sendWebhook()).status, 200);
    assert.equal(attempts, 2);
});