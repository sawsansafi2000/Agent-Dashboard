import assert from 'node:assert/strict';
import test from 'node:test';
import { sendOrderConfirmation } from '../agent-dashboard/src/services/emailService.js';

test('sends an order confirmation through Brevo', async t => {
    const originalFetch = globalThis.fetch;
    process.env.BREVO_API_KEY = 'brevo-test-key';
    process.env.SENDER_EMAIL = 'kontakt@natur-vitale.de';
    process.env.SENDER_NAME = 'NaturVitale';
    t.after(() => {
        globalThis.fetch = originalFetch;
        delete process.env.BREVO_API_KEY;
        delete process.env.SENDER_EMAIL;
        delete process.env.SENDER_NAME;
    });
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
        request = { url: String(url), init };
        return new Response(null, { status: 201 });
    };

    await sendOrderConfirmation({
        customerEmail: 'buyer@example.com',
        amountTotal: 1299,
        currency: 'eur',
        projectSlug: 'challenge',
    });

    assert(request);
    assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(request.init?.method, 'POST');
    assert.equal((request.init?.headers as Record<string, string>)['api-key'], 'brevo-test-key');
    const body = JSON.parse(String(request.init?.body));
    assert.deepEqual(body.sender, { email: 'kontakt@natur-vitale.de', name: 'NaturVitale' });
    assert.deepEqual(body.to, [{ email: 'buyer@example.com' }]);
    assert.match(body.subject, /NaturVitale/);
    assert.match(body.textContent, /12,99/);
    assert.match(body.textContent, /challenge/);
});