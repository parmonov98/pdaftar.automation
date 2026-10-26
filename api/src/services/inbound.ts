import { searchWithFallbacks } from '../ai/search.js';
import { replyFor } from '../ai/agent.js';
import { bumpUsage } from '../db.js';
import type { IncomingComment, IncomingEvent, IncomingMessage } from '../instagram/webhook.js';
import type { PdProduct } from '../pdaftar/client.js';
import {
  type AppContext,
  getWorkspace,
  igAccountByIgId,
  igClientFor,
  manualSendAllowed,
  pdaftarFor,
  sendMode,
  settingsOf,
} from './context.js';
import { enqueue } from './jobs.js';

/** Records a webhook event once (Meta retries) and queues the work. */
export function acceptEvent(ctx: AppContext, ev: IncomingEvent): boolean {
  const key = ev.kind === 'comment' ? `c:${ev.commentId}` : `m:${ev.mid}`;
  const fresh = ctx.db.prepare('INSERT OR IGNORE INTO webhook_events (dedupe_key) VALUES (?)').run(key).changes > 0;
  if (!fresh) return false;
  const acc = igAccountByIgId(ctx, ev.accountId);
  if (!acc) {
    ctx.log('webhook for unknown account', { accountId: ev.accountId });
    return false;
  }
  enqueue(ctx, ev.kind === 'comment' ? 'comment' : 'message', ev as unknown as Record<string, unknown>);
  return true;
}

async function productsForMedia(ctx: AppContext, workspaceId: number, mediaId: string | null, load: (id: number) => Promise<PdProduct | null>): Promise<PdProduct[]> {
  if (!mediaId) return [];
  const row = ctx.db.prepare('SELECT product_ids_json FROM media_products WHERE ig_media_id = ? AND workspace_id = ?').get(mediaId, workspaceId) as
    | { product_ids_json: string }
    | undefined;
  if (!row) return [];
  const ids = JSON.parse(row.product_ids_json) as number[];
  const out: PdProduct[] = [];
  for (const id of ids.slice(0, 5)) {
    const p = await load(id);
    if (p) out.push(p);
  }
  return out;
}

