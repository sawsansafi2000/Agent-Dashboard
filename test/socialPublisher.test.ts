import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SocialPublicationStore } from '../agent-dashboard/src/services/socialPublisher.js';

test('requires an explicit, revision-safe approval before publication', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new SocialPublicationStore(root);
    const draft = await store.create({ platform: 'x', content: 'Challenge startet.', createdBy: 'content-agent' });

    assert.equal(draft.status, 'draft');
    const approved = await store.approve(draft.id, draft.revision, 'admin');
    assert.equal(approved.status, 'approved');
    await assert.rejects(() => store.approve(draft.id, draft.revision, 'admin'), /zwischenzeitlich geändert/);
});

test('rejects unknown platforms and requires media for visual platforms', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new SocialPublicationStore(root);

    await assert.rejects(
        () => store.create({ platform: 'linkedin' as any, content: 'Nicht veröffentlichen.', createdBy: 'content-agent' }),
        /Unbekannte Social-Media-Plattform/,
    );
    await assert.rejects(
        () => store.create({ platform: 'instagram', content: 'Bildbeitrag', createdBy: 'content-agent' }),
        /Medien-URL/,
    );
});

test('publishes only approved posts when the global switch is enabled', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => {
        delete process.env.SOCIAL_PUBLISHING_ENABLED;
        delete process.env.X_ACCESS_TOKEN;
        delete process.env.X_ACCESS_TOKEN_SECRET;
        delete process.env.X_API_KEY;
        delete process.env.X_API_SECRET;
        delete process.env.X_USERNAME;
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ data: { id: 'post-42' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    const store = new SocialPublicationStore(root, fetcher);
    const draft = await store.create({ platform: 'x', content: 'Freigegebener Beitrag', createdBy: 'content-agent' });
    const approved = await store.approve(draft.id, draft.revision, 'admin');

    await assert.rejects(() => store.publish(approved.id, approved.revision), /global deaktiviert/);
    assert.equal(requests.length, 0);

    process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
    process.env.X_ACCESS_TOKEN = 'test-token';
    process.env.X_ACCESS_TOKEN_SECRET = 'test-token-secret';
    process.env.X_API_KEY = 'test-api-key';
    process.env.X_API_SECRET = 'test-api-secret';
    process.env.X_USERNAME = 'naturvitale';
    const published = await store.publish(approved.id, approved.revision);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.x.com/2/tweets');
    assert.match(String((requests[0].init?.headers as Record<string, string>)?.authorization), /^OAuth /);
    assert.match(String(requests[0].init?.body), /Freigegebener Beitrag/);
    assert.equal(published.status, 'published');
    assert.equal(published.providerPostId, 'post-42');
    assert.equal(published.providerUrl, 'https://x.com/naturvitale/status/post-42');
});

test('persists provider failures without retrying automatically', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => {
        delete process.env.SOCIAL_PUBLISHING_ENABLED;
        delete process.env.X_ACCESS_TOKEN;
        delete process.env.X_ACCESS_TOKEN_SECRET;
        delete process.env.X_API_KEY;
        delete process.env.X_API_SECRET;
    });
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
    process.env.X_ACCESS_TOKEN = 'test-token';
    process.env.X_ACCESS_TOKEN_SECRET = 'test-token-secret';
    process.env.X_API_KEY = 'test-api-key';
    process.env.X_API_SECRET = 'test-api-secret';
    const fetcher = (async () => new Response(JSON.stringify({ error: { message: 'Token abgelaufen' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const store = new SocialPublicationStore(root, fetcher);
    const draft = await store.create({ platform: 'x', content: 'Nicht doppelt senden', createdBy: 'content-agent' });
    const approved = await store.approve(draft.id, draft.revision, 'admin');

    await assert.rejects(() => store.publish(approved.id, approved.revision), /Token abgelaufen/);
    const [failed] = await store.list();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error || '', /Token abgelaufen/);
});

test('autonomous publishing still requires an explicit approval and publishes each approved item once', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => {
        delete process.env.SOCIAL_AUTONOMOUS_PUBLISHING_ENABLED;
        delete process.env.SOCIAL_PUBLISHING_ENABLED;
        delete process.env.X_ACCESS_TOKEN;
        delete process.env.X_ACCESS_TOKEN_SECRET;
        delete process.env.X_API_KEY;
        delete process.env.X_API_SECRET;
    });
    process.env.SOCIAL_AUTONOMOUS_PUBLISHING_ENABLED = 'true';
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
    process.env.X_ACCESS_TOKEN = 'test-token';
    process.env.X_ACCESS_TOKEN_SECRET = 'test-token-secret';
    process.env.X_API_KEY = 'test-api-key';
    process.env.X_API_SECRET = 'test-api-secret';
    let requests = 0;
    const fetcher = (async () => {
        requests += 1;
        return new Response(JSON.stringify({ data: { id: 'autonomous-post' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    const store = new SocialPublicationStore(root, fetcher);
    const publication = await store.create({ platform: 'x', content: 'Autonomer Beitrag', createdBy: 'campaign-agent' });

    assert.equal(publication.status, 'draft');
    assert.equal((await store.publishApproved()).length, 0);
    const approved = await store.approve(publication.id, publication.revision, 'admin');
    assert.equal(approved.status, 'approved');
    assert.equal((await store.publishApproved()).length, 1);
    assert.equal((await store.publishApproved()).length, 0);
    assert.equal(requests, 1);
});

test('refreshes TikTok access tokens through the official refresh-token grant', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => {
        delete process.env.TIKTOK_ACCESS_TOKEN;
        delete process.env.TIKTOK_REFRESH_TOKEN;
        delete process.env.TIKTOK_CLIENT_KEY;
        delete process.env.TIKTOK_CLIENT_SECRET;
    });
    process.env.TIKTOK_REFRESH_TOKEN = 'refresh-old';
    process.env.TIKTOK_CLIENT_KEY = 'client-key';
    process.env.TIKTOK_CLIENT_SECRET = 'client-secret';
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    const store = new SocialPublicationStore(root, fetcher);
    const results = await store.refreshProviderTokens();

    assert.equal(results.find(result => result.platform === 'tiktok')?.refreshed, true);
    assert.equal(process.env.TIKTOK_ACCESS_TOKEN, 'access-new');
    assert.equal(process.env.TIKTOK_REFRESH_TOKEN, 'refresh-new');
    assert.equal(requests[0].url, 'https://open.tiktokapis.com/v2/oauth/token/');
    assert.match(requests[0].body, /grant_type=refresh_token/);
});

test('publishes only due scheduled content and maps Instagram stories to STORIES', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => {
        delete process.env.SOCIAL_AUTONOMOUS_PUBLISHING_ENABLED;
        delete process.env.SOCIAL_PUBLISHING_ENABLED;
        delete process.env.META_LONG_LIVED_TOKEN;
        delete process.env.INSTAGRAM_ACCOUNT_ID;
    });
    process.env.SOCIAL_AUTONOMOUS_PUBLISHING_ENABLED = 'true';
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true';
    process.env.META_LONG_LIVED_TOKEN = 'meta-token';
    process.env.INSTAGRAM_ACCOUNT_ID = 'instagram-id';
    const bodies: string[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ id: bodies.length === 1 ? 'container-id' : 'story-id' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    const store = new SocialPublicationStore(root, fetcher);
    const story = await store.create({ platform: 'instagram', kind: 'story', content: 'Story', mediaUrl: 'https://example.com/story.jpg', createdBy: 'campaign-agent' });
    const later = await store.create({ platform: 'instagram', content: 'Später', mediaUrl: 'https://example.com/later.jpg', scheduledAt: '2999-01-01T00:00:00.000Z', createdBy: 'campaign-agent' });
    await store.approve(story.id, story.revision, 'admin');
    await store.approve(later.id, later.revision, 'admin');

    assert.equal((await store.publishApproved()).length, 1);
    assert.match(bodies[0], /media_type=STORIES/);
    assert.equal((await store.list()).filter(publication => publication.status === 'approved').length, 1);
});