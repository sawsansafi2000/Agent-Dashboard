import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateMaximumTokenUsage, estimateTaskCredits, estimateTokenCostCents } from '../src/apiBudget.js';

test('calculates token costs in whole cents and rounds up', () => {
    assert.equal(estimateTokenCostCents(
        { promptTokens: 1_000, completionTokens: 500 },
        { inputCentsPerMillionTokens: 250, outputCentsPerMillionTokens: 1_000 },
    ), 1);
});

test('uses a conservative character estimate for preflight reservation', () => {
    assert.deepEqual(estimateMaximumTokenUsage(3_001, 4_000), {
        promptTokens: 1_001,
        completionTokens: 4_000,
    });
});

test('expresses a task cost estimate as API-backed credits', () => {
    assert.deepEqual(estimateTaskCredits(3_001, 4_000, {
        inputCentsPerMillionTokens: 250,
        outputCentsPerMillionTokens: 1_000,
    }), {
        promptTokens: 1_001,
        completionTokens: 4_000,
        maximumCredits: 5,
    });
});