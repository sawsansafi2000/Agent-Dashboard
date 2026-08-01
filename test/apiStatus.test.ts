import assert from 'node:assert/strict';
import test from 'node:test';
import {
    apiBudgetAlertMessage,
    apiBudgetWarningMessage,
    getApiErrorDetails,
    importantLinksFooter,
    OPENAI_BILLING_URL,
} from '../src/apiStatus.js';

test('uses the exact required API budget alert text', () => {
    assert.equal(
        apiBudgetAlertMessage('OPENAI_API_KEY'),
        `API-Budget leer – bitte Token OPENAI_API_KEY unter ${OPENAI_BILLING_URL} aufladen`,
    );
});

test('warns early with the exact remaining budget and billing link', () => {
    assert.equal(
        apiBudgetWarningMessage(987),
        `API-Budget wird knapp: noch 9,87 EUR verfügbar. Jetzt Guthaben unter ${OPENAI_BILLING_URL} aufladen, damit die Agenten ohne Unterbrechung weiterlaufen.`,
    );
    assert.throws(() => apiBudgetWarningMessage(-1), /nicht-negative ganze Cent-Zahl/);
});

test('classifies provider quota and availability failures', () => {
    assert.equal(getApiErrorDetails({ status: 429, code: 'insufficient_quota', message: 'quota' })?.code, 'insufficient_quota');
    assert.equal(getApiErrorDetails({ status: 503, message: 'offline' })?.status, 503);
    assert.equal(getApiErrorDetails(new Error('ordinary failure')), null);
});

test('important links footer never contains dashboard passwords', () => {
    const original = process.env.DASHBOARD_PASSWORD;
    process.env.DASHBOARD_PASSWORD = 'must-not-appear';
    try {
        const footer = importantLinksFooter();
        assert.doesNotMatch(footer, /must-not-appear/);
        assert.match(footer, /OpenAI Nutzung/);
    } finally {
        if (original === undefined) delete process.env.DASHBOARD_PASSWORD;
        else process.env.DASHBOARD_PASSWORD = original;
    }
});