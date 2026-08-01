import { createHash, randomBytes } from 'crypto';
import { Request, Response, Router } from 'express';
import path from 'path';
import { PublicationKind, SocialPlatform, SocialPublicationStore } from '../services/socialPublisher';

const workspaceRoot = path.resolve(__dirname, '../../..');
const oauthAttempts = new Map<string, { platform: 'instagram' | 'tiktok'; redirectUri: string; codeVerifier: string | null; expiresAt: number }>();

function oauthBaseUrl(req: Request): string {
    return (process.env.SOCIAL_OAUTH_REDIRECT_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function oauthRedirectUri(req: Request, platform: 'instagram' | 'tiktok'): string {
    return `${oauthBaseUrl(req)}/dashboard/social/oauth/${platform}/callback`;
}

function createOauthAttempt(platform: 'instagram' | 'tiktok', redirectUri: string) {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = platform === 'tiktok' ? randomBytes(48).toString('base64url') : null;
    oauthAttempts.set(state, { platform, redirectUri, codeVerifier, expiresAt: Date.now() + 10 * 60_000 });
    return { state, codeVerifier };
}

function actor(): string {
    return process.env.DASHBOARD_USERNAME || 'dashboard-admin';
}

function revision(req: Request): number {
    const value = Number(req.body?.revision);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Gültige Revision ist erforderlich.');
    return value;
}

function handleError(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler.';
    const conflict = /zwischenzeitlich|Nur |pausiert|deaktiviert/.test(message);
    res.status(conflict ? 409 : 400).json({ error: message });
}

export function createSocialRouter(store: SocialPublicationStore): Router {
    const router = Router();

    router.get('/', (_req, res) => res.render('social'));

    router.get('/oauth/:platform/start', (req, res) => {
        const platform = req.params.platform;
        if (platform !== 'instagram' && platform !== 'tiktok') {
            res.status(404).send('Unbekannte Social-Media-Plattform.');
            return;
        }
        const redirectUri = oauthRedirectUri(req, platform);
        const { state, codeVerifier } = createOauthAttempt(platform, redirectUri);
        if (platform === 'instagram') {
            const url = new URL('https://www.facebook.com/v23.0/dialog/oauth');
            url.search = new URLSearchParams({
                client_id: process.env.META_APP_ID || '',
                redirect_uri: redirectUri,
                state,
                response_type: 'code',
                scope: 'pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish,business_management',
            }).toString();
            res.redirect(url.toString());
            return;
        }
        const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
        url.search = new URLSearchParams({
            client_key: process.env.TIKTOK_CLIENT_KEY || '',
            redirect_uri: redirectUri,
            state,
            response_type: 'code',
            scope: 'user.info.basic,video.upload,video.publish',
            code_challenge: createHash('sha256').update(codeVerifier!).digest('base64url'),
            code_challenge_method: 'S256',
        }).toString();
        res.redirect(url.toString());
    });

    router.get('/oauth/:platform/callback', async (req, res) => {
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const attempt = oauthAttempts.get(state);
        oauthAttempts.delete(state);
        if (!attempt || attempt.expiresAt < Date.now() || attempt.platform !== req.params.platform || !code) {
            res.redirect('/dashboard/social?oauth=invalid');
            return;
        }
        try {
            if (attempt.platform === 'instagram') await store.authorizeInstagram(code, attempt.redirectUri);
            else await store.authorizeTikTok(code, attempt.redirectUri, attempt.codeVerifier!);
            res.redirect(`/dashboard/social?oauth=${attempt.platform}-connected`);
        } catch (error) {
            console.error(`[SocialOAuth] ${attempt.platform} fehlgeschlagen:`, error);
            res.redirect(`/dashboard/social?oauth=${attempt.platform}-failed`);
        }
    });

    router.get('/publications', async (_req, res) => {
        res.json({ publications: await store.list(), platforms: store.platformStatus() });
    });

    router.post('/publications', async (req, res) => {
        try {
            const publication = await store.create({
                platform: String(req.body.platform || '') as SocialPlatform,
                content: String(req.body.content || ''),
                mediaUrl: typeof req.body.mediaUrl === 'string' ? req.body.mediaUrl : null,
                kind: String(req.body.kind || 'post') as PublicationKind,
                scheduledAt: typeof req.body.scheduledAt === 'string' ? req.body.scheduledAt : null,
                createdBy: actor(),
            });
            res.status(201).json({ publication });
        } catch (error) {
            handleError(res, error);
        }
    });

    router.post('/publications/:id/approve', async (req, res) => {
        try {
            res.json({ publication: await store.approve(req.params.id, revision(req), actor()) });
        } catch (error) {
            handleError(res, error);
        }
    });

    router.post('/publications/:id/reject', async (req, res) => {
        try {
            res.json({ publication: await store.reject(req.params.id, revision(req), actor()) });
        } catch (error) {
            handleError(res, error);
        }
    });

    router.post('/publications/:id/publish', async (req, res) => {
        try {
            res.json({ publication: await store.publish(req.params.id, revision(req)) });
        } catch (error) {
            handleError(res, error);
        }
    });

    return router;
}

export default createSocialRouter(new SocialPublicationStore(workspaceRoot));