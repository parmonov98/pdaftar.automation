import type { PdProduct, PdShop } from '../pdaftar/client.js';
import { formatPrice } from '../video/render.js';
import type { AiModels, ChatPart } from './models.js';

export interface WorkspaceSettings {
  /** Seller-written facts: delivery, address, hours, payment. */
  faq: string;
  /** false = every AI reply waits as a draft for the seller to approve. */
  autoSend: boolean;
  replyToComments: boolean;
  replyToDms: boolean;
  /** Prices in public comment replies. Off by default: price talk goes to DM. */
  publicPrice: boolean;
  /** Send one private DM to a commenter. Off by default: we never DM first. */
  privateReply: boolean;
  /** Create a pDaftar order when a customer confirms in DM. */
  createOrders: boolean;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  faq: '',
  autoSend: false,
  replyToComments: true,
  replyToDms: true,
  publicPrice: false,
  privateReply: false,
  createOrders: true,
};

export type Intent = 'price' | 'availability' | 'delivery' | 'order' | 'greeting' | 'human' | 'complaint' | 'other';

export interface Understanding {
  intent: Intent;
  productQuery: string | null;
  language: 'uz' | 'ru' | 'en';
  needsHuman: boolean;
  confidence: number;
  customerName: string | null;
  customerPhone: string | null;
  quantity: number | null;
}

export interface ReplyDecision {
  reply: string;
  handoff: boolean;
  reason: string | null;
  products: PdProduct[];
  understanding: Understanding;
  order: { productId: number; quantity: number; customerName: string; customerPhone: string } | null;
}

export interface ReplyContext {
  channel: 'comment' | 'dm';
  text: string;
  imageUrls: string[];
  /** Products already known from context, e.g. the Reel the comment is on. */
  contextProducts: PdProduct[];
  shop: PdShop;
  settings: WorkspaceSettings;
  /** Last few DM turns, oldest first. */
  history: { role: 'customer' | 'shop'; text: string }[];
  searchCatalog: (query: string) => Promise<PdProduct[]>;
}

const SYSTEM = `You are the Instagram sales assistant of a small shop in Uzbekistan. You reply on the shop's behalf.
Rules:
- Use ONLY the facts given in <facts>. Never invent a price, stock level, discount, address, delivery term or product.
- If a needed fact is missing, say you will check ("aniqlab beraman" / "уточню") and set handoff=true.
- Reply in the customer's language: Uzbek Latin by default, Uzbek Cyrillic if they write Cyrillic Uzbek, Russian if they write Russian.
- Be short and warm: 1–3 sentences, at most one emoji, no hashtags, no links unless one is in the facts.
- Public comment replies: never write a price when show_price is false; invite them to DM ("Direct'ga yozing").
- Never ask for card numbers or passwords. Never promise anything that is not in the facts.
- Angry customers, complaints, refunds, or a request for a person: set handoff=true and reply politely that the owner will answer soon.
Answer with JSON only.`;

