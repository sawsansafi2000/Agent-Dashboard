const express = require('express');
const fs = require('node:fs');
const path = require('path');
const { spawn } = require('node:child_process');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const kernel = require('./agent-kernel.cjs');
const { submitDeveloperTask } = require('./developerAgent.cjs');
const { getStripeProducts } = require('./stripeCatalog.cjs');

let stripe = null;
try {
    if (process.env.STRIPE_SECRET_KEY) {
        stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    }
} catch (e) {
    console.warn('[SERVER] Stripe Modul oder API-Key nicht verfügbar. Checkout läuft im Fallback-Modus.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const APP_BASIC_AUTH = process.env.APP_BASIC_AUTH === 'true';
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_PROXY_TOKEN = process.env.DASHBOARD_PROXY_TOKEN || '';
const DEFAULT_PUBLIC_URL = `http://localhost:${PORT}`;
const TASK_API_PORT = Number.parseInt(process.env.INTERNAL_AGENT_API_PORT || '3101', 10);
const TASK_API_URL = `http://127.0.0.1:${TASK_API_PORT}`;
const MAX_DISPATCH_RETRY_MS = 5 * 60 * 1000;
const DISPATCH_RETRY_INTERVAL_MS = 10 * 1000;
let runnerProcess = null;
let runnerRestartTimer = null;
let runnerRestartCount = 0;
let shuttingDown = false;

if (APP_BASIC_AUTH && (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD)) {
    throw new Error('APP_BASIC_AUTH erfordert DASHBOARD_USERNAME und DASHBOARD_PASSWORD.');
}
if (DASHBOARD_PROXY_TOKEN && !/^[a-f0-9]{64}$/i.test(DASHBOARD_PROXY_TOKEN)) {
    throw new Error('DASHBOARD_PROXY_TOKEN muss aus genau 64 hexadezimalen Zeichen bestehen.');
}

function getStripeConfiguration() {
    const issues = [];
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(process.env.STRIPE_SECRET_KEY || '')) {
        issues.push('STRIPE_SECRET_KEY fehlt oder hat kein gültiges Stripe-Secret-Key-Format.');
    }
    if (!/^whsec_[A-Za-z0-9]+$/.test(process.env.STRIPE_WEBHOOK_SECRET || '')) {
        issues.push('STRIPE_WEBHOOK_SECRET fehlt oder hat kein gültiges Stripe-Signaturformat.');
    }

    let products = [];
    try {
        products = getStripeProducts().filter((product) => !product.recurringInterval);
        if (!products.length) {
            issues.push('STRIPE_PRODUCT_CATALOG enthält noch kein einmaliges Dashboard-Angebot.');
        }
    } catch (error) {
        issues.push(error.message);
    }

    const configuredBaseUrl = process.env.PUBLIC_BASE_URL
        || (process.env.NODE_ENV === 'production' ? '' : DEFAULT_PUBLIC_URL);
    if (!configuredBaseUrl) {
        issues.push('PUBLIC_BASE_URL fehlt im Produktionsbetrieb.');
    } else {
        try {
            const publicUrl = new URL(configuredBaseUrl);
            if (!['http:', 'https:'].includes(publicUrl.protocol)
                || publicUrl.username
                || publicUrl.password
                || (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:')) {
                issues.push('PUBLIC_BASE_URL muss eine gültige öffentliche HTTPS-URL ohne Zugangsdaten sein.');
            }
        } catch (error) {
            issues.push('PUBLIC_BASE_URL ist keine gültige URL.');
        }
    }

    return {
        issues,
        products,
        secretReady: /^sk_(test|live)_[A-Za-z0-9]+$/.test(process.env.STRIPE_SECRET_KEY || ''),
        webhookReady: /^whsec_[A-Za-z0-9]+$/.test(process.env.STRIPE_WEBHOOK_SECRET || '')
    };
}

app.post('/api/stripe-webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret || '')) {
        return res.status(503).json({ success: false, error: 'Stripe-Webhooks sind nicht konfiguriert.' });
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret);
    } catch (error) {
        console.warn('[STRIPE WEBHOOK] Signatur oder Payload ungültig.');
        return res.status(400).json({ success: false, error: 'Ungültige Stripe-Webhook-Signatur oder Payload.' });
    }

    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
        return res.json({ success: true, received: true });
    }

    const session = event.data.object;
    if (session.payment_status !== 'paid') {
        return res.json({ success: true, received: true, paid: false });
    }

    let product;
    try {
        product = getStripeProducts().find((item) => item.id === session.metadata?.productId && !item.recurringInterval);
    } catch (error) {
        console.error('[STRIPE WEBHOOK] Product catalog validation failed:', error.message);
        return res.status(500).json({ success: false, error: 'Produktkatalog kann nicht validiert werden.' });
    }

    if (!product
        || session.mode !== 'payment'
        || session.currency !== product.currency
        || session.amount_total !== product.unitAmountCents) {
        console.error('[STRIPE WEBHOOK] Paid checkout does not match configured catalog:', event.id);
        return res.status(400).json({ success: false, error: 'Die bezahlte Sitzung stimmt nicht mit dem Produktkatalog überein.' });
    }

    const customerEmail = session.customer_details?.email || session.customer_email || null;
    db.serialize(() => {
        db.run('BEGIN IMMEDIATE', (beginError) => {
            if (beginError) {
                console.error('[STRIPE WEBHOOK] Could not begin transaction:', beginError.message);
                return res.status(500).json({ success: false, error: 'Zahlung konnte nicht gespeichert werden.' });
            }

            db.get(
                'SELECT id FROM paid_orders WHERE stripe_event_id = ? OR checkout_session_id = ?',
                [event.id, session.id],
                (lookupError, existing) => {
                    if (lookupError) {
                        return rollbackWebhook(lookupError, res);
                    }
                    if (existing) {
                        return db.run('COMMIT', (commitError) => {
                            if (commitError) {
                                return rollbackWebhook(commitError, res);
                            }
                            res.json({ success: true, received: true, duplicate: true });
                        });
                    }

                    db.run(
                        `INSERT INTO paid_orders
                            (stripe_event_id, checkout_session_id, stripe_customer_id, customer_email, product_id, product_name, amount_total, currency, fulfillment_status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                        [
                            event.id,
                            session.id,
                            session.customer || null,
                            customerEmail,
                            product.id,
                            product.name,
                            session.amount_total,
                            session.currency
                        ],
                        function (insertError) {
                            if (insertError) {
                                return rollbackWebhook(insertError, res);
                            }
                            const orderId = this.lastID;
                            db.run(
                                'INSERT INTO audit_log (action, details) VALUES (?, ?)',
                                ['STRIPE_PAYMENT_CONFIRMED', `Bestellung ${orderId}: ${product.id}, ${session.amount_total} ${session.currency}. Bereitstellung ausstehend.`],
                                (auditError) => {
                                    if (auditError) {
                                        return rollbackWebhook(auditError, res);
                                    }
                                    db.run('COMMIT', (commitError) => {
                                        if (commitError) {
                                            return rollbackWebhook(commitError, res);
                                        }
                                        console.log(`[STRIPE WEBHOOK] Zahlung für Bestellung ${orderId} bestätigt; Bereitstellung ausstehend.`);
                                        res.json({ success: true, received: true, orderId, fulfillmentStatus: 'pending' });
                                    });
                                }
                            );
                        }
                    );
                }
            );
        });
    });
});

app.use(express.json());
app.use((req, res, next) => {
    req.dashboardAuthenticated = false;
    if (!APP_BASIC_AUTH || req.path === '/health') return next();

    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Basic ([A-Za-z0-9+/]+=*)$/);
    if (match) {
        const supplied = Buffer.from(match[1], 'base64');
        const expected = Buffer.from(`${DASHBOARD_USERNAME}:${DASHBOARD_PASSWORD}`);
        if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
            req.dashboardAuthenticated = true;
            return next();
        }
    }

    res.set('WWW-Authenticate', 'Basic realm="Agent Dashboard"');
    return res.status(401).json({ success: false, error: 'Authentifizierung erforderlich.' });
});
app.use(express.static(path.join(__dirname, '../public')));

const db = new sqlite3.Database(process.env.DATABASE_PATH || path.join(__dirname, '../database.sqlite'), (err) => {
    if (err) console.error('Datenbankfehler:', err.message);
    else console.log('[DB] SQLite verbunden.');
});
db.configure('busyTimeout', 10_000);

let databaseReady;
const missionDispatches = new Map();
db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL', (error) => {
        if (error) console.error('[DB] WAL-Modus konnte nicht aktiviert werden:', error.message);
    });
    db.run('PRAGMA synchronous = FULL', (error) => {
        if (error) console.error('[DB] Volle SQLite-Synchronisierung konnte nicht aktiviert werden:', error.message);
    });
    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS runner_control_audit (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('requested', 'succeeded', 'failed')),
        details TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pending_marketing_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT,
        content TEXT,
        status TEXT DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pending_missions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        runner_task_id TEXT,
        execution_result TEXT,
        execution_error TEXT,
        dispatch_retry_after TEXT,
        dispatch_attempts INTEGER NOT NULL DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS paid_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_event_id TEXT NOT NULL UNIQUE,
        checkout_session_id TEXT NOT NULL UNIQUE,
        stripe_customer_id TEXT,
        customer_email TEXT,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        amount_total INTEGER NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'eur'),
        fulfillment_status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    databaseReady = new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(pending_missions)', [], (error, columns) => {
            if (error) return reject(error);
            const existing = new Set(columns.map(column => column.name));
            const additions = [
                ['runner_task_id', 'TEXT'],
                ['execution_result', 'TEXT'],
                ['execution_error', 'TEXT'],
                ['dispatch_retry_after', 'TEXT'],
                ['dispatch_attempts', 'INTEGER NOT NULL DEFAULT 0']
            ].filter(([name]) => !existing.has(name));
            const addNextColumn = (index) => {
                if (index >= additions.length) return resolve();
                const [name, type] = additions[index];
                db.run(`ALTER TABLE pending_missions ADD COLUMN ${name} ${type}`, (alterError) => {
                    if (alterError) return reject(alterError);
                    addNextColumn(index + 1);
                });
            };
            addNextColumn(0);
        });
    });
});

app.use((req, res, next) => {
    databaseReady.then(() => next()).catch((error) => {
        console.error('[DB] Datenbankinitialisierung fehlgeschlagen:', error.message);
        res.status(500).json({ success: false, error: 'Datenbankinitialisierung fehlgeschlagen.' });
    });
});

app.get('/health', async (req, res) => {
    try {
        await databaseReady;
        const response = await fetch(`${TASK_API_URL}/tasks`, {
            headers: getTaskApiHeaders(),
            signal: AbortSignal.timeout(3000)
        });
        const runner = await response.json().catch(() => ({}));
        const runnerAvailable = response.ok && Array.isArray(runner.tasks);
        res.status(runnerAvailable ? 200 : 503).json({
            status: runnerAvailable ? 'ok' : 'degraded',
            runnerAvailable,
            runnerProcess: runnerProcess ? 'running' : 'stopped',
            runnerRestartCount,
            ...(!APP_BASIC_AUTH || req.dashboardAuthenticated
                ? { control: runner.control || null }
                : {}),
            error: runnerAvailable
                ? null
                : !APP_BASIC_AUTH || req.dashboardAuthenticated
                    ? runner.error || 'Runner-API nicht erreichbar.'
                    : 'Runner nicht verfügbar.'
        });
    } catch (error) {
        const cause = error && typeof error === 'object' && error.cause instanceof Error
            ? error.cause.message
            : null;
        res.status(503).json({
            status: 'degraded',
            runnerAvailable: false,
            runnerProcess: runnerProcess ? 'running' : 'stopped',
            runnerRestartCount,
            error: !APP_BASIC_AUTH || req.dashboardAuthenticated
                ? cause || (error instanceof Error ? error.message : 'Runner nicht verfügbar.')
                : 'Runner nicht verfügbar.'
        });
    }
});

function rollbackWebhook(error, res) {
    console.error('[STRIPE WEBHOOK] Transaction failed:', error.message);
    db.run('ROLLBACK', (rollbackError) => {
        if (rollbackError) {
            console.error('[STRIPE WEBHOOK] Rollback failed:', rollbackError.message);
        }
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Zahlung konnte nicht sicher gespeichert werden.' });
        }
    });
}

function getTaskApiHeaders() {
    const token = process.env.INTERNAL_AGENT_API_TOKEN;
    if (!token) {
        throw new Error('INTERNAL_AGENT_API_TOKEN fehlt; der Agent-Runner ist nicht verbunden.');
    }
    return {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
    };
}

function isDashboardAuthenticated(req) {
    if (req.dashboardAuthenticated) return true;
    if (DASHBOARD_PROXY_TOKEN) {
        const proxyToken = Buffer.from(req.get('x-dashboard-proxy-auth') || '');
        const expectedProxyToken = Buffer.from(DASHBOARD_PROXY_TOKEN);
        if (proxyToken.length === expectedProxyToken.length && timingSafeEqual(proxyToken, expectedProxyToken)) {
            req.dashboardActor = (req.get('x-dashboard-actor') || DASHBOARD_USERNAME || 'admin').slice(0, 100);
            return true;
        }
    }
    if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) return false;
    const match = (req.get('authorization') || '').match(/^Basic ([A-Za-z0-9+/]+=*)$/);
    if (!match) return false;
    const supplied = Buffer.from(match[1], 'base64');
    const expected = Buffer.from(`${DASHBOARD_USERNAME}:${DASHBOARD_PASSWORD}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    req.dashboardActor = DASHBOARD_USERNAME;
    return true;
}

function writeRunnerControlAudit(id, status, details) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE runner_control_audit SET result = ?, details = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [status, details, id],
            function onRun(error) {
                if (error) return reject(error);
                if (this.changes !== 1) return reject(new Error('Runner-Audit-Eintrag wurde nicht gefunden.'));
                resolve();
            }
        );
    });
}

function createRunnerControlAudit(id, actor, action) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO runner_control_audit (id, actor, action, result, details)
             VALUES (?, ?, ?, 'requested', 'Steuerungsanfrage wird verarbeitet.')`,
            [id, actor, action],
            error => error ? reject(error) : resolve()
        );
    });
}

function missionStatusFromTask(task) {
    return ['queued', 'running', 'completed', 'failed'].includes(task.status) ? task.status : 'pending';
}

async function dispatchMissionToRunner(mission) {
    if (missionDispatches.has(mission.id)) return missionDispatches.get(mission.id);
    const dispatch = (async () => {
        const response = await fetch(`${TASK_API_URL}/tasks`, {
            method: 'POST',
            headers: getTaskApiHeaders(),
            body: JSON.stringify({
                message: mission.mission,
                targetAgent: 'master-orchestrator',
                clientRequestId: `dashboard-mission-${mission.id}`
            }),
            signal: AbortSignal.timeout(5000)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.task || typeof data.task.id !== 'string') {
            throw new Error(data.error || `Runner-Übergabe fehlgeschlagen (HTTP ${response.status}).`);
        }

        const task = data.task;
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE pending_missions
                 SET status = ?, runner_task_id = ?, execution_result = ?, execution_error = NULL,
                     dispatch_retry_after = NULL, dispatch_attempts = dispatch_attempts + 1
                 WHERE id = ?`,
                [
                    missionStatusFromTask(task),
                    task.id,
                    task.result == null ? null : JSON.stringify(task.result),
                    mission.id
                ],
                (error) => error ? reject(error) : resolve()
            );
        });
        kernel.logAudit('MISSION_DISPATCHED', `Mission ${mission.id} an Agent-Task ${task.id} übergeben.`);
        return task;
    })();
    missionDispatches.set(mission.id, dispatch);
    try {
        return await dispatch;
    } finally {
        missionDispatches.delete(mission.id);
    }
}

