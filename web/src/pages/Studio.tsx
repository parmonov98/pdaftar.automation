import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatPrice, type Me, type Product, type Promo } from '../api';
import { navigate } from '../App';
import { useT } from '../i18n';
import { ErrorBox } from './Inbox';

const TEMPLATES = ['product', 'collection', 'sale', 'new'] as const;

export function Studio({ me }: { me: Me }) {
  const { t } = useT();
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]>('product');
  const [enhance, setEnhance] = useState(true);
  const [oldPrices, setOldPrices] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promos, setPromos] = useState<Promo[]>([]);

  const loadProducts = useCallback(async (q: string) => {
    setLoadError(false);
    try {
      const r = await api<{ products: Product[] }>(`/api/catalog?search=${encodeURIComponent(q)}`);
      // Products customers can see, with a photo, come first.
      const rank = (p: Product) => (p.visible === false ? 2 : 0) + (p.images[0] ? 0 : 1);
      setProducts([...r.products].sort((a, b) => rank(a) - rank(b)));
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    const id = window.setTimeout(() => void loadProducts(search), 300);
    return () => window.clearTimeout(id);
  }, [search, loadProducts]);

  const loadPromos = useCallback(async () => {
    try {
      setPromos((await api<{ promos: Promo[] }>('/api/promos')).promos);
    } catch {
      /* keep the last list */
    }
  }, []);
  const working = promos.some((p) => ['queued', 'rendering', 'publishing'].includes(p.status));
  useEffect(() => {
    void loadPromos();
  }, [loadPromos]);
  useEffect(() => {
    if (!working) return;
    const id = window.setInterval(() => void loadPromos(), 3000);
    return () => window.clearInterval(id);
  }, [working, loadPromos]);

  const toggle = (id: number) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 10 ? s : [...s, id]));
  };
  // Single-product template uses the first pick only.
  useEffect(() => {
    if (selected.length > 1 && template === 'product') setTemplate('collection');
  }, [selected.length, template]);

  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const old: Record<string, number> = {};
      if (template === 'sale') {
        for (const id of selected) {
          const v = Number((oldPrices[id] ?? '').replace(/\s/g, ''));
          if (v > 0) old[String(id)] = v;
        }
      }
      await api('/api/promos', { method: 'POST', body: { productIds: selected, template, enhance, oldPrices: old } });
      setSelected([]);
      await loadPromos();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h2>{t.navStudio}</h2>
        <span className="muted">{selected.length ? t.selected(selected.length) : t.pickProducts}</span>
      </div>

      <section className="card pad stack">
        <input className="input" type="search" placeholder={t.searchProducts} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t.searchProducts} />
        {loadError ? (
          <ErrorBox onRetry={() => void loadProducts(search)} />
        ) : !products ? (
          <p className="muted">{t.loading}</p>
        ) : !products.length ? (
          <p className="muted">{t.empty}</p>
        ) : (
          <div className="products">
            {products.map((p) => {
              const on = selected.includes(p.id);
              return (
                <button key={p.id} className="product" aria-pressed={on} onClick={() => toggle(p.id)} disabled={!p.images[0]} title={!p.images[0] ? t.noPhoto : p.name}>
                  {p.images[0] ? <img src={p.images[0]} alt="" loading="lazy" /> : <div className="ph">{t.noPhoto}</div>}
                  {on && <span className="check">✓</span>}
                  <div className="meta">
                    <div className="name">{p.name}</div>
                    {p.visible === false && <div className="chip warn" style={{ marginBottom: 4 }}>{t.hiddenFromCustomers}</div>}
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>{formatPrice(p.price, p.currency)}</span>
                      {p.stock !== null && <span className={p.stock > 0 ? 'muted' : 'error-text'}>{p.stock > 0 ? p.stock : t.outOfStock}</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selected.length > 0 && (
        <section className="card pad stack">
          <div>
            <div className="label">{t.template}</div>
            <div className="templates">
              {TEMPLATES.map((k) => (
                <button key={k} aria-pressed={template === k} disabled={k === 'product' && selected.length > 1} onClick={() => setTemplate(k)}>
                  {t.templates[k]}
                </button>
              ))}
            </div>
          </div>
          {template === 'sale' &&
            selected.map((id) => (
              <div key={id} className="row">
                <span className="grow">{byId.get(id)?.name ?? `#${id}`} — {formatPrice(byId.get(id)?.price ?? null, byId.get(id)?.currency ?? null)}</span>
                <input className="input" style={{ maxWidth: 200 }} inputMode="numeric" placeholder={t.oldPrice} aria-label={t.oldPrice} value={oldPrices[id] ?? ''} onChange={(e) => setOldPrices((o) => ({ ...o, [id]: e.target.value }))} />
              </div>
            ))}
          <label className="toggle">
            <input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} />
            <span>{t.enhance}</span>
          </label>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div>
            <button className="btn primary" disabled={busy} onClick={() => void generate()}>
              {busy ? t.generating : t.generate}
            </button>
          </div>
        </section>
      )}

      {promos.length > 0 && (
        <section className="stack">
          <h3>{t.myVideos}</h3>
          <div className="videos">
            {promos.map((p) => (
              <PromoCard key={p.id} promo={p} igUsername={me.instagram?.username ?? null} onChange={loadPromos} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PromoCard({ promo, igUsername, onChange }: { promo: Promo; igUsername: string | null; onChange: () => void }) {
  const { t } = useT();
  const [caption, setCaption] = useState(promo.caption ?? '');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCaption(promo.caption ?? ''), [promo.caption]);

  const chip = promo.status === 'published' ? 'chip ok' : promo.status.startsWith('failed') ? 'chip err' : 'chip';
  const canPublish = ['ready', 'failed_publish', 'scheduled'].includes(promo.status);

  const publish = async (scheduled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/promos/${promo.id}/publish`, {
        method: 'POST',
        body: { caption, scheduledAt: scheduled && when ? new Date(when).toISOString() : null },
      });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card pad stack">
      <div className="row">
        <span className={chip}>{t.promoStatus[promo.status] ?? promo.status}</span>
        <span className="muted" style={{ fontSize: 13 }}>{t.templates[promo.template] ?? promo.template}</span>
      </div>
      {promo.video_url ? (
        <video className="video" src={promo.video_url} controls playsInline preload="metadata" />
      ) : (
        <div className="video" style={{ display: 'grid', placeItems: 'center', color: '#fff' }} aria-busy={!promo.error}>
          {promo.error ? '⚠️' : '⏳'}
        </div>
      )}
      {promo.error && <div className="error-text" role="alert">{promo.error}</div>}
      {promo.permalink && (
        <a href={promo.permalink} target="_blank" rel="noreferrer">
          {t.openOnInstagram} ↗
        </a>
      )}
      {canPublish && (
        <>
          <label className="label" htmlFor={`cap-${promo.id}`} style={{ marginBottom: -8 }}>
            {t.caption}
          </label>
          <textarea id={`cap-${promo.id}`} className="textarea" value={caption} onChange={(e) => setCaption(e.target.value)} />
          {igUsername ? (
            <>
              <div className="muted" style={{ fontSize: 13 }}>{t.publishTo(igUsername)}</div>
              <button className="btn primary" disabled={busy || !caption.trim()} onClick={() => void publish(false)}>
                {t.publishNow}
              </button>
              <div className="row">
                <input className="input grow" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label={t.schedule} />
                <button className="btn" disabled={busy || !when} onClick={() => void publish(true)}>
                  {t.schedule}
                </button>
              </div>
            </>
          ) : (
            <button className="btn" onClick={() => navigate('/app/settings')}>
              {t.connectFirst}
            </button>
          )}
          {error && <div className="error-text" role="alert">{error}</div>}
        </>
      )}
    </div>
  );
}
