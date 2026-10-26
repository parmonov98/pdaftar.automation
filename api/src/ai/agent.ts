import type { PdProduct } from '../pdaftar/client.js';
import { formatPrice } from '../video/render.js';
import type { AiModels, ChatMessage, ChatPart, ToolSpec } from './models.js';
import { checkGrounding, decideReply, fallbackReply, normalisePhone, type ReplyContext, type ReplyDecision } from './replies.js';

/**
 * Agent mode: Muse Spark decides which tools to call (catalog search, product lookup,
 * order intent, hand-off) and writes the answer from what the tools returned.
 * The same grounding check as the pipeline runs on the final text, so the agent can
 * never send a price it did not get from the catalog.
 */

export type ReplyEngine = 'pipeline' | 'agent';

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export type AgentDecision = ReplyDecision & { trace: AgentStep[] };

const MAX_ROUNDS = 5;

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: "Search the shop's catalog by product name in the customer's words (Uzbek, Russian, brand names). Returns up to 5 products with price and availability.",
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Short product name, e.g. "coca cola 1.5"' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_product',
      description: 'Get one product by id (from an earlier search) with its current price and availability.',
      parameters: { type: 'object', properties: { product_id: { type: 'integer' } }, required: ['product_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_order',
      description:
        'Place an order ONLY after the customer clearly confirmed they want to buy, and gave their name and phone number in the conversation. Never invent a name or phone.',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'integer' },
          quantity: { type: 'number' },
          customer_name: { type: 'string' },
          customer_phone: { type: 'string' },
        },
        required: ['product_id', 'quantity', 'customer_name', 'customer_phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff',
      description: 'Hand the conversation to the shop owner: complaints, refunds, a request for a person, or anything the catalog and shop facts cannot answer.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  },
];

function systemPrompt(ctx: ReplyContext, showPrice: boolean): string {
  return `You are the Instagram ${ctx.channel === 'comment' ? 'comment' : 'Direct'} assistant of the shop "${ctx.shop.name}" in Uzbekistan.
Use the tools to look things up. Facts about products come ONLY from tool results; never invent prices, stock, discounts or delivery terms.
${showPrice ? 'You may state prices exactly as returned (price_text).' : 'Do NOT write any price; invite the customer to write in Direct for the price.'}
Shop facts from the owner: ${ctx.settings.faq || '(none)'}
Shop address: ${ctx.shop.address ?? '(unknown)'}${ctx.shop.orderUrl ? `; online catalog: ${ctx.shop.orderUrl}` : ''}
Reply in the customer's language (Uzbek Latin by default, Russian if they write Russian). 1–3 short sentences, at most one emoji.
If you are unsure, or the customer is upset or asks for a person, call handoff and politely say the owner will answer soon.
${ctx.channel === 'comment' ? 'This is a public comment: never ask for or repeat phone numbers; never place orders.' : ''}
When you are done, answer with the final reply text only (no JSON).`;
}

