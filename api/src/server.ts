import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decideReply, type WorkspaceSettings } from './ai/replies.js';
import { currentMonth } from './db.js';
import { authorizeUrl, exchangeCode, InstagramClient } from './instagram/client.js';
import { parseWebhook } from './instagram/webhook.js';
import { encrypt, randomToken, verifyMetaSignature } from './lib/crypto.js';
import { PdaftarClient, PdaftarError } from './pdaftar/client.js';
import { type AppContext, getWorkspace, igAccountForWorkspace, pdaftarFor, settingsOf, type WorkspaceRow } from './services/context.js';
import { acceptEvent, sendCommentDraft, sendDraft } from './services/inbound.js';
import { createPromo, mediaDir, requestPublish, TEMPLATES } from './services/promo.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    workspace?: WorkspaceRow;
  }
}

const COOKIE = 'pda_session';

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  void app.register(cors, { origin: false });

  // Keep the raw body: Meta signs the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      const err = new Error('Invalid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(422).send({ error: 'validation', details: err.issues });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : err instanceof PdaftarError ? 502 : 500;
    if (status >= 500) ctx.log('request failed', { error: err.message });
    return reply.code(status).send({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  mkdirSync(mediaDir(ctx), { recursive: true });
  void app.register(fastifyStatic, { root: mediaDir(ctx), prefix: '/media/', decorateReply: false, maxAge: '7d' });

  // ---- auth ---------------------------------------------------------------
  const requireWorkspace = async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = readCookie(req, COOKIE);
    const row = sid
      ? (ctx.db.prepare(`SELECT workspace_id FROM sessions WHERE id = ? AND expires_at > datetime('now')`).get(sid) as { workspace_id: number } | undefined)
      : undefined;
    const ws = row ? getWorkspace(ctx, row.workspace_id) : undefined;
    if (!ws) return reply.code(401).send({ error: 'Not signed in' });
    req.workspace = ws;
  };

  app.get('/api/health', async () => ({ ok: true, ai: ctx.models.name, safeMode: ctx.config.instagram.safeMode }));

  app.post('/api/session', async (req, reply) => {
    const { token } = z.object({ token: z.string().trim().min(10).max(200) }).parse(req.body);
    let shop;
    try {
      shop = await new PdaftarClient(ctx.config.pdaftar.apiBaseUrl, token, ctx.fetchImpl).shop();
    } catch (e) {
      if (e instanceof PdaftarError && (e.status === 401 || e.status === 404)) return reply.code(401).send({ error: 'pDaftar token is not valid' });
      throw e;
    }
    const enc = encrypt(token, ctx.config.encryptionKey);
    ctx.db
      .prepare(
        `INSERT INTO workspaces (pdaftar_shop_id, shop_name, pdaftar_token_enc) VALUES (?, ?, ?)
         ON CONFLICT (pdaftar_shop_id) DO UPDATE SET shop_name = excluded.shop_name, pdaftar_token_enc = excluded.pdaftar_token_enc`,
      )
      .run(shop.id, shop.name, enc);
    const ws = ctx.db.prepare('SELECT id FROM workspaces WHERE pdaftar_shop_id = ?').get(shop.id) as { id: number };
    const sid = randomToken();
    ctx.db.prepare(`INSERT INTO sessions (id, workspace_id, expires_at) VALUES (?, ?, datetime('now', ?))`).run(sid, ws.id, `+${ctx.config.sessionTtlDays} days`);
    setCookie(reply, COOKIE, sid, ctx.config.sessionTtlDays * 86400, ctx.config.publicBaseUrl.startsWith('https'));
    return { shop: { id: shop.id, name: shop.name } };
  });

  app.post('/api/logout', async (req, reply) => {
    const sid = readCookie(req, COOKIE);
    if (sid) ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    setCookie(reply, COOKIE, '', 0, ctx.config.publicBaseUrl.startsWith('https'));
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireWorkspace }, async (req) => {
    const ws = req.workspace!;
    const acc = igAccountForWorkspace(ctx, ws.id);
    return {
      shop: { id: ws.pdaftar_shop_id, name: ws.shop_name },
      instagram: acc ? { username: acc.username, picture: acc.profile_picture_url, connectedAt: acc.token_expires_at } : null,
      settings: settingsOf(ws),
      safeMode: ctx.config.instagram.safeMode,
      instagramConfigured: !!(ctx.config.instagram.appId && ctx.config.instagram.redirectUri),
      ai: ctx.models.name,
    };
  });

  // ---- settings -----------------------------------------------------------
  const settingsSchema = z.object({
    faq: z.string().max(4000).optional(),
    autoSend: z.boolean().optional(),
    replyToComments: z.boolean().optional(),
    replyToDms: z.boolean().optional(),
    publicPrice: z.boolean().optional(),
    privateReply: z.boolean().optional(),
    createOrders: z.boolean().optional(),
  });
  app.put('/api/settings', { preHandler: requireWorkspace }, async (req) => {
    const patch = settingsSchema.parse(req.body);
    const next: WorkspaceSettings = { ...settingsOf(req.workspace!), ...patch };
    ctx.db.prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?').run(JSON.stringify(next), req.workspace!.id);
    return { settings: next };
  });

  // ---- instagram connect --------------------------------------------------
  app.get('/api/instagram/connect', { preHandler: requireWorkspace }, async (req, reply) => {
    const ig = ctx.config.instagram;
    if (!ig.appId || !ig.redirectUri) return reply.code(503).send({ error: 'Instagram app is not configured yet' });
    const state = randomToken(16);
    ctx.db.prepare('INSERT INTO oauth_states (state, workspace_id) VALUES (?, ?)').run(state, req.workspace!.id);
    return { url: authorizeUrl({ ...ig }, state) };
  });

  app.get('/auth/instagram/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const back = (status: string) => reply.redirect(`/app/settings?instagram=${status}`);
    if (q.error || !q.code || !q.state) return back('cancelled');
    const st = ctx.db.prepare(`SELECT workspace_id FROM oauth_states WHERE state = ? AND created_at > datetime('now', '-15 minutes')`).get(q.state) as
      | { workspace_id: number }
      | undefined;
    ctx.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(q.state);
    if (!st) return back('expired');
    const cfg = ctx.config.instagram;
    const token = await exchangeCode({ ...cfg }, q.code.replace(/#_$/, ''), ctx.fetchImpl);
    const client = new InstagramClient(token.userId, token.accessToken, cfg.graphVersion, ctx.fetchImpl);
    const me = await client.me();
    const igUserId = String(me.user_id ?? token.userId);
    if (cfg.allowedAccountIds.length && !cfg.allowedAccountIds.includes(igUserId)) return back('not_allowed');
    ctx.db
      .prepare(
        `INSERT INTO ig_accounts (workspace_id, ig_user_id, username, profile_picture_url, access_token_enc, token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET ig_user_id = excluded.ig_user_id, username = excluded.username,
           profile_picture_url = excluded.profile_picture_url, access_token_enc = excluded.access_token_enc, token_expires_at = excluded.token_expires_at`,
      )
      .run(st.workspace_id, igUserId, me.username, me.profile_picture_url ?? null, encrypt(token.accessToken, ctx.config.encryptionKey), token.expiresAt.toISOString());
    await new InstagramClient(igUserId, token.accessToken, cfg.graphVersion, ctx.fetchImpl).subscribe().catch((e: unknown) => ctx.log('subscribe failed', { error: String(e) }));
    return back('connected');
  });

  app.delete('/api/instagram', { preHandler: requireWorkspace }, async (req) => {
    ctx.db.prepare('DELETE FROM ig_accounts WHERE workspace_id = ?').run(req.workspace!.id);
    return { ok: true };
  });

  // ---- webhooks -------------------------------------------------------------
  app.get('/webhooks/instagram', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === ctx.config.instagram.webhookVerifyToken) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send('forbidden');
  });

  app.post('/webhooks/instagram', async (req, reply) => {
    if (!verifyMetaSignature(req.rawBody ?? Buffer.alloc(0), req.headers['x-hub-signature-256'] as string | undefined, ctx.config.instagram.appSecret)) {
      return reply.code(401).send('bad signature');
    }
    for (const ev of parseWebhook(req.body)) acceptEvent(ctx, ev);
    return reply.send('EVENT_RECEIVED');
  });

  // ---- inbox ------------------------------------------------------------------
  app.get('/api/inbox/comments', { preHandler: requireWorkspace }, async (req) => {
    return {
      comments: ctx.db
        .prepare(
          `SELECT c.id, c.comment_id, c.media_id, c.from_username, c.text, c.reply_text, c.status, c.reason, c.created_at FROM comments c
           JOIN ig_accounts a ON a.id = c.ig_account_id WHERE a.workspace_id = ? ORDER BY c.id DESC LIMIT 100`,
        )
        .all(req.workspace!.id),
    };
  });

  app.get('/api/inbox/conversations', { preHandler: requireWorkspace }, async (req) => {
    return {
      conversations: ctx.db
        .prepare(
          `SELECT c.id, c.username, c.igsid, c.status, c.ai_enabled, c.updated_at,
             (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.status = 'draft') AS drafts
           FROM conversations c JOIN ig_accounts a ON a.id = c.ig_account_id WHERE a.workspace_id = ? ORDER BY c.updated_at DESC LIMIT 100`,
        )
        .all(req.workspace!.id),
    };
  });

  app.get('/api/inbox/conversations/:id/messages', { preHandler: requireWorkspace }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const conv = ownedConversation(ctx, req.workspace!.id, id);
    if (!conv) return reply.code(404).send({ error: 'Not found' });
    return {
      conversation: conv,
      messages: ctx.db
        .prepare('SELECT id, direction, text, attachments_json, status, handled_by, ai_meta_json, created_at FROM messages WHERE conversation_id = ? ORDER BY id')
        .all(id),
    };
  });

  app.patch('/api/inbox/conversations/:id', { preHandler: requireWorkspace }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!ownedConversation(ctx, req.workspace!.id, id)) return reply.code(404).send({ error: 'Not found' });
    const body = z.object({ aiEnabled: z.boolean().optional(), status: z.enum(['open', 'handoff']).optional() }).parse(req.body);
    if (body.aiEnabled !== undefined) ctx.db.prepare('UPDATE conversations SET ai_enabled = ? WHERE id = ?').run(body.aiEnabled ? 1 : 0, id);
    if (body.status) ctx.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(body.status, id);
    return { ok: true };
  });

  const textBody = z.object({ text: z.string().trim().min(1).max(1000) });
  app.post('/api/inbox/messages/:id/send', { preHandler: requireWorkspace }, async (req, reply) => {
    const { text } = textBody.parse(req.body);
    try {
      await sendDraft(ctx, req.workspace!.id, Number((req.params as { id: string }).id), text);
    } catch (e) {
      return reply.code(409).send(sendError(e));
    }
    return { ok: true };
  });

  app.post('/api/inbox/comments/:id/send', { preHandler: requireWorkspace }, async (req, reply) => {
    const { text } = textBody.parse(req.body);
    try {
      await sendCommentDraft(ctx, req.workspace!.id, Number((req.params as { id: string }).id), text);
    } catch (e) {
      return reply.code(409).send(sendError(e));
    }
    return { ok: true };
  });

  // ---- playground: the full reply pipeline on a test message, nothing is sent ----
  app.post('/api/playground', { preHandler: requireWorkspace, bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const body = z
      .object({
        channel: z.enum(['comment', 'dm']),
        text: z.string().trim().max(1000).default(''),
        imageUrl: z.string().url().optional(),
        /** An uploaded photo as a data URL (jpeg/png/webp, up to ~4 MB). */
        imageData: z.string().regex(/^data:image\/(jpeg|png|webp);base64,/).max(6_000_000).optional(),
        /** An uploaded or recorded voice note as a data URL (any format ffmpeg reads). */
        audioData: z.string().regex(/^data:audio\/[\w.+-]+(;[\w=.-]+)*;base64,/).max(8_000_000).optional(),
        productIds: z.array(z.number().int().positive()).max(5).optional(),
      })
      .parse(req.body);
    let text = body.text;
    let transcript: string | null = null;
    if (body.audioData) {
      try {
        transcript = await ctx.models.transcribe(Buffer.from(body.audioData.split(',')[1] ?? '', 'base64'));
      } catch (e) {
        ctx.log('playground transcribe failed', { error: String(e) });
        return reply.code(502).send({ error: 'Voice note could not be transcribed', code: 'transcribe_failed' });
      }
      if (!transcript) return reply.code(422).send({ error: 'Voice note could not be understood', code: 'transcribe_empty' });
      text = [text, transcript].filter(Boolean).join('\n');
    }
    const image = body.imageData ?? body.imageUrl;
    const ws = req.workspace!;
    const pd = pdaftarFor(ctx, ws);
    const shop = await pd.shop();
    const contextProducts = [];
    for (const pid of body.productIds ?? []) {
      const p = await pd.product(pid);
      if (p) contextProducts.push(p);
    }
    const started = Date.now();
    const d = await decideReply(ctx.models, {
      channel: body.channel,
      text,
      imageUrls: image ? [image] : [],
      contextProducts,
      shop,
      settings: settingsOf(ws),
      history: [],
      searchCatalog: (q) => pd.products({ search: q, perPage: 5 }),
    });
    return {
      reply: d.reply,
      handoff: d.handoff,
      reason: d.reason,
      understanding: d.understanding,
      products: d.products.map((p) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency, stock: p.stock, image: p.images[0] ?? null })),
      ms: Date.now() - started,
      model: ctx.models.name,
      transcript,
    };
  });

  // ---- catalog & promo studio -------------------------------------------------
  app.get('/api/catalog', { preHandler: requireWorkspace }, async (req) => {
    const q = req.query as { search?: string; page?: string };
    const products = await pdaftarFor(ctx, req.workspace!).products({ search: q.search?.slice(0, 80), page: Number(q.page) || 1, perPage: 48 });
    return { products };
  });

  app.post('/api/promos', { preHandler: requireWorkspace }, async (req) => {
    const body = z
      .object({
        productIds: z.array(z.number().int().positive()).min(1).max(10),
        template: z.enum(TEMPLATES as [string, ...string[]]),
        oldPrices: z.record(z.string(), z.number().positive()).optional(),
        enhance: z.boolean().optional(),
      })
      .parse(req.body);
    const id = createPromo(ctx, req.workspace!.id, body as Parameters<typeof createPromo>[2]);
    return { id };
  });

  app.get('/api/promos', { preHandler: requireWorkspace }, async (req) => {
    const rows = ctx.db
      .prepare(
        `SELECT id, product_ids_json, template, status, caption, video_file, permalink, scheduled_at, error, created_at, updated_at
         FROM promo_videos WHERE workspace_id = ? ORDER BY id DESC LIMIT 50`,
      )
      .all(req.workspace!.id) as { video_file: string | null }[];
    return { promos: rows.map((r) => ({ ...r, video_url: r.video_file ? `/media/${r.video_file}` : null })) };
  });

  app.post('/api/promos/:id/publish', { preHandler: requireWorkspace }, async (req, reply) => {
    const body = z.object({ caption: z.string().trim().min(1).max(2200), scheduledAt: z.string().datetime().nullable().optional() }).parse(req.body);
    try {
      requestPublish(ctx, req.workspace!.id, Number((req.params as { id: string }).id), body.caption, body.scheduledAt ?? null);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    return { ok: true };
  });

  app.get('/api/usage', { preHandler: requireWorkspace }, async (req) => {
    const row = ctx.db.prepare('SELECT replies, videos, ai_calls FROM usage WHERE workspace_id = ? AND month = ?').get(req.workspace!.id, currentMonth());
    return { month: currentMonth(), usage: row ?? { replies: 0, videos: 0, ai_calls: 0 } };
  });

  // ---- web app (SPA) ------------------------------------------------------------
  const dist = ctx.config.webDistDir;
  if (dist && existsSync(join(dist, 'index.html'))) {
    // Wildcard serving: files from a rebuild are found without a restart.
    void app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: true });
    app.setNotFoundHandler((req, reply) => {
      if (/^\/(api|webhooks|media|assets)\//.test(req.url)) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/** Send failures carry a code the web app translates. */
function sendError(e: unknown): { error: string; code: string } {
  const message = e instanceof Error ? e.message : String(e);
  return { error: message, code: message.startsWith('Safe mode') ? 'safe_mode' : message === 'Draft not found' ? 'not_found' : 'send_failed' };
}

function ownedConversation(ctx: AppContext, workspaceId: number, id: number) {
  return ctx.db
    .prepare(`SELECT c.id, c.username, c.status, c.ai_enabled FROM conversations c JOIN ig_accounts a ON a.id = c.ig_account_id WHERE c.id = ? AND a.workspace_id = ?`)
    .get(id, workspaceId);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(reply: FastifyReply, name: string, value: string, maxAge: number, secure: boolean): void {
  reply.header(
    'set-cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
  );
}
