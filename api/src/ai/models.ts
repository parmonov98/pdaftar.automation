import type { Config } from '../config.js';

/**
 * Every AI step in the product goes through this interface, and in production it is
 * backed by Meta's models (Meta Model API). The mock exists so tests and local
 * development run without keys; it is never used when AI_PROVIDER=meta.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatPart[];
}

export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface AiModels {
  readonly name: string;
  /** Returns the model's text. `json` asks for a single JSON object. */
  chat(messages: ChatMessage[], opts?: { json?: boolean; vision?: boolean; maxTokens?: number }): Promise<string>;
  /** Cuts the main product out of a photo. Returns a PNG with transparency, or null if unsupported. */
  segmentProduct(image: Buffer, hint: string): Promise<Buffer | null>;
  /** Places the product cut-out into a clean scene. Returns an image, or null if unsupported. */
  stageProduct(cutout: Buffer, prompt: string): Promise<Buffer | null>;
}

export class AiError extends Error {}

export function createModels(config: Config['ai'], fetchImpl: typeof fetch = fetch): AiModels {
  return config.provider === 'meta' ? new MetaModels(config, fetchImpl) : new MockModels();
}

/** Meta Model API. Chat uses the OpenAI-compatible chat completions endpoint. */
export class MetaModels implements AiModels {
  readonly name = 'meta';
  /** Customer messages must never go to "contributor" variants, which Meta may train on. */
  static assertPrivateModel(model: string): void {
    if (/contributor/i.test(model)) throw new AiError(`Model ${model} may train on inputs; refusing to send customer data`);
  }

  constructor(
    private readonly cfg: Config['ai'],
    private readonly fetchImpl: typeof fetch,
  ) {
    if (!cfg.apiKey) throw new AiError('META_API_KEY is not set');
    if (!cfg.textModel) throw new AiError('META_TEXT_MODEL is not set');
    MetaModels.assertPrivateModel(cfg.textModel);
    MetaModels.assertPrivateModel(cfg.visionModel);
  }

  async chat(messages: ChatMessage[], opts: { json?: boolean; vision?: boolean; maxTokens?: number } = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: opts.vision ? this.cfg.visionModel || this.cfg.textModel : this.cfg.textModel,
      messages,
      temperature: 0.2,
      max_completion_tokens: opts.maxTokens ?? 600,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    const res = await this.post('/chat/completions', body);
    const content = extractContent(res);
    if (content === null) throw new AiError('Meta Model API returned no content');
    return content;
  }