async function recordMissionDispatchFailure(mission, error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = Number(mission.dispatch_attempts || 0) + 1;
    const retryDelay = Math.min(MAX_DISPATCH_RETRY_MS, 15_000 * (2 ** Math.min(attempts - 1, 5)));
    await new Promise((resolve, reject) => {
        db.run(
            `UPDATE pending_missions
             SET execution_error = ?, dispatch_attempts = ?, dispatch_retry_after = ?
             WHERE id = ?`,
            [message, attempts, new Date(Date.now() + retryDelay).toISOString(), mission.id],
            (updateError) => updateError ? reject(updateError) : resolve()
        );
    });
    kernel.logAudit('MISSION_DISPATCH_FAILED', `Mission ${mission.id}, Versuch ${attempts}: ${message}`);
    return message;
}

async function getRunnerTasks() {
    const response = await fetch(`${TASK_API_URL}/tasks`, {
        headers: getTaskApiHeaders(),
        signal: AbortSignal.timeout(5000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.tasks)) {
        throw new Error(data.error || `Runner-Status konnte nicht geladen werden (HTTP ${response.status}).`);
    }
    return data;
}

async function syncMissionWithRunner(mission, task) {
    const status = missionStatusFromTask(task);
    const result = task.result == null ? null : JSON.stringify(task.result);
    const error = typeof task.error === 'string' ? task.error : null;
    if (mission.status === status
        && mission.runner_task_id === task.id
        && mission.execution_result === result
        && mission.execution_error === error) return;

    await new Promise((resolve, reject) => {
        db.run(
            `UPDATE pending_missions
             SET status = ?, runner_task_id = ?, execution_result = ?, execution_error = ?
             WHERE id = ?`,
            [status, task.id, result, error, mission.id],
            (updateError) => updateError ? reject(updateError) : resolve()
        );
    });
}

async function retryPendingMissions() {
    try {
        await databaseReady;
        const missions = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, mission, dispatch_attempts FROM pending_missions
                 WHERE status = 'pending'
                   AND (dispatch_retry_after IS NULL OR dispatch_retry_after <= ?)
                 ORDER BY id ASC LIMIT 25`,
                [new Date().toISOString()],
                (error, rows) => error ? reject(error) : resolve(rows)
            );
        });
        await Promise.all(missions.map(async (mission) => {
            try {
                await dispatchMissionToRunner(mission);
            } catch (error) {
                await recordMissionDispatchFailure(mission, error);
            }
        }));
    } catch (error) {
        console.error('[MISSIONS] Automatischer Retry fehlgeschlagen:', error.message);
    }
}

app.get('/api/products', (req, res) => {
    try {
        const configuration = getStripeConfiguration();
        res.json({
            success: true,
            checkoutReady: Boolean(stripe && configuration.secretReady && configuration.issues.length === 0),
            webhookReady: configuration.webhookReady,
            configurationIssues: configuration.issues,
            products: configuration.products.map(({ id, name, description, unitAmountCents, currency }) => ({
                id, name, description, unitAmountCents, currency
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripe) {
        return res.status(503).json({
            success: false,
            error: 'Stripe ist nicht konfiguriert. STRIPE_SECRET_KEY muss gesetzt sein.'
        });
    }

    try {
        const configuration = getStripeConfiguration();
        if (!configuration.secretReady || configuration.issues.length) {
            return res.status(503).json({
                success: false,
                error: configuration.issues.join(' ')
            });
        }
        const product = configuration.products.find((item) => item.id === req.body?.productId);
        if (!product) {
            return res.status(400).json({ success: false, error: 'Bitte wähle ein gültiges Produkt aus dem konfigurierten Katalog.' });
        }
        const publicUrl = new URL(process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_URL);
        if (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') {
            return res.status(503).json({ success: false, error: 'Im Produktionsbetrieb ist eine öffentliche HTTPS-URL für PUBLIC_BASE_URL erforderlich.' });
        }
        const baseUrl = publicUrl.origin;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: product.currency,
                    product_data: {
                        name: product.name,
                        ...(product.description ? { description: product.description } : {})
                    },
                    unit_amount: product.unitAmountCents,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/?checkout=cancelled`,
            metadata: { productId: product.id },
        });
        res.json({ success: true, url: session.url });
    } catch (error) {
        console.error('[CHECKOUT ERROR]', {
            type: error.type || 'unknown',
            code: error.code || null,
            statusCode: error.statusCode || null,
            requestId: error.requestId || null
        });
        res.status(500).json({ success: false, error: 'Die Checkout-Sitzung konnte nicht erstellt werden.' });
    }
});

