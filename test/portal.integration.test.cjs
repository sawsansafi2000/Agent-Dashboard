const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHmac } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sqlite3 = require('sqlite3');
const test = require('node:test');

async function unusedPort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

function getDatabaseRow(databasePath, sql) {
    const database = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
    return new Promise((resolve, reject) => {
        database.get(sql, [], (error, row) => {
            database.close(closeError => {
                if (error) reject(error);
                else if (closeError) reject(closeError);
                else resolve(row);
            });
        });
    });
}

test('public portal generates local templates and fulfills paid workflow access per account', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-portal-test-'));
    const databasePath = path.join(directory, 'portal.sqlite');
    const port = await unusedPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const businessAssumptions = {
        marketCountry: 'Deutschland',
        currency: 'EUR',
        industry: 'gastronomy',
        unitPrice: 49,
        expectedMonthlySales: 10,
        variableCostPerSale: 10,
        monthlyFixedCosts: 100,
    };
    const llmPort = await unusedPort();
    const mailPort = await unusedPort();
    const marketPort = await unusedPort();
    const sentEmails = [];
    const marketRequests = [];
    let marketPayloadIndustry = 'gastronomy';
    let llmRequests = 0;
    const llmServer = http.createServer((request, response) => {
        llmRequests += 1;
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            const input = JSON.parse(body);
            const prompt = JSON.parse(input.messages.find(message => message.role === 'user').content);
            const schemaName = input.response_format.json_schema.name;
            const content = schemaName === 'portal_business_idea'
                ? {
                    title: `KI-Idee: ${prompt.topic}`,
                    summary: `Dynamischer Modellvorschlag für ${prompt.audience}.`,
                    businessModel: 'Manueller Pilot mit Nachfrageprüfung.',
                    customerProfile: 'Kleine Zielgruppe mit akutem Bedarf.',
                    valueProposition: 'Ein messbares Problem in einem kleinen Pilot lösen.',
                    validationMetric: 'Bezahlte Pilotbuchungen aus qualifizierten Gesprächen.',
                    offerTitle: 'Bezahlter Pilot',
                    offerDescription: 'Ein klar begrenzter Test mit vereinbartem Ergebnis.',
                    offerDeliverables: ['Pilotgespräch', 'Ergebnisnotiz'],
                    firstSteps: ['Interviews führen', 'Pilot anbieten', 'Ergebnis messen'],
                }
                : schemaName === 'portal_social_drafts'
                    ? {
                        drafts: prompt.platforms.map(platform => ({
                            platform: platform.id,
                            post: `Ein konkreter Test für ${platform.label}.`,
                            adHeadline: 'Ein klarer Pilot',
                            adCopy: 'Prüfe den Bedarf mit einem begrenzten, nachvollziehbaren Angebot.',
                            callToAction: 'Details anfragen',
                        })),
                    }
                    : {
                    title: `KI-Workflow: ${prompt.goal}`,
                    summary: `Dynamischer Ablauf für ${prompt.audience}.`,
                    steps: ['Anfrage erfassen', 'Manuell priorisieren', 'Ergebnis dokumentieren'],
                    successMetric: 'Anteil fristgerecht bearbeiteter Anfragen',
                    approvalBoundary: 'Vor jeder Kontaktaufnahme ist eine menschliche Freigabe erforderlich.',
                };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                id: 'chatcmpl_test',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: input.model,
                choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }));
        });
    });
    llmServer.listen(llmPort, '127.0.0.1');
    await once(llmServer, 'listening');
    const mailServer = http.createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            sentEmails.push(JSON.parse(body));
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end('{}');
        });
    });
    mailServer.listen(mailPort, '127.0.0.1');
    await once(mailServer, 'listening');
    const marketServer = http.createServer((request, response) => {
        marketRequests.push({
            url: new URL(request.url, `http://127.0.0.1:${marketPort}`),
            authorization: request.headers.authorization,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            country: 'Deutschland',
            industry: marketPayloadIndustry,
            source: 'Testanbieter',
            sourceUrl: 'https://benchmarks.example.test/methodology',
            asOf: new Date().toISOString(),
            metrics: [{ name: 'Medianer Auftragswert', value: 125, unit: 'EUR', sampleSize: 42 }],
        }));
    });
    marketServer.listen(marketPort, '127.0.0.1');
    await once(marketServer, 'listening');
    const child = spawn(process.execPath, [path.join(__dirname, '../portal/server.cjs')], {
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            PORTAL_DATABASE_PATH: databasePath,
            PORTAL_MARKET_DATA_URL: `http://127.0.0.1:${marketPort}/benchmarks`,
            PORTAL_MARKET_DATA_TOKEN: 'market-provider-test-token',
            PORTAL_TAX_PROFILES_JSON: JSON.stringify([{
                country: 'Deutschland',
                vatRatePercent: 19,
                verifiedAt: '2026-01-15T00:00:00.000Z',
                verifiedBy: 'Test-Steuerberatung',
                sourceUrl: 'https://tax.example.test/germany',
            }]),
            PORTAL_ERROR_TOKEN: 'portal-internal-test-token-12345678901234567890',
            PORTAL_MONTHLY_TOKEN_LIMIT: '1300',
            PORTAL_PREMIUM_MONTHLY_TOKEN_LIMIT: '5000',
            OPENAI_API_KEY: 'test-key',
            OPENAI_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
            OPENAI_MODEL: 'test-model',
            STRIPE_SECRET_KEY: 'sk_test_portaltest',
            STRIPE_WEBHOOK_SECRET: 'whsec_portaltestsecret',
            STRIPE_PRODUCT_CATALOG: JSON.stringify([{
                id: 'premium',
                name: 'Premium-Zugang',
                description: 'KI-Workflow-Generator',
                unitAmountCents: 9900,
            }, {
                id: 'premium_monthly',
                name: 'Premium-Abo',
                description: 'Monatlicher Workflow-Zugang',
                unitAmountCents: 9900,
                recurringInterval: 'month',
            }]),
            BREVO_API_KEY: 'test-brevo-key',
            SENDER_EMAIL: 'test@example.com',
            BREVO_API_URL: `http://127.0.0.1:${mailPort}/v3/smtp/email`,
            PUBLIC_BASE_URL: baseUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    async function waitForHealth() {
        for (let attempt = 0; attempt < 300; attempt += 1) {
            if (child.exitCode !== null) throw new Error(`Portal exited early:\n${output}`);
            try {
                const response = await fetch(`${baseUrl}/health`);
                if (response.ok) return;
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Portal did not become ready:\n${output}`);
    }

    try {
        await waitForHealth();
        const migration = await getDatabaseRow(databasePath, 'SELECT MAX(version) AS version FROM portal_schema_migrations');
        assert.equal(migration.version, 7);
        const home = await fetch(baseUrl);
        assert.equal(home.status, 200);
        assert.match(await home.text(), /Konto erstellen/);

        const unauthenticatedIdeas = await fetch(`${baseUrl}/api/ideas`);
        assert.equal(unauthenticatedIdeas.status, 401);

        const crossOrigin = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
            body: JSON.stringify({ email: 'first@example.com', password: 'correct horse battery staple' }),
        });
        assert.equal(crossOrigin.status, 403);

        const invalid = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'invalid@example.com', password: 'short' }),
        });
        assert.equal(invalid.status, 400);

        const register = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'First@Example.com', password: 'correct horse battery staple' }),
        });
        assert.equal(register.status, 201);
        assert.equal((await register.json()).verificationRequired, true);
        const unverifiedLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'first@example.com', password: 'correct horse battery staple' }),
        });
        assert.equal(unverifiedLogin.status, 403);
        const verificationLink = new URL(sentEmails.at(-1).textContent.split('\n')[0].replace(/^.*: /, ''));
        const verification = await fetch(`${baseUrl}/api/auth/verify-email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ token: verificationLink.searchParams.get('token') }),
        });
        assert.equal(verification.status, 200);
        const firstCookie = verification.headers.get('set-cookie').split(';', 1)[0];
        assert.match(verification.headers.get('set-cookie'), /HttpOnly/);
        assert.match(verification.headers.get('set-cookie'), /SameSite=Strict/);

        const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: firstCookie } });
        assert.equal(dashboard.status, 200);
        assert.match(await dashboard.text(), /Workflow-Vorlagen/);
        const unauthenticatedDashboard = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
        assert.equal(unauthenticatedDashboard.status, 302);
        assert.equal(unauthenticatedDashboard.headers.get('location'), '/login');

        const ideaResponse = await fetch(`${baseUrl}/api/ideas/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({
                topic: 'Gesunde Mahlzeiten',
                audience: 'Schichtarbeitende',
                ...businessAssumptions,
            }),
        });
        assert.equal(ideaResponse.status, 201);
        const generatedIdea = await ideaResponse.json();
        assert.equal(generatedIdea.idea.idea.title, 'Pilot: Gesunde Mahlzeiten');
        assert.equal(generatedIdea.idea.idea.generationMethod, 'local_template');
        assert.match(generatedIdea.idea.idea.executionPolicy, /keine externe Aktion/i);
        assert.equal(generatedIdea.idea.idea.commercialCase.monthlyProjection.revenue, 490);
        assert.equal(generatedIdea.idea.idea.commercialCase.monthlyProjection.operatingResultBeforeTax, 290);
        assert.equal(generatedIdea.idea.idea.commercialCase.monthlyProjection.breakEvenMonthlySales, 3);
        assert.equal(generatedIdea.idea.idea.commercialCase.taxStatus, 'not_calculated');
        assert.deepEqual(generatedIdea.idea.idea.commercialCase.taxProfile, {
            status: 'reference_only',
            vatRatePercent: 19,
            verifiedAt: '2026-01-15T00:00:00.000Z',
            verifiedBy: 'Test-Steuerberatung',
            sourceUrl: 'https://tax.example.test/germany',
        });
        assert.equal(generatedIdea.idea.idea.commercialCase.industryLabel, 'Gastronomie');
        assert.equal(generatedIdea.idea.idea.industryValidationSteps.length, 3);
        assert.equal(generatedIdea.idea.validationActions.length, 3);
        assert.deepEqual(
            generatedIdea.idea.validationActions.map(action => action.actionText),
            generatedIdea.idea.idea.industryValidationSteps,
        );
        const firstValidationAction = generatedIdea.idea.validationActions[0];
        const savedValidationAction = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/actions/${firstValidationAction.id}`,
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
                body: JSON.stringify({
                    status: 'done',
                    dueDate: '2026-12-01',
                    resultNote: 'Drei passende Zielkunden interviewt.',
                }),
            },
        );
        assert.equal(savedValidationAction.status, 200);
        assert.deepEqual((await savedValidationAction.json()).action, {
            ...firstValidationAction,
            status: 'done',
            dueDate: '2026-12-01',
            resultNote: 'Drei passende Zielkunden interviewt.',
            updatedAt: (await getDatabaseRow(
                databasePath,
                `SELECT updated_at AS updatedAt FROM portal_idea_actions WHERE id = ${firstValidationAction.id}`,
            )).updatedAt,
        });
        const invalidValidationStatus = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/actions/${firstValidationAction.id}`,
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
                body: JSON.stringify({ status: 'skipped', dueDate: null, resultNote: '' }),
            },
        );
        assert.equal(invalidValidationStatus.status, 400);
        const invalidValidationDate = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/actions/${firstValidationAction.id}`,
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
                body: JSON.stringify({ status: 'done', dueDate: '2026-02-30', resultNote: '' }),
            },
        );
        assert.equal(invalidValidationDate.status, 400);
        const missingMarketConsent = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/market-benchmarks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ shareMarketContext: false }),
        });
        assert.equal(missingMarketConsent.status, 400);
        assert.equal(marketRequests.length, 0);
        const marketBenchmarkResponse = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/market-benchmarks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ shareMarketContext: true }),
        });
        assert.equal(marketBenchmarkResponse.status, 201);
        const marketBenchmark = await marketBenchmarkResponse.json();
        assert.equal(marketBenchmark.benchmark.provenance, 'external_provider');
        assert.equal(marketBenchmark.benchmark.metrics[0].sampleSize, 42);
        assert.equal(marketRequests.length, 1);
        assert.equal(marketRequests[0].url.searchParams.get('country'), 'Deutschland');
        assert.equal(marketRequests[0].url.searchParams.get('industry'), 'gastronomy');
        assert.deepEqual([...marketRequests[0].url.searchParams.keys()].sort(), ['country', 'industry']);
        assert.equal(marketRequests[0].authorization, 'Bearer market-provider-test-token');
        marketPayloadIndustry = 'software';
        const mismatchedMarketBenchmark = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/market-benchmarks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ shareMarketContext: true }),
        });
        marketPayloadIndustry = 'gastronomy';
        assert.equal(mismatchedMarketBenchmark.status, 502);
        assert.equal(marketRequests.length, 2);
        const connectStatus = await fetch(`${baseUrl}/api/billing/connect-status`, {
            headers: { cookie: firstCookie },
        });
        assert.equal(connectStatus.status, 200);
        assert.equal((await connectStatus.json()).enabled, false);
        const invalidCurrency = await fetch(`${baseUrl}/api/ideas/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ topic: 'Ungültige Währung', ...businessAssumptions, currency: 'XYZ' }),
        });
        assert.equal(invalidCurrency.status, 400);
        const updatedIdeaResponse = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({
                title: 'Eigener Ideenname',
                summary: 'Eigene Zusammenfassung.',
                businessModel: 'Manueller Testpilot.',
                firstSteps: ['Schritt eins', 'Schritt zwei', 'Schritt drei'],
            }),
        });
        assert.equal(updatedIdeaResponse.status, 200);
        assert.equal((await updatedIdeaResponse.json()).idea.idea.title, 'Eigener Ideenname');
        const recordedSale = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/sales`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ amount: 79.9 }),
        });
        assert.equal(recordedSale.status, 201);
        const recordedSaleData = await recordedSale.json();
        assert.deepEqual(recordedSaleData.salesSummary, { count: 1, revenue: 79.9, currency: 'EUR' });
        const subCentSale = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/sales`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ amount: 0.001 }),
        });
        assert.equal(subCentSale.status, 400);
        const salesList = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/sales`, {
            headers: { cookie: firstCookie },
        });
        assert.equal((await salesList.json()).sales[0].amount, 79.9);
        const businessExport = await fetch(`${baseUrl}/api/account/export`, {
            headers: { cookie: firstCookie },
        });
        const businessExportData = await businessExport.json();
        assert.equal(businessExportData.businessSales[0].amount, 79.9);
        assert.equal(businessExportData.validationActions.length, 3);
        assert.equal(businessExportData.validationActions[0].resultNote, 'Drei passende Zielkunden interviewt.');
        const unavailableProduct = await fetch(`${baseUrl}/api/create-checkout-session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ productId: 'unknown' }),
        });
        assert.equal(unavailableProduct.status, 400);
        const lockedWorkflow = await fetch(`${baseUrl}/api/workflows/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ goal: 'Interessenten nachfassen' }),
        });
        assert.equal(lockedWorkflow.status, 403);

        const catalog = await fetch(`${baseUrl}/api/products`);
        assert.equal(catalog.status, 200);
        assert.equal((await catalog.json()).checkoutReady, true);

        const eventPayload = JSON.stringify({
            id: 'evt_portal_paid_1',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_test_portal_paid_1',
                    mode: 'payment',
                    payment_status: 'paid',
                    currency: 'eur',
                    amount_total: 9900,
                    client_reference_id: '1',
                    payment_intent: 'pi_portal_paid_1',
                    customer: 'cus_portal_first',
                    metadata: { productId: 'premium', portalUserId: '1' },
                },
            },
        });
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = `t=${timestamp},v1=${createHmac('sha256', 'whsec_portaltestsecret')
            .update(`${timestamp}.${eventPayload}`).digest('hex')}`;
        const webhookUrl = `${baseUrl}/api/portal/stripe-webhook`;
        const sendWebhook = (stripeSignature = signature) => fetch(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature },
            body: eventPayload,
        });
        assert.equal((await sendWebhook('invalid')).status, 400);
        const fulfillment = await sendWebhook();
        assert.equal(fulfillment.status, 200);
        assert.equal((await fulfillment.json()).fulfillmentStatus, 'fulfilled');
        const duplicateFulfillment = await sendWebhook();
        assert.equal((await duplicateFulfillment.json()).duplicate, true);

        const socialResponse = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ platforms: ['instagram', 'linkedin'] }),
        });
        const generatedSocial = await socialResponse.json();
        assert.equal(socialResponse.status, 201, JSON.stringify(generatedSocial));
        assert.equal(generatedSocial.drafts.length, 2);
        assert.ok(generatedSocial.drafts.every(draft => draft.status === 'draft' && draft.approvalRequired));
        assert.deepEqual(generatedSocial.drafts.map(draft => draft.platform), ['instagram', 'linkedin']);
        const socialDraftList = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts`, {
            headers: { cookie: firstCookie },
        });
        assert.equal((await socialDraftList.json()).drafts.length, 2);
        const tooSoonSchedule = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts/${generatedSocial.drafts[0].id}/approve`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
                body: JSON.stringify({ scheduledAt: new Date(Date.now() + 30_000).toISOString() }),
            },
        );
        assert.equal(tooSoonSchedule.status, 400);
        const scheduledAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const approvedSocialDraft = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts/${generatedSocial.drafts[0].id}/approve`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
                body: JSON.stringify({ scheduledAt }),
            },
        );
        assert.equal(approvedSocialDraft.status, 200);
        const approvedDraft = (await approvedSocialDraft.json()).draft;
        assert.equal(approvedDraft.publicationState, 'awaiting_oauth_integration');
        assert.equal(approvedDraft.scheduledAt, scheduledAt);
        assert.equal(approvedDraft.approvalRequired, false);
        const duplicateApproval = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts/${generatedSocial.drafts[0].id}/approve`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
                body: JSON.stringify({ scheduledAt }),
            },
        );
        assert.equal(duplicateApproval.status, 409);
        const socialExport = await fetch(`${baseUrl}/api/account/export`, { headers: { cookie: firstCookie } });
        assert.equal((await socialExport.json()).socialDrafts.length, 2);
        const benchmarkExport = await fetch(`${baseUrl}/api/account/export`, { headers: { cookie: firstCookie } });
        assert.equal((await benchmarkExport.json()).marketBenchmarks.length, 1);
        const invalidSocialPlatforms = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ platforms: ['instagram', 'linkedin', 'x', 'facebook'] }),
        });
        assert.equal(invalidSocialPlatforms.status, 400);

        const workflowResponse = await fetch(`${baseUrl}/api/workflows/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ goal: 'Interessenten nachfassen', audience: 'Kleine Unternehmen' }),
        });
        assert.equal(workflowResponse.status, 201);
        const generatedWorkflow = await workflowResponse.json();
        assert.equal(generatedWorkflow.workflow.workflow.title, 'Ablauf: Interessenten nachfassen');
        assert.equal(generatedWorkflow.workflow.workflow.generationMethod, 'local_template');
        const updatedWorkflowResponse = await fetch(`${baseUrl}/api/workflows/${generatedWorkflow.workflow.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({
                title: 'Eigener Workflowname',
                summary: 'Eigene Workflow-Zusammenfassung.',
                steps: ['Erster Schritt', 'Zweiter Schritt', 'Dritter Schritt'],
                successMetric: 'Messbare Erfolgsquote',
                approvalBoundary: 'Vor Aktionen manuell prüfen.',
            }),
        });
        assert.equal(updatedWorkflowResponse.status, 200);
        const rateLimitIdeaIds = [];
        for (let index = 0; index < 5; index += 1) {
            const assumptions = index === 0
                ? {
                    marketCountry: 'Kuwait',
                    currency: 'KWD',
                    industry: 'ecommerce',
                    unitPrice: 1.234,
                    expectedMonthlySales: 10,
                    variableCostPerSale: 0.123,
                    monthlyFixedCosts: 1.111,
                }
                : businessAssumptions;
            const withinRateLimit = await fetch(`${baseUrl}/api/ideas/generate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
                body: JSON.stringify({ topic: `Weitere Idee ${index}`, ...assumptions }),
            });
            assert.equal(withinRateLimit.status, 201);
            const generated = (await withinRateLimit.json()).idea;
            rateLimitIdeaIds.push(generated.id);
            if (index === 0) {
                assert.equal(generated.idea.commercialCase.monthlyProjection.revenue, 12.34);
                assert.equal(generated.idea.commercialCase.monthlyProjection.operatingResultBeforeTax, 9.999);
            }
        }
        const usage = await fetch(`${baseUrl}/api/billing/usage`, { headers: { cookie: firstCookie } });
        const premiumUsage = await usage.json();
        assert.equal(premiumUsage.usedTokens, 0);
        assert.equal(premiumUsage.monthlyLimit, 5000);
        const rateLimited = await fetch(`${baseUrl}/api/ideas/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ topic: 'Noch eine dynamische Idee', ...businessAssumptions }),
        });
        assert.equal(rateLimited.status, 429);
        for (const ideaId of rateLimitIdeaIds) {
            const deletedIdea = await fetch(`${baseUrl}/api/ideas/${ideaId}`, {
                method: 'DELETE',
                headers: { cookie: firstCookie, origin: baseUrl },
            });
            assert.equal(deletedIdea.status, 204);
        }

        async function sendEvent(type, id, object, eventCreated = Math.floor(Date.now() / 1000)) {
            const payload = JSON.stringify({
                id,
                type,
                created: eventCreated,
                data: { object },
            });
            const eventTimestamp = Math.floor(Date.now() / 1000);
            const eventSignature = `t=${eventTimestamp},v1=${createHmac('sha256', 'whsec_portaltestsecret')
                .update(`${eventTimestamp}.${payload}`).digest('hex')}`;
            return fetch(webhookUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'stripe-signature': eventSignature },
                body: payload,
            });
        }
        const refund = await sendEvent('charge.refunded', 'evt_portal_refund_1', {
            payment_intent: 'pi_portal_paid_1',
            invoice: null,
        });
        assert.equal(refund.status, 200);
        assert.equal((await (await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: firstCookie } })).json()).premiumEnabled, false);
        const refundedWorkflow = await fetch(`${baseUrl}/api/workflows/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: firstCookie, origin: baseUrl },
            body: JSON.stringify({ goal: 'Interessenten nachfassen' }),
        });
        assert.equal(refundedWorkflow.status, 403);

        const subscription = await sendEvent('customer.subscription.created', 'evt_subscription_created', {
            id: 'sub_portal_1',
            customer: 'cus_portal_first',
            status: 'active',
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            metadata: { productId: 'premium_monthly', portalUserId: '1' },
        });
        assert.equal(subscription.status, 200);
        assert.equal((await (await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: firstCookie } })).json()).premiumEnabled, true);
        const failedInvoice = await sendEvent('invoice.payment_failed', 'evt_invoice_failed', {
            id: 'in_portal_1',
            subscription: 'sub_portal_1',
            payment_intent: 'pi_invoice_1',
            number: 'INV-1',
            status: 'open',
            amount_due: 9900,
            amount_paid: 0,
            currency: 'eur',
            created: Math.floor(Date.now() / 1000),
        });
        assert.equal(failedInvoice.status, 200);
        assert.equal((await (await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: firstCookie } })).json()).premiumEnabled, false);
        const paidInvoice = await sendEvent('invoice.paid', 'evt_invoice_paid', {
            id: 'in_portal_1',
            subscription: 'sub_portal_1',
            payment_intent: 'pi_invoice_1',
            number: 'INV-1',
            status: 'paid',
            amount_due: 9900,
            amount_paid: 9900,
            currency: 'eur',
            hosted_invoice_url: 'https://invoice.stripe.com/i/test',
            invoice_pdf: 'https://invoice.stripe.com/i/test/pdf',
            created: Math.floor(Date.now() / 1000),
        });
        assert.equal(paidInvoice.status, 200);
        assert.equal((await (await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: firstCookie } })).json()).premiumEnabled, true);
        const invoices = await fetch(`${baseUrl}/api/billing/invoices`, { headers: { cookie: firstCookie } });
        assert.equal((await invoices.json()).invoices[0].status, 'paid');
        const refundBeforeInvoice = Math.floor(Date.now() / 1000) + 1;
        const earlyRefund = await sendEvent('charge.refunded', 'evt_invoice_refunded_early', {
            payment_intent: 'pi_invoice_refunded',
            invoice: 'in_refunded',
        }, refundBeforeInvoice);
        assert.equal(earlyRefund.status, 200);
        const refundedInvoice = await sendEvent('invoice.paid', 'evt_invoice_paid_after_refund', {
            id: 'in_refunded',
            subscription: 'sub_portal_1',
            payment_intent: 'pi_invoice_refunded',
            number: 'INV-REFUNDED',
            status: 'paid',
            amount_due: 9900,
            amount_paid: 9900,
            currency: 'eur',
            created: refundBeforeInvoice - 1,
        }, refundBeforeInvoice - 1);
        assert.equal(refundedInvoice.status, 200);
        assert.equal((await (await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: firstCookie } })).json()).premiumEnabled, false);
        const invoiceList = await fetch(`${baseUrl}/api/billing/invoices`, { headers: { cookie: firstCookie } });
        assert.equal((await invoiceList.json()).invoices.find(invoice => invoice.id === 'in_refunded').status, 'refunded');
        const laterInvoice = await sendEvent('invoice.paid', 'evt_invoice_next_period_paid', {
            id: 'in_next',
            subscription: 'sub_portal_1',
            payment_intent: 'pi_invoice_next',
            number: 'INV-NEXT',
            status: 'paid',
            amount_due: 9900,
            amount_paid: 9900,
            currency: 'eur',
            created: refundBeforeInvoice + 1,
        }, refundBeforeInvoice + 1);
        assert.equal(laterInvoice.status, 200);
        assert.equal((await (await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: firstCookie } })).json()).premiumEnabled, true);
        const canceledSubscription = await sendEvent('customer.subscription.deleted', 'evt_subscription_deleted', {
            id: 'sub_portal_1',
            customer: 'cus_portal_first',
            status: 'canceled',
            current_period_end: Math.floor(Date.now() / 1000),
            metadata: { productId: 'premium_monthly', portalUserId: '1' },
        }, refundBeforeInvoice + 2);
        assert.equal(canceledSubscription.status, 200);
        assert.equal((await (await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: firstCookie } })).json()).premiumEnabled, false);
        const internalErrorsUnauthorized = await fetch(`${baseUrl}/internal/errors`);
        assert.equal(internalErrorsUnauthorized.status, 401);
        const internalErrorsAuthorized = await fetch(`${baseUrl}/internal/errors`, {
            headers: { 'x-portal-error-token': 'portal-internal-test-token-12345678901234567890' },
        });
        assert.equal(internalErrorsAuthorized.status, 200);

        const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'first@example.com', password: 'correct horse battery staple' }),
        });
        assert.equal(duplicate.status, 409);

        const secondRegister = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'second@example.com', password: 'another strong password' }),
        });
        assert.equal(secondRegister.status, 201);
        const secondVerificationLink = new URL(sentEmails.at(-1).textContent.split('\n')[0].replace(/^.*: /, ''));
        const secondVerification = await fetch(`${baseUrl}/api/auth/verify-email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ token: secondVerificationLink.searchParams.get('token') }),
        });
        assert.equal(secondVerification.status, 200);
        const secondCookie = secondVerification.headers.get('set-cookie').split(';', 1)[0];
        const crossAccountMarketFetch = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/market-benchmarks`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: secondCookie, origin: baseUrl },
            body: JSON.stringify({ shareMarketContext: true }),
        });
        assert.equal(crossAccountMarketFetch.status, 404);
        const crossAccountActionUpdate = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/actions/${firstValidationAction.id}`,
            {
                method: 'PATCH',
                headers: { 'content-type': 'application/json', cookie: secondCookie, origin: baseUrl },
                body: JSON.stringify({ status: 'todo', dueDate: null, resultNote: '' }),
            },
        );
        assert.equal(crossAccountActionUpdate.status, 404);
        assert.equal(marketRequests.length, 2);
        const crossAccountSocialApproval = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts/${generatedSocial.drafts[1].id}/approve`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', cookie: secondCookie, origin: baseUrl },
                body: JSON.stringify({ scheduledAt: new Date(Date.now() + 5 * 60_000).toISOString() }),
            },
        );
        assert.equal(crossAccountSocialApproval.status, 404);
        const crossAccountSocialDrafts = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts`, {
            headers: { cookie: secondCookie },
        });
        assert.equal(crossAccountSocialDrafts.status, 404);
        const crossAccountSocialDelete = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts/${generatedSocial.drafts[0].id}`,
            { method: 'DELETE', headers: { cookie: secondCookie, origin: baseUrl } },
        );
        assert.equal(crossAccountSocialDelete.status, 404);
        const ownSocialDelete = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/social-drafts/${generatedSocial.drafts[0].id}`,
            { method: 'DELETE', headers: { cookie: firstCookie, origin: baseUrl } },
        );
        assert.equal(ownSocialDelete.status, 204);
        const crossAccountEdit = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', cookie: secondCookie, origin: baseUrl },
            body: JSON.stringify({
                title: 'Fremder Entwurf',
                summary: 'Nicht zugänglich.',
                businessModel: 'Nicht zugänglich.',
                firstSteps: ['Schritt eins', 'Schritt zwei', 'Schritt drei'],
            }),
        });
        assert.equal(crossAccountEdit.status, 404);
        const crossAccountSales = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/sales`, {
            headers: { cookie: secondCookie },
        });
        assert.equal(crossAccountSales.status, 404);
        const crossAccountSaleDelete = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/sales/${recordedSaleData.sale.id}`,
            { method: 'DELETE', headers: { cookie: secondCookie, origin: baseUrl } },
        );
        assert.equal(crossAccountSaleDelete.status, 404);
        const removedSale = await fetch(
            `${baseUrl}/api/ideas/${generatedIdea.idea.id}/sales/${recordedSaleData.sale.id}`,
            { method: 'DELETE', headers: { cookie: firstCookie, origin: baseUrl } },
        );
        assert.equal(removedSale.status, 204);
        const emptySales = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}/sales`, {
            headers: { cookie: firstCookie },
        });
        assert.equal((await emptySales.json()).salesSummary.revenue, 0);
        const crossAccountDelete = await fetch(`${baseUrl}/api/workflows/${generatedWorkflow.workflow.id}`, {
            method: 'DELETE',
            headers: { cookie: secondCookie, origin: baseUrl },
        });
        assert.equal(crossAccountDelete.status, 404);
        const secondUserIdeas = await fetch(`${baseUrl}/api/ideas`, { headers: { cookie: secondCookie } });
        assert.deepEqual((await secondUserIdeas.json()).ideas, []);
        const freeIdea = await fetch(`${baseUrl}/api/ideas/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: secondCookie, origin: baseUrl },
            body: JSON.stringify({ topic: 'Kostenlimit prüfen', ...businessAssumptions }),
        });
        assert.equal(freeIdea.status, 201);
        const exhaustedFreeBudget = await fetch(`${baseUrl}/api/ideas/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: secondCookie, origin: baseUrl },
            body: JSON.stringify({ topic: 'Weiteres Budget testen', ...businessAssumptions }),
        });
        assert.equal(exhaustedFreeBudget.status, 201);
        const freeUsage = await fetch(`${baseUrl}/api/billing/usage`, { headers: { cookie: secondCookie } });
        assert.equal((await freeUsage.json()).monthlyLimit, 1300);
        assert.equal(llmRequests, 0, 'Portal generation must not contact the configured model endpoint');
        const secondUserEntitlements = await fetch(`${baseUrl}/api/billing/entitlements`, { headers: { cookie: secondCookie } });
        assert.equal((await secondUserEntitlements.json()).premiumEnabled, false);
        const secondExport = await fetch(`${baseUrl}/api/account/export`, { headers: { cookie: secondCookie } });
        assert.equal(secondExport.status, 200);
        assert.equal((await secondExport.json()).account.email, 'second@example.com');
        const deleteSecond = await fetch(`${baseUrl}/api/account`, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', cookie: secondCookie, origin: baseUrl },
            body: JSON.stringify({ password: 'another strong password' }),
        });
        assert.equal(deleteSecond.status, 204);
        assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: secondCookie } })).status, 401);

        const logout = await fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { cookie: firstCookie, origin: baseUrl },
        });
        assert.equal(logout.status, 204);
        const revoked = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: firstCookie } });
        assert.equal(revoked.status, 401);

        const login = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'first@example.com', password: 'correct horse battery staple' }),
        });
        assert.equal(login.status, 200);
        const loggedIn = await fetch(`${baseUrl}/api/auth/me`, {
            headers: { cookie: login.headers.get('set-cookie').split(';', 1)[0] },
        });
        assert.equal((await loggedIn.json()).user.email, 'first@example.com');

        const resetRequest = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'first@example.com' }),
        });
        assert.equal(resetRequest.status, 202);
        const resetLink = new URL(sentEmails.at(-1).textContent.split('\n')[0].replace(/^.*: /, ''));
        const reset = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ token: resetLink.searchParams.get('token'), password: 'a newly secure password' }),
        });
        assert.equal(reset.status, 200);
        assert.equal((await fetch(`${baseUrl}/api/auth/me`, {
            headers: { cookie: login.headers.get('set-cookie').split(';', 1)[0] },
        })).status, 401);
        const oldPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'first@example.com', password: 'correct horse battery staple' }),
        });
        assert.equal(oldPasswordLogin.status, 401);
        const newPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'first@example.com', password: 'a newly secure password' }),
        });
        assert.equal(newPasswordLogin.status, 200);
        const anotherSession = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email: 'first@example.com', password: 'a newly secure password' }),
        });
        assert.equal(anotherSession.status, 200);
        const changePassword = await fetch(`${baseUrl}/api/auth/change-password`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                cookie: newPasswordLogin.headers.get('set-cookie').split(';', 1)[0],
                origin: baseUrl,
            },
            body: JSON.stringify({
                currentPassword: 'a newly secure password',
                newPassword: 'a third secure password',
            }),
        });
        assert.equal(changePassword.status, 200);
        assert.equal((await fetch(`${baseUrl}/api/auth/me`, {
            headers: { cookie: anotherSession.headers.get('set-cookie').split(';', 1)[0] },
        })).status, 401);
        const ownIdeaDelete = await fetch(`${baseUrl}/api/ideas/${generatedIdea.idea.id}`, {
            method: 'DELETE',
            headers: { cookie: newPasswordLogin.headers.get('set-cookie').split(';', 1)[0], origin: baseUrl },
        });
        assert.equal(ownIdeaDelete.status, 204);
        const remainingIdeaActions = await getDatabaseRow(
            databasePath,
            `SELECT COUNT(*) AS count FROM portal_idea_actions WHERE idea_id = ${generatedIdea.idea.id}`,
        );
        assert.equal(remainingIdeaActions.count, 0);
        const ownWorkflowDelete = await fetch(`${baseUrl}/api/workflows/${generatedWorkflow.workflow.id}`, {
            method: 'DELETE',
            headers: { cookie: newPasswordLogin.headers.get('set-cookie').split(';', 1)[0], origin: baseUrl },
        });
        assert.equal(ownWorkflowDelete.status, 204);
        assert.deepEqual((await (await fetch(`${baseUrl}/api/ideas`, {
            headers: { cookie: newPasswordLogin.headers.get('set-cookie').split(';', 1)[0] },
        })).json()).ideas, []);
        const accountRateLimit = 'abuse@example.com';
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const failedLogin = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: baseUrl,
                    'x-forwarded-for': `198.51.100.${attempt + 1}`,
                },
                body: JSON.stringify({ email: accountRateLimit, password: 'incorrect password' }),
            });
            assert.equal(failedLogin.status, 401);
        }
        const distributedAttempt = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: baseUrl,
                'x-forwarded-for': '203.0.113.100',
            },
            body: JSON.stringify({ email: accountRateLimit, password: 'incorrect password' }),
        });
        assert.equal(distributedAttempt.status, 429);
        const deleteFirstAccount = await fetch(`${baseUrl}/api/account`, {
            method: 'DELETE',
            headers: {
                'content-type': 'application/json',
                cookie: newPasswordLogin.headers.get('set-cookie').split(';', 1)[0],
                origin: baseUrl,
            },
            body: JSON.stringify({ password: 'a third secure password' }),
        });
        assert.equal(deleteFirstAccount.status, 204);
        assert.equal((await fetch(`${baseUrl}/api/auth/me`, {
            headers: { cookie: newPasswordLogin.headers.get('set-cookie').split(';', 1)[0] },
        })).status, 401);
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await once(child, 'exit');
        }
        llmServer.closeAllConnections();
        await new Promise(resolve => llmServer.close(resolve));
        mailServer.closeAllConnections();
        await new Promise(resolve => mailServer.close(resolve));
        marketServer.closeAllConnections();
        await new Promise(resolve => marketServer.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