export async function understand(models: AiModels, ctx: Pick<ReplyContext, 'text' | 'imageUrls' | 'history' | 'channel'>): Promise<Understanding> {
  const history = ctx.history.map((h) => `${h.role}: ${h.text}`).join('\n');
  const prompt = `<task>understand</task>
Classify the customer's latest ${ctx.channel === 'comment' ? 'Instagram comment' : 'Instagram DM'} for a shop.
<history>${history}</history>
<message>${ctx.text}</message>
Return JSON: {"intent": one of ["price","availability","delivery","order","greeting","human","complaint","other"],
"product_query": short product name to search the shop catalog (in the words the catalog would use, e.g. "Coca-Cola 1.5") or null,
"language": "uz"|"ru"|"en", "needs_human": boolean, "confidence": 0..1,
"customer_name": string|null, "customer_phone": string|null (only if the customer wrote it), "quantity": number|null}`;
  const content: ChatPart[] = [{ type: 'text', text: prompt }];
  for (const url of ctx.imageUrls.slice(0, 2)) content.push({ type: 'image_url', image_url: { url } });
  const raw = await models.chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: ctx.imageUrls.length ? content : prompt },
    ],
    { json: true, vision: ctx.imageUrls.length > 0, maxTokens: 300 },
  );
  const j = parseJson(raw) as Record<string, unknown>;
  const intent = (['price', 'availability', 'delivery', 'order', 'greeting', 'human', 'complaint', 'other'] as const).find((i) => i === j.intent) ?? 'other';
  return {
    intent,
    productQuery: typeof j.product_query === 'string' && j.product_query.trim() ? j.product_query.trim().slice(0, 80) : null,
    language: j.language === 'ru' || j.language === 'en' ? j.language : 'uz',
    needsHuman: j.needs_human === true || intent === 'human' || intent === 'complaint',
    confidence: typeof j.confidence === 'number' ? Math.max(0, Math.min(1, j.confidence)) : 0.5,
    customerName: typeof j.customer_name === 'string' ? j.customer_name : null,
    customerPhone: typeof j.customer_phone === 'string' ? normalisePhone(j.customer_phone) : null,
    quantity: typeof j.quantity === 'number' && j.quantity > 0 ? Math.floor(j.quantity) : null,
  };
}

/** Finds catalog products for the message: context products first, then a search with a fallback per word. */
export async function findProducts(ctx: ReplyContext, u: Understanding): Promise<PdProduct[]> {
  if (ctx.contextProducts.length && !u.productQuery) return ctx.contextProducts.slice(0, 5);
  if (!u.productQuery) return ctx.contextProducts.slice(0, 5);
  let found = await ctx.searchCatalog(u.productQuery);
  if (!found.length) {
    const words = u.productQuery.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
    for (const w of words.slice(0, 2)) {
      found = await ctx.searchCatalog(w);
      if (found.length) break;
    }
  }
  if (ctx.contextProducts.length) {
    const ids = new Set(found.map((p) => p.id));
    found = [...ctx.contextProducts.filter((p) => !ids.has(p.id)), ...found];
  }
  return found.slice(0, 5);
}

/** With a customer photo and several candidates, asks the vision model which catalog photo matches. */
export async function pickByPhoto(models: AiModels, customerImage: string, candidates: PdProduct[]): Promise<PdProduct[]> {
  const withImages = candidates.filter((p) => p.images[0]).slice(0, 4);
  if (withImages.length < 2) return candidates;
  const content: ChatPart[] = [
    { type: 'text', text: '<task>match</task>\nThe first image is from a customer. Which of the following catalog photos shows the SAME product? Return JSON {"index": 1-based index or 0 if none, "confidence": 0..1}.' },
    { type: 'image_url', image_url: { url: customerImage } },
  ];
  withImages.forEach((p, i) => {
    content.push({ type: 'text', text: `Catalog ${i + 1}: ${p.name}` });
    content.push({ type: 'image_url', image_url: { url: p.images[0]! } });
  });
  const j = parseJson(await models.chat([{ role: 'user', content }], { json: true, vision: true, maxTokens: 60 })) as { index?: number; confidence?: number };
  const idx = Number(j.index ?? 0);
  if (idx >= 1 && idx <= withImages.length && (j.confidence ?? 0) >= 0.5) {
    const hit = withImages[idx - 1]!;
    return [hit, ...candidates.filter((p) => p.id !== hit.id)];
  }
  return candidates;
}