app.get('/api/marketing-queue', (req, res) => {
    db.all(`SELECT * FROM pending_marketing_queue ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, queue: rows });
    });
});

app.get('/api/dashboard-stats', (req, res) => {
    db.get(`SELECT
        (SELECT COUNT(*) FROM pending_missions WHERE status IN ('pending', 'queued', 'running')) AS pendingMissions,
        (SELECT COUNT(*) FROM pending_marketing_queue WHERE status = 'draft') AS marketingDrafts,
        (SELECT COUNT(*) FROM paid_orders) AS paidOrders,
        (SELECT COUNT(*) FROM paid_orders WHERE fulfillment_status = 'pending') AS pendingFulfillment,
        (SELECT COALESCE(SUM(amount_total), 0) FROM paid_orders) AS revenueCents`,
    [], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({
            success: true,
            stats: {
                agentCount: 1,
                pendingMissions: row.pendingMissions,
                marketingDrafts: row.marketingDrafts,
                paidOrders: row.paidOrders,
                revenueCents: row.revenueCents,
                pendingFulfillment: row.pendingFulfillment
            }
        });
    });
});

app.get('/api/missions', async (req, res) => {
    try {
        const missions = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, mission, status, runner_task_id, execution_result, execution_error, dispatch_retry_after, dispatch_attempts, created_at
                 FROM pending_missions ORDER BY id DESC LIMIT 20`,
                [],
                (error, rows) => error ? reject(error) : resolve(rows)
            );
        });
        let runnerError = null;
        let runnerTasks = [];
        let runnerControl = null;
        let runnerExecutionMode = null;
        let runnerAvailable = false;

        for (const mission of missions.filter(item => item.status === 'pending'
            && (!item.dispatch_retry_after || Date.parse(item.dispatch_retry_after) <= Date.now()))) {
            try {
                await dispatchMissionToRunner(mission);
                mission.execution_error = null;
            } catch (error) {
                runnerError = error instanceof Error ? error.message : String(error);
                mission.execution_error = runnerError;
                await recordMissionDispatchFailure(mission, error);
                mission.dispatch_attempts = Number(mission.dispatch_attempts || 0) + 1;
            }
        }

        try {
            const runnerStatus = await getRunnerTasks();
            runnerTasks = runnerStatus.tasks;
            runnerControl = runnerStatus.control || null;
            runnerExecutionMode = runnerStatus.executionMode || null;
            runnerAvailable = true;
        } catch (error) {
            runnerError = error instanceof Error ? error.message : String(error);
        }

        const runnerTasksById = new Map(runnerTasks.map(task => [task.id, task]));
        for (const mission of missions) {
            const task = runnerTasksById.get(mission.runner_task_id)
                || runnerTasks.find(item => item.idempotencyKey === `chat:dashboard-mission-${mission.id}`);
            if (!task) continue;
            await syncMissionWithRunner(mission, task);
            mission.runner_task_id = task.id;
            mission.status = missionStatusFromTask(task);
            mission.execution_result = task.result == null ? null : JSON.stringify(task.result);
            mission.execution_error = typeof task.error === 'string' ? task.error : null;
        }

        res.json({
            success: true,
            runnerAvailable,
            runnerError,
            runnerControl,
            runnerControlAvailable: isDashboardAuthenticated(req),
            runnerExecutionMode,
            missions: missions.map(({ id, mission, status, runner_task_id, execution_result, execution_error, created_at }) => ({
                id,
                mission,
                status,
                runnerTaskId: runner_task_id,
                result: execution_result,
                error: execution_error,
                createdAt: created_at
            }))
        });
    } catch (error) {
        console.error('[MISSIONS] Status konnte nicht geladen werden:', error.message);
        res.status(500).json({ success: false, error: 'Missionen konnten nicht geladen werden.' });
    }
});

