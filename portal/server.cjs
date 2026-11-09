'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const sqlite3 = require('sqlite3');
const { generateLocalContent } = require('./local-generation.cjs');
const Stripe = require('stripe');
const { getStripeProducts } = require('../src/stripeCatalog.cjs');

const scrypt = promisify(crypto.scrypt);
const app = express();
const port = Number(process.env.PORT || 3200);
const databasePath = process.env.PORTAL_DATABASE_PATH || path.join(__dirname, 'data', 'portal.sqlite');
const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;
const failedAuthLimit = 10;
const failedAuthWindowMs = 15 * 60 * 1000;
const apiRateLimit = Number(process.env.PORTAL_API_RATE_LIMIT || 240);
const llmRateLimit = Number(process.env.PORTAL_LLM_RATE_LIMIT || 8);
const monthlyTokenLimit = Number(process.env.PORTAL_MONTHLY_TOKEN_LIMIT || 50_000);
const premiumMonthlyTokenLimit = Number(process.env.PORTAL_PREMIUM_MONTHLY_TOKEN_LIMIT || 200_000);
const errorRetentionDays = Number(process.env.PORTAL_ERROR_RETENTION_DAYS || 90);
const llmMaxCompletionTokens = 1200;
const socialDraftCompletionTokens = 1200;
const industryProfiles = {
    gastronomy: {
        label: 'Gastronomie',
        metrics: ['Wareneinsatzquote', 'verkaufte Portionen pro Öffnungstag', 'Wiederkehrrate'],
        validationSteps: ['Kleine Karte mit klar begrenztem Angebot testen', 'Bezahlte Vorbestellungen oder Tischreservierungen messen', 'Wareneinsatz und Ausschuss pro Testwoche erfassen'],
    },
    craft: {
        label: 'Handwerk',
        metrics: ['Angebotsannahmequote', 'Deckungsbeitrag je Auftrag', 'Durchlaufzeit bis zur Abnahme'],
        validationSteps: ['Eng umrissene Leistung mit Festpreis kalkulieren', 'Angebote an passende lokale Interessenten senden', 'Arbeitszeit, Material und Nacharbeit je Auftrag erfassen'],
    },
    ecommerce: {
        label: 'E-Commerce',
        metrics: ['Conversion-Rate', 'Deckungsbeitrag nach Versand und Retouren', 'Retourenquote'],
        validationSteps: ['Kleine Produktcharge oder Vorbestellung testen', 'Conversion und Warenkorbabbruch messen', 'Versand-, Zahlungs- und Retourenkosten je Bestellung erfassen'],
    },
    services: {
        label: 'Dienstleistung',
        metrics: ['Konversion qualifizierter Gespräche zu bezahlten Piloten', 'abrechenbare Auslastung', 'Deckungsbeitrag je Projektstunde'],
        validationSteps: ['Leistungsumfang und Kapazitätsgrenze schriftlich festlegen', 'Bezahlten Pilot mit klarer Abnahme anbieten', 'Aufwand, Nacharbeit und Wiederbuchungen dokumentieren'],
    },
    software: {
        label: 'Software / SaaS',
        metrics: ['Aktivierung zum ersten messbaren Nutzen', 'Nutzerbindung nach 30 Tagen', 'CAC-Amortisationsdauer'],
        validationSteps: ['Klickbaren oder manuellen MVP mit wenigen Testkunden prüfen', 'Aktivierung und wiederholte Nutzung instrumentieren', 'Support-, Infrastruktur- und Akquisekosten je Kunde erfassen'],
    },
    other: {
        label: 'Andere Branche',
        metrics: ['Konversion qualifizierter Interviews zu bezahlten Piloten', 'Deckungsbeitrag je Verkauf', 'Wiederkaufs- oder Empfehlungsrate'],
        validationSteps: ['Problem mit mindestens zehn passenden Personen überprüfen', 'Einen begrenzten bezahlten Pilot anbieten', 'Erlöse, Vollkosten und Abbruchgründe dokumentieren'],
    },
};
const socialPlatforms = {
    instagram: { label: 'Instagram', maxLength: 2200 },
    facebook: { label: 'Facebook', maxLength: 2000 },
    tiktok: { label: 'TikTok', maxLength: 2200 },
    linkedin: { label: 'LinkedIn', maxLength: 3000 },
    x: { label: 'X', maxLength: 280 },
};
const marketBenchmarkUrl = process.env.PORTAL_MARKET_DATA_URL?.trim() || '';
const marketBenchmarkToken = process.env.PORTAL_MARKET_DATA_TOKEN?.trim() || '';
const taxProfiles = parseTaxProfiles(process.env.PORTAL_TAX_PROFILES_JSON || '[]');
if (process.env.PORTAL_STRIPE_CONNECT_ENABLED === 'true') {
    throw new Error('Stripe Connect ist noch nicht freigabefähig; Onboarding und Zahlungsflüsse sind deaktiviert.');
}
if (marketBenchmarkUrl) {
    const url = new URL(marketBenchmarkUrl);
    if (!['https:', ...(process.env.NODE_ENV === 'test' ? ['http:'] : [])].includes(url.protocol)
        || url.username || url.password || url.hash
        || (process.env.NODE_ENV !== 'test' && (!url.hostname.includes('.') || url.hostname === 'localhost'))) {
        throw new Error('PORTAL_MARKET_DATA_URL muss eine öffentliche HTTPS-URL ohne Zugangsdaten sein.');
    }
}
if (!Number.isSafeInteger(apiRateLimit) || apiRateLimit < 1 || apiRateLimit > 100_000
    || !Number.isSafeInteger(llmRateLimit) || llmRateLimit < 1 || llmRateLimit > 10_000
    || !Number.isSafeInteger(monthlyTokenLimit) || monthlyTokenLimit < 1 || monthlyTokenLimit > 100_000_000
    || !Number.isSafeInteger(premiumMonthlyTokenLimit) || premiumMonthlyTokenLimit < monthlyTokenLimit || premiumMonthlyTokenLimit > 100_000_000
    || !Number.isSafeInteger(errorRetentionDays) || errorRetentionDays < 1 || errorRetentionDays > 3650) {
    throw new Error('Portal-Limits und Error-Retention müssen positive, begrenzte Ganzzahlen sein.');
}
const stripe = /^sk_(test|live)_[A-Za-z0-9]+$/.test(process.env.STRIPE_SECRET_KEY || '')
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new sqlite3.Database(databasePath);
db.configure('busyTimeout', 10_000);

let writeTail = Promise.resolve();

async function serializeWrite(work) {
    const previous = writeTail;
    let release;
    writeTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
        return await work();
    } finally {
        release();
    }
}

function run(sql, ...params) {
    return serializeWrite(() => new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    }));
}

function get(sql, ...params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row);
        });
    });
}

function all(sql, ...params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows);
        });
    });
}