export async function decideReply(models: AiModels, ctx: ReplyContext): Promise<ReplyDecision> {
  const u = await understand(models, ctx);
  let products = u.intent === 'greeting' || u.intent === 'delivery' ? ctx.contextProducts : await findProducts(ctx, u);
  if (ctx.imageUrls[0] && products.length > 1) products = await pickByPhoto(models, ctx.imageUrls[0], products);

  const showPrice = ctx.channel === 'dm' || ctx.settings.publicPrice;
  const facts = {
    channel: ctx.channel,
    show_price: showPrice,
    language: u.language,
    intent: u.intent,
    shop: { name: ctx.shop.name, address: ctx.shop.address, phone: ctx.shop.phone, order_link: ctx.shop.orderUrl },
    shop_faq: ctx.settings.faq || null,
    products: products.slice(0, 3).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      price_text: p.price !== null ? formatPrice(p.price, p.currency) : null,
      currency: p.currency,
      stock: p.stock,
      availability: p.stock === null ? 'unknown' : p.stock > 0 ? 'in_stock' : 'out_of_stock',
    })),
    customer: { name: u.customerName, phone: u.customerPhone, quantity: u.quantity },
  };
  const history = ctx.history.map((h) => `${h.role}: ${h.text}`).join('\n');
  const prompt = `<task>reply</task>
<facts>${JSON.stringify(facts)}</facts>
<history>${history}</history>
<message>${ctx.text}${ctx.imageUrls.length ? ' [customer sent a photo]' : ''}</message>
Write the shop's reply. Return JSON: {"reply": string, "handoff": boolean, "reason": string|null,
"order": {"product_id": number, "quantity": number} | null — only when the customer clearly confirmed buying a product in the facts AND gave name and phone}`;
  const raw = await models.chat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    { json: true, maxTokens: 400 },
  );
  const j = parseJson(raw) as { reply?: unknown; handoff?: unknown; reason?: unknown; order?: { product_id?: unknown; quantity?: unknown } | null };
  let reply = typeof j.reply === 'string' ? j.reply.trim() : '';
  let handoff = j.handoff === true || u.needsHuman;
  let reason: string | null = typeof j.reason === 'string' ? j.reason : u.needsHuman ? 'customer needs a person' : null;

  const check = checkGrounding(reply, facts.products, showPrice);
  if (!reply || !check.ok) {
    reply = fallbackReply(u.language, ctx.channel);
    handoff = true;
    reason = check.reason ?? 'empty reply';
  }

  let order: ReplyDecision['order'] = null;
  const pid = Number(j.order?.product_id);
  if (ctx.channel === 'dm' && ctx.settings.createOrders && pid && products.some((p) => p.id === pid) && u.customerName && u.customerPhone) {
    order = { productId: pid, quantity: Math.max(1, Math.floor(Number(j.order?.quantity) || u.quantity || 1)), customerName: u.customerName, customerPhone: u.customerPhone };
  }

  return { reply: reply.slice(0, 900), handoff, reason, products, understanding: u, order };
}

/**
 * Hard check on the model's text: every price-like number must be a real catalog price,
 * and public replies with show_price=false must not contain one.
 */
export function checkGrounding(reply: string, products: { price: number | null }[], showPrice: boolean): { ok: boolean; reason?: string } {
  const numbers = [...reply.matchAll(/\d[\d\s.,]*\d|\d/g)]
    .map((m) => Number(m[0].replace(/[\s.,]/g, '')))
    .filter((n) => n >= 1000);
  if (!numbers.length) return { ok: true };
  if (!showPrice) return { ok: false, reason: 'price in a public reply' };
  const real = new Set(products.map((p) => (p.price === null ? null : Math.round(p.price))).filter((n): n is number => n !== null));
  const unknown = numbers.filter((n) => !real.has(n) && !looksLikePhone(n));
  return unknown.length ? { ok: false, reason: `ungrounded number ${unknown[0]}` } : { ok: true };
}

function looksLikePhone(n: number): boolean {
  return String(n).length >= 9;
}

export function fallbackReply(language: Understanding['language'], channel: 'comment' | 'dm'): string {
  if (language === 'ru') return channel === 'comment' ? 'Спасибо! Напишите нам в Direct — ответим подробно 🙂' : 'Спасибо за сообщение! Уточню и скоро отвечу.';
  if (language === 'en') return channel === 'comment' ? 'Thanks! Send us a DM and we will help 🙂' : 'Thanks for your message! Let me check and get back to you shortly.';
  return channel === 'comment' ? "Rahmat! Direct'ga yozing, batafsil javob beramiz 🙂" : 'Xabaringiz uchun rahmat! Aniqlab, tez orada javob beraman.';
}

export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  return digits.length >= 9 ? `+${digits}` : null;
}

export function parseJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}
