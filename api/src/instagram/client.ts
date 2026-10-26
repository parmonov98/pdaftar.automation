/**
 * Instagram API with Instagram Login (graph.instagram.com).
 * Scopes: instagram_business_basic, instagram_business_manage_messages,
 * instagram_business_manage_comments, instagram_business_content_publish.
 */

export const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
  'instagram_business_content_publish',
];

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export interface IgAppConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
}

export function authorizeUrl(cfg: IgAppConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: IG_SCOPES.join(','),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

export interface LongLivedToken {
  accessToken: string;
  userId: string;
  expiresAt: Date;
}

/** code → short-lived token → long-lived (60-day) token. */
export async function exchangeCode(cfg: IgAppConfig, code: string, fetchImpl: Fetch = fetch): Promise<LongLivedToken> {
  const form = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: cfg.redirectUri,
    code,
  });
  const shortRes = await fetchImpl('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  const shortBody = (await json(shortRes)) as { data?: { access_token: string; user_id: string | number }[]; access_token?: string; user_id?: string | number };
  const first = shortBody.data?.[0] ?? shortBody;
  if (!first.access_token) throw new InstagramError('Instagram did not return an access token', shortRes.status);

  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: cfg.appSecret, access_token: first.access_token });
  const longRes = await fetchImpl(`https://graph.instagram.com/access_token?${q}`);
  const longBody = (await json(longRes)) as { access_token: string; expires_in: number };
  return {
    accessToken: longBody.access_token,
    userId: String(first.user_id),
    expiresAt: new Date(Date.now() + longBody.expires_in * 1000),
  };
}

export async function refreshToken(token: string, fetchImpl: Fetch = fetch): Promise<{ accessToken: string; expiresAt: Date }> {
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const res = await fetchImpl(`https://graph.instagram.com/refresh_access_token?${q}`);
  const body = (await json(res)) as { access_token: string; expires_in: number };
  return { accessToken: body.access_token, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
}

async function json(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: number }; error_message?: string } | null) ?? {};
    throw new InstagramError(err.error?.message ?? err.error_message ?? `Instagram request failed (${res.status})`, res.status, err.error?.code);
  }
  return body;
}

export type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';

/** Calls made on behalf of one connected account. */
export class InstagramClient {
  private readonly base: string;

  constructor(
    private readonly igUserId: string,
    private readonly token: string,
    graphVersion: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.base = `https://graph.instagram.com/${graphVersion}`;
  }

  me(): Promise<{ user_id?: string; id?: string; username: string; profile_picture_url?: string }> {
    return this.get('/me', { fields: 'user_id,username,profile_picture_url' }) as Promise<{ username: string }>;
  }

  /** Username of a person who messaged the account (needs the messaging permission). */
  async userProfile(igsid: string): Promise<{ username: string | null; name: string | null }> {
    try {
      const body = (await this.get(`/${igsid}`, { fields: 'username,name' })) as { username?: string; name?: string };
      return { username: body.username ?? null, name: body.name ?? null };
    } catch {
      return { username: null, name: null };
    }
  }

  /** Subscribes this account to our app's webhook fields. */
  async subscribe(fields = ['comments', 'messages']): Promise<void> {
    await this.post(`/${this.igUserId}/subscribed_apps`, { subscribed_fields: fields.join(',') });
  }

  async sendText(recipientIgsid: string, text: string): Promise<string | null> {
    const body = (await this.postJson(`/${this.igUserId}/messages`, { recipient: { id: recipientIgsid }, message: { text } })) as { message_id?: string };
    return body.message_id ?? null;
  }

  /** One private DM to a commenter (within 7 days of the comment). Off by default in settings. */
  async privateReply(commentId: string, text: string): Promise<string | null> {
    const body = (await this.postJson(`/${this.igUserId}/messages`, { recipient: { comment_id: commentId }, message: { text } })) as { message_id?: string };
    return body.message_id ?? null;
  }

  async replyToComment(commentId: string, message: string): Promise<string> {
    const body = (await this.post(`/${commentId}/replies`, { message })) as { id: string };
    return body.id;
  }

  async createReelContainer(p: { videoUrl: string; caption: string; coverUrl?: string; shareToFeed?: boolean }): Promise<string> {
    const params: Record<string, string> = {
      media_type: 'REELS',
      video_url: p.videoUrl,
      caption: p.caption,
      share_to_feed: String(p.shareToFeed ?? true),
    };
    if (p.coverUrl) params.cover_url = p.coverUrl;
    const body = (await this.post(`/${this.igUserId}/media`, params)) as { id: string };
    return body.id;
  }

  async containerStatus(containerId: string): Promise<ContainerStatus> {
    const body = (await this.get(`/${containerId}`, { fields: 'status_code' })) as { status_code: ContainerStatus };
    return body.status_code;
  }

  async publish(containerId: string): Promise<string> {
    const body = (await this.post(`/${this.igUserId}/media_publish`, { creation_id: containerId })) as { id: string };
    return body.id;
  }

  async permalink(mediaId: string): Promise<string | null> {
    const body = (await this.get(`/${mediaId}`, { fields: 'permalink' })) as { permalink?: string };
    return body.permalink ?? null;
  }

  /** Remaining Reels/posts in the rolling 24h window (the limit differs between docs, so read it). */
  async publishingQuota(): Promise<{ used: number; total: number }> {
    const body = (await this.get(`/${this.igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' })) as {
      data?: { quota_usage?: number; config?: { quota_total?: number } }[];
    };
    const row = body.data?.[0];
    return { used: row?.quota_usage ?? 0, total: row?.config?.quota_total ?? 50 };
  }

  private async get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const q = new URLSearchParams(params);
    const res = await this.fetchImpl(`${this.base}${path}?${q}`, { headers: { Authorization: `Bearer ${this.token}` } });
    return json(res);
  }

  private async post(path: string, params: Record<string, string>): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: new URLSearchParams(params),
    });
    return json(res);
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return json(res);
  }
}
