import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import { buildServer } from '../src/server.js';
import type { AppContext } from '../src/services/context.js';
import { handleComment, handleMessage } from '../src/services/inbound.js';
import { runOne } from '../src/services/jobs.js';
import { createPromo, handlePublish, handleRender, mediaDir, requestPublish } from '../src/services/promo.js';
import { fakeFetch, json, pdaftarRoutes, testContext } from './helpers.js';

const IG = 'https://graph.instagram.com/v26.0';
const PHOTO = await readFile(new URL('./fixtures/product.jpg', import.meta.url));

function instagramRoutes(opts: { username?: string } = {}) {
  return (url: URL, init?: RequestInit) => {
    if (url.hostname === 'cdn.test') return new Response(PHOTO);
    if (!url.href.startsWith(IG)) return undefined;
    const path = url.pathname.replace('/v26.0', '');
    if (/^\/\d+$/.test(path) && (init?.method ?? 'GET') === 'GET' && url.searchParams.get('fields') === 'username,name') return json({ username: opts.username ?? 'stranger', name: 'X' });
    if (path === '/178/messages') return json({ recipient_id: '55', message_id: 'out-1' });
    if (/^\/c\d+\/replies$/.test(path)) return json({ id: 'reply-1' });
    if (path === '/178/content_publishing_limit') return json({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] });
    if (path === '/178/media') return json({ id: 'cont-1' });
    if (path === '/cont-1') return json({ status_code: 'FINISHED' });
    if (path === '/178/media_publish') return json({ id: 'media-9' });
    if (path === '/media-9') return json({ permalink: 'https://instagram.com/reel/abc' });
    return undefined;
  };
}

function seed(ctx: AppContext, settings: Record<string, unknown> = {}) {
  ctx.db
    .prepare('INSERT INTO workspaces (pdaftar_shop_id, shop_name, pdaftar_token_enc, settings_json) VALUES (729, ?, ?, ?)')
    .run('THEDEVS MCHJ', encrypt('pda_valid_token_123', ctx.config.encryptionKey), JSON.stringify(settings));
  ctx.db
    .prepare('INSERT INTO ig_accounts (workspace_id, ig_user_id, username, access_token_enc, token_expires_at) VALUES (1, ?, ?, ?, ?)')
    .run('178', 'thedevs_shop', encrypt('IGTOKEN', ctx.config.encryptionKey), '2099-01-01T00:00:00Z');
}

