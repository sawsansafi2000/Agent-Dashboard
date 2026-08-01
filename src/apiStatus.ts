export interface ApiErrorDetails {
    status?: number;
    code?: string;
    message: string;
}

export class ApiPausedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ApiPausedError';
    }
}

export const OPENAI_BILLING_URL = 'https://platform.openai.com/settings/organization/billing/overview';
export const OPENAI_API_KEYS_URL = 'https://platform.openai.com/api-keys';

export function apiProviderBlockedMessage(reason: string | null, tokenLabel = process.env.API_TOKEN_LABEL || 'OPENAI_API_KEY'): string {
    return `OpenAI-API blockiert (${reason || 'unbekannter Grund'}). Token ${tokenLabel} unter ${OPENAI_API_KEYS_URL} prüfen; Guthaben und Zahlungsdaten unter ${OPENAI_BILLING_URL} verwalten.`;
}

export function apiBudgetWarningMessage(remainingCents: number): string {
    if (!Number.isSafeInteger(remainingCents) || remainingCents < 0) {
        throw new Error('Verbleibendes API-Budget muss eine nicht-negative ganze Cent-Zahl sein.');
    }
    const remainingEuros = (remainingCents / 100).toFixed(2).replace('.', ',');
    return `API-Budget wird knapp: noch ${remainingEuros} EUR verfügbar. Jetzt Guthaben unter ${OPENAI_BILLING_URL} aufladen, damit die Agenten ohne Unterbrechung weiterlaufen.`;
}

export function getApiErrorDetails(error: unknown): ApiErrorDetails | null {
    if (!error || typeof error !== 'object') return null;
    const candidate = error as { status?: unknown; code?: unknown; message?: unknown; error?: { code?: unknown } };
    const status = typeof candidate.status === 'number' ? candidate.status : undefined;
    const codeValue = candidate.code ?? candidate.error?.code;
    const code = typeof codeValue === 'string' ? codeValue : undefined;
    const message = typeof candidate.message === 'string' ? candidate.message : String(error);
    const providerUnavailable = status === 401 || status === 403 || status === 429 || (status !== undefined && status >= 500)
        || ['insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key'].includes(code ?? '');
    return providerUnavailable ? { status, code, message } : null;
}

export function importantLinksFooter(): string {
    const baseUrl = (process.env.PRODUCTION_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const username = process.env.DASHBOARD_USERNAME || 'nicht konfiguriert';
    return [
        '',
        'Wichtige Links & Zugang',
        `- Agenten-Chat: ${baseUrl}/dashboard/chat`,
        `- Admin-Dashboard: ${baseUrl}/dashboard`,
        `- Dashboard-Benutzer: ${username}`,
        '- Dashboard-Passwort: wird aus Sicherheitsgründen nicht ausgegeben',
        '- OpenAI Nutzung: https://platform.openai.com/usage',
        `- OpenAI Abrechnung: ${OPENAI_BILLING_URL}`,
        '- Stripe: https://dashboard.stripe.com/',
        '- Hetzner: https://console.hetzner.cloud/',
    ].join('\n');
}

export function apiBudgetAlertMessage(tokenLabel = process.env.API_TOKEN_LABEL || 'OPENAI_API_KEY'): string {
    return `API-Budget leer – bitte Token ${tokenLabel} unter ${OPENAI_BILLING_URL} aufladen`;
}