function connectionRun(connection, sql, ...params) {
    return new Promise((resolve, reject) => {
        connection.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function connectionGet(connection, sql, ...params) {
    return new Promise((resolve, reject) => {
        connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function connectionAll(connection, sql, ...params) {
    return new Promise((resolve, reject) => {
        connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function transaction(work) {
    return serializeWrite(() => runTransaction(work));
}

async function runTransaction(work) {
    const connection = new sqlite3.Database(databasePath);
    connection.configure('busyTimeout', 10_000);
    try {
        await connectionRun(connection, 'PRAGMA foreign_keys = ON');
        await connectionRun(connection, 'BEGIN IMMEDIATE');
        try {
            const result = await work({
                run: (sql, ...params) => connectionRun(connection, sql, ...params),
                get: (sql, ...params) => connectionGet(connection, sql, ...params),
                all: (sql, ...params) => connectionAll(connection, sql, ...params),
            });
            await connectionRun(connection, 'COMMIT');
            return result;
        } catch (error) {
            await connectionRun(connection, 'ROLLBACK').catch(rollbackError => {
                console.error('[Portal] Rollback fehlgeschlagen:', rollbackError.message);
            });
            throw error;
        }
    } finally {
        await new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve()));
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function clientIp(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimit(scope, limit, windowMs, keyForRequest) {
    return async (req, res, next) => {
        const key = keyForRequest(req);
        const now = Date.now();
        try {
            await run(
                `INSERT INTO portal_rate_limits(scope, rate_key, window_started_at, request_count)
                 VALUES (?, ?, ?, 1)
                 ON CONFLICT(scope, rate_key) DO UPDATE SET
                    request_count = CASE
                        WHEN portal_rate_limits.window_started_at <= ? THEN 1
                        ELSE portal_rate_limits.request_count + 1
                    END,
                    window_started_at = CASE
                        WHEN portal_rate_limits.window_started_at <= ? THEN excluded.window_started_at
                        ELSE portal_rate_limits.window_started_at
                    END`,
                scope, key, now, now - windowMs, now - windowMs,
            );
            const state = await get(
                'SELECT request_count FROM portal_rate_limits WHERE scope = ? AND rate_key = ?',
                scope, key,
            );
            if (state.request_count > limit) {
                res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
                res.status(429).json({ error: 'Zu viele Anfragen. Bitte spaeter erneut versuchen.' });
                return;
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}

async function monthlyTokenLimitForUser(userId) {
    const entitlement = await get(
        `SELECT product_id FROM portal_access_grants WHERE user_id = ? AND revoked_at IS NULL
         UNION ALL
         SELECT product_id FROM portal_entitlements WHERE user_id = ?
           AND NOT EXISTS (
               SELECT 1 FROM portal_access_grants
               WHERE user_id = portal_entitlements.user_id
                 AND product_id = portal_entitlements.product_id
           )
         LIMIT 1`,
        userId, userId,
    );
    return entitlement ? premiumMonthlyTokenLimit : monthlyTokenLimit;
}

function getPublicBaseUrl() {
    const value = process.env.PUBLIC_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : `http://localhost:${port}`);
    if (!value) throw new Error('PUBLIC_BASE_URL ist nicht konfiguriert.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
        throw new Error('PUBLIC_BASE_URL muss eine gültige öffentliche HTTPS-URL ohne Zugangsdaten sein.');
    }
    return url.origin;
}

async function sendPortalEmail(email, subject, textContent, htmlContent) {
    const apiKey = process.env.BREVO_API_KEY?.trim();
    const senderEmail = (process.env.SENDER_EMAIL || process.env.EMAIL_FROM || '').trim();
    const senderName = (process.env.SENDER_NAME || 'NaturVitale').trim();
    if (!apiKey || !senderEmail) {
        throw new Error('E-Mail-Versand ist nicht konfiguriert (BREVO_API_KEY und SENDER_EMAIL erforderlich).');
    }
    const endpoint = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== 'https:' && process.env.NODE_ENV !== 'test') {
        throw new Error('BREVO_API_URL muss HTTPS verwenden.');
    }
    const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'api-key': apiKey,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            sender: { email: senderEmail, name: senderName },
            to: [{ email }],
            subject,
            textContent,
            htmlContent,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        const details = (await response.text()).slice(0, 300);
        throw new Error(`Brevo E-Mail-Versand fehlgeschlagen (HTTP ${response.status}): ${details}`);
    }
}

async function createEmailToken(userId, purpose, email) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + (purpose === 'password_reset' ? 30 : 60) * 60 * 1000;
    await run(
        'INSERT INTO portal_user_tokens(token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
        hashToken(token), userId, purpose, expiresAt, Date.now(),
    );
    const url = new URL(purpose === 'email_verification' ? '/verify-email' : '/reset-password', getPublicBaseUrl());
    url.searchParams.set('token', token);
    const link = url.toString();
    const label = purpose === 'email_verification' ? 'E-Mail-Adresse bestätigen' : 'Passwort zurücksetzen';
    await sendPortalEmail(
        email,
        purpose === 'email_verification' ? 'Bitte bestätige deine E-Mail-Adresse' : 'Passwort zurücksetzen',
        `${label}: ${link}\n\nDer Link ist ${purpose === 'email_verification' ? '60' : '30'} Minuten gültig. Falls du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.`,
        `<p><a href="${link}">${label}</a></p><p>Der Link ist ${purpose === 'email_verification' ? '60' : '30'} Minuten gültig. Falls du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.</p>`,
    );
}

function logPortalError(error, req, userId = null) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const stack = error instanceof Error ? (error.stack || '').slice(0, 4000) : '';
    const requestPath = `${req.method} ${req.path}`.slice(0, 300);
    run(
        'INSERT INTO portal_error_events(user_id, request_path, message, stack, created_at) VALUES (?, ?, ?, ?, ?)',
        userId, requestPath, message, stack, Date.now(),
    ).catch(loggingError => console.error('[Portal] Fehler konnte nicht protokolliert werden:', loggingError.message));
    console.error('[Portal]', { requestPath, userId, message });
}

function getCookie(req, name) {
    const cookieHeader = req.get('cookie') || '';
    const prefix = `${name}=`;
    const entry = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    const token = entry ? entry.slice(prefix.length) : '';
    return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function enforceSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (!origin) {
        next();
        return;
    }

    try {
        if (new URL(origin).host === req.get('host')) {
            next();
            return;
        }
    } catch {
        // Reject malformed origins below.
    }
    res.status(403).json({ error: 'Ungueltige Herkunft der Anfrage.' });
}

async function loadUser(req, _res, next) {
    try {
        const token = getCookie(req, 'nv_portal_session');
        if (token) {
            req.portalUser = await get(
                `SELECT users.id, users.email, users.email_verified_at, users.created_at
                 FROM portal_sessions
                 JOIN portal_users AS users ON users.id = portal_sessions.user_id
                 WHERE portal_sessions.token_hash = ? AND portal_sessions.expires_at > ?`,
                hashToken(token),
                Date.now()
            );
        }
        next();
    } catch (error) {
        next(error);
    }
}

function requireUser(req, res, next) {
    if (!req.portalUser) {
        res.status(401).json({ error: 'Bitte melde dich an.' });
        return;
    }
    if (!req.portalUser.email_verified_at) {
        res.status(403).json({ error: 'Bitte bestätige zuerst deine E-Mail-Adresse.' });
        return;
    }
    next();
}

async function createSession(userId, res) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + sessionLifetimeMs;
    await run('INSERT INTO portal_sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)',
        hashToken(token), userId, expiresAt);
    res.cookie('nv_portal_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: sessionLifetimeMs,
    });
}

function normalizeIdeaInput(body) {
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
    const audience = typeof body?.audience === 'string' ? body.audience.trim() : '';
    const strengths = typeof body?.strengths === 'string' ? body.strengths.trim() : '';
    const marketCountry = typeof body?.marketCountry === 'string' ? body.marketCountry.trim() : '';
    const currency = typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    const industry = typeof body?.industry === 'string' ? body.industry.trim() : '';
    const unitPrice = parseAmount(body?.unitPrice);
    const expectedMonthlySales = parseAmount(body?.expectedMonthlySales);
    const variableCostPerSale = parseAmount(body?.variableCostPerSale);
    const monthlyFixedCosts = parseAmount(body?.monthlyFixedCosts);
    const currencyScale = getCurrencyScale(currency);
    if (topic.length < 3 || topic.length > 120 || audience.length > 120 || strengths.length > 120
        || marketCountry.length < 2 || marketCountry.length > 100 || !currencyScale
        || !Object.hasOwn(industryProfiles, industry)
        || unitPrice === null || unitPrice <= 0 || unitPrice > 1_000_000
        || !Number.isSafeInteger(expectedMonthlySales) || expectedMonthlySales < 1 || expectedMonthlySales > 100_000
        || variableCostPerSale === null || variableCostPerSale < 0 || variableCostPerSale > 1_000_000
        || monthlyFixedCosts === null || monthlyFixedCosts < 0 || monthlyFixedCosts > 1_000_000) {
        return null;
    }
    const moneyInputs = [unitPrice, variableCostPerSale, monthlyFixedCosts]
        .map(value => toMinorUnits(value, currencyScale));
    if (moneyInputs.some(value => value === null) || moneyInputs[0] <= 0) return null;
    return {
        topic,
        audience: audience || 'Menschen mit einem konkreten Bedarf',
        strengths: strengths || 'Fachwissen und persoenliche Umsetzung',
        marketCountry,
        currency,
        industry,
        unitPriceMinor: moneyInputs[0],
        expectedMonthlySales,
        variableCostPerSaleMinor: moneyInputs[1],
        monthlyFixedCostsMinor: moneyInputs[2],
    };
}

function parseAmount(value) {
    if ((typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && !value.trim())) return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function getCurrencyScale(currency) {
    if (!/^[A-Z]{3}$/.test(currency)) return null;
    if (!Intl.supportedValuesOf('currency').includes(currency)) return null;
    try {
        const digits = new Intl.NumberFormat('en', { style: 'currency', currency })
            .resolvedOptions().maximumFractionDigits;
        return 10 ** digits;
    } catch {
        return null;
    }
}

function toMinorUnits(amount, currencyScale) {
    const minorUnits = Math.round(amount * currencyScale);
    return Number.isSafeInteger(minorUnits) ? minorUnits : null;
}

function fromMinorUnits(amount, currencyScale) {
    const digits = Math.log10(currencyScale);
    return Number((amount / currencyScale).toFixed(digits));
}

function buildBusinessCase(input) {
    const currencyScale = getCurrencyScale(input.currency);
    const industry = industryProfiles[input.industry];
    const taxProfile = taxProfiles.find(profile => profile.country.toLowerCase() === input.marketCountry.toLowerCase()) || null;
    const unitMarginMinor = input.unitPriceMinor - input.variableCostPerSaleMinor;
    const monthlyRevenueMinor = input.unitPriceMinor * input.expectedMonthlySales;
    const monthlyVariableCostsMinor = input.variableCostPerSaleMinor * input.expectedMonthlySales;
    const monthlyResultMinor = monthlyRevenueMinor - monthlyVariableCostsMinor - input.monthlyFixedCostsMinor;
    return {
        marketCountry: input.marketCountry,
        currency: input.currency,
        industry: input.industry,
        industryLabel: industry.label,
        industryMetrics: industry.metrics,
        taxProfile: taxProfile
            ? {
                status: 'reference_only',
                vatRatePercent: taxProfile.vatRatePercent,
                verifiedAt: taxProfile.verifiedAt,
                verifiedBy: taxProfile.verifiedBy,
                sourceUrl: taxProfile.sourceUrl,
            }
            : { status: 'not_configured' },
        paymentMode: 'manual_recording',
        assumptions: {
            unitPrice: fromMinorUnits(input.unitPriceMinor, currencyScale),
            expectedMonthlySales: input.expectedMonthlySales,
            variableCostPerSale: fromMinorUnits(input.variableCostPerSaleMinor, currencyScale),
            monthlyFixedCosts: fromMinorUnits(input.monthlyFixedCostsMinor, currencyScale),
        },
        monthlyProjection: {
            revenue: fromMinorUnits(monthlyRevenueMinor, currencyScale),
            variableCosts: fromMinorUnits(monthlyVariableCostsMinor, currencyScale),
            fixedCosts: fromMinorUnits(input.monthlyFixedCostsMinor, currencyScale),
            operatingResultBeforeTax: fromMinorUnits(monthlyResultMinor, currencyScale),
            breakEvenMonthlySales: unitMarginMinor > 0
                ? Math.ceil(input.monthlyFixedCostsMinor / unitMarginMinor)
                : null,
        },
        taxStatus: 'not_calculated',
    };
}

function getValidationActionTitles(idea) {
    const candidates = Array.isArray(idea?.industryValidationSteps) && idea.industryValidationSteps.length
        ? idea.industryValidationSteps
        : idea?.firstSteps;
    if (!Array.isArray(candidates)) return [];
    return candidates
        .filter(step => typeof step === 'string' && step.trim())
        .slice(0, 5)
        .map(step => step.trim().slice(0, 300));
}

async function ensureIdeaValidationActions(tx, ideaId, userId, idea) {
    const existing = await tx.get(
        'SELECT COUNT(*) AS count FROM portal_idea_actions WHERE idea_id = ? AND user_id = ?',
        ideaId, userId,
    );
    if (existing.count > 0) return;
    const now = Date.now();
    for (const [position, actionText] of getValidationActionTitles(idea).entries()) {
        await tx.run(
            `INSERT OR IGNORE INTO portal_idea_actions
                (idea_id, user_id, position, action_text, status, result_note, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'todo', '', ?, ?)`,
            ideaId, userId, position, actionText, now, now,
        );
    }
}

function parseTaxProfiles(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new Error(`PORTAL_TAX_PROFILES_JSON ist ungültiges JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length > 100) {
        throw new Error('PORTAL_TAX_PROFILES_JSON muss ein Array mit höchstens 100 geprüften Profilen sein.');
    }
    const countries = new Set();
    return parsed.map(profile => {
        const country = typeof profile?.country === 'string' ? profile.country.trim() : '';
        const verifiedBy = typeof profile?.verifiedBy === 'string' ? profile.verifiedBy.trim() : '';
        const sourceUrl = typeof profile?.sourceUrl === 'string' ? profile.sourceUrl.trim() : '';
        const verifiedAt = typeof profile?.verifiedAt === 'string' ? profile.verifiedAt : '';
        const vatRatePercent = profile?.vatRatePercent;
        let parsedUrl;
        try {
            parsedUrl = new URL(sourceUrl);
        } catch {
            parsedUrl = null;
        }
        const countryKey = country.toLowerCase();
        if (!country || country.length > 100 || countries.has(countryKey)
            || !Number.isFinite(vatRatePercent) || vatRatePercent < 0 || vatRatePercent > 100
            || !verifiedBy || verifiedBy.length > 120 || !Number.isFinite(Date.parse(verifiedAt))
            || !parsedUrl || parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
            throw new Error('Jedes Steuerprofil benötigt ein eindeutiges Land, einen Satz von 0 bis 100 %, Prüfdatum, Prüfstelle und HTTPS-Quelle.');
        }
        countries.add(countryKey);
        return { country, vatRatePercent, verifiedAt, verifiedBy, sourceUrl: parsedUrl.toString() };
    });
}

function normalizeWorkflowInput(body) {
    const goal = typeof body?.goal === 'string' ? body.goal.trim() : '';
    const audience = typeof body?.audience === 'string' ? body.audience.trim() : '';
    const constraints = typeof body?.constraints === 'string' ? body.constraints.trim() : '';
    if (goal.length < 3 || goal.length > 300 || audience.length > 120 || constraints.length > 300) {
        return null;
    }
    return {
        goal,
        audience: audience || 'Noch nicht festgelegt',
        constraints: constraints || 'Einfacher manueller Ablauf ohne externe Aktionen',
    };
}

function isStringList(value, minLength, maxLength, itemMaxLength) {
    return Array.isArray(value)
        && value.length >= minLength
        && value.length <= maxLength
        && value.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= itemMaxLength);
}

async function generateStructuredContent(name, systemPrompt, input, schema, maxCompletionTokens = llmMaxCompletionTokens) {
    return {
        result: generateLocalContent(name, input),
        totalTokens: 0,
    };
}

async function generateIdea(input) {
    const industry = industryProfiles[input.industry];
    const generated = await generateStructuredContent(
        'portal_business_idea',
        `Du bist Stella, der KI-Agent für Geschäftsideen im Natur-Vitale-Portal. Erstelle einen konkreten, überprüfbaren Entwurf auf Deutsch für das vom Nutzer genannte Land und die Branche ${industry.label}. Nutze passende Branchenbegriffe, Kennzahlen und nächste Schritte, aber erfinde keine Markt- oder Umsatzdaten und behaupte keine Recherche. Preise und Verkäufe sind nur die separat berechneten Nutzereingaben. Keine garantierten Einnahmen, Heilversprechen oder externen Aktionen.`,
        {
            topic: input.topic,
            audience: input.audience,
            strengths: input.strengths,
            marketCountry: input.marketCountry,
            currency: input.currency,
            industry: industry.label,
            industryMetrics: industry.metrics,
            validationSteps: industry.validationSteps,
        },
        {
            type: 'object',
            additionalProperties: false,
            required: [
                'title', 'summary', 'businessModel', 'customerProfile', 'valueProposition',
                'validationMetric', 'offerTitle', 'offerDescription', 'offerDeliverables', 'firstSteps',
            ],
            properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                businessModel: { type: 'string' },
                customerProfile: { type: 'string' },
                valueProposition: { type: 'string' },
                validationMetric: { type: 'string' },
                offerTitle: { type: 'string' },
                offerDescription: { type: 'string' },
                offerDeliverables: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
                firstSteps: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
            },
        },
    );
    const result = generated.result;
    if (typeof result.title !== 'string' || !result.title.trim() || result.title.length > 120
        || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 1200
        || typeof result.businessModel !== 'string' || !result.businessModel.trim() || result.businessModel.length > 500
        || typeof result.customerProfile !== 'string' || !result.customerProfile.trim() || result.customerProfile.length > 500
        || typeof result.valueProposition !== 'string' || !result.valueProposition.trim() || result.valueProposition.length > 500
        || typeof result.validationMetric !== 'string' || !result.validationMetric.trim() || result.validationMetric.length > 300
        || typeof result.offerTitle !== 'string' || !result.offerTitle.trim() || result.offerTitle.length > 120
        || typeof result.offerDescription !== 'string' || !result.offerDescription.trim() || result.offerDescription.length > 700
        || !isStringList(result.offerDeliverables, 2, 4, 200)
        || !isStringList(result.firstSteps, 3, 5, 300)) {
        throw new Error('Die lokale Vorlage entspricht nicht dem erwarteten Ideenformat.');
    }
    return {
        totalTokens: generated.totalTokens,
        output: {
            title: result.title.trim(),
            summary: result.summary.trim(),
            businessModel: result.businessModel.trim(),
            customerProfile: result.customerProfile.trim(),
            valueProposition: result.valueProposition.trim(),
            validationMetric: result.validationMetric.trim(),
            offerDraft: {
                title: result.offerTitle.trim(),
                description: result.offerDescription.trim(),
                deliverables: result.offerDeliverables.map(item => item.trim()),
            },
            firstSteps: result.firstSteps.map(step => step.trim()),
            generationMethod: 'local_template',
            industryValidationSteps: industry.validationSteps,
            commercialCase: buildBusinessCase(input),
            executionPolicy: 'Entwurf: keine externe Aktion, Zahlung oder automatische Ausfuehrung wurde gestartet.',
        },
    };
}

function normalizeSocialPlatforms(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3
        || !value.every(platform => typeof platform === 'string' && Object.hasOwn(socialPlatforms, platform))
        || new Set(value).size !== value.length) return null;
    return value;
}

function validateMarketBenchmarks(value, country, industry) {
    const source = typeof value?.source === 'string' ? value.source.trim() : '';
    const sourceUrl = typeof value?.sourceUrl === 'string' ? value.sourceUrl.trim() : '';
    const asOf = typeof value?.asOf === 'string' ? value.asOf : '';
    const responseCountry = typeof value?.country === 'string' ? value.country.trim() : '';
    const responseIndustry = typeof value?.industry === 'string' ? value.industry.trim() : '';
    const metrics = value?.metrics;
    let parsedSourceUrl;
    try {
        parsedSourceUrl = new URL(sourceUrl);
    } catch {
        parsedSourceUrl = null;
    }
    if (!responseCountry || responseCountry.toLowerCase() !== country.toLowerCase()
        || !responseIndustry || responseIndustry.toLowerCase() !== industry.toLowerCase()
        || !source || source.length > 200 || !parsedSourceUrl || parsedSourceUrl.protocol !== 'https:'
        || parsedSourceUrl.username || parsedSourceUrl.password || !Number.isFinite(Date.parse(asOf))
        || !Array.isArray(metrics) || metrics.length < 1 || metrics.length > 20) {
        throw new Error('Der Marktdatenanbieter lieferte keine gültigen Herkunfts- und Kennzahldaten.');
    }
    const normalizedMetrics = metrics.map(metric => {
        const name = typeof metric?.name === 'string' ? metric.name.trim() : '';
        const unit = typeof metric?.unit === 'string' ? metric.unit.trim() : '';
        const value = metric?.value;
        const sampleSize = metric?.sampleSize ?? null;
        if (!name || name.length > 120 || !unit || unit.length > 40
            || (typeof value !== 'number' && typeof value !== 'string')
            || (typeof value === 'number' && !Number.isFinite(value))
            || (typeof value === 'string' && (!value.trim() || value.length > 120))
            || (sampleSize !== null && (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 1_000_000_000))) {
            throw new Error('Der Marktdatenanbieter lieferte eine ungültige Kennzahl.');
        }
        return { name, value, unit, sampleSize };
    });
    return {
        country,
        industry,
        source,
        sourceUrl: parsedSourceUrl.toString(),
        asOf: new Date(asOf).toISOString(),
        metrics: normalizedMetrics,
        provenance: 'external_provider',
        disclaimer: 'Externe Stichprobe, keine Umsatzprognose. Quelle, Aktualität und Eignung vor Geschäftsentscheidungen prüfen.',
    };
}

async function fetchMarketBenchmarks(country, industry) {
    if (!marketBenchmarkUrl) {
        const error = new Error('Es ist kein geprüfter Marktdatenanbieter konfiguriert.');
        error.statusCode = 503;
        throw error;
    }
    const url = new URL(marketBenchmarkUrl);
    url.searchParams.set('country', country);
    url.searchParams.set('industry', industry);
    const response = await fetch(url, {
        headers: {
            accept: 'application/json',
            ...(marketBenchmarkToken ? { authorization: `Bearer ${marketBenchmarkToken}` } : {}),
        },
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
        const error = new Error(`Marktdatenanbieter antwortete mit HTTP ${response.status}.`);
        error.statusCode = 502;
        throw error;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
        const error = new Error('Marktdatenanbieter lieferte kein JSON.');
        error.statusCode = 502;
        throw error;
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 32_768) {
        const error = new Error('Antwort des Marktdatenanbieters ist zu groß.');
        error.statusCode = 502;
        throw error;
    }
    let payload;
    try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Marktdatenanbieter lieferte keinen Antwortinhalt.');
        const chunks = [];
        let byteLength = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > 32_768) {
                await reader.cancel();
                throw new Error('Antwort des Marktdatenanbieters ist zu groß.');
            }
            chunks.push(Buffer.from(value));
        }
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        error.statusCode = 502;
        throw error;
    }
    return validateMarketBenchmarks(payload, country, industry);
}

async function generateSocialDrafts(idea, platforms) {
    const generated = await generateStructuredContent(
        'portal_social_drafts',
        'Du bist eine vorsichtige Marketing-Redaktion. Erstelle für die angefragten Plattformen jeweils einen plattformgerechten Social-Media-Entwurf und separate Werbe-Copy auf Deutsch. Nutze nur belegte Angaben aus der Geschäftsidee; erfinde keine Preise, Produktmerkmale, Kundenstimmen, Marktbehauptungen, Garantien oder Heilversprechen. Keine Veröffentlichung oder externe Aktion ausführen.',
        {
            idea: {
                title: idea.title,
                summary: idea.summary,
                industry: idea.commercialCase?.industryLabel,
                audience: idea.customerProfile,
                valueProposition: idea.valueProposition,
                offer: idea.offerDraft,
                marketCountry: idea.commercialCase?.marketCountry,
            },
            platforms: platforms.map(platform => ({
                id: platform,
                label: socialPlatforms[platform].label,
                maximumPostLength: socialPlatforms[platform].maxLength,
            })),
        },
        {
            type: 'object',
            additionalProperties: false,
            required: ['drafts'],
            properties: {
                drafts: {
                    type: 'array',
                    minItems: platforms.length,
                    maxItems: platforms.length,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['platform', 'post', 'adHeadline', 'adCopy', 'callToAction'],
                        properties: {
                            platform: { type: 'string', enum: platforms },
                            post: { type: 'string' },
                            adHeadline: { type: 'string' },
                            adCopy: { type: 'string' },
                            callToAction: { type: 'string' },
                        },
                    },
                },
            },
        },
        socialDraftCompletionTokens,
    );
    const drafts = generated.result.drafts;
    if (!Array.isArray(drafts) || drafts.length !== platforms.length
        || new Set(drafts.map(draft => draft.platform)).size !== platforms.length
        || !platforms.every(platform => drafts.some(draft => draft.platform === platform))
        || drafts.some(draft => !Object.hasOwn(socialPlatforms, draft.platform)
            || typeof draft.post !== 'string' || !draft.post.trim()
            || draft.post.length > socialPlatforms[draft.platform].maxLength
            || typeof draft.adHeadline !== 'string' || !draft.adHeadline.trim() || draft.adHeadline.length > 120
            || typeof draft.adCopy !== 'string' || !draft.adCopy.trim() || draft.adCopy.length > 1000
            || typeof draft.callToAction !== 'string' || !draft.callToAction.trim() || draft.callToAction.length > 120)) {
        throw new Error('Die lokale Vorlage entspricht nicht dem erwarteten Social-Draft-Format.');
    }
    return {
        totalTokens: generated.totalTokens,
        output: drafts.map(draft => ({
            platform: draft.platform,
            platformLabel: socialPlatforms[draft.platform].label,
            post: draft.post.trim(),
            adHeadline: draft.adHeadline.trim(),
            adCopy: draft.adCopy.trim(),
            callToAction: draft.callToAction.trim(),
            status: 'draft',
            approvalRequired: true,
            generationMethod: 'local_template',
        })),
    };
}

async function generateWorkflow(input) {
    const generated = await generateStructuredContent(
        'portal_business_workflow',
        'Du bist Stella, der KI-Agent für manuelle Geschäftsabläufe im Natur-Vitale-Portal. Erstelle auf Deutsch einen konkreten, nachvollziehbaren Workflow. Keine externen Aktionen ausführen, keine Zugangsdaten verlangen und vor jeder späteren Automatisierung menschliche Freigabe vorsehen.',
        input,
        {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'summary', 'steps', 'successMetric', 'approvalBoundary'],
            properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                steps: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 7 },
                successMetric: { type: 'string' },
                approvalBoundary: { type: 'string' },
            },
        },
    );
    const result = generated.result;
    if (typeof result.title !== 'string' || !result.title.trim() || result.title.length > 120
        || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 1200
        || !isStringList(result.steps, 3, 7, 300)
        || typeof result.successMetric !== 'string' || !result.successMetric.trim() || result.successMetric.length > 300
        || typeof result.approvalBoundary !== 'string' || !result.approvalBoundary.trim() || result.approvalBoundary.length > 300) {
        throw new Error('Die lokale Vorlage entspricht nicht dem erwarteten Workflow-Format.');
    }
    return {
        totalTokens: generated.totalTokens,
        output: {
            title: result.title.trim(),
            summary: result.summary.trim(),
            steps: result.steps.map(step => step.trim()),
            successMetric: result.successMetric.trim(),
            approvalBoundary: result.approvalBoundary.trim(),
            generationMethod: 'local_template',
        },
    };
}

async function generateLocalOutput(input, generator) {
    const generated = await generator(input);
    return generated.output;
}

function getPublicBaseUrl() {
    const value = process.env.PUBLIC_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : `http://localhost:${port}`);
    if (!value) throw new Error('PUBLIC_BASE_URL ist nicht konfiguriert.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) {
        throw new Error('PUBLIC_BASE_URL muss eine gültige öffentliche HTTPS-URL ohne Zugangsdaten sein.');
    }
    return url.origin;
}

function getPortalStripeConfiguration() {
    const products = getStripeProducts();
    const webhookSecret = /^whsec_[A-Za-z0-9]+$/.test(process.env.STRIPE_WEBHOOK_SECRET || '');
    let baseUrlReady = false;
    try {
        getPublicBaseUrl();
        baseUrlReady = true;
    } catch {
        baseUrlReady = false;
    }
    return {
        products,
        webhookSecret,
        checkoutReady: Boolean(stripe && webhookSecret && baseUrlReady && products.length),
    };
}

function stripeObjectId(value) {
    if (typeof value === 'string') return value;
    return typeof value?.id === 'string' ? value.id : null;
}

function invoiceSubscriptionId(invoice) {
    return stripeObjectId(invoice.subscription)
        || stripeObjectId(invoice.parent?.subscription_details?.subscription)
        || null;
}

async function setAccessGrant(tx, userId, productId, sourceType, sourceId, activatedAt) {
    await tx.run(
        `INSERT INTO portal_access_grants(user_id, product_id, source_type, source_id, activated_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(source_type, source_id) DO UPDATE SET
            user_id = excluded.user_id,
            product_id = excluded.product_id,
            activated_at = excluded.activated_at,
            revoked_at = NULL`,
        userId, productId, sourceType, sourceId, activatedAt,
    );
}

async function revokeAccessGrant(tx, sourceType, sourceId, revokedAt) {
    await tx.run(
        'UPDATE portal_access_grants SET revoked_at = ? WHERE source_type = ? AND source_id = ? AND revoked_at IS NULL',
        revokedAt, sourceType, sourceId,
    );
}

async function upsertSubscription(tx, subscription, eventCreated) {
    const subscriptionId = stripeObjectId(subscription.id);
    if (!subscriptionId) return false;
    const existing = await tx.get(
        'SELECT user_id, product_id, status, last_event_created FROM portal_subscriptions WHERE stripe_subscription_id = ?',
        subscriptionId,
    );
    const userId = Number(subscription.metadata?.portalUserId) || existing?.user_id;
    const productId = subscription.metadata?.productId || existing?.product_id;
    const product = getStripeProducts().find(item => item.id === productId && item.recurringInterval);
    if (!Number.isSafeInteger(userId) || userId < 1 || !product) {
        throw new Error('Stripe-Abonnement enthält keine gültige Portal-Konto-/Produktzuordnung.');
    }
    const user = await tx.get('SELECT id FROM portal_users WHERE id = ?', userId);
    if (!user) return false;
    const status = typeof subscription.status === 'string' ? subscription.status : 'incomplete';
    if (existing && (existing.last_event_created > eventCreated
        || (existing.last_event_created === eventCreated
            && ['canceled', 'refunded'].includes(existing.status)
            && !['canceled', 'refunded'].includes(status)))) return true;

    const customerId = stripeObjectId(subscription.customer);
    const periodEnd = Number.isSafeInteger(subscription.current_period_end)
        ? subscription.current_period_end * 1000
        : null;
    await tx.run(
        `INSERT INTO portal_subscriptions
            (stripe_subscription_id, user_id, product_id, stripe_customer_id, status, current_period_end, last_event_created, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stripe_subscription_id) DO UPDATE SET
            stripe_customer_id = excluded.stripe_customer_id,
            status = excluded.status,
            current_period_end = excluded.current_period_end,
            last_event_created = excluded.last_event_created,
            updated_at = excluded.updated_at`,
        subscriptionId, userId, product.id, customerId, status, periodEnd, eventCreated, Date.now(),
    );
    if (status === 'active' || status === 'trialing') {
        await setAccessGrant(tx, userId, product.id, 'subscription', subscriptionId, Date.now());
    } else {
        await revokeAccessGrant(tx, 'subscription', subscriptionId, Date.now());
    }
    return true;
}

async function saveInvoice(tx, invoice, status, eventCreated) {
    const subscriptionId = invoiceSubscriptionId(invoice);
    const subscription = subscriptionId
        ? await tx.get('SELECT user_id FROM portal_subscriptions WHERE stripe_subscription_id = ?', subscriptionId)
        : null;
    if (!subscription) return;
    const refund = await tx.get(
        'SELECT event_created FROM portal_refunded_invoices WHERE stripe_invoice_id = ?',
        invoice.id,
    );
    const invoiceStatus = refund && refund.event_created >= eventCreated ? 'refunded' : status;
    await tx.run(
        `INSERT INTO portal_invoices
            (stripe_invoice_id, user_id, stripe_subscription_id, payment_intent_id, invoice_number, status,
             amount_due, amount_paid, currency, hosted_invoice_url, invoice_pdf, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stripe_invoice_id) DO UPDATE SET
            status = excluded.status,
            amount_due = excluded.amount_due,
            amount_paid = excluded.amount_paid,
            hosted_invoice_url = excluded.hosted_invoice_url,
            invoice_pdf = excluded.invoice_pdf,
            updated_at = excluded.updated_at`,
        invoice.id, subscription.user_id, subscriptionId, stripeObjectId(invoice.payment_intent),
        invoice.number || null, invoiceStatus, invoice.amount_due || 0, invoice.amount_paid || 0,
        invoice.currency || 'eur', invoice.hosted_invoice_url || null, invoice.invoice_pdf || null,
        Number.isSafeInteger(invoice.created) ? invoice.created * 1000 : Date.now(), Date.now(),
    );
    const current = await tx.get(
        'SELECT status, last_event_created FROM portal_subscriptions WHERE stripe_subscription_id = ?',
        subscriptionId,
    );
    if (refund && refund.event_created >= eventCreated) {
        if (current && current.status !== 'canceled' && current.last_event_created <= refund.event_created) {
            await tx.run(
                'UPDATE portal_subscriptions SET status = ?, last_event_created = ?, updated_at = ? WHERE stripe_subscription_id = ?',
                'refunded', refund.event_created, Date.now(), subscriptionId,
            );
            await revokeAccessGrant(tx, 'subscription', subscriptionId, Date.now());
        }
        return;
    }
    if (current && (current.last_event_created > eventCreated
        || ['canceled', 'incomplete_expired'].includes(current.status))) return;
    const subscriptionStatus = status === 'paid' ? 'active' : 'past_due';
    await tx.run(
        'UPDATE portal_subscriptions SET status = ?, last_event_created = ?, updated_at = ? WHERE stripe_subscription_id = ?',
        subscriptionStatus, eventCreated, Date.now(), subscriptionId,
    );
    const details = await tx.get(
        'SELECT user_id, product_id FROM portal_subscriptions WHERE stripe_subscription_id = ?',
        subscriptionId,
    );
    if (subscriptionStatus === 'active') {
        await setAccessGrant(tx, details.user_id, details.product_id, 'subscription', subscriptionId, Date.now());
    } else {
        await revokeAccessGrant(tx, 'subscription', subscriptionId, Date.now());
    }
}

async function processStripeEvent(event) {
    return transaction(async tx => {
        const existingEvent = await tx.get(
            'SELECT stripe_event_id FROM portal_stripe_events WHERE stripe_event_id = ?',
            event.id,
        );
        if (existingEvent) return { duplicate: true };

        const object = event.data.object;
        const eventCreated = event.created || Math.floor(Date.now() / 1000);
        const now = Date.now();
        let fulfillmentStatus = 'processed';
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
            if (object.payment_status !== 'paid' && object.payment_status !== 'no_payment_required') {
                await tx.run('INSERT INTO portal_stripe_events(stripe_event_id, event_type, created_at) VALUES (?, ?, ?)', event.id, event.type, now);
                return { duplicate: false, fulfillmentStatus: 'pending' };
            }
            const product = getStripeProducts().find(item => item.id === object.metadata?.productId);
            const userId = Number(object.metadata?.portalUserId);
            const recurring = Boolean(product?.recurringInterval);
            const expectedMode = recurring ? 'subscription' : 'payment';
            const amountValid = object.amount_total === product?.unitAmountCents;
            if (!product || object.mode !== expectedMode || object.currency !== product.currency || !amountValid
                || !Number.isSafeInteger(userId) || userId < 1 || object.client_reference_id !== String(userId)) {
                throw new Error('Die bezahlte Sitzung stimmt nicht mit Produkt, Betrag oder Nutzerkonto überein.');
            }
            const user = await tx.get('SELECT id FROM portal_users WHERE id = ?', userId);
            if (user) {
                fulfillmentStatus = 'fulfilled';
                const sessionId = stripeObjectId(object.id);
                const subscriptionId = stripeObjectId(object.subscription);
                const orderResult = await tx.run(
                    `INSERT INTO portal_orders
                        (stripe_event_id, checkout_session_id, user_id, product_id, amount_total, currency,
                         fulfillment_status, stripe_payment_intent_id, stripe_subscription_id, stripe_customer_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(checkout_session_id) DO NOTHING`,
                    event.id, sessionId, userId, product.id, object.amount_total, object.currency,
                    recurring ? 'subscription' : 'fulfilled',
                    stripeObjectId(object.payment_intent), subscriptionId, stripeObjectId(object.customer), now,
                );
                if (!recurring && orderResult.changes) {
                    await setAccessGrant(tx, userId, product.id, 'purchase', sessionId, now);
                }
                if (recurring && subscriptionId) {
                    const subscriptionStatus = object.payment_status === 'paid' ? 'active' : 'incomplete';
                    fulfillmentStatus = subscriptionStatus === 'active' ? 'fulfilled' : 'pending';
                    const existingSubscription = await tx.get(
                        'SELECT status, last_event_created FROM portal_subscriptions WHERE stripe_subscription_id = ?',
                        subscriptionId,
                    );
                    if (!existingSubscription) {
                        await tx.run(
                            `INSERT INTO portal_subscriptions
                                (stripe_subscription_id, user_id, product_id, stripe_customer_id, status, last_event_created, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            subscriptionId, userId, product.id, stripeObjectId(object.customer), subscriptionStatus, eventCreated, now,
                        );
                    } else if (existingSubscription.last_event_created <= eventCreated
                        && !['canceled', 'refunded'].includes(existingSubscription.status)) {
                        await tx.run(
                            `UPDATE portal_subscriptions
                             SET status = ?, last_event_created = ?, updated_at = ?
                             WHERE stripe_subscription_id = ?`,
                            subscriptionStatus, eventCreated, now, subscriptionId,
                        );
                    }
                    const currentSubscription = await tx.get(
                        'SELECT status FROM portal_subscriptions WHERE stripe_subscription_id = ?',
                        subscriptionId,
                    );
                    if (currentSubscription?.status === 'active' || currentSubscription?.status === 'trialing') {
                        await setAccessGrant(tx, userId, product.id, 'subscription', subscriptionId, now);
                    } else {
                        await revokeAccessGrant(tx, 'subscription', subscriptionId, now);
                    }
                }
            }
        } else if (event.type === 'customer.subscription.updated'
            || event.type === 'customer.subscription.created'
            || event.type === 'customer.subscription.deleted') {
            await upsertSubscription(tx, object, eventCreated);
        } else if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') {
            await saveInvoice(tx, object, event.type === 'invoice.paid' ? 'paid' : 'payment_failed', eventCreated);
        } else if (event.type === 'charge.refunded') {
            const paymentIntentId = stripeObjectId(object.payment_intent);
            if (paymentIntentId) {
                const order = await tx.get(
                    'SELECT checkout_session_id FROM portal_orders WHERE stripe_payment_intent_id = ?',
                    paymentIntentId,
                );
                if (order) {
                    await tx.run(
                        `UPDATE portal_orders SET fulfillment_status = 'refunded'
                         WHERE checkout_session_id = ?`,
                        order.checkout_session_id,
                    );
                    await revokeAccessGrant(tx, 'purchase', order.checkout_session_id, now);
                }
            }
            const invoiceId = stripeObjectId(object.invoice);
            if (invoiceId) {
                await tx.run(
                    `INSERT INTO portal_refunded_invoices(stripe_invoice_id, event_created, created_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(stripe_invoice_id) DO UPDATE SET
                        event_created = MAX(portal_refunded_invoices.event_created, excluded.event_created)`,
                    invoiceId, eventCreated, now,
                );
                const invoice = await tx.get(
                    'SELECT stripe_subscription_id FROM portal_invoices WHERE stripe_invoice_id = ?',
                    invoiceId,
                );
                if (invoice?.stripe_subscription_id) {
                    const subscription = await tx.get(
                        'SELECT status FROM portal_subscriptions WHERE stripe_subscription_id = ? AND last_event_created <= ?',
                        invoice.stripe_subscription_id, eventCreated,
                    );
                    if (subscription && subscription.status !== 'canceled') {
                        await tx.run(
                            'UPDATE portal_subscriptions SET status = ?, last_event_created = ?, updated_at = ? WHERE stripe_subscription_id = ?',
                            'refunded', eventCreated, now, invoice.stripe_subscription_id,
                        );
                        await revokeAccessGrant(tx, 'subscription', invoice.stripe_subscription_id, now);
                    }
                }
            }
        }

        await tx.run(
            'INSERT INTO portal_stripe_events(stripe_event_id, event_type, created_at) VALUES (?, ?, ?)',
            event.id, event.type, now,
        );
        return { duplicate: false, fulfillmentStatus };
    });
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(enforceSameOrigin);

app.post('/api/portal/stripe-webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res, next) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret || '')) {
        res.status(503).json({ error: 'Stripe-Webhooks sind nicht konfiguriert.' });
        return;
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret);
    } catch {
        res.status(400).json({ error: 'Ungültige Stripe-Webhook-Signatur oder Payload.' });
        return;
    }
    const supportedEvents = new Set([
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.paid',
        'invoice.payment_failed',
        'charge.refunded',
    ]);
    if (!supportedEvents.has(event.type)) {
        res.json({ received: true });
        return;
    }
    try {
        const result = await processStripeEvent(event);
        res.json({ received: true, ...result });
    } catch (error) {
        next(error);
    }
});

app.use(express.json({ limit: '16kb' }));
app.use(loadUser);
app.use('/api', rateLimit('api-ip', apiRateLimit, 15 * 60 * 1000, clientIp));

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.get('/internal/errors', async (req, res, next) => {
    const expectedToken = process.env.PORTAL_ERROR_TOKEN || '';
    const suppliedToken = req.get('x-portal-error-token') || '';
    const expected = Buffer.from(expectedToken);
    const supplied = Buffer.from(suppliedToken);
    if (expected.length < 32 || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
        res.status(expected.length < 32 ? 503 : 401).json({ error: 'Interne Fehlerübersicht ist nicht verfügbar.' });
        return;
    }
    try {
        const events = await all(
            `SELECT id, request_path AS requestPath, message, stack, created_at AS createdAt
             FROM portal_error_events ORDER BY id DESC LIMIT 100`,
        );
        res.json({ events });
    } catch (error) {
        next(error);
    }
});

app.get('/api/auth/me', (req, res) => {
    if (!req.portalUser) {
        res.status(401).json({ error: 'Bitte melde dich an.' });
        return;
    }
    res.json({ user: req.portalUser });
});

app.post('/api/auth/register', rateLimit('register-ip', 8, 60 * 60 * 1000, clientIp), async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
        || password.length < 12 || Buffer.byteLength(password, 'utf8') > 128) {
        res.status(400).json({ error: 'Bitte gib eine gueltige E-Mail-Adresse und ein Passwort mit 12 bis 128 Bytes ein.' });
        return;
    }

    try {
        const salt = crypto.randomBytes(16);
        const passwordHash = await scrypt(password, salt, 64);
        const result = await run(
            'INSERT INTO portal_users(email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?)',
            email, salt.toString('hex'), passwordHash.toString('hex'), Date.now()
        );
        try {
            await createEmailToken(result.lastID, 'email_verification', email);
        } catch (emailError) {
            logPortalError(emailError, req, result.lastID);
            res.status(503).json({ error: 'Konto angelegt, aber die Bestätigungs-E-Mail konnte nicht versendet werden. Bitte nutze „Bestätigung erneut senden“.' });
            return;
        }
        res.status(201).json({ user: { id: result.lastID, email }, verificationRequired: true });
    } catch (error) {
        if (error && error.code === 'SQLITE_CONSTRAINT') {
            res.status(409).json({ error: 'Fuer diese E-Mail-Adresse existiert bereits ein Konto.' });
            return;
        }
        next(error);
    }
});

app.post(
    '/api/auth/login',
    rateLimit('login-ip', failedAuthLimit, failedAuthWindowMs, clientIp),
    rateLimit('login-account', failedAuthLimit, failedAuthWindowMs, req => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        return crypto.createHash('sha256').update(email).digest('hex');
    }),
    async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    try {
        const user = await get('SELECT id, email, password_salt, password_hash, email_verified_at FROM portal_users WHERE email = ?', email);
        const salt = user ? Buffer.from(user.password_salt, 'hex') : Buffer.alloc(16);
        const storedHash = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
        const suppliedHash = await scrypt(password, salt, 64);
        const valid = user && storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
        if (!valid) {
            res.status(401).json({ error: 'E-Mail-Adresse oder Passwort ist nicht korrekt.' });
            return;
        }
        if (!user.email_verified_at) {
            res.status(403).json({ error: 'Bitte bestätige zuerst deine E-Mail-Adresse.' });
            return;
        }
        await createSession(user.id, res);
        res.json({ user: { id: user.id, email: user.email } });
    } catch (error) {
        next(error);
    }
    },
);

app.post('/api/auth/verify-email', rateLimit('verify-email-ip', 20, 60 * 60 * 1000, clientIp), async (req, res, next) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!/^[a-f0-9]{64}$/.test(token)) {
        res.status(400).json({ error: 'Der Bestätigungslink ist ungültig oder abgelaufen.' });
        return;
    }
    try {
        const user = await transaction(async tx => {
            const row = await tx.get(
                `SELECT users.id, users.email, tokens.token_hash
                 FROM portal_user_tokens AS tokens
                 JOIN portal_users AS users ON users.id = tokens.user_id
                 WHERE tokens.token_hash = ? AND tokens.purpose = 'email_verification' AND tokens.expires_at > ?`,
                hashToken(token), Date.now(),
            );
            if (!row) return null;
            await tx.run('DELETE FROM portal_user_tokens WHERE user_id = ? AND purpose = ?', row.id, 'email_verification');
            await tx.run('UPDATE portal_users SET email_verified_at = ? WHERE id = ?', Date.now(), row.id);
            return { id: row.id, email: row.email };
        });
        if (!user) {
            res.status(400).json({ error: 'Der Bestätigungslink ist ungültig oder abgelaufen.' });
            return;
        }
        await createSession(user.id, res);
        res.json({ user });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/resend-verification', rateLimit('resend-verification-ip', 5, 15 * 60 * 1000, clientIp), async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    try {
        const user = await get(
            'SELECT id, email FROM portal_users WHERE email = ? AND email_verified_at IS NULL',
            email,
        );
        if (user) {
            await run('DELETE FROM portal_user_tokens WHERE user_id = ? AND purpose = ?', user.id, 'email_verification');
            try {
                await createEmailToken(user.id, 'email_verification', user.email);
            } catch (emailError) {
                logPortalError(emailError, req, user.id);
                res.status(503).json({ error: 'Die E-Mail konnte nicht versendet werden. Bitte versuche es später erneut.' });
                return;
            }
        }
        res.json({ message: 'Falls ein unbestätigtes Konto existiert, wurde eine E-Mail versendet.' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/password-reset/request', rateLimit('password-reset-ip', 5, 15 * 60 * 1000, clientIp), async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    try {
        const user = await get('SELECT id, email FROM portal_users WHERE email = ?', email);
        if (user) {
            await run('DELETE FROM portal_user_tokens WHERE user_id = ? AND purpose = ?', user.id, 'password_reset');
            try {
                await createEmailToken(user.id, 'password_reset', user.email);
            } catch (emailError) {
                logPortalError(emailError, req, user.id);
            }
        }
        res.status(202).json({ message: 'Falls ein Konto mit dieser E-Mail-Adresse existiert, erhältst du einen Link zum Zurücksetzen.' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/password-reset/confirm', rateLimit('password-reset-confirm-ip', 10, 15 * 60 * 1000, clientIp), async (req, res, next) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!/^[a-f0-9]{64}$/.test(token) || password.length < 12 || Buffer.byteLength(password, 'utf8') > 128) {
        res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen; das Passwort muss 12 bis 128 Bytes lang sein.' });
        return;
    }
    try {
        const salt = crypto.randomBytes(16);
        const passwordHash = await scrypt(password, salt, 64);
        const updated = await transaction(async tx => {
            const row = await tx.get(
                `SELECT user_id FROM portal_user_tokens
                 WHERE token_hash = ? AND purpose = 'password_reset' AND expires_at > ?`,
                hashToken(token), Date.now(),
            );
            if (!row) return false;
            await tx.run('DELETE FROM portal_user_tokens WHERE user_id = ? AND purpose = ?', row.user_id, 'password_reset');
            await tx.run(
                'UPDATE portal_users SET password_salt = ?, password_hash = ? WHERE id = ?',
                salt.toString('hex'), passwordHash.toString('hex'), row.user_id,
            );
            await tx.run('DELETE FROM portal_sessions WHERE user_id = ?', row.user_id);
            return true;
        });
        if (!updated) {
            res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen.' });
            return;
        }
        res.json({ message: 'Passwort geändert. Bitte melde dich erneut an.' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/change-password', requireUser, rateLimit('password-change-ip', 5, 15 * 60 * 1000, clientIp), async (req, res, next) => {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 12 || Buffer.byteLength(newPassword, 'utf8') > 128) {
        res.status(400).json({ error: 'Das neue Passwort muss 12 bis 128 Bytes lang sein.' });
        return;
    }
    try {
        const user = await get(
            'SELECT password_salt, password_hash FROM portal_users WHERE id = ?',
            req.portalUser.id,
        );
        const suppliedHash = await scrypt(currentPassword, Buffer.from(user.password_salt, 'hex'), 64);
        const storedHash = Buffer.from(user.password_hash, 'hex');
        if (storedHash.length !== suppliedHash.length || !crypto.timingSafeEqual(storedHash, suppliedHash)) {
            res.status(401).json({ error: 'Das aktuelle Passwort ist nicht korrekt.' });
            return;
        }
        const salt = crypto.randomBytes(16);
        const passwordHash = await scrypt(newPassword, salt, 64);
        const currentSession = getCookie(req, 'nv_portal_session');
        await transaction(async tx => {
            await tx.run(
                'UPDATE portal_users SET password_salt = ?, password_hash = ? WHERE id = ?',
                salt.toString('hex'), passwordHash.toString('hex'), req.portalUser.id,
            );
            await tx.run(
                'DELETE FROM portal_sessions WHERE user_id = ? AND token_hash != ?',
                req.portalUser.id, hashToken(currentSession),
            );
        });
        res.json({ message: 'Passwort geändert. Andere Sitzungen wurden abgemeldet.' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/logout-other-sessions', requireUser, async (req, res, next) => {
    const token = getCookie(req, 'nv_portal_session');
    if (!token) {
        res.status(401).json({ error: 'Bitte melde dich erneut an.' });
        return;
    }
    try {
        const result = await run(
            'DELETE FROM portal_sessions WHERE user_id = ? AND token_hash != ?',
            req.portalUser.id, hashToken(token),
        );
        res.json({ revokedSessions: result.changes });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/logout', async (req, res, next) => {
    try {
        const token = getCookie(req, 'nv_portal_session');
        if (token) await run('DELETE FROM portal_sessions WHERE token_hash = ?', hashToken(token));
        res.clearCookie('nv_portal_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.get('/api/account/export', requireUser, async (req, res, next) => {
    try {
        const [ideas, workflows, businessSales, socialDrafts, marketBenchmarks, validationActions, orders, invoices, subscriptions, usage] = await Promise.all([
            all('SELECT input_json, idea_json, created_at FROM portal_ideas WHERE user_id = ? ORDER BY id', req.portalUser.id),
            all('SELECT input_json, workflow_json, created_at FROM portal_workflows WHERE user_id = ? ORDER BY id', req.portalUser.id),
            all('SELECT idea_id, amount_minor, currency, created_at FROM portal_business_sales WHERE user_id = ? ORDER BY id', req.portalUser.id),
            all('SELECT idea_id, draft_json, created_at FROM portal_social_drafts WHERE user_id = ? ORDER BY id', req.portalUser.id),
            all('SELECT idea_id, benchmark_json, created_at FROM portal_market_benchmark_snapshots WHERE user_id = ? ORDER BY id', req.portalUser.id),
            all(`SELECT idea_id AS ideaId, action_text AS actionText, position, status, due_date AS dueDate,
                        result_note AS resultNote, created_at AS createdAt, updated_at AS updatedAt
                 FROM portal_idea_actions WHERE user_id = ? ORDER BY idea_id, position`, req.portalUser.id),
            all('SELECT product_id, amount_total, currency, fulfillment_status, created_at FROM portal_orders WHERE user_id = ? ORDER BY id', req.portalUser.id),
            all('SELECT invoice_number, status, amount_due, amount_paid, currency, hosted_invoice_url, invoice_pdf, created_at FROM portal_invoices WHERE user_id = ? ORDER BY created_at DESC', req.portalUser.id),
            all('SELECT product_id, status, current_period_end, updated_at FROM portal_subscriptions WHERE user_id = ? ORDER BY updated_at DESC', req.portalUser.id),
            all('SELECT month_key, used_tokens, updated_at FROM portal_usage WHERE user_id = ? ORDER BY month_key DESC', req.portalUser.id),
        ]);
        res.json({
            exportedAt: new Date().toISOString(),
            account: { email: req.portalUser.email, createdAt: req.portalUser.created_at },
            ideas: ideas.map(row => ({ input: JSON.parse(row.input_json), idea: JSON.parse(row.idea_json), createdAt: row.created_at })),
            workflows: workflows.map(row => ({ input: JSON.parse(row.input_json), workflow: JSON.parse(row.workflow_json), createdAt: row.created_at })),
            businessSales: businessSales.map(row => ({
                ideaId: row.idea_id,
                amount: fromMinorUnits(row.amount_minor, getCurrencyScale(row.currency)),
                currency: row.currency,
                createdAt: row.created_at,
            })),
            socialDrafts: socialDrafts.map(row => ({
                ideaId: row.idea_id,
                ...JSON.parse(row.draft_json),
                createdAt: row.created_at,
            })),
            marketBenchmarks: marketBenchmarks.map(row => ({
                ideaId: row.idea_id,
                ...JSON.parse(row.benchmark_json),
                createdAt: row.created_at,
            })),
            validationActions,
            orders,
            invoices,
            subscriptions,
            usage,
        });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/account', requireUser, async (req, res, next) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    try {
        const user = await get(
            'SELECT id, password_salt, password_hash FROM portal_users WHERE id = ?',
            req.portalUser.id,
        );
        const suppliedHash = await scrypt(password, Buffer.from(user.password_salt, 'hex'), 64);
        const storedHash = Buffer.from(user.password_hash, 'hex');
        if (storedHash.length !== suppliedHash.length || !crypto.timingSafeEqual(storedHash, suppliedHash)) {
            res.status(401).json({ error: 'Das Passwort ist nicht korrekt.' });
            return;
        }

        const activeSubscriptions = await all(
            `SELECT stripe_subscription_id FROM portal_subscriptions
             WHERE user_id = ? AND status IN ('active', 'trialing', 'past_due', 'unpaid')`,
            user.id,
        );
        if (activeSubscriptions.length && !stripe) {
            res.status(503).json({ error: 'Aktive Abos können gerade nicht gekündigt werden. Bitte versuche es später erneut.' });
            return;
        }
        try {
            for (const subscription of activeSubscriptions) {
                await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
            }
        } catch (stripeError) {
            logPortalError(stripeError, req, user.id);
            res.status(502).json({ error: 'Ein Abo konnte nicht gekündigt werden. Das Konto wurde nicht gelöscht.' });
            return;
        }

        await transaction(async tx => {
            await tx.run('DELETE FROM portal_error_events WHERE user_id = ?', user.id);
            await tx.run(
                `DELETE FROM portal_refunded_invoices
                 WHERE stripe_invoice_id IN (SELECT stripe_invoice_id FROM portal_invoices WHERE user_id = ?)`,
                user.id,
            );
            await tx.run('DELETE FROM portal_rate_limits WHERE scope = ? AND rate_key = ?', 'llm-user', String(user.id));
            const email = await tx.get('SELECT email FROM portal_users WHERE id = ?', user.id);
            if (email) {
                const emailKey = crypto.createHash('sha256').update(email.email.trim().toLowerCase()).digest('hex');
                await tx.run('DELETE FROM portal_rate_limits WHERE scope = ? AND rate_key = ?', 'login-account', emailKey);
            }
            await tx.run('DELETE FROM portal_entitlements WHERE user_id = ?', user.id);
            await tx.run('DELETE FROM portal_users WHERE id = ?', user.id);
        });
        res.clearCookie('nv_portal_session', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            path: '/',
        });
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.get('/api/ideas', requireUser, async (req, res, next) => {
    try {
        const [rows, salesRows, socialDraftRows, benchmarkRows] = await Promise.all([
            all(
                'SELECT id, input_json, idea_json, created_at FROM portal_ideas WHERE user_id = ? ORDER BY id DESC LIMIT 50',
                req.portalUser.id,
            ),
            all(
                `SELECT idea_id, COUNT(*) AS count, SUM(amount_minor) AS revenue_minor, currency
                 FROM portal_business_sales WHERE user_id = ? GROUP BY idea_id`,
                req.portalUser.id,
            ),
            all(
                'SELECT id, idea_id, draft_json, created_at FROM portal_social_drafts WHERE user_id = ? ORDER BY id DESC',
                req.portalUser.id,
            ),
            all(
                'SELECT id, idea_id, benchmark_json, created_at FROM portal_market_benchmark_snapshots WHERE user_id = ? ORDER BY id DESC',
                req.portalUser.id,
            ),
        ]);
        await transaction(async tx => {
            for (const row of rows) {
                await ensureIdeaValidationActions(tx, row.id, req.portalUser.id, JSON.parse(row.idea_json));
            }
        });
        const actionRows = await all(
            `SELECT id, idea_id, action_text, position, status, due_date, result_note, created_at, updated_at
             FROM portal_idea_actions WHERE user_id = ? ORDER BY idea_id DESC, position`,
            req.portalUser.id,
        );
        const salesByIdea = new Map(salesRows.map(row => {
            const currency = row.currency;
            const scale = getCurrencyScale(currency);
            return [row.idea_id, {
                count: row.count,
                revenue: scale ? fromMinorUnits(row.revenue_minor, scale) : null,
                currency,
            }];
        }));
        const socialDraftsByIdea = new Map();
        for (const row of socialDraftRows) {
            const drafts = socialDraftsByIdea.get(row.idea_id) || [];
            drafts.push({ id: row.id, ...JSON.parse(row.draft_json), createdAt: row.created_at });
            socialDraftsByIdea.set(row.idea_id, drafts);
        }
        const benchmarksByIdea = new Map();
        for (const row of benchmarkRows) {
            const snapshots = benchmarksByIdea.get(row.idea_id) || [];
            snapshots.push({ id: row.id, ...JSON.parse(row.benchmark_json), createdAt: row.created_at });
            benchmarksByIdea.set(row.idea_id, snapshots);
        }
        const actionsByIdea = new Map();
        for (const row of actionRows) {
            const actions = actionsByIdea.get(row.idea_id) || [];
            actions.push({
                id: row.id,
                actionText: row.action_text,
                position: row.position,
                status: row.status,
                dueDate: row.due_date,
                resultNote: row.result_note,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            });
            actionsByIdea.set(row.idea_id, actions);
        }
        res.json({ ideas: rows.map(row => ({
            id: row.id,
            input: JSON.parse(row.input_json),
            idea: JSON.parse(row.idea_json),
            createdAt: row.created_at,
            salesSummary: salesByIdea.get(row.id) || {
                count: 0,
                revenue: 0,
                currency: JSON.parse(row.idea_json).commercialCase?.currency || null,
            },
            socialDrafts: socialDraftsByIdea.get(row.id) || [],
            marketBenchmarks: benchmarksByIdea.get(row.id) || [],
            validationActions: actionsByIdea.get(row.id) || [],
        })) });
    } catch (error) {
        next(error);
    }
});

app.patch('/api/ideas/:ideaId/actions/:actionId', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    const actionId = Number(req.params.actionId);
    const { status, dueDate, resultNote } = req.body || {};
    const normalizedDueDate = dueDate === '' || dueDate === null ? null : dueDate;
    const validDueDate = normalizedDueDate === null
        || (typeof normalizedDueDate === 'string'
            && /^\d{4}-\d{2}-\d{2}$/.test(normalizedDueDate)
            && !Number.isNaN(Date.parse(`${normalizedDueDate}T00:00:00.000Z`))
            && new Date(`${normalizedDueDate}T00:00:00.000Z`).toISOString().slice(0, 10) === normalizedDueDate);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1
        || !Number.isSafeInteger(actionId) || actionId < 1
        || !['todo', 'in_progress', 'done'].includes(status)
        || !validDueDate
        || typeof resultNote !== 'string' || resultNote.trim().length > 500) {
        res.status(400).json({ error: 'Status, Fälligkeitsdatum oder Ergebnisnotiz ist ungültig. Notizen dürfen höchstens 500 Zeichen enthalten.' });
        return;
    }
    try {
        const updatedAt = Date.now();
        const result = await run(
            `UPDATE portal_idea_actions
             SET status = ?, due_date = ?, result_note = ?, updated_at = ?
             WHERE id = ? AND idea_id = ? AND user_id = ?
               AND EXISTS (SELECT 1 FROM portal_ideas WHERE id = ? AND user_id = ?)`,
            status, normalizedDueDate, resultNote.trim(), updatedAt,
            actionId, ideaId, req.portalUser.id, ideaId, req.portalUser.id,
        );
        if (!result.changes) {
            res.status(404).json({ error: 'Validierungsschritt nicht gefunden.' });
            return;
        }
        const action = await get(
            `SELECT id, action_text AS actionText, position, status, due_date AS dueDate,
                    result_note AS resultNote, created_at AS createdAt, updated_at AS updatedAt
             FROM portal_idea_actions WHERE id = ? AND idea_id = ? AND user_id = ?`,
            actionId, ideaId, req.portalUser.id,
        );
        res.json({ action });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ideas/:ideaId/market-benchmarks', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1 || req.body?.shareMarketContext !== true) {
        res.status(400).json({ error: 'Gib eine gültige Ideen-ID an und bestätige ausdrücklich die Weitergabe von Land und Branche.' });
        return;
    }
    try {
        const row = await get(
            'SELECT input_json FROM portal_ideas WHERE id = ? AND user_id = ?',
            ideaId, req.portalUser.id,
        );
        if (!row) {
            res.status(404).json({ error: 'Idee nicht gefunden.' });
            return;
        }
        const input = JSON.parse(row.input_json);
        let snapshot;
        try {
            snapshot = await fetchMarketBenchmarks(input.marketCountry, input.industry);
        } catch (error) {
            if (error.statusCode === 503 || error.statusCode === 502) {
                res.status(error.statusCode).json({ error: error.message });
                return;
            }
            logPortalError(error, req, req.portalUser.id);
            res.status(502).json({ error: 'Marktdaten konnten beim Anbieter nicht abgerufen werden.' });
            return;
        }
        const createdAt = Date.now();
        const inserted = await transaction(async tx => {
            const ownedIdea = await tx.get(
                'SELECT id FROM portal_ideas WHERE id = ? AND user_id = ?',
                ideaId, req.portalUser.id,
            );
            if (!ownedIdea) return null;
            return tx.run(
                'INSERT INTO portal_market_benchmark_snapshots(idea_id, user_id, country, industry, source, source_url, as_of, benchmark_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                ideaId, req.portalUser.id, input.marketCountry, input.industry,
                snapshot.source, snapshot.sourceUrl, snapshot.asOf, JSON.stringify(snapshot), createdAt,
            );
        });
        if (!inserted) {
            res.status(404).json({ error: 'Idee nicht gefunden.' });
            return;
        }
        res.status(201).json({ benchmark: { id: inserted.lastID, ...snapshot, createdAt } });
    } catch (error) {
        next(error);
    }
});

app.get('/api/ideas/:ideaId/social-drafts', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1) {
        res.status(400).json({ error: 'Ungültige Ideen-ID.' });
        return;
    }
    try {
        const rows = await all(
            'SELECT id, draft_json, created_at FROM portal_social_drafts WHERE idea_id = ? AND user_id = ? ORDER BY id DESC LIMIT 30',
            ideaId, req.portalUser.id,
        );
        const idea = await get('SELECT id FROM portal_ideas WHERE id = ? AND user_id = ?', ideaId, req.portalUser.id);
        if (!idea) {
            res.status(404).json({ error: 'Idee nicht gefunden.' });
            return;
        }
        res.json({
            drafts: rows.map(row => ({ id: row.id, ...JSON.parse(row.draft_json), createdAt: row.created_at })),
        });
    } catch (error) {
        next(error);
    }
});

app.post(
    '/api/ideas/:ideaId/social-drafts',
    requireUser,
    (req, res, next) => {
        const ideaId = Number(req.params.ideaId);
        const platforms = normalizeSocialPlatforms(req.body?.platforms);
        if (!Number.isSafeInteger(ideaId) || ideaId < 1 || !platforms) {
            res.status(400).json({ error: 'Wähle für eine gültige Idee ein bis drei unterstützte Social-Media-Plattformen aus.' });
            return;
        }
        req.socialDraftInput = { ideaId, platforms };
        next();
    },
    rateLimit('llm-user', llmRateLimit, 15 * 60 * 1000, req => String(req.portalUser.id)),
    rateLimit('llm-ip', llmRateLimit * 3, 15 * 60 * 1000, clientIp),
    async (req, res, next) => {
        const { ideaId, platforms } = req.socialDraftInput;
        try {
            const row = await get(
                'SELECT idea_json FROM portal_ideas WHERE id = ? AND user_id = ?',
                ideaId, req.portalUser.id,
            );
            if (!row) {
                res.status(404).json({ error: 'Idee nicht gefunden.' });
                return;
            }
            const generated = await generateLocalOutput(
                { ideaId, platforms, idea: JSON.parse(row.idea_json) },
                input => generateSocialDrafts(input.idea, input.platforms),
            );
            const createdAt = Date.now();
            const drafts = await transaction(async tx => {
                const ownedIdea = await tx.get(
                    'SELECT id FROM portal_ideas WHERE id = ? AND user_id = ?',
                    ideaId, req.portalUser.id,
                );
                if (!ownedIdea) return null;
                const saved = [];
                for (const draft of generated) {
                    const inserted = await tx.run(
                        'INSERT INTO portal_social_drafts(idea_id, user_id, draft_json, created_at) VALUES (?, ?, ?, ?)',
                        ideaId, req.portalUser.id, JSON.stringify(draft), createdAt,
                    );
                    saved.push({ id: inserted.lastID, ...draft, createdAt });
                }
                return saved;
            });
            if (!drafts) {
                res.status(404).json({ error: 'Idee nicht gefunden.' });
                return;
            }
            res.status(201).json({ drafts });
        } catch (error) {
            logPortalError(error, req, req.portalUser.id);
            if (error.status || error.statusCode) console.error('[Portal] Social-Draft-Generierung fehlgeschlagen:', {
                status: error.status || error.statusCode,
                code: error.code || null,
                message: error.message,
            });
            res.status(error.statusCode || (error.status ? 502 : 500)).json({
                error: error.statusCode === 429
                    ? error.message
                    : error.status || error.statusCode
                        ? 'Die lokalen Social-Vorlagen konnten gerade nicht erstellt werden. Bitte versuche es erneut.'
                        : 'Die Social-Entwürfe konnten nicht gespeichert werden.',
            });
        }
    },
);

app.delete('/api/ideas/:ideaId/social-drafts/:draftId', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    const draftId = Number(req.params.draftId);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1 || !Number.isSafeInteger(draftId) || draftId < 1) {
        res.status(400).json({ error: 'Ungültige Ideen- oder Entwurfs-ID.' });
        return;
    }
    try {
        const deleted = await run(
            'DELETE FROM portal_social_drafts WHERE id = ? AND idea_id = ? AND user_id = ?',
            draftId, ideaId, req.portalUser.id,
        );
        if (!deleted.changes) {
            res.status(404).json({ error: 'Social-Entwurf nicht gefunden.' });
            return;
        }
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.post('/api/ideas/:ideaId/social-drafts/:draftId/approve', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    const draftId = Number(req.params.draftId);
    const scheduledAt = typeof req.body?.scheduledAt === 'string' ? Date.parse(req.body.scheduledAt) : NaN;
    if (!Number.isSafeInteger(ideaId) || ideaId < 1 || !Number.isSafeInteger(draftId) || draftId < 1
        || !Number.isFinite(scheduledAt) || scheduledAt < Date.now() + 60_000
        || scheduledAt > Date.now() + 365 * 24 * 60 * 60 * 1000) {
        res.status(400).json({ error: 'Wähle einen Veröffentlichungszeitpunkt mindestens eine Minute in der Zukunft und innerhalb des nächsten Jahres.' });
        return;
    }
    try {
        const draft = await transaction(async tx => {
            const existing = await tx.get(
                'SELECT draft_json, status, created_at FROM portal_social_drafts WHERE id = ? AND idea_id = ? AND user_id = ?',
                draftId, ideaId, req.portalUser.id,
            );
            if (!existing) return { notFound: true };
            if (existing.status !== 'draft') return { conflict: true };
            const approvedAt = Date.now();
            const nextDraft = {
                ...JSON.parse(existing.draft_json),
                status: 'approved',
                approvalRequired: false,
                approvedByUserId: req.portalUser.id,
                approvedAt,
                scheduledAt: new Date(scheduledAt).toISOString(),
                publicationState: 'awaiting_oauth_integration',
            };
            await tx.run(
                'UPDATE portal_social_drafts SET draft_json = ?, status = ?, scheduled_at = ?, approved_at = ?, approved_by_user_id = ? WHERE id = ? AND idea_id = ? AND user_id = ? AND status = ?',
                JSON.stringify(nextDraft), 'approved', nextDraft.scheduledAt, approvedAt, req.portalUser.id,
                draftId, ideaId, req.portalUser.id, 'draft',
            );
            return { id: draftId, ...nextDraft, createdAt: existing.created_at };
        });
        if (draft.notFound) {
            res.status(404).json({ error: 'Social-Entwurf nicht gefunden.' });
            return;
        }
        if (draft.conflict) {
            res.status(409).json({ error: 'Dieser Entwurf wurde bereits freigegeben oder geändert.' });
            return;
        }
        res.json({ draft });
    } catch (error) {
        next(error);
    }
});

app.get('/api/ideas/:ideaId/sales', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1) {
        res.status(400).json({ error: 'Ungültige Ideen-ID.' });
        return;
    }
    try {
        const idea = await get(
            'SELECT idea_json FROM portal_ideas WHERE id = ? AND user_id = ?',
            ideaId, req.portalUser.id,
        );
        if (!idea) {
            res.status(404).json({ error: 'Idee nicht gefunden.' });
            return;
        }
        const rows = await all(
            'SELECT id, amount_minor, currency, created_at FROM portal_business_sales WHERE idea_id = ? AND user_id = ? ORDER BY id DESC LIMIT 50',
            ideaId, req.portalUser.id,
        );
        const currency = JSON.parse(idea.idea_json).commercialCase?.currency || 'EUR';
        const summary = await get(
            'SELECT COUNT(*) AS count, SUM(amount_minor) AS revenue_minor FROM portal_business_sales WHERE idea_id = ? AND user_id = ?',
            ideaId, req.portalUser.id,
        );
        const scale = getCurrencyScale(currency);
        res.json({
            sales: rows.map(row => ({
                id: row.id,
                amount: fromMinorUnits(row.amount_minor, getCurrencyScale(row.currency)),
                currency: row.currency,
                createdAt: row.created_at,
            })),
            salesSummary: {
                count: summary.count,
                revenue: fromMinorUnits(summary.revenue_minor || 0, scale),
                currency,
            },
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ideas/:ideaId/sales', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    const amount = parseAmount(req.body?.amount);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1 || amount === null || amount <= 0 || amount > 10_000_000) {
        res.status(400).json({ error: 'Bitte gib eine gültige Ideen-ID und einen Umsatz zwischen 0 und 10.000.000 ein.' });
        return;
    }
    try {
        const result = await transaction(async tx => {
            const row = await tx.get(
                'SELECT idea_json FROM portal_ideas WHERE id = ? AND user_id = ?',
                ideaId, req.portalUser.id,
            );
            if (!row) return { notFound: true };
            const businessCase = JSON.parse(row.idea_json).commercialCase;
            const currency = businessCase?.currency;
            const scale = getCurrencyScale(currency);
            if (!scale) return { invalidCurrency: true };
            const amountMinor = toMinorUnits(amount, scale);
            if (!amountMinor || amountMinor <= 0) {
                return { invalidAmount: true };
            }
            const inserted = await tx.run(
                'INSERT INTO portal_business_sales(idea_id, user_id, amount_minor, currency, created_at) VALUES (?, ?, ?, ?, ?)',
                ideaId, req.portalUser.id, amountMinor, currency, Date.now(),
            );
            const summary = await tx.get(
                'SELECT COUNT(*) AS count, SUM(amount_minor) AS revenue_minor FROM portal_business_sales WHERE idea_id = ? AND user_id = ?',
                ideaId, req.portalUser.id,
            );
            return {
                sale: {
                    id: inserted.lastID,
                    amount: fromMinorUnits(amountMinor, scale),
                    currency,
                    createdAt: Date.now(),
                },
                salesSummary: {
                    count: summary.count,
                    revenue: fromMinorUnits(summary.revenue_minor, scale),
                    currency,
                },
            };
        });
        if (result.notFound) {
            res.status(404).json({ error: 'Idee nicht gefunden.' });
            return;
        }
        if (result.invalidCurrency) {
            res.status(409).json({ error: 'Die Geschäftsidee enthält keine gültige Währung. Bitte erstelle einen neuen Entwurf.' });
            return;
        }
        if (result.invalidAmount) {
            res.status(400).json({ error: 'Der Betrag ist für die Währung zu klein oder ungültig.' });
            return;
        }
        res.status(201).json({ sale: result.sale, salesSummary: result.salesSummary });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/ideas/:ideaId/sales/:saleId', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    const saleId = Number(req.params.saleId);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1 || !Number.isSafeInteger(saleId) || saleId < 1) {
        res.status(400).json({ error: 'Ungültige Ideen- oder Umsatz-ID.' });
        return;
    }
    try {
        const result = await run(
            `DELETE FROM portal_business_sales
             WHERE id = ? AND idea_id = ? AND user_id = ?
               AND EXISTS (SELECT 1 FROM portal_ideas WHERE id = ? AND user_id = ?)`,
            saleId, ideaId, req.portalUser.id, ideaId, req.portalUser.id,
        );
        if (!result.changes) {
            res.status(404).json({ error: 'Umsatzeintrag nicht gefunden.' });
            return;
        }
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.put('/api/ideas/:ideaId', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    const { title, summary, businessModel, firstSteps } = req.body || {};
    if (!Number.isSafeInteger(ideaId) || ideaId < 1
        || typeof title !== 'string' || !title.trim() || title.trim().length > 120
        || typeof summary !== 'string' || !summary.trim() || summary.trim().length > 1200
        || typeof businessModel !== 'string' || !businessModel.trim() || businessModel.trim().length > 500
        || !isStringList(firstSteps, 3, 5, 300)) {
        res.status(400).json({ error: 'Der Ideenentwurf enthält ungültige oder zu lange Felder.' });
        return;
    }
    try {
        const row = await get(
            'SELECT idea_json FROM portal_ideas WHERE id = ? AND user_id = ?',
            ideaId, req.portalUser.id,
        );
        if (!row) {
            res.status(404).json({ error: 'Idee nicht gefunden.' });
            return;
        }
        const idea = JSON.parse(row.idea_json);
        const updatedIdea = {
            ...idea,
            title: title.trim(),
            summary: summary.trim(),
            businessModel: businessModel.trim(),
            firstSteps: firstSteps.map(step => step.trim()),
        };
        await run(
            'UPDATE portal_ideas SET idea_json = ? WHERE id = ? AND user_id = ?',
            JSON.stringify(updatedIdea), ideaId, req.portalUser.id,
        );
        res.json({ idea: { id: ideaId, idea: updatedIdea } });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/ideas/:ideaId', requireUser, async (req, res, next) => {
    const ideaId = Number(req.params.ideaId);
    if (!Number.isSafeInteger(ideaId) || ideaId < 1) {
        res.status(400).json({ error: 'Ungültige Ideen-ID.' });
        return;
    }
    try {
        const deleted = await transaction(async tx => {
            const existing = await tx.get(
                'SELECT id FROM portal_ideas WHERE id = ? AND user_id = ?',
                ideaId, req.portalUser.id,
            );
            if (!existing) return false;
            await tx.run('DELETE FROM portal_business_sales WHERE idea_id = ? AND user_id = ?', ideaId, req.portalUser.id);
            await tx.run('DELETE FROM portal_ideas WHERE id = ? AND user_id = ?', ideaId, req.portalUser.id);
            return true;
        });
        if (!deleted) {
            res.status(404).json({ error: 'Idee nicht gefunden.' });
            return;
        }
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

app.post(
    '/api/ideas/generate',
    requireUser,
    (req, res, next) => {
        const input = normalizeIdeaInput(req.body);
        if (!input) {
            res.status(400).json({
                error: 'Thema, Branche, Zielmarkt, ISO-Währung, Preis, erwartete Monatsverkäufe sowie variable und monatliche Fixkosten müssen gültig sein.',
            });
            return;
        }
        req.normalizedIdeaInput = input;
        next();
    },
    rateLimit('llm-user', llmRateLimit, 15 * 60 * 1000, req => String(req.portalUser.id)),
    rateLimit('llm-ip', llmRateLimit * 3, 15 * 60 * 1000, clientIp),
    async (req, res, next) => {
    const input = req.normalizedIdeaInput;

    let idea;
    try {
        idea = await generateLocalOutput(input, generateIdea);
    } catch (error) {
        logPortalError(error, req, req.portalUser.id);
        console.error('[Portal] Lokale Ideengenerierung fehlgeschlagen:', {
            status: error.status || null,
            code: error.code || null,
            message: error.message,
        });
        res.status(error.statusCode || 502).json({
            error: error.statusCode === 429
                ? error.message
                : 'Die lokale Ideenvorlage konnte gerade nicht erstellt werden. Bitte versuche es erneut.',
        });
        return;
    }
    try {
        const storedInput = {
            topic: input.topic,
            audience: input.audience,
            strengths: input.strengths,
            marketCountry: input.marketCountry,
            currency: input.currency,
            industry: input.industry,
            unitPrice: fromMinorUnits(input.unitPriceMinor, getCurrencyScale(input.currency)),
            expectedMonthlySales: input.expectedMonthlySales,
            variableCostPerSale: fromMinorUnits(input.variableCostPerSaleMinor, getCurrencyScale(input.currency)),
            monthlyFixedCosts: fromMinorUnits(input.monthlyFixedCostsMinor, getCurrencyScale(input.currency)),
        };
        const createdAt = Date.now();
        const result = await transaction(async tx => {
            const inserted = await tx.run(
                'INSERT INTO portal_ideas(user_id, input_json, idea_json, created_at) VALUES (?, ?, ?, ?)',
                req.portalUser.id, JSON.stringify(storedInput), JSON.stringify(idea), createdAt,
            );
            await ensureIdeaValidationActions(tx, inserted.lastID, req.portalUser.id, idea);
            const validationActions = await tx.all(
                `SELECT id, action_text AS actionText, position, status, due_date AS dueDate,
                        result_note AS resultNote, created_at AS createdAt, updated_at AS updatedAt
                 FROM portal_idea_actions WHERE idea_id = ? AND user_id = ? ORDER BY position`,
                inserted.lastID, req.portalUser.id,
            );
            return { id: inserted.lastID, validationActions };
        });
        res.status(201).json({
            idea: {
                id: result.id,
                input: storedInput,
                idea,
                createdAt,
                salesSummary: { count: 0, revenue: 0, currency: input.currency },
                validationActions: result.validationActions,
            },
        });
    } catch (error) {
        next(error);
    }
    },
);

app.get('/api/workflows', requireUser, async (req, res, next) => {
    try {
        const rows = await all(
            'SELECT id, input_json, workflow_json, created_at FROM portal_workflows WHERE user_id = ? ORDER BY id DESC LIMIT 50',
            req.portalUser.id,
        );
        res.json({
            workflows: rows.map(row => ({
                id: row.id,
                input: JSON.parse(row.input_json),
                workflow: JSON.parse(row.workflow_json),
                createdAt: row.created_at,
            })),
        });
    } catch (error) {
        next(error);
    }
});

app.put('/api/workflows/:workflowId', requireUser, async (req, res, next) => {
    const workflowId = Number(req.params.workflowId);
    const { title, summary, steps, successMetric, approvalBoundary } = req.body || {};
    if (!Number.isSafeInteger(workflowId) || workflowId < 1
        || typeof title !== 'string' || !title.trim() || title.trim().length > 120
        || typeof summary !== 'string' || !summary.trim() || summary.trim().length > 1200
        || !isStringList(steps, 3, 7, 300)
        || typeof successMetric !== 'string' || !successMetric.trim() || successMetric.trim().length > 300
        || typeof approvalBoundary !== 'string' || !approvalBoundary.trim() || approvalBoundary.trim().length > 300) {
        res.status(400).json({ error: 'Der Workflow enthält ungültige oder zu lange Felder.' });
        return;
    }
    try {
        const existing = await get(
            'SELECT workflow_json FROM portal_workflows WHERE id = ? AND user_id = ?',
            workflowId, req.portalUser.id,
        );
        if (!existing) {
            res.status(404).json({ error: 'Workflow nicht gefunden.' });
            return;
        }
        const updatedWorkflow = {
            ...JSON.parse(existing.workflow_json),
            title: title.trim(),
            summary: summary.trim(),
            steps: steps.map(step => step.trim()),
            successMetric: successMetric.trim(),
            approvalBoundary: approvalBoundary.trim(),
        };
        await run(
            'UPDATE portal_workflows SET workflow_json = ? WHERE id = ? AND user_id = ?',
            JSON.stringify(updatedWorkflow), workflowId, req.portalUser.id,
        );
        res.json({ workflow: { id: workflowId, workflow: updatedWorkflow } });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/workflows/:workflowId', requireUser, async (req, res, next) => {
    const workflowId = Number(req.params.workflowId);
    if (!Number.isSafeInteger(workflowId) || workflowId < 1) {
        res.status(400).json({ error: 'Ungültige Workflow-ID.' });
        return;
    }
    try {
        const result = await run(
            'DELETE FROM portal_workflows WHERE id = ? AND user_id = ?',
            workflowId, req.portalUser.id,
        );
        if (!result.changes) {
            res.status(404).json({ error: 'Workflow nicht gefunden.' });
            return;
        }
        res.status(204).end();
    } catch (error) {
        next(error);
    }
});

async function requirePremiumUser(req, res, next) {
    try {
        const entitlement = await get(
            `SELECT product_id FROM portal_access_grants WHERE user_id = ? AND revoked_at IS NULL
             UNION ALL
             SELECT product_id FROM portal_entitlements WHERE user_id = ?
               AND NOT EXISTS (
                   SELECT 1 FROM portal_access_grants
                   WHERE user_id = portal_entitlements.user_id
                     AND product_id = portal_entitlements.product_id
               )
             LIMIT 1`,
            req.portalUser.id, req.portalUser.id,
        );
        if (!entitlement) {
            res.status(403).json({ error: 'Der Workflow-Generator wird nach einem Premium-Kauf freigeschaltet.' });
            return;
        }
        next();
    } catch (error) {
        next(error);
    }
}

app.post(
    '/api/workflows/generate',
    requireUser,
    requirePremiumUser,
    rateLimit('llm-user', llmRateLimit, 15 * 60 * 1000, req => String(req.portalUser.id)),
    rateLimit('llm-ip', llmRateLimit * 3, 15 * 60 * 1000, clientIp),
    async (req, res, next) => {
    const input = normalizeWorkflowInput(req.body);
    if (!input) {
        res.status(400).json({ error: 'Ziel muss 3 bis 300 Zeichen lang sein; Zielgruppe und Rahmenbedingungen duerfen maximal 120 bzw. 300 Zeichen enthalten.' });
        return;
    }
    let workflow;
    try {
        workflow = await generateLocalOutput(input, generateWorkflow);
    } catch (error) {
        logPortalError(error, req, req.portalUser.id);
        console.error('[Portal] Lokale Workflowgenerierung fehlgeschlagen:', {
            status: error.status || null,
            code: error.code || null,
            message: error.message,
        });
        res.status(error.statusCode || 502).json({
            error: error.statusCode === 429
                ? error.message
                : 'Die lokale Workflowvorlage konnte gerade nicht erstellt werden. Bitte versuche es erneut.',
        });
        return;
    }
    try {
        const result = await run(
            'INSERT INTO portal_workflows(user_id, input_json, workflow_json, created_at) VALUES (?, ?, ?, ?)',
            req.portalUser.id, JSON.stringify(input), JSON.stringify(workflow), Date.now(),
        );
        res.status(201).json({ workflow: { id: result.lastID, input, workflow, createdAt: Date.now() } });
    } catch (error) {
        next(error);
    }
    },
);

app.get('/api/usage', requireUser, async (req, res, next) => {
    try {
        const monthKey = new Date().toISOString().slice(0, 7);
        const tokenLimit = await monthlyTokenLimitForUser(req.portalUser.id);
        const usage = await get(
            'SELECT used_tokens, reserved_tokens FROM portal_usage WHERE user_id = ? AND month_key = ?',
            req.portalUser.id, monthKey,
        );
        const usedTokens = usage?.used_tokens || 0;
        res.json({
            month: monthKey,
            usedTokens,
            limitTokens: tokenLimit,
            remainingTokens: Math.max(0, tokenLimit - usedTokens - (usage?.reserved_tokens || 0)),
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/products', (_req, res, next) => {
    try {
        const configuration = getPortalStripeConfiguration();
        res.json({
            checkoutReady: configuration.checkoutReady,
            products: configuration.products.map(({ id, name, description, unitAmountCents, currency, recurringInterval }) => ({
                id, name, description, unitAmountCents, currency, recurringInterval,
            })),
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/create-checkout-session', requireUser, async (req, res, next) => {
    if (!stripe) {
        res.status(503).json({ error: 'Stripe ist nicht konfiguriert.' });
        return;
    }
    let configuration;
    let baseUrl;
    try {
        configuration = getPortalStripeConfiguration();
        baseUrl = getPublicBaseUrl();
    } catch (error) {
        next(error);
        return;
    }
    if (!configuration.checkoutReady) {
        res.status(503).json({ error: 'Der Checkout ist noch nicht vollstaendig konfiguriert.' });
        return;
    }
    const product = configuration.products.find(item => item.id === req.body?.productId);
    if (!product) {
        res.status(400).json({ error: 'Bitte wähle ein gültiges Produkt aus dem konfigurierten Katalog.' });
        return;
    }
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: product.currency,
                    product_data: {
                        name: product.name,
                        ...(product.description ? { description: product.description } : {}),
                    },
                    unit_amount: product.unitAmountCents,
                    ...(product.recurringInterval ? { recurring: { interval: product.recurringInterval } } : {}),
                },
                quantity: 1,
            }],
            mode: product.recurringInterval ? 'subscription' : 'payment',
            customer_email: req.portalUser.email,
            client_reference_id: String(req.portalUser.id),
            success_url: `${baseUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/dashboard?checkout=cancelled`,
            metadata: { productId: product.id, portalUserId: String(req.portalUser.id) },
            ...(product.recurringInterval ? {
                subscription_data: { metadata: { productId: product.id, portalUserId: String(req.portalUser.id) } },
            } : {}),
        });
        if (!session.url) {
            res.status(502).json({ error: 'Stripe hat keine Checkout-URL zurückgegeben.' });
            return;
        }
        res.json({ url: session.url });
    } catch (error) {
        logPortalError(error, req, req.portalUser.id);
        console.error('[Portal] Stripe-Checkout konnte nicht erstellt werden:', {
            type: error.type || null,
            code: error.code || null,
            statusCode: error.statusCode || null,
            requestId: error.requestId || null,
        });
        res.status(502).json({ error: 'Die Checkout-Sitzung konnte nicht erstellt werden.' });
    }
});

app.get('/api/billing/entitlements', requireUser, async (req, res, next) => {
    try {
        const rows = await all(
            `SELECT product_id AS productId, activated_at AS activatedAt
             FROM portal_access_grants WHERE user_id = ? AND revoked_at IS NULL
             UNION ALL
             SELECT product_id AS productId, activated_at AS activatedAt
             FROM portal_entitlements
             WHERE user_id = ? AND NOT EXISTS (
                 SELECT 1 FROM portal_access_grants
                 WHERE user_id = portal_entitlements.user_id
                   AND product_id = portal_entitlements.product_id
             )`,
            req.portalUser.id, req.portalUser.id,
        );
        const products = getStripeProducts();
        res.json({
            entitlements: rows.map(row => ({
                productId: row.productId,
                name: products.find(product => product.id === row.productId)?.name || row.productId,
                activatedAt: row.activatedAt,
            })),
            premiumEnabled: rows.length > 0,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/billing/invoices', requireUser, async (req, res, next) => {
    try {
        const invoices = await all(
            `SELECT stripe_invoice_id AS id, invoice_number AS number, status, amount_due AS amountDue,
                    amount_paid AS amountPaid, currency, hosted_invoice_url AS hostedInvoiceUrl,
                    invoice_pdf AS invoicePdf, created_at AS createdAt
             FROM portal_invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            req.portalUser.id,
        );
        res.json({ invoices });
    } catch (error) {
        next(error);
    }
});

app.get('/api/billing/usage', requireUser, async (req, res, next) => {
    try {
        const monthKey = new Date().toISOString().slice(0, 7);
        const tokenLimit = await monthlyTokenLimitForUser(req.portalUser.id);
        const usage = await get(
            'SELECT used_tokens AS usedTokens, reserved_tokens AS reservedTokens FROM portal_usage WHERE user_id = ? AND month_key = ?',
            req.portalUser.id, monthKey,
        );
        res.json({
            month: monthKey,
            usedTokens: usage?.usedTokens || 0,
            reservedTokens: usage?.reservedTokens || 0,
            monthlyLimit: tokenLimit,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/billing/subscriptions', requireUser, async (req, res, next) => {
    try {
        const subscriptions = await all(
            `SELECT product_id AS productId, status, current_period_end AS currentPeriodEnd,
                    updated_at AS updatedAt
             FROM portal_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50`,
            req.portalUser.id,
        );
        res.json({ subscriptions });
    } catch (error) {
        next(error);
    }
});

app.post('/api/billing/portal-session', requireUser, async (req, res, next) => {
    if (!stripe) {
        res.status(503).json({ error: 'Stripe Billing ist nicht konfiguriert.' });
        return;
    }
    try {
        const customer = await get(
            `SELECT stripe_customer_id FROM portal_subscriptions
             WHERE user_id = ? AND stripe_customer_id IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1`,
            req.portalUser.id,
        );
        if (!customer?.stripe_customer_id) {
            res.status(404).json({ error: 'Für dieses Konto wurde noch kein Stripe-Abo angelegt.' });
            return;
        }
        const session = await stripe.billingPortal.sessions.create({
            customer: customer.stripe_customer_id,
            return_url: `${getPublicBaseUrl()}/dashboard`,
        });
        res.json({ url: session.url });
    } catch (error) {
        next(error);
    }
});

app.get('/api/billing/checkout-status', requireUser, async (req, res, next) => {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
        res.status(400).json({ error: 'Ungültige Checkout-Sitzungs-ID.' });
        return;
    }
    try {
        const order = await get(
            'SELECT product_id FROM portal_orders WHERE checkout_session_id = ? AND user_id = ? AND fulfillment_status = ?',
            sessionId, req.portalUser.id, 'fulfilled',
        );
        res.json({ fulfilled: Boolean(order), productId: order?.product_id || null });
    } catch (error) {
        next(error);
    }
});

app.get('/api/billing/connect-status', requireUser, (_req, res) => {
    res.json({
        enabled: false,
        status: 'not_available',
        message: 'Händler-Onboarding, Auszahlungen und Nutzerverkäufe sind bis zur technischen und rechtlichen Abnahme deaktiviert.',
    });
});

app.get('/dashboard', (req, res) => {
    if (!req.portalUser) {
        res.redirect(302, '/login');
        return;
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/login', '/register', '/verify-email', '/reset-password', '/'], (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/assets', express.static(path.join(__dirname, 'assets'), { fallthrough: false, maxAge: '1h' }));

app.use((error, req, res, _next) => {
    logPortalError(error, req, req.portalUser?.id || null);
    res.status(500).json({ error: 'Ein interner Fehler ist aufgetreten.' });
});

const schema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS portal_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        email_verified_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS portal_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_sessions_expiry ON portal_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS portal_ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        input_json TEXT NOT NULL,
        idea_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_ideas_owner ON portal_ideas(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS portal_business_sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id INTEGER NOT NULL REFERENCES portal_ideas(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_business_sales_owner ON portal_business_sales(user_id, idea_id, id DESC);
    CREATE TABLE IF NOT EXISTS portal_idea_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id INTEGER NOT NULL REFERENCES portal_ideas(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 4),
        action_text TEXT NOT NULL CHECK (length(action_text) BETWEEN 1 AND 300),
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
        due_date TEXT,
        result_note TEXT NOT NULL DEFAULT '' CHECK (length(result_note) <= 500),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (idea_id, position)
    );
    CREATE INDEX IF NOT EXISTS portal_idea_actions_owner ON portal_idea_actions(user_id, idea_id, position);
    CREATE TABLE IF NOT EXISTS portal_social_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id INTEGER NOT NULL REFERENCES portal_ideas(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        draft_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
        scheduled_at TEXT,
        approved_at INTEGER,
        approved_by_user_id INTEGER REFERENCES portal_users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_social_drafts_owner ON portal_social_drafts(user_id, idea_id, id DESC);
    CREATE TABLE IF NOT EXISTS portal_social_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('instagram', 'facebook', 'tiktok', 'linkedin', 'x')),
        provider_account_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
        connected_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE (user_id, provider, provider_account_id)
    );
    CREATE INDEX IF NOT EXISTS portal_social_connections_owner ON portal_social_connections(user_id, provider, status);
    CREATE TABLE IF NOT EXISTS portal_market_benchmark_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id INTEGER NOT NULL REFERENCES portal_ideas(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        country TEXT NOT NULL,
        industry TEXT NOT NULL,
        source TEXT NOT NULL,
        source_url TEXT NOT NULL,
        as_of TEXT NOT NULL,
        benchmark_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_market_benchmarks_owner ON portal_market_benchmark_snapshots(user_id, idea_id, id DESC);
    CREATE TABLE IF NOT EXISTS portal_workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        input_json TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_workflows_owner ON portal_workflows(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS portal_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_event_id TEXT NOT NULL UNIQUE,
        checkout_session_id TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        amount_total INTEGER NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'eur'),
        fulfillment_status TEXT NOT NULL,
        stripe_payment_intent_id TEXT,
        stripe_subscription_id TEXT,
        stripe_customer_id TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_connect_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE REFERENCES portal_users(id) ON DELETE CASCADE,
        stripe_account_id TEXT NOT NULL UNIQUE,
        country TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        status TEXT NOT NULL CHECK (status IN ('onboarding', 'pending', 'enabled', 'restricted')),
        charges_enabled INTEGER NOT NULL DEFAULT 0 CHECK (charges_enabled IN (0, 1)),
        payouts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (payouts_enabled IN (0, 1)),
        details_submitted INTEGER NOT NULL DEFAULT 0 CHECK (details_submitted IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_marketplace_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id INTEGER NOT NULL REFERENCES portal_ideas(id) ON DELETE RESTRICT,
        seller_user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE RESTRICT,
        connect_account_id INTEGER NOT NULL REFERENCES portal_connect_accounts(id) ON DELETE RESTRICT,
        stripe_payment_intent_id TEXT NOT NULL UNIQUE,
        stripe_transfer_id TEXT UNIQUE,
        gross_amount_minor INTEGER NOT NULL CHECK (gross_amount_minor > 0),
        platform_fee_minor INTEGER NOT NULL CHECK (platform_fee_minor >= 0),
        seller_net_minor INTEGER NOT NULL CHECK (seller_net_minor >= 0 AND gross_amount_minor = platform_fee_minor + seller_net_minor),
        currency TEXT NOT NULL CHECK (length(currency) = 3),
        status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'refunded', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_marketplace_transactions_seller ON portal_marketplace_transactions(seller_user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS portal_entitlements (
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        order_id INTEGER NOT NULL REFERENCES portal_orders(id),
        activated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS portal_user_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_user_tokens_owner ON portal_user_tokens(user_id, purpose);
    CREATE TABLE IF NOT EXISTS portal_rate_limits (
        scope TEXT NOT NULL,
        rate_key TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        PRIMARY KEY (scope, rate_key)
    );
    CREATE TABLE IF NOT EXISTS portal_usage (
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        month_key TEXT NOT NULL,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, month_key)
    );
    CREATE TABLE IF NOT EXISTS portal_access_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        activated_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE (source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS portal_access_grants_owner ON portal_access_grants(user_id, product_id, revoked_at);
    CREATE TABLE IF NOT EXISTS portal_subscriptions (
        stripe_subscription_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        stripe_customer_id TEXT,
        status TEXT NOT NULL,
        current_period_end INTEGER,
        last_event_created INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_subscriptions_owner ON portal_subscriptions(user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS portal_invoices (
        stripe_invoice_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
        stripe_subscription_id TEXT,
        payment_intent_id TEXT,
        invoice_number TEXT,
        status TEXT NOT NULL,
        amount_due INTEGER NOT NULL DEFAULT 0,
        amount_paid INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL,
        hosted_invoice_url TEXT,
        invoice_pdf TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_invoices_owner ON portal_invoices(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS portal_invoices_payment ON portal_invoices(payment_intent_id);
    CREATE TABLE IF NOT EXISTS portal_refunded_invoices (
        stripe_invoice_id TEXT PRIMARY KEY,
        event_created INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_stripe_events (
        stripe_event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_error_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES portal_users(id) ON DELETE SET NULL,
        request_path TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_error_events_created ON portal_error_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS portal_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
    );
`;

db.exec(schema, error => {
    if (error) throw error;
    (async () => {
        await transaction(async tx => {
            const applied = await tx.all('SELECT version FROM portal_schema_migrations');
            const versions = new Set(applied.map(row => row.version));
            const columnsToEnsure = [
                ['portal_users', 'email_verified_at', 'INTEGER'],
                ['portal_social_drafts', 'status', "TEXT NOT NULL DEFAULT 'draft'"],
                ['portal_social_drafts', 'scheduled_at', 'TEXT'],
                ['portal_social_drafts', 'approved_at', 'INTEGER'],
                ['portal_social_drafts', 'approved_by_user_id', 'INTEGER'],
                ['portal_orders', 'stripe_payment_intent_id', 'TEXT'],
                ['portal_orders', 'stripe_subscription_id', 'TEXT'],
                ['portal_orders', 'stripe_customer_id', 'TEXT'],
            ];
            for (const [table, column, definition] of columnsToEnsure) {
                const columns = await tx.all(`PRAGMA table_info(${table})`);
                if (!columns.some(item => item.name === column)) {
                    await tx.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
                }
            }
            if (!versions.has(1)) {
                await tx.run('INSERT INTO portal_schema_migrations(version, applied_at) VALUES (?, ?)', 1, Date.now());
            }
            if (!versions.has(2)) {
                await tx.run(
                    `INSERT OR IGNORE INTO portal_access_grants(user_id, product_id, source_type, source_id, activated_at, revoked_at)
                     SELECT entitlements.user_id, entitlements.product_id, 'purchase',
                            orders.checkout_session_id, entitlements.activated_at, NULL
                     FROM portal_entitlements AS entitlements
                     JOIN portal_orders AS orders ON orders.id = entitlements.order_id`,
                );
                await tx.run('INSERT INTO portal_schema_migrations(version, applied_at) VALUES (?, ?)', 2, Date.now());
            }
            if (!versions.has(3)) {
                await tx.run('INSERT INTO portal_schema_migrations(version, applied_at) VALUES (?, ?)', 3, Date.now());
            }
            if (!versions.has(4)) {
                await tx.run('INSERT INTO portal_schema_migrations(version, applied_at) VALUES (?, ?)', 4, Date.now());
            }
            if (!versions.has(5)) {
                await tx.run('INSERT INTO portal_schema_migrations(version, applied_at) VALUES (?, ?)', 5, Date.now());
            }
            if (!versions.has(6)) {
                await tx.run('INSERT INTO portal_schema_migrations(version, applied_at) VALUES (?, ?)', 6, Date.now());
            }
            if (!versions.has(7)) {
                await tx.run('INSERT INTO portal_schema_migrations(version, applied_at) VALUES (?, ?)', 7, Date.now());
            }
        });
        await cleanupExpiredData();
    })().then(() => {
        const cleanupTimer = setInterval(() => {
            cleanupExpiredData().catch(cleanupError => {
                console.error('[Portal] Bereinigung abgelaufener Daten fehlgeschlagen:', cleanupError.message);
            });
        }, 60 * 60 * 1000);
        cleanupTimer.unref();
        app.listen(port, '0.0.0.0', () => {
            console.log(`[Portal] listening on ${port}`);
        });
    }).catch(initializationError => {
        console.error('[Portal] Datenbankmigration fehlgeschlagen:', initializationError);
        process.exitCode = 1;
    });
});

async function cleanupExpiredData() {
    const now = Date.now();
    await run('DELETE FROM portal_sessions WHERE expires_at <= ?', now);
    await run('DELETE FROM portal_user_tokens WHERE expires_at <= ?', now);
    await run('DELETE FROM portal_rate_limits WHERE window_started_at < ?', now - 24 * 60 * 60 * 1000);
    await run('DELETE FROM portal_error_events WHERE created_at < ?', now - errorRetentionDays * 24 * 60 * 60 * 1000);
}
