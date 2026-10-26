/**
 * Client for pDaftar's integration API (`/api/integration/automation/*`).
 * Authenticated with a per-shop integration token issued inside pDaftar.
 * The response shapes are normalised here so the rest of the service never
 * depends on pDaftar's envelope.
 */

export interface PdShop {
  id: number;
  name: string;
  currency: string | null;
  phone: string | null;
  address: string | null;
  orderUrl: string | null;
}

export interface PdProduct {
  id: number;
  name: string;
  price: number | null;
  currency: string | null;
  stock: number | null;
  unit: string | null;
  images: string[];
  /** Owner allows this product in the public catalog (hidden ones are never offered). */
  visible: boolean;
  /** Owner allows customers to see the stock count; otherwise only "available". */
  showQuantity: boolean;
  /** Whether pDaftar would accept an order for it right now. */
  orderable: boolean;
}

export interface PdOrderInput {
  customerName: string;
  customerPhone?: string;
  items: { productId: number; quantity: number }[];
  note?: string;
  externalRef?: string;
}

export interface PdOrder {
  id: number;
  status: string | null;
  url: string | null;
}

export class PdaftarError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class PdaftarClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async shop(): Promise<PdShop> {
    const body = await this.request('GET', '/shop');
    return normaliseShop(unwrap(body));
  }

  async products(params: { search?: string; page?: number; perPage?: number } = {}): Promise<PdProduct[]> {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', String(params.page));
    q.set('per_page', String(params.perPage ?? 50));
    const body = await this.request('GET', `/products?${q}`);
    const data = unwrap(body);
    const rows = Array.isArray(data) ? data : Array.isArray((data as { data?: unknown })?.data) ? (data as { data: unknown[] }).data : [];
    return rows.map(normaliseProduct);
  }

  async product(id: number): Promise<PdProduct | null> {
    try {
      return normaliseProduct(unwrap(await this.request('GET', `/products/${id}`)));
    } catch (e) {
      if (e instanceof PdaftarError && e.status === 404) return null;
      throw e;
    }
  }

  async createOrder(input: PdOrderInput): Promise<PdOrder> {
    const body = await this.request('POST', '/orders', {
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      items: input.items.map((i) => ({ product_id: i.productId, quantity: i.quantity })),
      note: input.note,
      external_ref: input.externalRef,
    });
    const o = unwrap(body) as Record<string, unknown>;
    return {
      id: Number(o.id),
      status: str(o.status),
      url: str(o.url ?? o.order_url ?? o.view_url),
    };
  }

  private async request(method: string, path: string, json?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/integration/automation${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = (body as { message?: string } | null)?.message ?? `pDaftar ${method} ${path} failed`;
      throw new PdaftarError(msg, res.status);
    }
    return body;
  }
}

function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body) {
    const inner = (body as { data: unknown }).data;
    // Paginated lists keep their `data` array one level down.
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && 'data' in inner && Array.isArray((inner as { data: unknown }).data)) {
      return inner;
    }
    return inner;
  }
  return body;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normaliseShop(raw: unknown): PdShop {
  const s = (raw ?? {}) as Record<string, unknown>;
  const currencies = s.currencies;
  const currency =
    str(s.currency) ??
    str((s.currency as { code?: string } | undefined)?.code) ??
    (Array.isArray(currencies) ? str(currencies[0]) ?? str((currencies[0] as { code?: string } | undefined)?.code) : null);
  return {
    id: Number(s.id),
    name: str(s.name) ?? 'Shop',
    currency,
    phone: str(s.phone),
    address: str(s.address),
    orderUrl: str(s.order_url ?? s.catalog_url ?? s.public_url),
  };
}

export function normaliseProduct(raw: unknown): PdProduct {
  const p = (raw ?? {}) as Record<string, unknown>;
  const price = p.price as unknown;
  const images = Array.isArray(p.images) ? p.images : p.image ? [p.image] : p.image_url ? [p.image_url] : [];
  return {
    id: Number(p.id),
    name: str(p.name) ?? '',
    price: typeof price === 'object' && price !== null ? num((price as { amount?: unknown }).amount) : num(price ?? p.sale_price),
    currency:
      str(p.currency) ??
      (typeof price === 'object' && price !== null ? str((price as { currency?: unknown }).currency) : null),
    stock: num(p.stock_quantity ?? p.stock ?? p.quantity),
    unit: str(p.unit) ?? str((p.unit as { name?: string } | undefined)?.name),
    images: images
      .map((i: unknown) => (typeof i === 'string' ? i : str((i as { url?: string })?.url)))
      .filter((i): i is string => !!i),
    visible: p.is_visible_to_clients === undefined ? true : p.is_visible_to_clients === true,
    showQuantity: p.show_quantity_to_clients === undefined ? true : p.show_quantity_to_clients === true,
    orderable: p.is_orderable === undefined ? true : p.is_orderable === true,
  };
}