app.post('/api/runner/control', async (req, res) => {
    if (!isDashboardAuthenticated(req)) {
        return res.status(403).json({ success: false, error: 'Runner-Steuerung ist nur im authentifizierten Admin-Bereich verfügbar.' });
    }
    const action = req.body?.action;
    if (action !== 'pause' && action !== 'resume') {
        return res.status(400).json({ success: false, error: 'Aktion muss pause oder resume sein.' });
    }
    const auditId = randomUUID();
    const actor = req.dashboardActor || DASHBOARD_USERNAME || 'admin';
    try {
        await createRunnerControlAudit(auditId, actor, action);
        const response = await fetch(`${TASK_API_URL}/control`, {
            method: 'POST',
            headers: getTaskApiHeaders(),
            body: JSON.stringify({ action }),
            signal: AbortSignal.timeout(5000)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = data.error || `Runner-Steuerung fehlgeschlagen (HTTP ${response.status}).`;
            await writeRunnerControlAudit(auditId, 'failed', message.slice(0, 1000));
            return res.status(response.status === 400 || response.status === 409 ? response.status : 502)
                .json({ success: false, error: message });
        }
        await writeRunnerControlAudit(auditId, 'succeeded', JSON.stringify(data.control || {}));
        kernel.logAudit('RUNNER_CONTROL_CHANGED', `Runner wurde über den Admin-Bereich ${action === 'pause' ? 'pausiert' : 'fortgesetzt'}.`);
        return res.json({ success: true, control: data.control });
    } catch (error) {
        console.error('[RUNNER CONTROL] Steuerung fehlgeschlagen:', error.message);
        try {
            await writeRunnerControlAudit(auditId, 'failed', (error instanceof Error ? error.message : String(error)).slice(0, 1000));
        } catch (auditError) {
            console.error('[RUNNER CONTROL] Audit-Eintrag konnte nicht abgeschlossen werden:', auditError.message);
        }
        return res.status(503).json({ success: false, error: 'Runner-Steuerung ist derzeit nicht erreichbar.' });
    }
});

app.get('/api/audit-log', (req, res) => {
    if (!isDashboardAuthenticated(req)) {
        return res.status(403).json({ success: false, error: 'Audit-Protokoll ist nur im authentifizierten Admin-Bereich verfügbar.' });
    }
    db.all(`SELECT id, action, details, timestamp FROM (
                SELECT CAST(id AS TEXT) AS id, action, details, timestamp FROM audit_log
                UNION ALL
                SELECT id, 'RUNNER_CONTROL_' || result AS action,
                       'actor=' || actor || '; action=' || action || '; ' || details AS details,
                       created_at AS timestamp
                FROM runner_control_audit
            )
            ORDER BY timestamp DESC, id DESC LIMIT 100`,
    [], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, entries: rows });
    });
});

