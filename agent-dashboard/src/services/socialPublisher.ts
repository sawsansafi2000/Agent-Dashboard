import { createHmac, randomBytes, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

export type SocialPlatform = 'x' | 'facebook' | 'instagram' | 'tiktok' | 'youtube';
export type PublicationStatus = 'draft' | 'approved' | 'publishing' | 'published' | 'rejected' | 'failed';
export type PublicationKind = 'post' | 'story';

export interface SocialPublication {
    id: string;
    platform: SocialPlatform;
    content: string;
    mediaUrl: string | null;
    kind: PublicationKind;
    scheduledAt: string | null;
    status: PublicationStatus;
    revision: number;
    createdBy: string;
    approvedBy: string | null;
    approvedAt: string | null;
    publishedAt: string | null;
    providerPostId: string | null;
    providerUrl: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

interface PublicationDocument {
    version: 1;
    publications: SocialPublication[];
}

interface SocialTokenDocument {
    version: 1;
    metaAccessToken: string | null;
    tiktokAccessToken: string | null;
    tiktokRefreshToken: string | null;
    updatedAt: string | null;
}

export interface CreatePublicationInput {
    platform: SocialPlatform;
    content: string;
    mediaUrl?: string | null;
    kind?: PublicationKind;
    scheduledAt?: string | null;
    createdBy: string;
}

export interface SocialPlatformStatus {
    platform: SocialPlatform;
    configured: boolean;
    publishingEnabled: boolean;
    reason: string | null;
}

interface ProviderResult {
    postId: string;
    url: string | null;
}

type Fetcher = typeof fetch;

const platforms = new Set<SocialPlatform>(['x', 'facebook', 'instagram', 'tiktok', 'youtube']);

export class SocialPublicationStore {
    private readonly file: string;
    private readonly tokenFile: string;
    private readonly lockDirectory: string;

    constructor(rootDirectory: string, private readonly fetcher: Fetcher = fetch) {
        this.file = path.join(rootDirectory, 'data', 'social-publications.json');
        this.tokenFile = path.join(rootDirectory, 'data', 'social-oauth-tokens.json');
        this.lockDirectory = `${this.file}.lock`;
    }

    async list(): Promise<SocialPublication[]> {
        return (await this.read()).publications;
    }

    async authorizeInstagram(code: string, redirectUri: string): Promise<void> {
        const response = await this.requestJson('https://graph.facebook.com/v23.0/oauth/access_token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: this.requiredEnvironment('META_APP_ID'),
                client_secret: this.requiredEnvironment('META_APP_SECRET'),
                redirect_uri: redirectUri,
                code,
            }),
        });
        const shortLivedToken = this.requiredResponseId(response, 'access_token');
        const exchangeUrl = new URL('https://graph.facebook.com/v23.0/oauth/access_token');
        exchangeUrl.search = new URLSearchParams({
            grant_type: 'fb_exchange_token',
            client_id: this.requiredEnvironment('META_APP_ID'),
            client_secret: this.requiredEnvironment('META_APP_SECRET'),
            fb_exchange_token: shortLivedToken,
        }).toString();
        const exchange = await this.requestJson(exchangeUrl.toString(), { method: 'GET' });
        const tokens = await this.readTokens();
        tokens.metaAccessToken = this.requiredResponseId(exchange, 'access_token');
        process.env.META_LONG_LIVED_TOKEN = tokens.metaAccessToken;
        process.env.META_TOKEN_STATUS = 'healthy';
        await this.writeTokens(tokens);
    }

    async authorizeTikTok(code: string, redirectUri: string, codeVerifier: string): Promise<void> {
        const response = await this.requestJson('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_key: this.requiredEnvironment('TIKTOK_CLIENT_KEY'),
                client_secret: this.requiredEnvironment('TIKTOK_CLIENT_SECRET'),
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier,
            }),
        });
        const tokens = await this.readTokens();
        tokens.tiktokAccessToken = this.requiredResponseId(response, 'access_token');
        tokens.tiktokRefreshToken = this.requiredResponseId(response, 'refresh_token');
        process.env.TIKTOK_ACCESS_TOKEN = tokens.tiktokAccessToken;
        process.env.TIKTOK_REFRESH_TOKEN = tokens.tiktokRefreshToken;
        process.env.TIKTOK_TOKEN_STATUS = 'healthy';
        await this.writeTokens(tokens);
    }

    platformStatus(): SocialPlatformStatus[] {
        const enabled = process.env.SOCIAL_PUBLISHING_ENABLED === 'true';
        return ([
            ['x', Boolean(process.env.X_API_KEY && process.env.X_API_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET), null],
            ['facebook', Boolean(process.env.META_LONG_LIVED_TOKEN && process.env.FACEBOOK_PAGE_ID), null],
            ['instagram', Boolean(process.env.META_LONG_LIVED_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID)
                && process.env.META_TOKEN_STATUS !== 'blocked', process.env.META_TOKEN_STATUS === 'blocked' ? 'Token-Erneuerung erforderlich.' : null],
            ['tiktok', Boolean(process.env.TIKTOK_ACCESS_TOKEN) && process.env.TIKTOK_TOKEN_STATUS !== 'blocked',
                process.env.TIKTOK_TOKEN_STATUS === 'blocked' ? 'Token-Erneuerung erforderlich.' : null],
            ['youtube', Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN), null],
        ] as Array<[SocialPlatform, boolean, string | null]>).map(([platform, configured, fixedReason]) => ({
            platform,
            configured,
            publishingEnabled: enabled && configured,
            reason: fixedReason || (!enabled ? 'Veröffentlichung ist global deaktiviert.' : !configured ? 'Zugangsdaten fehlen.' : null),
        }));
    }

    async create(input: CreatePublicationInput): Promise<SocialPublication> {
        if (!platforms.has(input.platform)) throw new Error('Unbekannte Social-Media-Plattform.');
        const content = input.content.trim();
        const createdBy = input.createdBy.trim();
        const kind = input.kind || 'post';
        if (!content || content.length > 5_000) throw new Error('Inhalt muss zwischen 1 und 5.000 Zeichen lang sein.');
        if (!createdBy) throw new Error('Ersteller ist erforderlich.');
        if (kind !== 'post' && kind !== 'story') throw new Error('Unbekannter Inhaltstyp.');
        if (kind === 'story' && input.platform !== 'instagram') throw new Error('Stories werden derzeit nur für Instagram unterstützt.');
        const mediaUrl = this.normalizeMediaUrl(input.mediaUrl);
        if ((input.platform === 'instagram' || input.platform === 'tiktok' || input.platform === 'youtube') && !mediaUrl) {
            throw new Error(`${input.platform} erfordert eine öffentliche HTTPS-Medien-URL.`);
        }
        const now = new Date().toISOString();
        const scheduledAt = this.normalizeScheduledAt(input.scheduledAt);
        const publication: SocialPublication = {
            id: randomUUID(),
            platform: input.platform,
            content,
            mediaUrl,
            kind,
            scheduledAt,
            status: 'draft',
            revision: 1,
            createdBy,
            approvedBy: null,
            approvedAt: null,
            publishedAt: null,
            providerPostId: null,
            providerUrl: null,
            error: null,
            createdAt: now,
            updatedAt: now,
        };
        return this.mutate(document => {
            document.publications.push(publication);
            return publication;
        });
    }

    async publishApproved(): Promise<SocialPublication[]> {
        if (process.env.SOCIAL_AUTONOMOUS_PUBLISHING_ENABLED !== 'true') return [];
        const now = Date.now();
        const approved = (await this.list()).filter(publication => publication.status === 'approved'
            && (!publication.scheduledAt || Date.parse(publication.scheduledAt) <= now));
        const results: SocialPublication[] = [];
        for (const publication of approved) {
            try {
                results.push(await this.publish(publication.id, publication.revision));
            } catch (error) {
                console.error(`[SocialAutomation] ${publication.platform} ${publication.id} fehlgeschlagen:`, error);
            }
        }
        return results;
    }

    async refreshProviderTokens(): Promise<Array<{ platform: 'instagram' | 'tiktok'; refreshed: boolean; reason: string | null }>> {
        const results: Array<{ platform: 'instagram' | 'tiktok'; refreshed: boolean; reason: string | null }> = [];
        const tokens = await this.readTokens();

        const metaToken = tokens.metaAccessToken || process.env.META_LONG_LIVED_TOKEN?.trim();
        if (metaToken && process.env.META_APP_ID && process.env.META_APP_SECRET) {
            try {
                const url = new URL('https://graph.facebook.com/v23.0/oauth/access_token');
                url.search = new URLSearchParams({
                    grant_type: 'fb_exchange_token',
                    client_id: process.env.META_APP_ID,
                    client_secret: process.env.META_APP_SECRET,
                    fb_exchange_token: metaToken,
                }).toString();
                const response = await this.requestJson(url.toString(), { method: 'GET' });
                tokens.metaAccessToken = this.requiredResponseId(response, 'access_token');
                process.env.META_LONG_LIVED_TOKEN = tokens.metaAccessToken;
                process.env.META_TOKEN_STATUS = 'healthy';
                results.push({ platform: 'instagram', refreshed: true, reason: null });
            } catch (error) {
                process.env.META_TOKEN_STATUS = 'blocked';
                results.push({ platform: 'instagram', refreshed: false, reason: error instanceof Error ? error.message : String(error) });
            }
        } else {
            results.push({ platform: 'instagram', refreshed: false, reason: 'Meta-App-Zugang oder Ausgangstoken fehlt.' });
        }

        const tiktokRefreshToken = tokens.tiktokRefreshToken || process.env.TIKTOK_REFRESH_TOKEN?.trim();
        if (tiktokRefreshToken && process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET) {
            try {
                const response = await this.requestJson('https://open.tiktokapis.com/v2/oauth/token/', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_key: process.env.TIKTOK_CLIENT_KEY,
                        client_secret: process.env.TIKTOK_CLIENT_SECRET,
                        grant_type: 'refresh_token',
                        refresh_token: tiktokRefreshToken,
                    }),
                });
                tokens.tiktokAccessToken = this.requiredResponseId(response, 'access_token');
                tokens.tiktokRefreshToken = this.requiredResponseId(response, 'refresh_token');
                process.env.TIKTOK_ACCESS_TOKEN = tokens.tiktokAccessToken;
                process.env.TIKTOK_REFRESH_TOKEN = tokens.tiktokRefreshToken;
                process.env.TIKTOK_TOKEN_STATUS = 'healthy';
                results.push({ platform: 'tiktok', refreshed: true, reason: null });
            } catch (error) {
                process.env.TIKTOK_TOKEN_STATUS = 'blocked';
                results.push({ platform: 'tiktok', refreshed: false, reason: error instanceof Error ? error.message : String(error) });
            }
        } else {
            results.push({ platform: 'tiktok', refreshed: false, reason: 'TikTok-Refresh-Token oder App-Zugang fehlt.' });
        }

        if (results.some(result => result.refreshed)) await this.writeTokens(tokens);
        return results;
    }

    async approve(id: string, revision: number, approvedBy: string): Promise<SocialPublication> {
        return this.update(id, revision, publication => {
            if (publication.status !== 'draft') throw new Error('Nur Entwürfe können freigegeben werden.');
            if (!approvedBy.trim()) throw new Error('Freigebende Person ist erforderlich.');
            publication.status = 'approved';
            publication.approvedBy = approvedBy.trim();
            publication.approvedAt = new Date().toISOString();
            publication.error = null;
        });
    }

    async reject(id: string, revision: number, rejectedBy: string): Promise<SocialPublication> {
        return this.update(id, revision, publication => {
            if (publication.status !== 'draft' && publication.status !== 'approved') {
                throw new Error('Nur Entwürfe oder Freigaben können abgelehnt werden.');
            }
            if (!rejectedBy.trim()) throw new Error('Ablehnende Person ist erforderlich.');
            publication.status = 'rejected';
            publication.approvedBy = null;
            publication.approvedAt = null;
            publication.error = `Abgelehnt von ${rejectedBy.trim()}`;
        });
    }

    async publish(id: string, revision: number): Promise<SocialPublication> {
        const publishing = await this.update(id, revision, publication => {
            if (process.env.SOCIAL_PUBLISHING_ENABLED !== 'true') {
                throw new Error('Social Publishing ist global deaktiviert.');
            }
            if (publication.status !== 'approved' || !publication.approvedBy || !publication.approvedAt) {
                throw new Error('Nur explizit freigegebene Beiträge können veröffentlicht werden.');
            }
            const status = this.platformStatus().find(candidate => candidate.platform === publication.platform);
            if (!status?.publishingEnabled) throw new Error(status?.reason || 'Plattform ist nicht verfügbar.');
            publication.status = 'publishing';
            publication.error = null;
        });

        try {
            const result = await this.publishToProvider(publishing);
            return this.update(publishing.id, publishing.revision, publication => {
                if (publication.status !== 'publishing') throw new Error('Beitrag ist nicht in Veröffentlichung.');
                publication.status = 'published';
                publication.publishedAt = new Date().toISOString();
                publication.providerPostId = result.postId;
                publication.providerUrl = result.url;
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.update(publishing.id, publishing.revision, publication => {
                if (publication.status !== 'publishing') return;
                publication.status = 'failed';
                publication.error = message;
            });
            throw error;
        }
    }

    private async publishToProvider(publication: SocialPublication): Promise<ProviderResult> {
        if (publication.platform === 'x') return this.publishToX(publication);
        if (publication.platform === 'facebook') return this.publishToFacebook(publication);
        if (publication.platform === 'instagram') return this.publishToInstagram(publication);
        if (publication.platform === 'tiktok') return this.publishToTikTok(publication);
        if (publication.platform === 'youtube') return this.publishToYouTube(publication);
        throw new Error('Plattform wird nicht unterstützt.');
    }

    private async publishToX(publication: SocialPublication): Promise<ProviderResult> {
        const url = 'https://api.x.com/2/tweets';
        const response = await this.requestJson(url, {
            method: 'POST',
            headers: { authorization: this.xOAuthHeader(url, 'POST'), 'content-type': 'application/json' },
            body: JSON.stringify({ text: publication.content }),
        });
        const postId = this.requiredResponseId(response.data, 'id');
        const username = process.env.X_USERNAME?.trim();
        return { postId, url: username ? `https://x.com/${encodeURIComponent(username)}/status/${postId}` : null };
    }

    private async publishToFacebook(publication: SocialPublication): Promise<ProviderResult> {
        const token = this.requiredEnvironment('META_LONG_LIVED_TOKEN');
        const pageId = this.requiredEnvironment('FACEBOOK_PAGE_ID');
        const body = new URLSearchParams({ message: publication.content, access_token: token });
        if (publication.mediaUrl) body.set('link', publication.mediaUrl);
        const response = await this.requestJson(`https://graph.facebook.com/v23.0/${encodeURIComponent(pageId)}/feed`, {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
        });
        const postId = this.requiredResponseId(response, 'id');
        return { postId, url: `https://www.facebook.com/${postId.replace('_', '/posts/')}` };
    }

    private async publishToInstagram(publication: SocialPublication): Promise<ProviderResult> {
        const token = this.requiredEnvironment('META_LONG_LIVED_TOKEN');
        const accountId = this.requiredEnvironment('INSTAGRAM_ACCOUNT_ID');
        if (!publication.mediaUrl) throw new Error('Instagram erfordert eine öffentliche HTTPS-Medien-URL.');
        const creation = await this.requestJson(`https://graph.facebook.com/v23.0/${encodeURIComponent(accountId)}/media`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                image_url: publication.mediaUrl,
                ...(publication.kind === 'story' ? { media_type: 'STORIES' } : { caption: publication.content }),
                access_token: token,
            }),
        });
        const creationId = this.requiredResponseId(creation, 'id');
        const published = await this.requestJson(`https://graph.facebook.com/v23.0/${encodeURIComponent(accountId)}/media_publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ creation_id: creationId, access_token: token }),
        });
        const postId = this.requiredResponseId(published, 'id');
        return { postId, url: null };
    }

    private async publishToTikTok(publication: SocialPublication): Promise<ProviderResult> {
        const token = this.requiredEnvironment('TIKTOK_ACCESS_TOKEN');
        if (!publication.mediaUrl) throw new Error('TikTok erfordert eine öffentliche HTTPS-Medien-URL.');
        const response = await this.requestJson('https://open.tiktokapis.com/v2/post/publish/video/init/', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({
                post_info: { title: publication.content, privacy_level: 'SELF_ONLY', disable_comment: false },
                source_info: { source: 'PULL_FROM_URL', video_url: publication.mediaUrl },
            }),
        });
        return { postId: this.requiredResponseId(response.data, 'publish_id'), url: null };
    }

    private async publishToYouTube(publication: SocialPublication): Promise<ProviderResult> {
        if (!publication.mediaUrl) throw new Error('YouTube erfordert eine öffentliche HTTPS-Medien-URL.');
        const clientId = this.requiredEnvironment('YOUTUBE_CLIENT_ID');
        const clientSecret = this.requiredEnvironment('YOUTUBE_CLIENT_SECRET');
        const refreshToken = this.requiredEnvironment('YOUTUBE_REFRESH_TOKEN');
        const tokenResponse = await this.requestJson('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        });
        const accessToken = this.requiredResponseId(tokenResponse, 'access_token');
        const mediaResponse = await this.fetcher(publication.mediaUrl, { signal: AbortSignal.timeout(30_000) });
        if (!mediaResponse.ok) throw new Error(`YouTube-Medium konnte nicht geladen werden: HTTP ${mediaResponse.status}`);
        const contentLength = Number(mediaResponse.headers.get('content-length') || 0);
        if (contentLength > 100 * 1024 * 1024) throw new Error('YouTube-Medium überschreitet das Upload-Limit von 100 MB.');
        const media = await mediaResponse.arrayBuffer();
        if (media.byteLength > 100 * 1024 * 1024) throw new Error('YouTube-Medium überschreitet das Upload-Limit von 100 MB.');
        const uploadSession = await this.fetcher('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ snippet: { title: publication.content.slice(0, 100), description: publication.content }, status: { privacyStatus: 'private' } }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!uploadSession.ok) throw new Error(`YouTube-Upload konnte nicht initialisiert werden: HTTP ${uploadSession.status}`);
        const uploadUrl = uploadSession.headers.get('location');
        if (!uploadUrl) throw new Error('YouTube lieferte keine Upload-URL.');
        const uploaded = await this.requestJson(uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': mediaResponse.headers.get('content-type') || 'application/octet-stream' },
            body: media,
        });
        const postId = this.requiredResponseId(uploaded, 'id');
        return { postId, url: `https://youtu.be/${postId}` };
    }

    private xOAuthHeader(url: string, method: string): string {
        const consumerKey = this.requiredEnvironment('X_API_KEY');
        const consumerSecret = this.requiredEnvironment('X_API_SECRET');
        const token = this.requiredEnvironment('X_ACCESS_TOKEN');
        const tokenSecret = this.requiredEnvironment('X_ACCESS_TOKEN_SECRET');
        const parameters: Record<string, string> = {
            oauth_consumer_key: consumerKey,
            oauth_nonce: randomBytes(16).toString('hex'),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
            oauth_token: token,
            oauth_version: '1.0',
        };
        const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        const parameterString = Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
        const signatureBase = `${method.toUpperCase()}&${encode(url)}&${encode(parameterString)}`;
        parameters.oauth_signature = createHmac('sha1', `${encode(consumerSecret)}&${encode(tokenSecret)}`).update(signatureBase).digest('base64');
        return `OAuth ${Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${encode(key)}="${encode(value)}"`).join(', ')}`;
    }

    private async requestJson(url: string, init: RequestInit): Promise<any> {
        const response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
        const body = await response.json().catch(() => ({})) as any;
        if (!response.ok) {
            const providerMessage = body?.error?.message || body?.error?.code || body?.message || `HTTP ${response.status}`;
            throw new Error(`Social Provider abgelehnt: ${providerMessage}`);
        }
        return body;
    }

    private requiredEnvironment(name: string): string {
        const value = process.env[name]?.trim();
        if (!value) throw new Error(`${name} ist nicht konfiguriert.`);
        return value;
    }

    private requiredResponseId(value: any, key: string): string {
        const id = value?.[key];
        if (typeof id !== 'string' || !id.trim()) throw new Error(`Social Provider lieferte keine ${key}.`);
        return id;
    }

    private async update(
        id: string,
        revision: number,
        change: (publication: SocialPublication) => void,
    ): Promise<SocialPublication> {
        return this.mutate(document => {
            const publication = document.publications.find(candidate => candidate.id === id);
            if (!publication) throw new Error('Social-Media-Beitrag wurde nicht gefunden.');
            if (publication.revision !== revision) throw new Error('Beitrag wurde zwischenzeitlich geändert.');
            change(publication);
            publication.revision += 1;
            publication.updatedAt = new Date().toISOString();
            return publication;
        });
    }

    private normalizeMediaUrl(value?: string | null): string | null {
        const normalized = value?.trim();
        if (!normalized) return null;
        const url = new URL(normalized);
        if (url.protocol !== 'https:') throw new Error('Medien-URL muss HTTPS verwenden.');
        return url.toString();
    }

    private normalizeScheduledAt(value?: string | null): string | null {
        const normalized = value?.trim();
        if (!normalized) return null;
        const timestamp = Date.parse(normalized);
        if (!Number.isFinite(timestamp)) throw new Error('Ungültiger Veröffentlichungszeitpunkt.');
        return new Date(timestamp).toISOString();
    }

    private async mutate<T>(change: (document: PublicationDocument) => T): Promise<T> {
        const release = await this.acquireLock();
        try {
            const document = await this.read();
            const result = change(document);
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            const temporaryFile = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
            await fs.writeFile(temporaryFile, JSON.stringify(document, null, 2), 'utf8');
            await fs.rename(temporaryFile, this.file);
            return result;
        } finally {
            await release();
        }
    }

    private async read(): Promise<PublicationDocument> {
        try {
            const document = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PublicationDocument>;
            return {
                version: 1,
                publications: Array.isArray(document.publications)
                    ? document.publications.map(publication => ({
                        ...publication,
                        kind: publication.kind || 'post',
                        scheduledAt: publication.scheduledAt || null,
                    }))
                    : [],
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, publications: [] };
            throw error;
        }
    }

    private async readTokens(): Promise<SocialTokenDocument> {
        try {
            const document = JSON.parse(await fs.readFile(this.tokenFile, 'utf8')) as Partial<SocialTokenDocument>;
            return {
                version: 1,
                metaAccessToken: document.metaAccessToken || null,
                tiktokAccessToken: document.tiktokAccessToken || null,
                tiktokRefreshToken: document.tiktokRefreshToken || null,
                updatedAt: document.updatedAt || null,
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { version: 1, metaAccessToken: null, tiktokAccessToken: null, tiktokRefreshToken: null, updatedAt: null };
            }
            throw error;
        }
    }

    private async writeTokens(tokens: SocialTokenDocument): Promise<void> {
        await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
        const temporaryFile = `${this.tokenFile}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify({ ...tokens, updatedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryFile, this.tokenFile);
    }

    private async acquireLock(): Promise<() => Promise<void>> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const deadline = Date.now() + 10_000;
        while (true) {
            try {
                await fs.mkdir(this.lockDirectory);
                return () => fs.rm(this.lockDirectory, { recursive: true, force: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
    }
}