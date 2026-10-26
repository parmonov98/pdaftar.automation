import { describe, expect, it } from 'vitest';
import { parseWebhook } from '../src/instagram/webhook.js';
import { encrypt } from '../src/lib/crypto.js';
import { acceptEvent } from '../src/services/inbound.js';
import { runOne } from '../src/services/jobs.js';
import { handleSocialEvent } from '../src/services/social.js';
import { fakeFetch, json, testContext } from './helpers.js';

const IG = 'https://graph.instagram.com/v26.0';

function igRoutes(url: URL) {
  if (!url.href.startsWith(IG)) return undefined;
  const path = url.pathname.replace('/v26.0', '');
  if (path === '/55') return json({ username: 'Ali_Shop', name: 'Ali', is_user_follow_business: true });
  if (path === '/m1') return json({ permalink: 'https://www.instagram.com/p/DaAxjL4MFE6/' });
  return undefined;
}

function setup(env: Record<string, string>, pdaftarStatus = 200) {
  const seen: unknown[] = [];
  const pdaftar = (url: URL, init?: RequestInit) => {
    if (!url.pathname.endsWith('/social-events')) return undefined;
    seen.push({ auth: (init?.headers as Record<string, string>).Authorization, body: JSON.parse(String(init?.body)) });
    return json({ data: { outcome: 'approved' } }, pdaftarStatus);
  };
  const f = fakeFetch([igRoutes, pdaftar]);
  const ctx = testContext(f.impl, env);
  ctx.db.prepare(`INSERT INTO workspaces (pdaftar_shop_id, shop_name, pdaftar_token_enc) VALUES (1, 'pDaftar', ?)`).run(encrypt('pda_x', ctx.config.encryptionKey));
  ctx.db.prepare(`INSERT INTO ig_accounts (workspace_id, ig_user_id, username, access_token_enc) VALUES (1, '178', 'pdaftar.uz', ?)`).run(encrypt('T', ctx.config.encryptionKey));
  return { ctx, seen, f };
}

const OFFICIAL = { IG_OFFICIAL_ACCOUNT_IDS: '178', PDAFTAR_SOCIAL_TOKEN: 'pda_social_token_000000000000000000000000' };

describe('ambassador task verification', () => {
  it('parses a story mention instead of treating it as an empty DM', () => {
    const events = parseWebhook({
      object: 'instagram',
      entry: [{ id: '178', messaging: [{ sender: { id: '55' }, recipient: { id: '178' }, timestamp: 9, message: { mid: 'sm1', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn/story' } }] } }] }],
    });
    expect(events).toEqual([{ kind: 'story_mention', accountId: '178', senderId: '55', mid: 'sm1', storyUrl: 'https://cdn/story', timestamp: 9 }]);
  });

  it('forwards a story mention on the official account with the username, using the social token', async () => {
    const { ctx, seen } = setup(OFFICIAL);
    acceptEvent(ctx, { kind: 'story_mention', accountId: '178', senderId: '55', mid: 'sm1', storyUrl: 'https://cdn/story', timestamp: Date.parse('2026-10-27T10:00:00Z') });
    expect(ctx.db.prepare(`SELECT type FROM jobs WHERE type != 'refresh_tokens'`).all()).toEqual([{ type: 'social_event' }]);
    await runOne(ctx, { social_event: handleSocialEvent });
    expect(seen).toEqual([
      {
        auth: 'Bearer pda_social_token_000000000000000000000000',
        body: { type: 'story_mention', ig_user_id: '55', ig_username: 'Ali_Shop', story_url: 'https://cdn/story', event_id: 'story:sm1', occurred_at: '2026-10-27T10:00:00.000Z' },
      },
    ]);
  });

  it('forwards comments with the post permalink, and still queues the normal reply', async () => {
    const { ctx, seen } = setup(OFFICIAL);
    acceptEvent(ctx, { kind: 'comment', accountId: '178', commentId: 'c9', mediaId: 'm1', fromId: '55', fromUsername: 'ali_shop', text: 'zo‘r ilova!', parentId: null });
    expect((ctx.db.prepare(`SELECT type FROM jobs WHERE type != 'refresh_tokens' ORDER BY id`).all() as { type: string }[]).map((r) => r.type)).toEqual(['social_event', 'comment']);
    await runOne(ctx, { social_event: handleSocialEvent }, ['social_event']);
    expect(seen[0]).toMatchObject({ body: { type: 'comment', ig_username: 'ali_shop', media_id: 'm1', media_permalink: 'https://www.instagram.com/p/DaAxjL4MFE6/', event_id: 'comment:c9' } });
  });

  it('a DM to the official account reports whether the sender follows it', async () => {
    const { ctx, seen } = setup(OFFICIAL);
    acceptEvent(ctx, { kind: 'message', accountId: '178', senderId: '55', mid: 'd1', text: 'salom', imageUrls: [], audioUrls: [], timestamp: 0 });
    await runOne(ctx, { social_event: handleSocialEvent }, ['social_event']);
    expect(seen[0]).toMatchObject({ body: { type: 'follow_check', ig_username: 'Ali_Shop', is_following: true, event_id: 'follow:d1' } });
  });

  it('shop accounts that are not official forward nothing', async () => {
    const { ctx } = setup({ PDAFTAR_SOCIAL_TOKEN: 'pda_social_token_000000000000000000000000' });
    acceptEvent(ctx, { kind: 'story_mention', accountId: '178', senderId: '55', mid: 'sm2', storyUrl: null, timestamp: 0 });
    expect(ctx.db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type = 'social_event'`).get()).toEqual({ n: 0 });
  });

  it('retries on a pDaftar 5xx but not on a 4xx', async () => {
    const down = setup(OFFICIAL, 503);
    acceptEvent(down.ctx, { kind: 'story_mention', accountId: '178', senderId: '55', mid: 'sm3', storyUrl: null, timestamp: 0 });
    await runOne(down.ctx, { social_event: handleSocialEvent }, ['social_event']);
    expect(down.ctx.db.prepare(`SELECT status, attempts FROM jobs WHERE type = 'social_event'`).get()).toEqual({ status: 'pending', attempts: 1 });

    const bad = setup(OFFICIAL, 422);
    acceptEvent(bad.ctx, { kind: 'story_mention', accountId: '178', senderId: '55', mid: 'sm4', storyUrl: null, timestamp: 0 });
    await runOne(bad.ctx, { social_event: handleSocialEvent }, ['social_event']);
    expect(bad.ctx.db.prepare(`SELECT status FROM jobs WHERE type = 'social_event'`).get()).toEqual({ status: 'done' });
  });
});