app.post('/api/kernel', (req, res) => {
    const { action } = req.body || {};
    try {
        if (action === 'generate_marketing') {
            const input = req.body || {};
            const allowedPlatforms = ['Instagram', 'TikTok', 'LinkedIn', 'X'];
            const platform = typeof input.platform === 'string' ? input.platform : 'LinkedIn';
            const industry = typeof input.industry === 'string' ? input.industry.trim() : '';
            const offer = typeof input.offer === 'string' ? input.offer.trim() : '';
            const audience = typeof input.audience === 'string' ? input.audience.trim() : '';
            if (!allowedPlatforms.includes(platform)) {
                return res.status(400).json({ success: false, error: 'Bitte wähle eine unterstützte Plattform.' });
            }
            if ([industry, offer, audience].some((value) => value.length > 120)) {
                return res.status(400).json({ success: false, error: 'Branche, Angebot und Zielgruppe dürfen jeweils höchstens 120 Zeichen lang sein.' });
            }
            kernel.generateMarketingDraft({ platform, industry, offer, audience }, (err, lastId) => {
                if (err) {
                    return res.status(500).json({ success: false, error: err.message });
                }
                res.json({ success: true, message: `Marketing-Entwurf ${lastId} für ${platform} erfolgreich erstellt.` });
            });
        } else if (action === 'submit_mission') {
            const mission = typeof req.body.mission === 'string' ? req.body.mission.trim() : '';
            if (!mission || mission.length > 4000) {
                return res.status(400).json({
                    success: false,
                    error: 'Die Mission muss zwischen 1 und 4.000 Zeichen lang sein.'
                });
            }
            db.run(`INSERT INTO pending_missions (mission) VALUES (?)`, [mission], function (err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                const submittedMission = { id: this.lastID, mission };
                kernel.logAudit('MISSION_SUBMITTED', `Mission ${submittedMission.id} in die lokale Warteschlange übernommen.`);
                dispatchMissionToRunner(submittedMission).then((task) => {
                    res.status(201).json({
                        success: true,
                        mission: { id: submittedMission.id, status: missionStatusFromTask(task) }
                    });
                }).catch((dispatchError) => {
                    const message = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
                    recordMissionDispatchFailure(submittedMission, dispatchError).then(() => {
                        res.status(202).json({
                            success: true,
                            dispatchError: message,
                            mission: { id: submittedMission.id, status: 'pending' }
                        });
                    }).catch((updateError) => {
                        console.error('[MISSIONS] Übergabefehler konnte nicht gespeichert werden:', updateError.message);
                        res.status(202).json({
                            success: true,
                            warning: 'Mission lokal gespeichert; Übergabefehler konnte nicht protokolliert werden.',
                            mission: { id: submittedMission.id, status: 'pending' }
                        });
                    });
                });
            });
        } else {
            res.status(400).json({ success: false, error: 'Unbekannte Kernel-Aktion.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/developer/task', async (req, res) => {
    if (process.env.AGENT_EXECUTION_MODE !== 'local') {
        return res.status(503).json({
            success: false,
            error: 'Lokale Developer-Tasks sind nur im deterministischen lokalen Ausführungsmodus verfügbar.',
        });
    }

    try {
        const task = await submitDeveloperTask(req.body || {}, async (command) => {
            const response = await fetch(`${TASK_API_URL}/tasks`, {
                method: 'POST',
                headers: getTaskApiHeaders(),
                body: JSON.stringify({
                    message: command,
                    targetAgent: 'master-orchestrator',
                    clientRequestId: `developer-${randomUUID()}`,
                }),
                signal: AbortSignal.timeout(5000),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.task || typeof data.task.id !== 'string') {
                const error = new Error(data.error || `Übergabe an die lokale Task-Queue fehlgeschlagen (HTTP ${response.status}).`);
                error.statusCode = response.status === 400 ? 400 : 503;
                throw error;
            }
            return data.task;
        });
        res.status(202).json({
            success: true,
            task,
            mode: 'local-deterministic',
            externalModelCalls: false,
        });
    } catch (error) {
        const status = Number.isSafeInteger(error.statusCode) ? error.statusCode : 500;
        if (status >= 500) {
            console.error('[DEVELOPER AGENT] Lokale Task-Übergabe fehlgeschlagen:', error.message);
        }
        res.status(status).json({
            success: false,
            error: error instanceof Error ? error.message : 'Lokale Task konnte nicht übergeben werden.',
        });
    }
});

function startRunnerProcess() {
    if (process.env.RUN_AGENT_WORKER !== 'true' || shuttingDown || runnerProcess) return;
    const compiledRunnerEntry = path.resolve(__dirname, '../dist/runAgentLoop.mjs');
    const runnerEntry = fs.existsSync(compiledRunnerEntry)
        ? compiledRunnerEntry
        : path.join(__dirname, 'runAgentLoop.ts');
    const runnerArgs = runnerEntry.endsWith('.mjs')
        ? [runnerEntry]
        : ['--import', 'tsx', runnerEntry];
    runnerProcess = spawn(process.execPath, runnerArgs, {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
        stdio: 'inherit'
    });
    console.log(`[RUNNER] Starte internen Worker (PID ${runnerProcess.pid ?? 'wird zugewiesen'}).`);
    runnerProcess.once('error', (error) => {
        console.error('[RUNNER] Prozess konnte nicht gestartet werden:', error.message);
    });
    runnerProcess.once('close', (code, signal) => {
        runnerProcess = null;
        if (shuttingDown) return;
        runnerRestartCount += 1;
        const delay = Math.min(60_000, 5_000 * (2 ** Math.min(runnerRestartCount - 1, 4)));
        console.error(`[RUNNER] Prozess beendet (Code ${code ?? 'n/a'}, Signal ${signal ?? 'n/a'}); Neustart in ${delay} ms.`);
        runnerRestartTimer = setTimeout(startRunnerProcess, delay);
    });
}

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Enterprise Agent OS läuft auf http://localhost:${PORT}`);
    void retryPendingMissions();
    startRunnerProcess();
});

const dispatchRetryTimer = setInterval(() => { void retryPendingMissions(); }, DISPATCH_RETRY_INTERVAL_MS);
dispatchRetryTimer.unref();

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(dispatchRetryTimer);
    clearTimeout(runnerRestartTimer);
    const closeServer = () => server.close(() => db.close());
    if (!runnerProcess) {
        closeServer();
        return;
    }

    const activeRunner = runnerProcess;
    const forceStopTimer = setTimeout(() => activeRunner.kill('SIGKILL'), 5_000);
    activeRunner.once('close', () => {
        clearTimeout(forceStopTimer);
        closeServer();
    });
    activeRunner.kill('SIGTERM');
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
