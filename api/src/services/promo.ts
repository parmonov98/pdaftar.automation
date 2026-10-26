import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiModels } from '../ai/models.js';
import { parseJson } from '../ai/replies.js';
import { bumpUsage } from '../db.js';
import { randomToken } from '../lib/crypto.js';
import type { PdProduct, PdShop } from '../pdaftar/client.js';
import { formatPrice, renderPromo, type Slide, type Template } from '../video/render.js';
import { type AppContext, getWorkspace, igAccountForWorkspace, igClientFor, pdaftarFor } from './context.js';
import { enqueue } from './jobs.js';

export interface PromoRequest {
  productIds: number[];
  template: Template;
  /** Previous prices for the sale template, by product id. Only real, seller-entered values. */
  oldPrices?: Record<string, number>;
  /** Use Meta's models to clean up product photos (SAM 3.1 crop + Muse Image scene). */
  enhance?: boolean;
}

export const TEMPLATES: Template[] = ['product', 'collection', 'sale', 'new'];

export function mediaDir(ctx: AppContext): string {
  return join(ctx.config.dataDir, 'media');
}

export function createPromo(ctx: AppContext, workspaceId: number, req: PromoRequest): number {
  const ids = [...new Set(req.productIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 10);
  if (!ids.length) throw new Error('Choose at least one product');
  if (!TEMPLATES.includes(req.template)) throw new Error('Unknown template');
  const r = ctx.db
    .prepare(`INSERT INTO promo_videos (workspace_id, product_ids_json, template, status, ai_meta_json) VALUES (?, ?, ?, 'queued', ?)`)
    .run(workspaceId, JSON.stringify(ids), req.template, JSON.stringify({ oldPrices: req.oldPrices ?? {}, enhance: req.enhance !== false }));
  const id = Number(r.lastInsertRowid);
  enqueue(ctx, 'render_video', { videoId: id });
  return id;
}

async function download(ctx: AppContext, url: string): Promise<Buffer> {
  const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Product photo → promo frame: SAM 3.1 finds and crops the product, Muse Image builds a clean
 * scene around that exact product. Any failure falls back to the original photo.
 */
export async function prepareImage(models: AiModels, photo: Buffer, productName: string, log: AppContext['log']): Promise<{ image: Buffer; steps: string[] }> {
  const steps: string[] = [];
  let subject = photo;
  try {
    const crop = await models.segmentProduct(photo, shortNoun(productName));
    if (crop) {
      subject = crop;
      steps.push('sam-crop');
    }
  } catch (e) {
    log('segment failed', { error: String(e) });
  }
  try {
    const staged = await models.stageProduct(
      subject,
      `Professional e-commerce photo of this exact product (${productName}) on a clean, softly lit studio background with a subtle shadow. ` +
        'Keep the product, its shape, colors, label and text exactly as in the input image. Do not add any text, logos, prices or other products.',
    );
    if (staged) {
      steps.push('muse-image-scene');
      return { image: staged, steps };
    }
  } catch (e) {
    log('stage failed', { error: String(e) });
  }
  return { image: subject, steps };
}

/** SAM wants a short noun phrase, not a sentence. */
export function shortNoun(name: string): string {
  return name.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ') || 'product';
}

export async function writeCaption(
  models: AiModels,
  shop: PdShop,
  products: PdProduct[],
  template: Template,
): Promise<{ caption: string; headline: string }> {
  const facts = {
    shop: { name: shop.name, address: shop.address, phone: shop.phone },
    template,
    products: products.map((p) => ({ name: p.name, price: shop.showPrices && p.price !== null ? formatPrice(p.price, p.currency) : null, in_stock: p.orderable && (p.stock === null || p.stock > 0) })),
  };
  const raw = await models.chat(
    [
      {
        role: 'system',
        content:
          'You write Instagram Reel captions for small shops in Uzbekistan, in Uzbek (Latin). Use only the given facts. No invented discounts, prices, or claims. 2–4 short lines, at most 2 emoji, end with a call to write in Direct. Then 3–6 relevant hashtags.',
      },
      {
        role: 'user',
        content: `<task>caption</task>\n<facts>${JSON.stringify(facts)}</facts>\nReturn JSON {"headline": short title (max 40 chars), "caption": string without hashtags, "hashtags": string[]}`,
      },
    ],
    { json: true, maxTokens: 400 },
  );
  const j = parseJson(raw) as { headline?: string; caption?: string; hashtags?: string[] };
  const tags = (j.hashtags ?? []).map((t) => (t.startsWith('#') ? t : `#${t}`)).filter((t) => /^#[\p{L}\p{N}_]+$/u.test(t)).slice(0, 6);
  const base = (j.caption ?? '').trim() || `${products.map((p) => p.name).join(', ')} — ${shop.name}. Direct'ga yozing!`;
  return {
    headline: (j.headline ?? '').trim().slice(0, 40) || (products.length === 1 ? products[0]!.name : 'Yangi mahsulotlar'),
    caption: `${base}\n\n${tags.join(' ')}`.trim().slice(0, 2100),
  };
}

export async function handleRender(ctx: AppContext, payload: Record<string, unknown>): Promise<void> {
  const id = Number(payload.videoId);
  const v = ctx.db.prepare('SELECT * FROM promo_videos WHERE id = ?').get(id) as
    | { id: number; workspace_id: number; product_ids_json: string; template: Template; ai_meta_json: string | null; status: string }
    | undefined;
  if (!v || !['queued', 'rendering'].includes(v.status)) return;
  const ws = getWorkspace(ctx, v.workspace_id);
  if (!ws) return;
  ctx.db.prepare(`UPDATE promo_videos SET status = 'rendering', error = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  try {
    const opts = JSON.parse(v.ai_meta_json ?? '{}') as { oldPrices?: Record<string, number>; enhance?: boolean };
    const pd = pdaftarFor(ctx, ws);
    const shop = await pd.shop();
    const products: PdProduct[] = [];
    for (const pid of JSON.parse(v.product_ids_json) as number[]) {
      const p = await pd.product(pid);
      if (p) products.push(p);
    }
    if (!products.length) throw new Error('Products were not found in pDaftar');
    const missing = products.filter((p) => !p.images[0]);
    if (missing.length) throw new Error(`No photo for: ${missing.map((p) => p.name).join(', ')}`);

    const slides: Slide[] = [];
    const steps: Record<number, string[]> = {};
    for (const p of products) {
      const photo = await download(ctx, p.images[0]!);
      const prepared = opts.enhance === false ? { image: photo, steps: [] } : await prepareImage(ctx.models, photo, p.name, ctx.log);
      steps[p.id] = prepared.steps;
      const old = opts.oldPrices?.[String(p.id)];
      slides.push({
        image: prepared.image,
        background: photo,
        title: p.name,
        priceLine: shop.showPrices && p.price !== null ? formatPrice(p.price, p.currency) : null,
        oldPriceLine: v.template === 'sale' && old && p.price !== null && old > p.price ? formatPrice(old, p.currency) : null,
        stockLine: p.orderable && (p.stock === null || p.stock > 0) ? 'Mavjud' : null,
      });
    }
    const { caption, headline } = await writeCaption(ctx.models, shop, products, v.template);
    await mkdir(mediaDir(ctx), { recursive: true });
    const file = `${randomToken(12)}.mp4`;
    await renderPromo({ template: v.template, shopName: shop.name, headline, cta: "Buyurtma uchun Direct'ga yozing", slides }, join(mediaDir(ctx), file));
    ctx.db
      .prepare(`UPDATE promo_videos SET status = 'ready', video_file = ?, caption = ?, ai_meta_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(file, caption, JSON.stringify({ ...opts, steps, model: ctx.models.name }), id);
    bumpUsage(ctx.db, ws.id, 'videos');
  } catch (e) {
    ctx.db.prepare(`UPDATE promo_videos SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(String(e instanceof Error ? e.message : e).slice(0, 500), id);
  }
}

/** Publishes a rendered video as a Reel on the workspace's own Instagram account. */
export function requestPublish(ctx: AppContext, workspaceId: number, videoId: number, caption: string, scheduledAt: string | null): void {
  const v = ctx.db.prepare('SELECT id, status FROM promo_videos WHERE id = ? AND workspace_id = ?').get(videoId, workspaceId) as { id: number; status: string } | undefined;
  if (!v) throw new Error('Video not found');
  if (!['ready', 'failed_publish', 'scheduled'].includes(v.status)) throw new Error(`Video is ${v.status}`);
  if (!igAccountForWorkspace(ctx, workspaceId)) throw new Error('Connect Instagram first');
  const when = scheduledAt ? new Date(scheduledAt) : null;
  if (when && Number.isNaN(when.getTime())) throw new Error('Bad schedule time');
  const delay = when ? Math.max(0, (when.getTime() - Date.now()) / 1000) : 0;
  ctx.db
    .prepare(`UPDATE promo_videos SET caption = ?, status = ?, scheduled_at = ?, error = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(caption.slice(0, 2200), delay > 0 ? 'scheduled' : 'publishing', when ? when.toISOString() : null, videoId);
  enqueue(ctx, 'publish_video', { videoId }, delay);
}

export async function handlePublish(ctx: AppContext, payload: Record<string, unknown>): Promise<void> {
  const id = Number(payload.videoId);
  const v = ctx.db.prepare('SELECT * FROM promo_videos WHERE id = ?').get(id) as
    | { id: number; workspace_id: number; status: string; video_file: string; caption: string; product_ids_json: string; ig_container_id: string | null }
    | undefined;
  if (!v || !['publishing', 'scheduled'].includes(v.status)) return;
  const acc = igAccountForWorkspace(ctx, v.workspace_id);
  if (!acc) throw new Error('Instagram account disconnected');
  const ig = igClientFor(ctx, acc);
  ctx.db.prepare(`UPDATE promo_videos SET status = 'publishing', updated_at = datetime('now') WHERE id = ?`).run(id);
  try {
    let container = v.ig_container_id;
    if (!container) {
      const quota = await ig.publishingQuota().catch(() => null);
      if (quota && quota.used >= quota.total) throw new Error('Instagram daily publishing limit reached; try again tomorrow');
      container = await ig.createReelContainer({ videoUrl: `${ctx.config.publicBaseUrl}/media/${v.video_file}`, caption: v.caption, shareToFeed: true });
      ctx.db.prepare('UPDATE promo_videos SET ig_container_id = ? WHERE id = ?').run(container, id);
    }
    const status = await ig.containerStatus(container);
    if (status === 'IN_PROGRESS') {
      enqueue(ctx, 'publish_video', { videoId: id }, 10);
      return;
    }
    if (status === 'ERROR' || status === 'EXPIRED') {
      ctx.db.prepare('UPDATE promo_videos SET ig_container_id = NULL WHERE id = ?').run(id);
      throw new Error(`Instagram could not process the video (${status})`);
    }
    const mediaId = status === 'PUBLISHED' ? container : await ig.publish(container);
    const permalink = await ig.permalink(mediaId).catch(() => null);
    ctx.db
      .prepare(`UPDATE promo_videos SET status = 'published', ig_media_id = ?, permalink = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(mediaId, permalink, id);
    // Comments under this Reel are answered with exactly these products.
    ctx.db.prepare('INSERT OR REPLACE INTO media_products (ig_media_id, workspace_id, product_ids_json) VALUES (?, ?, ?)').run(mediaId, v.workspace_id, v.product_ids_json);
  } catch (e) {
    ctx.db
      .prepare(`UPDATE promo_videos SET status = 'failed_publish', error = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(String(e instanceof Error ? e.message : e).slice(0, 500), id);
  }
}

/** Keeps long-lived Instagram tokens fresh (they last 60 days; refresh after 24h of age). */
export async function handleRefreshTokens(ctx: AppContext): Promise<void> {
  const { refreshToken } = await import('../instagram/client.js');
  const { decrypt, encrypt } = await import('../lib/crypto.js');
  const due = ctx.db
    .prepare(`SELECT id, access_token_enc FROM ig_accounts WHERE token_expires_at IS NULL OR token_expires_at < datetime('now', '+20 days')`)
    .all() as { id: number; access_token_enc: string }[];
  for (const acc of due) {
    try {
      const t = await refreshToken(decrypt(acc.access_token_enc, ctx.config.encryptionKey), ctx.fetchImpl);
      ctx.db
        .prepare('UPDATE ig_accounts SET access_token_enc = ?, token_expires_at = ? WHERE id = ?')
        .run(encrypt(t.accessToken, ctx.config.encryptionKey), t.expiresAt.toISOString(), acc.id);
    } catch (e) {
      ctx.log('token refresh failed', { account: acc.id, error: String(e) });
    }
  }
  enqueue(ctx, 'refresh_tokens', {}, 12 * 3600);
}