export async function handleComment(ctx: AppContext, payload: Record<string, unknown>): Promise<void> {
  const ev = payload as unknown as IncomingComment;
  const acc = igAccountByIgId(ctx, ev.accountId);
  if (!acc) return;
  const ws = getWorkspace(ctx, acc.workspace_id);
  if (!ws) return;
  const settings = settingsOf(ws);

  const insert = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO comments (ig_account_id, comment_id, media_id, from_id, from_username, text, status)
       VALUES (?, ?, ?, ?, ?, ?, 'received')`,
    )
    .run(acc.id, ev.commentId, ev.mediaId, ev.fromId, ev.fromUsername, ev.text);
  const row = ctx.db.prepare('SELECT id, status FROM comments WHERE comment_id = ?').get(ev.commentId) as { id: number; status: string };
  if (!insert.changes && row.status !== 'received') return;

  // Replies inside a thread, or comments with replies switched off, are left to the seller.
  if (!settings.replyToComments || ev.parentId) {
    ctx.db.prepare(`UPDATE comments SET status = 'skipped', reason = ? WHERE id = ?`).run(ev.parentId ? 'thread reply' : 'comment replies off', row.id);
    return;
  }

  const pd = pdaftarFor(ctx, ws);
  const shop = await pd.shop();
  const contextProducts = await productsForMedia(ctx, ws.id, ev.mediaId, (id) => pd.product(id));
  const decision = await replyFor(ctx.models, {
    channel: 'comment',
    text: ev.text,
    imageUrls: [],
    contextProducts,
    shop,
    settings,
    history: [],
    searchCatalog: (q) => searchWithFallbacks((v) => pd.products({ search: v, perPage: 5 }), q),
  }, ctx.config.replyEngine);
  bumpUsage(ctx.db, ws.id, 'ai_calls', 2);

  const meta = JSON.stringify({ intent: decision.understanding.intent, products: decision.products.map((p) => p.id), reason: decision.reason });
  const mode = decision.handoff ? 'draft' : sendMode(ctx, settings, ev.fromUsername);
  if (mode === 'draft') {
    ctx.db
      .prepare(`UPDATE comments SET reply_text = ?, status = ?, reason = ?, ai_meta_json = ? WHERE id = ?`)
      .run(decision.reply, decision.handoff ? 'handoff' : 'draft', decision.reason, meta, row.id);
    return;
  }
  const ig = igClientFor(ctx, acc);
  const replyId = await ig.replyToComment(ev.commentId, decision.reply);
  ctx.db
    .prepare(`UPDATE comments SET reply_text = ?, reply_comment_id = ?, status = 'replied', ai_meta_json = ? WHERE id = ?`)
    .run(decision.reply, replyId, meta, row.id);
  bumpUsage(ctx.db, ws.id, 'replies');

  // A single private DM to the commenter, only when the seller turned it on.
  if (settings.privateReply && settings.autoSend) {
    const dm = decision.understanding.language === 'ru' ? 'Здравствуйте! Подробности по вашему вопросу здесь 🙂' : "Assalomu alaykum! Savolingiz bo'yicha shu yerda batafsil yozaman 🙂";
    await ig.privateReply(ev.commentId, dm).catch((e: unknown) => ctx.log('private reply failed', { error: String(e) }));
  }
}

export async function handleMessage(ctx: AppContext, payload: Record<string, unknown>): Promise<void> {
  const ev = payload as unknown as IncomingMessage;
  const acc = igAccountByIgId(ctx, ev.accountId);
  if (!acc) return;
  const ws = getWorkspace(ctx, acc.workspace_id);
  if (!ws) return;
  const settings = settingsOf(ws);
  const ig = igClientFor(ctx, acc);

  let conv = ctx.db.prepare('SELECT * FROM conversations WHERE ig_account_id = ? AND igsid = ?').get(acc.id, ev.senderId) as
    | { id: number; username: string | null; ai_enabled: number; status: string }
    | undefined;
  if (!conv) {
    const profile = await ig.userProfile(ev.senderId);
    ctx.db.prepare('INSERT OR IGNORE INTO conversations (ig_account_id, igsid, username) VALUES (?, ?, ?)').run(acc.id, ev.senderId, profile.username);
    conv = ctx.db.prepare('SELECT * FROM conversations WHERE ig_account_id = ? AND igsid = ?').get(acc.id, ev.senderId) as typeof conv;
  }
  if (!conv) return;
  // Voice notes: Muse Voice Transcribe turns them into text, then the normal pipeline runs.
  let text = ev.text;
  let voice = false;
  for (const url of (ev.audioUrls ?? []).slice(0, 1)) {
    try {
      const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`audio download ${res.status}`);
      const transcript = await ctx.models.transcribe(Buffer.from(await res.arrayBuffer()));
      if (transcript) {
        text = [text, transcript].filter(Boolean).join('\n');
        voice = true;
      }
    } catch (e) {
      ctx.log('transcribe failed', { error: String(e) });
    }
  }
  ctx.db
    .prepare(`INSERT OR IGNORE INTO messages (conversation_id, direction, mid, text, attachments_json, status) VALUES (?, 'in', ?, ?, ?, 'received')`)
    .run(conv.id, ev.mid, voice ? `🎤 ${text}` : text, JSON.stringify([...ev.imageUrls, ...(ev.audioUrls ?? [])]));
  ctx.db.prepare(`UPDATE conversations SET last_inbound_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(conv.id);

  if (!settings.replyToDms || !conv.ai_enabled || conv.status === 'handoff') return;

  const history = (
    ctx.db
      .prepare(`SELECT direction, text FROM messages WHERE conversation_id = ? AND mid IS NOT ? AND status IN ('received','sent') ORDER BY id DESC LIMIT 8`)
      .all(conv.id, ev.mid) as { direction: string; text: string | null }[]
  )
    .reverse()
    .filter((m) => m.text)
    .map((m) => ({ role: m.direction === 'in' ? ('customer' as const) : ('shop' as const), text: m.text! }));

  // A voice note we could not understand goes to a person, not to the model.
  if (!text.trim() && !ev.imageUrls.length) {
    ctx.db.prepare(`UPDATE conversations SET status = 'handoff' WHERE id = ?`).run(conv.id);
    ctx.db
      .prepare(`INSERT INTO messages (conversation_id, direction, text, status, handled_by, ai_meta_json) VALUES (?, 'out', ?, 'draft', 'ai', ?)`)
      .run(conv.id, "Ovozli xabaringiz uchun rahmat! Tez orada javob beramiz.", JSON.stringify({ reason: 'voice note not transcribed' }));
    return;
  }

  const pd = pdaftarFor(ctx, ws);
  const shop = await pd.shop();
  const decision = await replyFor(ctx.models, {
    channel: 'dm',
    text,
    imageUrls: ev.imageUrls,
    contextProducts: [],
    shop,
    settings,
    history,
    searchCatalog: (q) => searchWithFallbacks((v) => pd.products({ search: v, perPage: 5 }), q),
  }, ctx.config.replyEngine);
  bumpUsage(ctx.db, ws.id, 'ai_calls', (ev.imageUrls.length ? 3 : 2) + (voice ? 1 : 0));

  let replyText = decision.reply;
  let orderNote: string | null = null;
  if (decision.order) {
    try {
      const order = await pd.createOrder({
        customerName: decision.order.customerName,
        customerPhone: decision.order.customerPhone,
        items: [{ productId: decision.order.productId, quantity: decision.order.quantity }],
        note: 'Instagram',
        externalRef: `ig:${ev.mid}`,
      });
      orderNote = `pDaftar order #${order.id}`;
      if (order.url) replyText = `${replyText}\n${order.url}`;
    } catch (e) {
      ctx.log('order create failed', { error: String(e) });
      decision.handoff = true;
      decision.reason = 'order could not be created';
    }
  }

  const meta = JSON.stringify({
    voice,
    intent: decision.understanding.intent,
    products: decision.products.map((p) => p.id),
    reason: decision.reason,
    order: orderNote,
  });
  if (decision.handoff) ctx.db.prepare(`UPDATE conversations SET status = 'handoff' WHERE id = ?`).run(conv.id);

  const mode = decision.handoff ? 'draft' : sendMode(ctx, settings, conv.username);
  if (mode === 'draft') {
    ctx.db
      .prepare(`INSERT INTO messages (conversation_id, direction, text, status, handled_by, ai_meta_json) VALUES (?, 'out', ?, 'draft', 'ai', ?)`)
      .run(conv.id, replyText, meta);
    return;
  }
  const mid = await ig.sendText(ev.senderId, replyText);
  ctx.db
    .prepare(`INSERT INTO messages (conversation_id, direction, mid, text, status, handled_by, ai_meta_json) VALUES (?, 'out', ?, ?, 'sent', 'ai', ?)`)
    .run(conv.id, mid, replyText, meta);
  bumpUsage(ctx.db, ws.id, 'replies');
}

