import type { IncomingComment, IncomingMessage, IncomingStoryMention } from '../instagram/webhook.js';
import { type AppContext, igAccountByIgId, igClientFor } from './context.js';
import { enqueue } from './jobs.js';

/**
 * pDaftar's own Instagram account doubles as the verifier for ambassador tasks
 * ("share our post to your story", "comment under this post"). Events from the official
 * account are forwarded to pDaftar, which matches them against pending task submissions.
 * Rewards are decided in pDaftar, per task and opt-in; nothing is approved here.
 */

export function isOfficial(ctx: AppContext, igAccountId: string): boolean {
  return ctx.config.instagram.officialAccountIds.includes(igAccountId);
}

export type SocialSource = IncomingComment | IncomingMessage | IncomingStoryMention;

/** Queues verification for events on the official account. Returns whether anything was queued. */
export function queueSocial(ctx: AppContext, ev: SocialSource): boolean {
  if (!isOfficial(ctx, ev.accountId) || !ctx.config.pdaftar.socialToken) return false;
  enqueue(ctx, 'social_event', ev as unknown as Record<string, unknown>);
  return true;
}

interface SocialEventBody {
  type: 'story_mention' | 'comment' | 'follow_check';
  ig_user_id: string;
  ig_username: string | null;
  media_id?: string;
  media_permalink?: string | null;
  text?: string;
  story_url?: string | null;
  is_following?: boolean;
  event_id: string;
  occurred_at: string;
}

export async function handleSocialEvent(ctx: AppContext, payload: Record<string, unknown>): Promise<void> {
  const ev = payload as unknown as SocialSource;
  const acc = igAccountByIgId(ctx, ev.accountId);
  if (!acc) return;
  const ig = igClientFor(ctx, acc);
  let body: SocialEventBody | null = null;

  if (ev.kind === 'story_mention') {
    const profile = await ig.userProfile(ev.senderId);
    body = {
      type: 'story_mention',
      ig_user_id: ev.senderId,
      ig_username: profile.username,
      story_url: ev.storyUrl,
      event_id: `story:${ev.mid}`,
      occurred_at: new Date(ev.timestamp).toISOString(),
    };
  } else if (ev.kind === 'comment') {
    if (!ev.fromId) return;
    body = {
      type: 'comment',
      ig_user_id: ev.fromId,
      ig_username: ev.fromUsername,
      media_id: ev.mediaId ?? undefined,
      media_permalink: ev.mediaId ? await ig.mediaPermalink(ev.mediaId) : null,
      text: ev.text.slice(0, 1000),
      event_id: `comment:${ev.commentId}`,
      occurred_at: new Date().toISOString(),
    };
  } else {
    // A DM tells us who the person is; Instagram also says whether they follow the account.
    const profile = await ig.userProfile(ev.senderId);
    if (profile.followsUs === null) return;
    body = {
      type: 'follow_check',
      ig_user_id: ev.senderId,
      ig_username: profile.username,
      is_following: profile.followsUs,
      event_id: `follow:${ev.mid}`,
      occurred_at: new Date(ev.timestamp).toISOString(),
    };
  }

  const res = await ctx.fetchImpl(`${ctx.config.pdaftar.apiBaseUrl}/api/integration/automation/social-events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.config.pdaftar.socialToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (res.status >= 500 || res.status === 429) throw new Error(`pDaftar social-events ${res.status}`);
  if (!res.ok) {
    ctx.log('social event rejected', { status: res.status, type: body.type, body: text.slice(0, 200) });
    return;
  }
  ctx.log('social event forwarded', { type: body.type, result: text.slice(0, 200) });
}