describe('session + auth', () => {
  it('signs in with a pDaftar token and rejects a bad one', async () => {
    const f = fakeFetch([pdaftarRoutes()]);
    const ctx = testContext(f.impl);
    const app = buildServer(ctx);
    const bad = await app.inject({ method: 'POST', url: '/api/session', payload: { token: 'pda_wrong_token_000' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/session', payload: { token: 'pda_valid_token_123' } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^pda_session=/);
    expect(String(ok.headers['set-cookie'])).toContain('Secure');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ shop: { id: 729, name: 'THEDEVS MCHJ' }, instagram: null, safeMode: true });
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    // The stored token is encrypted.
    const row = ctx.db.prepare('SELECT pdaftar_token_enc FROM workspaces').get() as { pdaftar_token_enc: string };
    expect(row.pdaftar_token_enc).not.toContain('pda_valid');
  });
});

describe('webhooks', () => {
  it('verifies the subscription handshake', async () => {
    const app = buildServer(testContext(fakeFetch([]).impl));
    const ok = await app.inject({ method: 'GET', url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify1&hub.challenge=42' });
    expect(ok.body).toBe('42');
    const no = await app.inject({ method: 'GET', url: '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42' });
    expect(no.statusCode).toBe(403);
  });

  it('requires a valid signature, dedupes retries and queues work', async () => {
    const ctx = testContext(fakeFetch([]).impl);
    seed(ctx);
    const app = buildServer(ctx);
    const payload = JSON.stringify({ object: 'instagram', entry: [{ id: '178', messaging: [{ sender: { id: '55' }, recipient: { id: '178' }, message: { mid: 'm-1', text: 'salom' } }] }] });
    const sig = `sha256=${createHmac('sha256', 'secret1').update(payload).digest('hex')}`;
    const unsigned = await app.inject({ method: 'POST', url: '/webhooks/instagram', payload, headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/webhooks/instagram', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
      expect(res.statusCode).toBe(200);
    }
    expect(ctx.db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type = 'message'`).get()).toEqual({ n: 1 });
  });
});

describe('DM replies', () => {
  const dm = (text: string, mid = 'm-1') => ({ kind: 'message', accountId: '178', senderId: '55', mid, text, imageUrls: [], timestamp: 1 });

  it('in safe mode, a stranger gets a grounded draft and nothing is sent', async () => {
    const f = fakeFetch([pdaftarRoutes(), instagramRoutes({ username: 'stranger' })]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE_ALLOWED_USERNAMES: 'pdaftar_uz' });
    seed(ctx, { autoSend: true });
    await handleMessage(ctx, dm('futbolka narxi qancha?'));
    const out = ctx.db.prepare(`SELECT text, status FROM messages WHERE direction = 'out'`).get() as { text: string; status: string };
    expect(out.status).toBe('draft');
    expect(out.text).toContain("189 000 so'm");
    // The owner hides the stock count for this product, so the reply must not reveal it.
    expect(out.text).not.toMatch(/Omborda 3/);
    expect(out.text).toContain('Mavjud');
    expect(f.calls.some((c) => c.url.endsWith('/178/messages'))).toBe(false);
  });

  it('an allowlisted tester gets the reply sent', async () => {
    const f = fakeFetch([pdaftarRoutes(), instagramRoutes({ username: 'pdaftar_uz' })]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE_ALLOWED_USERNAMES: '@pdaftar_uz' });
    seed(ctx, { autoSend: true });
    await handleMessage(ctx, dm('cola bormi?'));
    const send = f.calls.find((c) => c.url.endsWith('/178/messages'));
    expect(send).toBeDefined();
    expect(JSON.parse(send!.body!)).toMatchObject({ recipient: { id: '55' } });
    expect(ctx.db.prepare(`SELECT status FROM messages WHERE direction = 'out'`).get()).toEqual({ status: 'sent' });
    expect(ctx.db.prepare('SELECT replies FROM usage').get()).toEqual({ replies: 1 });
  });

  it('autoSend off keeps drafts even for testers, and the seller can approve one', async () => {
    const f = fakeFetch([pdaftarRoutes(), instagramRoutes({ username: 'pdaftar_uz' })]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE_ALLOWED_USERNAMES: 'pdaftar_uz' });
    seed(ctx, { autoSend: false });
    await handleMessage(ctx, dm('cola narxi?'));
    const draft = ctx.db.prepare(`SELECT id, status FROM messages WHERE direction = 'out'`).get() as { id: number; status: string };
    expect(draft.status).toBe('draft');
    const { sendDraft } = await import('../src/services/inbound.js');
    await sendDraft(ctx, 1, draft.id, 'Coca-Cola 1.5 L — 14 000 so‘m.');
    expect(ctx.db.prepare('SELECT status, handled_by FROM messages WHERE id = ?').get(draft.id)).toEqual({ status: 'sent', handled_by: 'human' });
  });

  it('never shows prices when the shop hides prices publicly', async () => {
    const hidden = (url: URL, init?: RequestInit) =>
      url.pathname.endsWith('/automation/shop')
        ? json({ data: { id: 729, name: 'THEDEVS MCHJ', currency: 'UZS', show_prices_publicly: false, order_url: null } })
        : pdaftarRoutes()(url, init);
    const f = fakeFetch([hidden, instagramRoutes({ username: 'pdaftar_uz' })]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE_ALLOWED_USERNAMES: 'pdaftar_uz' });
    seed(ctx, { autoSend: true });
    await handleMessage(ctx, dm('futbolka narxi qancha?', 'm-p'));
    const out = ctx.db.prepare(`SELECT text FROM messages WHERE direction = 'out'`).get() as { text: string };
    expect(out.text).not.toMatch(/189/);
  });

  it('never offers a product the owner hid from customers', async () => {
    const f = fakeFetch([pdaftarRoutes(), instagramRoutes({ username: 'pdaftar_uz' })]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE_ALLOWED_USERNAMES: 'pdaftar_uz' });
    seed(ctx, { autoSend: true });
    await handleMessage(ctx, dm('yashirin narxi?', 'm-h'));
    const out = ctx.db.prepare(`SELECT text FROM messages WHERE direction = 'out'`).get() as { text: string };
    expect(out.text).not.toContain('Yashirin');
    expect(out.text).not.toContain('99 000');
  });

  it('a person asking for an operator is handed off', async () => {
    const f = fakeFetch([pdaftarRoutes(), instagramRoutes({ username: 'pdaftar_uz' })]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE_ALLOWED_USERNAMES: 'pdaftar_uz' });
    seed(ctx, { autoSend: true });
    await handleMessage(ctx, dm('operator bilan gaplashmoqchiman'));
    expect(ctx.db.prepare('SELECT status FROM conversations').get()).toEqual({ status: 'handoff' });
    expect(f.calls.some((c) => c.url.endsWith('/178/messages'))).toBe(false);
  });
});

describe('comment replies', () => {
  it('a comment on a published Reel is answered about that product, without a public price', async () => {
    const f = fakeFetch([pdaftarRoutes(), instagramRoutes()]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE: 'false' });
    seed(ctx, { autoSend: true });
    ctx.db.prepare('INSERT INTO media_products (ig_media_id, workspace_id, product_ids_json) VALUES (?, 1, ?)').run('media-9', '[13]');
    await handleComment(ctx, { kind: 'comment', accountId: '178', commentId: 'c77', mediaId: 'media-9', fromId: '9', fromUsername: 'ali', text: 'narxi qancha?', parentId: null });
    const row = ctx.db.prepare('SELECT status, reply_text FROM comments').get() as { status: string; reply_text: string };
    expect(row.status).toBe('replied');
    expect(row.reply_text).toContain('Qora futbolka XL');
    expect(row.reply_text).not.toMatch(/189/);
    expect(f.calls.some((c) => c.url.endsWith('/c77/replies'))).toBe(true);
  });

  it('thread replies are left to the seller', async () => {
    const ctx = testContext(fakeFetch([pdaftarRoutes()]).impl);
    seed(ctx, { autoSend: true });
    await handleComment(ctx, { kind: 'comment', accountId: '178', commentId: 'c78', mediaId: null, fromId: '9', fromUsername: 'ali', text: 'ok', parentId: 'c1' });
    expect(ctx.db.prepare('SELECT status FROM comments').get()).toEqual({ status: 'skipped' });
  });
});

describe('promo video', () => {
  it('renders a Reel from pDaftar products and publishes it to the shop account', async () => {
    const f = fakeFetch([pdaftarRoutes(), instagramRoutes()]);
    const ctx = testContext(f.impl);
    seed(ctx);
    const id = createPromo(ctx, 1, { productIds: [11, 13], template: 'new' });
    await runOne(ctx, { render_video: handleRender });
    const v = ctx.db.prepare('SELECT status, video_file, caption, error FROM promo_videos WHERE id = ?').get(id) as { status: string; video_file: string; caption: string; error: string | null };
    expect(v.error).toBeNull();
    expect(v.status).toBe('ready');
    expect(existsSync(join(mediaDir(ctx), v.video_file))).toBe(true);
    expect(v.caption).toContain('#');

    requestPublish(ctx, 1, id, v.caption, null);
    await runOne(ctx, { publish_video: handlePublish });
    const p = ctx.db.prepare('SELECT status, ig_media_id, permalink FROM promo_videos WHERE id = ?').get(id);
    expect(p).toEqual({ status: 'published', ig_media_id: 'media-9', permalink: 'https://instagram.com/reel/abc' });
    const container = f.calls.find((c) => c.url.endsWith('/178/media'))!;
    expect(container.body).toContain('media_type=REELS');
    expect(container.body).toContain(encodeURIComponent(`https://automation.test/media/${v.video_file}`));
    expect(ctx.db.prepare('SELECT product_ids_json FROM media_products WHERE ig_media_id = ?').get('media-9')).toEqual({ product_ids_json: '[11,13]' });
  });

  it('refuses to publish without a connected account', async () => {
    const ctx = testContext(fakeFetch([pdaftarRoutes()]).impl);
    ctx.db.prepare('INSERT INTO workspaces (pdaftar_shop_id, shop_name, pdaftar_token_enc) VALUES (1, ?, ?)').run('S', encrypt('x', ctx.config.encryptionKey));
    ctx.db.prepare(`INSERT INTO promo_videos (workspace_id, product_ids_json, template, status) VALUES (1, '[1]', 'product', 'ready')`).run();
    expect(() => requestPublish(ctx, 1, 1, 'cap', null)).toThrow('Connect Instagram first');
  });
});

describe('web app serving', () => {
  it('serves files added after startup and falls back to index.html for app routes only', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dist = mkdtempSync(join(tmpdir(), 'dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
    const ctx = testContext(fakeFetch([]).impl, { WEB_DIST_DIR: dist });
    const app = buildServer(ctx);
    await app.ready();
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'new.js'), 'console.log(1)');
    const js = await app.inject({ method: 'GET', url: '/assets/new.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    const page = await app.inject({ method: 'GET', url: '/app/studio' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>app</title>');
    expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
  });
});