/** Sends a draft the seller approved (optionally edited). */
export async function sendDraft(ctx: AppContext, workspaceId: number, messageId: number, text: string): Promise<void> {
  const row = ctx.db
    .prepare(
      `SELECT m.id, c.igsid, c.username, c.id AS conversation_id, a.id AS account_id FROM messages m
       JOIN conversations c ON c.id = m.conversation_id JOIN ig_accounts a ON a.id = c.ig_account_id
       WHERE m.id = ? AND a.workspace_id = ? AND m.status = 'draft'`,
    )
    .get(messageId, workspaceId) as { id: number; igsid: string; username: string | null; conversation_id: number; account_id: number } | undefined;
  if (!row) throw new Error('Draft not found');
  if (!manualSendAllowed(ctx, row.username)) throw new Error('Safe mode: this account may only message allowlisted test users');
  const acc = ctx.db.prepare('SELECT * FROM ig_accounts WHERE id = ?').get(row.account_id) as Parameters<typeof igClientFor>[1];
  const mid = await igClientFor(ctx, acc).sendText(row.igsid, text);
  ctx.db.prepare(`UPDATE messages SET status = 'sent', text = ?, mid = ?, handled_by = 'human' WHERE id = ?`).run(text, mid, row.id);
  bumpUsage(ctx.db, workspaceId, 'replies');
}

export async function sendCommentDraft(ctx: AppContext, workspaceId: number, commentRowId: number, text: string): Promise<void> {
  const row = ctx.db
    .prepare(
      `SELECT c.id, c.comment_id, c.from_username, a.id AS account_id FROM comments c JOIN ig_accounts a ON a.id = c.ig_account_id
       WHERE c.id = ? AND a.workspace_id = ? AND c.status IN ('draft','handoff')`,
    )
    .get(commentRowId, workspaceId) as { id: number; comment_id: string; from_username: string | null; account_id: number } | undefined;
  if (!row) throw new Error('Draft not found');
  if (!manualSendAllowed(ctx, row.from_username)) throw new Error('Safe mode: this account may only reply to allowlisted test users');
  const acc = ctx.db.prepare('SELECT * FROM ig_accounts WHERE id = ?').get(row.account_id) as Parameters<typeof igClientFor>[1];
  const replyId = await igClientFor(ctx, acc).replyToComment(row.comment_id, text);
  ctx.db.prepare(`UPDATE comments SET status = 'replied', reply_text = ?, reply_comment_id = ? WHERE id = ?`).run(text, replyId, row.id);
  bumpUsage(ctx.db, workspaceId, 'replies');
}
