export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
}

export interface ApiPricing {
    inputCentsPerMillionTokens: number;
    outputCentsPerMillionTokens: number;
}

export interface CreditEstimate extends TokenUsage {
    maximumCredits: number;
}

export function estimateTokenCostCents(usage: TokenUsage, pricing: ApiPricing): number {
    if (![usage.promptTokens, usage.completionTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error('Tokenverbrauch muss aus nicht-negativen ganzen Zahlen bestehen.');
    }
    const cost = (usage.promptTokens * pricing.inputCentsPerMillionTokens
        + usage.completionTokens * pricing.outputCentsPerMillionTokens) / 1_000_000;
    return Math.ceil(cost);
}

export function estimateMaximumTokenUsage(inputCharacters: number, maximumCompletionTokens: number): TokenUsage {
    if (!Number.isSafeInteger(inputCharacters) || inputCharacters < 0) {
        throw new Error('Eingabezeichen müssen eine nicht-negative ganze Zahl sein.');
    }
    return {
        promptTokens: Math.ceil(inputCharacters / 3),
        completionTokens: maximumCompletionTokens,
    };
}

export function estimateTaskCredits(
    inputCharacters: number,
    maximumCompletionTokens: number,
    pricing: ApiPricing,
): CreditEstimate {
    const usage = estimateMaximumTokenUsage(inputCharacters, maximumCompletionTokens);
    return {
        ...usage,
        maximumCredits: estimateTokenCostCents(usage, pricing),
    };
}