  /**
   * SAM 3.1 through /responses. SAM answers with a token stream such as
   * `<0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;...|>`. We use the box to crop
   * the product; it needs no RLE decoder and is enough for a clean product frame.
   */
  async segmentProduct(image: Buffer, hint: string): Promise<Buffer | null> {
    if (!this.cfg.segmentModel) return null;
    const res = await this.post('/responses', {
      model: this.cfg.segmentModel,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: hint },
            { type: 'input_image', image_url: `data:${sniffMime(image)};base64,${image.toString('base64')}` },
          ],
        },
      ],
    });
    const box = parseSamBox(responseText(res));
    if (!box) return null;
    return cropToBox(image, box);
  }

  /** Muse Image edit: the product crop goes in `images[]`; the model builds the scene around it. */
  async stageProduct(cutout: Buffer, prompt: string): Promise<Buffer | null> {
    if (!this.cfg.imageModel) return null;
    const res = await this.post('/images/edits', {
      model: this.cfg.imageModel,
      images: [`data:${sniffMime(cutout)};base64,${cutout.toString('base64')}`],
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    });
    return firstImage(res);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new AiError(`Meta Model API ${path} ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

/** Handles both the OpenAI-compatible shape and Llama API's native `completion_message`. */
export function extractContent(res: unknown): string | null {
  const r = res as {
    choices?: { message?: { content?: unknown } }[];
    completion_message?: { content?: unknown };
  };
  const raw = r.choices?.[0]?.message?.content ?? r.completion_message?.content;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'text' in raw) return String((raw as { text: unknown }).text);
  if (Array.isArray(raw)) {
    return raw
      .map((p) => (typeof p === 'string' ? p : (p as { text?: string }).text ?? ''))
      .join('');
  }
  return null;
}

export interface SamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

/** First `<|box;...|>` in SAM's output. Coordinates are relative to w×h. */
export function parseSamBox(text: string): SamBox | null {
  const m = text.match(/<\|box;([^|]*)\|>/);
  if (!m) return null;
  const kv = Object.fromEntries(
    m[1]!.split(';').map((pair) => {
      const [k, v] = pair.split('=');
      return [k?.trim(), Number(v)];
    }),
  ) as Record<string, number>;
  const { x1, y1, x2, y2, w, h } = kv;
  if ([x1, y1, x2, y2, w, h].some((n) => n === undefined || !Number.isFinite(n))) return null;
  if (x2! <= x1! || y2! <= y1!) return null;
  return { x1: x1!, y1: y1!, x2: x2!, y2: y2!, w: w!, h: h! };
}

/** Concatenates text from a /responses result (output[].content[].text) or a plain string. */
export function responseText(res: unknown): string {
  if (typeof res === 'string') return res;
  const r = res as { output_text?: string; output?: { content?: { text?: string }[] }[] };
  if (typeof r.output_text === 'string') return r.output_text;
  return (r.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('');
}

export function sniffMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

/** Crops with a 6% margin around the box, using ffmpeg (no image library needed). */
async function cropToBox(image: Buffer, box: SamBox): Promise<Buffer> {
  const { cropImage } = await import('../video/ffmpeg.js');
  const padX = (box.x2 - box.x1) * 0.06;
  const padY = (box.y2 - box.y1) * 0.06;
  return cropImage(image, {
    left: Math.max(0, (box.x1 - padX) / box.w),
    top: Math.max(0, (box.y1 - padY) / box.h),
    right: Math.min(1, (box.x2 + padX) / box.w),
    bottom: Math.min(1, (box.y2 + padY) / box.h),
  });
}

function firstImage(res: unknown): Buffer | null {
  const r = res as { data?: { b64_json?: string; url?: string }[]; image?: string; mask?: string };
  const b64 = r.data?.[0]?.b64_json ?? r.image ?? r.mask;
  if (!b64) return null;
  return Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64');
}

/**
 * Deterministic stand-in for tests and key-less development. It answers from the
 * prompt's own JSON facts so the pipeline can be exercised end to end.
 */
export class MockModels implements AiModels {
  readonly name = 'mock';

  async chat(messages: ChatMessage[], opts: { json?: boolean } = {}): Promise<string> {
    const last = messages[messages.length - 1];
    const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    const marker = text.match(/<task>(\w+)<\/task>/)?.[1];
    if (marker === 'understand') return JSON.stringify(mockUnderstand(text));
    if (marker === 'reply') return JSON.stringify(mockReply(text));
    if (marker === 'caption') return JSON.stringify(mockCaption(text));
    if (marker === 'describe') return JSON.stringify({ query: 'mahsulot', description: 'mahsulot rasmi' });
    return opts.json ? '{}' : 'OK';
  }

  async segmentProduct(): Promise<Buffer | null> {
    return null;
  }

  async stageProduct(): Promise<Buffer | null> {
    return null;
  }
}

function between(text: string, tag: string): string {
  return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';
}

function mockUnderstand(text: string) {
  const msg = between(text, 'message').toLowerCase();
  const cyr = /[а-яё]/i.test(msg);
  const intent = /narx|qancha|necha|цена|сколько|price/.test(msg)
    ? 'price'
    : /bormi|bor mi|есть|qoldi|available/.test(msg)
      ? 'availability'
      : /dostavka|yetkaz|доставк/.test(msg)
        ? 'delivery'
        : /operator|odam|менеджер|shikoyat|жалоб/.test(msg)
          ? 'human'
          : /salom|assalom|привет|hello/.test(msg)
            ? 'greeting'
            : 'other';
  const query = msg
    .replace(/[?!.,]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/narx|qancha|necha|bormi|salom|цена|сколько|есть|price|nechpul|turadi/.test(w))
    .join(' ');
  return {
    intent,
    product_query: query || null,
    language: cyr ? 'ru' : 'uz',
    needs_human: intent === 'human',
    confidence: 0.8,
  };
}

function mockReply(text: string) {
  const facts = JSON.parse(between(text, 'facts') || '{}') as {
    products?: { name: string; price: number | null; price_text?: string | null; currency: string | null; stock: number | null }[];
    channel?: string;
    show_price?: boolean;
    language?: string;
  };
  const intent = (facts as { intent?: string }).intent;
  if (intent === 'human' || intent === 'complaint') {
    return { reply: "Uzr, noqulaylik uchun! Do'kon egasi tez orada o'zi javob beradi.", handoff: true };
  }
  const p = facts.products?.[0];
  if (!p) return { reply: 'Assalomu alaykum! Qaysi mahsulot qiziqtirdi? Rasmini yuboring, aniqlab beraman.', handoff: false };
  if (facts.channel === 'comment' && !facts.show_price) {
    return { reply: `${p.name} bor! Narxi va buyurtma uchun Direct'ga yozing 🙂`, handoff: false };
  }
  const price = p.price_text ?? 'narxini aniqlab beraman';
  const avail = (p as { availability?: string }).availability;
  const stock = avail === 'out_of_stock' ? ' Hozircha tugagan.' : p.stock !== null ? ` Omborda ${p.stock} ta bor.` : avail === 'in_stock' ? ' Mavjud.' : '';
  return { reply: `${p.name} — ${price}.${stock} Buyurtma berasizmi?`, handoff: false };
}

function mockCaption(text: string) {
  const facts = JSON.parse(between(text, 'facts') || '{}') as { products?: { name: string }[]; shop?: { name?: string } };
  const names = (facts.products ?? []).map((p) => p.name).join(', ');
  return {
    headline: facts.products?.length === 1 ? facts.products[0]!.name : 'Yangi kelgan mahsulotlar',
    caption: `${names} — ${facts.shop?.name ?? ''}da! Narx va buyurtma uchun Direct'ga yozing.`,
    hashtags: ['#toshkent', '#dokon', '#pdaftar'],
  };
}