export async function runAgent(models: AiModels, ctx: ReplyContext): Promise<AgentDecision> {
  const showPrice = ctx.shop.showPrices && (ctx.channel === 'dm' || ctx.settings.publicPrice);
  const seen = new Map<number, PdProduct>();
  for (const p of ctx.contextProducts) if (p.visible) seen.set(p.id, p);
  const trace: AgentStep[] = [];
  let handoff: string | null = null;
  let order: ReplyDecision['order'] = null;

  const view = (p: PdProduct) => ({
    id: p.id,
    name: p.name,
    price_text: showPrice && p.price !== null ? formatPrice(p.price, p.currency) : null,
    availability: p.stock === null ? (p.orderable ? 'unknown' : 'out_of_stock') : p.stock > 0 && p.orderable ? 'in_stock' : 'out_of_stock',
    stock: p.showQuantity ? p.stock : null,
  });

  const userContent: ChatPart[] = [{ type: 'text', text: ctx.text || '(no text)' }];
  for (const url of ctx.imageUrls.slice(0, 2)) userContent.push({ type: 'image_url', image_url: { url } });
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(ctx, showPrice) },
    ...ctx.history.map((h) => ({ role: h.role === 'customer' ? ('user' as const) : ('assistant' as const), content: h.text })),
  ];
  if (ctx.contextProducts.length) {
    messages.push({ role: 'system', content: `The comment is under a post showing: ${JSON.stringify(ctx.contextProducts.filter((p) => p.visible).map(view))}` });
  }
  messages.push({ role: 'user', content: ctx.imageUrls.length ? userContent : ctx.text });

  let final: string | null = null;
  for (let round = 0; round < MAX_ROUNDS && final === null; round++) {
    const turn = await models.chatWithTools(messages, ctx.channel === 'comment' ? TOOLS.filter((t) => t.function.name !== 'place_order') : TOOLS);
    if (!turn.toolCalls.length) {
      final = turn.content ?? '';
      break;
    }
    messages.push({ role: 'assistant', content: turn.content, tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = await runTool(call.function.name, args);
      trace.push({ tool: call.function.name, args, result: result.slice(0, 400) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      if (name === 'search_catalog') {
        const found = (await ctx.searchCatalog(String(args.query ?? '').slice(0, 80))).filter((p) => p.visible).slice(0, 5);
        found.forEach((p) => seen.set(p.id, p));
        return JSON.stringify({ products: found.map(view) });
      }
      if (name === 'get_product') {
        const p = seen.get(Number(args.product_id));
        return JSON.stringify(p ? view(p) : { error: 'unknown product id; search first' });
      }
      if (name === 'place_order') {
        const p = seen.get(Number(args.product_id));
        const phone = normalisePhone(String(args.customer_phone ?? ''));
        const name_ = String(args.customer_name ?? '').trim();
        // The name and phone must really appear in what the customer wrote.
        const said = [ctx.text, ...ctx.history.filter((h) => h.role === 'customer').map((h) => h.text)].join('\n');
        const digits = said.replace(/\D/g, '');
        if (ctx.channel !== 'dm' || !ctx.settings.createOrders) return JSON.stringify({ ok: false, error: 'orders are not taken here' });
        if (!p || !p.orderable) return JSON.stringify({ ok: false, error: 'product not orderable' });
        if (!phone || !digits.includes(phone.replace(/\D/g, '').slice(-9))) return JSON.stringify({ ok: false, error: 'ask the customer for their phone number' });
        if (name_.length < 2 || !said.toLowerCase().includes(name_.toLowerCase().split(/\s+/)[0]!)) return JSON.stringify({ ok: false, error: 'ask the customer for their name' });
        order = { productId: p.id, quantity: Math.max(1, Math.floor(Number(args.quantity) || 1)), customerName: name_, customerPhone: phone };
        return JSON.stringify({ ok: true, note: 'The order will be registered with the shop; tell the customer the shop will confirm.' });
      }
      if (name === 'handoff') {
        handoff = String(args.reason ?? 'agent asked for a person').slice(0, 200);
        return JSON.stringify({ ok: true });
      }
      return JSON.stringify({ error: `unknown tool ${name}` });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message.slice(0, 200) });
    }
  }

  const products = [...seen.values()];
  let reply = (final ?? '').trim();
  let reason: string | null = handoff;
  const check = checkGrounding(reply, products.map((p) => ({ price: showPrice ? p.price : null })), showPrice);
  const language = /[а-яё]/i.test(ctx.text) && !/[ўқғҳ]/i.test(ctx.text) ? 'ru' : 'uz';
  if (!reply || !check.ok) {
    reply = fallbackReply(language, ctx.channel);
    reason = check.reason ?? (final === null ? 'agent did not finish' : 'empty reply');
    handoff = handoff ?? reason;
  }

  return {
    reply: reply.slice(0, 900),
    handoff: handoff !== null,
    reason,
    products,
    understanding: { intent: 'other', productQuery: null, language, needsHuman: handoff !== null, confidence: 1, customerName: null, customerPhone: null, quantity: null },
    order,
    trace,
  };
}

/** Picks the configured engine. */
export async function replyFor(models: AiModels, ctx: ReplyContext, engine: ReplyEngine): Promise<ReplyDecision & { trace?: AgentStep[] }> {
  return engine === 'agent' ? runAgent(models, ctx) : decideReply(models, ctx);
}
