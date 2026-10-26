import { useState, type FormEvent } from 'react';
import { api, formatPrice } from '../api';
import { useT } from '../i18n';

interface Result {
  reply: string;
  handoff: boolean;
  reason: string | null;
  understanding: { intent: string; productQuery: string | null; language: string; confidence: number };
  products: { id: number; name: string; price: number | null; currency: string | null; stock: number | null; image: string | null }[];
  ms: number;
  model: string;
}

export function Playground() {
  const { t } = useT();
  const [channel, setChannel] = useState<'dm' | 'comment'>('dm');
  const [text, setText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api<Result>('/api/playground', { method: 'POST', body: { channel, text, imageUrl: imageUrl.trim() || undefined } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h2>{t.navPlayground}</h2>
      </div>
      <p className="muted" style={{ margin: 0 }}>{t.playgroundIntro}</p>
      <form className="card pad stack" onSubmit={run}>
        <div className="tabs" role="tablist" aria-label={t.channel}>
          <button type="button" role="tab" aria-selected={channel === 'dm'} onClick={() => setChannel('dm')}>
            {t.channelDm}
          </button>
          <button type="button" role="tab" aria-selected={channel === 'comment'} onClick={() => setChannel('comment')}>
            {t.channelComment}
          </button>
        </div>
        <div>
          <label className="label" htmlFor="pg-text">{t.message}</label>
          <textarea id="pg-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            {t.examples.map((ex) => (
              <button key={ex} type="button" className="btn small" onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
        </div>
        {channel === 'dm' && (
          <div>
            <label className="label" htmlFor="pg-img">{t.imageUrl}</label>
            <input id="pg-img" className="input" type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
          </div>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
        <div>
          <button className="btn primary" type="submit" disabled={busy || (!text.trim() && !imageUrl.trim())}>
            {busy ? t.running : t.run}
          </button>
        </div>
      </form>

      {result && (
        <section className="card pad stack" aria-live="polite">
          <div className="row">
            <h3 className="grow">{t.reply}</h3>
            {result.handoff && <span className="chip warn">{t.handoffYes}</span>}
            <span className="muted" style={{ fontSize: 13 }}>
              {result.model} · {(result.ms / 1000).toFixed(1)} s
            </span>
          </div>
          <div className="bubble out" style={{ maxWidth: '100%' }}>{result.reply}</div>
          <div className="muted" style={{ fontSize: 14 }}>
            {t.intent}: <strong>{result.understanding.intent}</strong>
            {result.understanding.productQuery && <> · “{result.understanding.productQuery}”</>} · {result.understanding.language}
            {result.reason && <> · {result.reason}</>}
          </div>
          {result.products.length > 0 && (
            <>
              <h3>{t.matched}</h3>
              <div className="list">
                {result.products.map((p) => (
                  <div key={p.id} className="row">
                    {p.image && <img src={p.image} alt="" width={44} height={44} style={{ borderRadius: 8, objectFit: 'cover' }} />}
                    <span className="grow">{p.name}</span>
                    <span>{formatPrice(p.price, p.currency)}</span>
                    {p.stock !== null && <span className={p.stock > 0 ? 'chip ok' : 'chip err'}>{p.stock > 0 ? `${t.inStock}: ${p.stock}` : t.outOfStock}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
