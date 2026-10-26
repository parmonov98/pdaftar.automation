import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/ai/agent.js';
import type { AiModels, ChatMessage, ToolSpec, ToolTurn } from '../src/ai/models.js';
import { MockModels } from '../src/ai/models.js';
import { DEFAULT_SETTINGS, type ReplyContext } from '../src/ai/replies.js';
import { normaliseProduct } from '../src/pdaftar/client.js';
import { PRODUCTS } from './helpers.js';

const catalog = PRODUCTS.map(normaliseProduct);
const shop = { id: 729, name: 'THEDEVS', currency: 'UZS', phone: null, address: 'Toshkent', orderUrl: null, showPrices: true };

function ctx(over: Partial<ReplyContext> = {}): ReplyContext {
  return {
    channel: 'dm',
    text: 'cola narxi qancha?',
    imageUrls: [],
    contextProducts: [],
    shop,
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    searchCatalog: async (q: string) => catalog.filter((p) => p.name.toLowerCase().includes(q.toLowerCase().split(' ')[0]!)),
    ...over,
  };
}

/** A scripted "model": returns the queued turns in order and records what it saw. */
function scripted(turns: ToolTurn[]): AiModels & { seen: { messages: ChatMessage[]; tools: ToolSpec[] }[] } {
  const seen: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  const base = new MockModels();
  return Object.assign(Object.create(base), {
    seen,
    chatWithTools: async (messages: ChatMessage[], tools: ToolSpec[]) => {
      seen.push({ messages: [...messages], tools });
      return turns.shift() ?? { content: 'ok', toolCalls: [] };
    },
  });
}
const call = (name: string, args: unknown, id = name) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('agent mode', () => {
  it('searches the catalog and answers with the real price (mock model)', async () => {
    const d = await runAgent(new MockModels(), ctx());
    expect(d.trace.map((s) => s.tool)).toEqual(['search_catalog']);
    expect(d.reply).toContain("14 000 so'm");
    expect(d.handoff).toBe(false);
  });

  it('a made-up price in the final answer is replaced and handed off', async () => {
    const m = scripted([{ content: null, toolCalls: [call('search_catalog', { query: 'cola' })] }, { content: 'Coca-Cola 9 999 so‘m', toolCalls: [] }]);
    const d = await runAgent(m, ctx());
    expect(d.handoff).toBe(true);
    expect(d.reason).toMatch(/ungrounded/);
    expect(d.reply).not.toContain('9 999');
  });

  it('hidden products and hidden counts never reach the model', async () => {
    const m = scripted([{ content: null, toolCalls: [call('search_catalog', { query: 'futbolka' })] }, { content: 'ok', toolCalls: [] }]);
    await runAgent(m, ctx({ text: 'futbolka bormi' }));
    const toolMsg = m.seen[1]!.messages.find((x) => x.role === 'tool')!;
    const result = JSON.parse(String(toolMsg.content)) as { products: { name: string; stock: number | null }[] };
    expect(result.products.map((p) => p.name)).toEqual(['Qora futbolka XL']);
    expect(result.products[0]!.stock).toBeNull();
  });

  it('only places an order with a name and phone the customer actually wrote', async () => {
    const order = call('place_order', { product_id: 13, quantity: 1, customer_name: 'Ali', customer_phone: '+998901112233' });
    const invented = scripted([{ content: null, toolCalls: [call('search_catalog', { query: 'futbolka' })] }, { content: null, toolCalls: [order] }, { content: 'Rahmat!', toolCalls: [] }]);
    const d1 = await runAgent(invented, ctx({ text: 'futbolka olaman' }));
    expect(d1.order).toBeNull();
    expect(d1.trace[1]!.result).toContain('phone');

    const real = scripted([{ content: null, toolCalls: [call('search_catalog', { query: 'futbolka' })] }, { content: null, toolCalls: [order] }, { content: 'Rahmat, buyurtma qabul qilindi!', toolCalls: [] }]);
    const d2 = await runAgent(real, ctx({ text: 'Ali, 90 111 22 33, futbolka olaman' }));
    expect(d2.order).toEqual({ productId: 13, quantity: 1, customerName: 'Ali', customerPhone: '+998901112233' });
  });

  it('public comments cannot place orders or show prices', async () => {
    const m = scripted([{ content: null, toolCalls: [call('search_catalog', { query: 'cola' })] }, { content: 'Coca-Cola 14 000 so‘m', toolCalls: [] }]);
    const d = await runAgent(m, ctx({ channel: 'comment', text: 'cola narxi?' }));
    expect(m.seen[0]!.tools.map((t) => t.function.name)).not.toContain('place_order');
    expect(d.reply).not.toContain('14 000');
    expect(d.handoff).toBe(true);
  });

  it('hand-off from the model is honoured', async () => {
    const d = await runAgent(new MockModels(), ctx({ text: 'shikoyat: buyurtma kelmadi, operator kerak' }));
    expect(d.handoff).toBe(true);
    expect(d.trace[0]!.tool).toBe('handoff');
  });

  it('stops after the round limit', async () => {
    const loop = scripted(Array.from({ length: 10 }, (_, i) => ({ content: null, toolCalls: [call('search_catalog', { query: 'cola' }, `c${i}`)] })));
    const d = await runAgent(loop, ctx());
    expect(d.trace).toHaveLength(5);
    expect(d.handoff).toBe(true);
  });
});

