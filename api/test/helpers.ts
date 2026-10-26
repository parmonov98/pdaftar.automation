import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockModels } from '../src/ai/models.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import type { AppContext } from '../src/services/context.js';

export interface Call {
  method: string;
  url: string;
  body: string | null;
}

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/** Fake fetch: routes are tried in order; every call is recorded. */
export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body === undefined || init.body === null ? null : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    calls.push({ method: init?.method ?? 'GET', url: url.href, body });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: { message: `no route for ${url.href}` } }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export const PRODUCTS = [
  { id: 11, name: 'Coca-Cola 1.5 L', price: 14000, currency: 'UZS', stock: 24, unit: 'dona', images: ['https://cdn.test/cola.jpg'] },
  { id: 12, name: 'Pepsi 1 L', price: 11000, currency: 'UZS', stock: 0, unit: 'dona', images: ['https://cdn.test/pepsi.jpg'] },
  { id: 13, name: 'Qora futbolka XL', price: 189000, currency: 'UZS', stock: 3, unit: 'dona', images: ['https://cdn.test/tshirt.jpg'] },
];

/** pDaftar integration API with the three products above. */
export function pdaftarRoutes(token = 'pda_valid_token_123') {
  return (url: URL, init?: RequestInit) => {
    if (!url.pathname.startsWith('/api/integration/automation')) return undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${token}`) return json({ message: 'Unauthenticated.' }, 401);
    const path = url.pathname.replace('/api/integration/automation', '');
    if (path === '/shop') return json({ data: { id: 729, name: 'THEDEVS MCHJ', currency: 'UZS', phone: '+998901112233', address: 'Toshkent, Chilonzor', order_url: 'https://shop.pdaftar.uz/s/729' } });
    if (path === '/products') {
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      return json({ data: PRODUCTS.filter((p) => !q || p.name.toLowerCase().includes(q)) });
    }
    const m = path.match(/^\/products\/(\d+)$/);
    if (m) {
      const p = PRODUCTS.find((x) => x.id === Number(m[1]));
      return p ? json({ data: p }) : json({ message: 'Not found' }, 404);
    }
    if (path === '/orders' && init?.method === 'POST') return json({ data: { id: 501, status: 'new', url: 'https://shop.pdaftar.uz/o/501' } }, 201);
    return undefined;
  };
}

export function testContext(fetchImpl: typeof fetch, env: Record<string, string> = {}): AppContext {
  const dir = mkdtempSync(join(tmpdir(), 'pda-test-'));
  const config = loadConfig({
    DATA_DIR: dir,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: 'https://automation.test',
    PDAFTAR_API_BASE_URL: 'https://pdaftar.test',
    IG_APP_ID: 'app1',
    IG_APP_SECRET: 'secret1',
    IG_WEBHOOK_VERIFY_TOKEN: 'verify1',
    IG_REDIRECT_URI: 'https://automation.test/auth/instagram/callback',
    ...env,
  });
  const logs: string[] = [];
  return { config, db: openDb(join(dir, 'db.sqlite')), models: new MockModels(), fetchImpl, log: (m) => logs.push(m) };
}
