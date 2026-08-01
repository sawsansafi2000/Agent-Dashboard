import { SocialPublicationStore } from './socialPublisher';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export function startSocialAutomation(store: SocialPublicationStore): () => void {
    const intervalMs = Number.parseInt(process.env.SOCIAL_AUTOMATION_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
    const refreshIntervalMs = Number.parseInt(
        process.env.SOCIAL_TOKEN_REFRESH_INTERVAL_MS || String(DEFAULT_REFRESH_INTERVAL_MS),
        10,
    );
    let running = false;
    let lastRefreshAt = 0;

    const run = async (): Promise<void> => {
        if (running || process.env.SOCIAL_HEALTHCHECKS_ENABLED === 'false') return;
        running = true;
        try {
            if (Date.now() - lastRefreshAt >= refreshIntervalMs) {
                const refreshes = await store.refreshProviderTokens();
                lastRefreshAt = Date.now();
                refreshes.filter(result => !result.refreshed).forEach(result => {
                    console.warn(`[SocialAutomation] ${result.platform}: ${result.reason}`);
                });
            }
            if (process.env.SOCIAL_AUTONOMOUS_PUBLISHING_ENABLED === 'true') {
                const published = await store.publishApproved();
                if (published.length) console.log(`[SocialAutomation] ${published.length} freigegebene Beitrag/Beiträge veröffentlicht.`);
            }
        } catch (error) {
            console.error('[SocialAutomation] Durchlauf fehlgeschlagen; Worker läuft weiter:', error);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => void run(), Number.isFinite(intervalMs) && intervalMs >= 10_000 ? intervalMs : DEFAULT_INTERVAL_MS);
    void run();
    return () => clearInterval(timer);
}