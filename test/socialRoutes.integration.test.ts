import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createSocialRouter } from '../agent-dashboard/src/routes/social.js';
import { SocialPublicationStore } from '../agent-dashboard/src/services/socialPublisher.js';

test('social API persists drafts, requires approval and blocks publishing by default', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-api-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    delete process.env.SOCIAL_PUBLISHING_ENABLED;
    const app = express();
    app.use(express.json());
    app.use('/social', createSocialRouter(new SocialPublicationStore(root)));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve())));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}/social`;

    const createdResponse = await fetch(`${baseUrl}/publications`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'x', content: 'Integrationstest' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as any).publication;
    assert.equal(created.status, 'draft');

    const prematurePublish = await fetch(`${baseUrl}/publications/${created.id}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: created.revision }),
    });
    assert.equal(prematurePublish.status, 409);

    const approvedResponse = await fetch(`${baseUrl}/publications/${created.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: created.revision }),
    });
    assert.equal(approvedResponse.status, 200);
    const approved = (await approvedResponse.json() as any).publication;

    const disabledPublish = await fetch(`${baseUrl}/publications/${created.id}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: approved.revision }),
    });
    assert.equal(disabledPublish.status, 409);
    assert.match((await disabledPublish.json() as any).error, /global deaktiviert/);

    const listed = await fetch(`${baseUrl}/publications`).then(response => response.json() as Promise<any>);
    assert.equal(listed.publications.length, 1);
    assert.equal(listed.publications[0].status, 'approved');
    assert.equal(listed.platforms.some((item: any) => item.platform === 'linkedin'), false);
});

test('social OAuth starts use the current instance and official provider parameters', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-social-oauth-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const originalMetaAppId = process.env.META_APP_ID;
    const originalTikTokClientKey = process.env.TIKTOK_CLIENT_KEY;
    const originalRedirectBase = process.env.SOCIAL_OAUTH_REDIRECT_BASE_URL;
    process.env.META_APP_ID = 'meta-app-id';
    process.env.TIKTOK_CLIENT_KEY = 'tiktok-client-key';
    delete process.env.SOCIAL_OAUTH_REDIRECT_BASE_URL;
    t.after(() => {
        if (originalMetaAppId === undefined) delete process.env.META_APP_ID;
        else process.env.META_APP_ID = originalMetaAppId;
        if (originalTikTokClientKey === undefined) delete process.env.TIKTOK_CLIENT_KEY;
        else process.env.TIKTOK_CLIENT_KEY = originalTikTokClientKey;
        if (originalRedirectBase === undefined) delete process.env.SOCIAL_OAUTH_REDIRECT_BASE_URL;
        else process.env.SOCIAL_OAUTH_REDIRECT_BASE_URL = originalRedirectBase;
    });

    const app = express();
    app.use('/dashboard/social', createSocialRouter(new SocialPublicationStore(root)));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve())));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const instagramResponse = await fetch(`${baseUrl}/dashboard/social/oauth/instagram/start`, { redirect: 'manual' });
    const instagramUrl = new URL(instagramResponse.headers.get('location')!);
    assert.equal(instagramResponse.status, 302);
    assert.equal(instagramUrl.origin, 'https://www.facebook.com');
    assert.equal(instagramUrl.searchParams.get('client_id'), 'meta-app-id');
    assert.equal(instagramUrl.searchParams.get('redirect_uri'), `${baseUrl}/dashboard/social/oauth/instagram/callback`);
    assert.ok(instagramUrl.searchParams.get('state'));

    const tiktokResponse = await fetch(`${baseUrl}/dashboard/social/oauth/tiktok/start`, { redirect: 'manual' });
    const tiktokUrl = new URL(tiktokResponse.headers.get('location')!);
    assert.equal(tiktokResponse.status, 302);
    assert.equal(tiktokUrl.origin, 'https://www.tiktok.com');
    assert.equal(tiktokUrl.searchParams.get('client_key'), 'tiktok-client-key');
    assert.equal(tiktokUrl.searchParams.get('redirect_uri'), `${baseUrl}/dashboard/social/oauth/tiktok/callback`);
    assert.equal(tiktokUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(tiktokUrl.searchParams.get('code_challenge'));
    assert.ok(tiktokUrl.searchParams.get('state'));
});