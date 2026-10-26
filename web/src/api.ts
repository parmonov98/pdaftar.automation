export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export interface Settings {
  faq: string;
  autoSend: boolean;
  replyToComments: boolean;
  replyToDms: boolean;
  publicPrice: boolean;
  privateReply: boolean;
  createOrders: boolean;
}

export interface Me {
  shop: { id: number; name: string };
  instagram: { username: string; picture: string | null } | null;
  settings: Settings;
  safeMode: boolean;
  instagramConfigured: boolean;
  ai: string;
}

export interface Product {
  id: number;
  name: string;
  price: number | null;
  currency: string | null;
  stock: number | null;
  images: string[];
}

export interface Promo {
  id: number;
  product_ids_json: string;
  template: string;
  status: string;
  caption: string | null;
  video_url: string | null;
  permalink: string | null;
  scheduled_at: string | null;
  error: string | null;
  created_at: string;
}

export interface CommentRow {
  id: number;
  from_username: string | null;
  text: string;
  reply_text: string | null;
  status: string;
  reason: string | null;
  created_at: string;
}

export interface Conversation {
  id: number;
  username: string | null;
  igsid: string;
  status: string;
  ai_enabled: number;
  last_text: string | null;
  drafts: number;
  updated_at: string;
}

export interface Message {
  id: number;
  direction: 'in' | 'out';
  text: string | null;
  attachments_json: string;
  status: string;
  handled_by: string | null;
  created_at: string;
}

export function formatPrice(amount: number | null, currency: string | null): string {
  if (amount === null) return '—';
  const grouped = Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (!currency || /^(uzs|so'?m)$/i.test(currency)) return `${grouped} so'm`;
  return currency.toUpperCase() === 'USD' ? `$${grouped}` : `${grouped} ${currency}`;
}
