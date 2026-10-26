import { useEffect, useState } from 'react';
import { api, type Me, type Settings } from '../api';
import { useT } from '../i18n';

const TOGGLES: (keyof Omit<Settings, 'faq'>)[] = ['autoSend', 'replyToComments', 'replyToDms', 'publicPrice', 'privateReply', 'createOrders'];

export function SettingsPage({ me, onChange }: { me: Me; onChange: () => void }) {
  const { t } = useT();
  const [s, setS] = useState<Settings>(me.settings);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const igStatus = new URLSearchParams(window.location.search).get('instagram');

  useEffect(() => setS(me.settings), [me.settings]);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await api('/api/settings', { method: 'PUT', body: s });
      setSaved(true);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setError(null);
    try {
      const r = await api<{ url: string }>('/api/instagram/connect');
      window.location.href = r.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    }
  };

  const disconnect = async () => {
    await api('/api/instagram', { method: 'DELETE' }).catch(() => undefined);
    onChange();
  };

  return (
    <div className="stack" style={{ maxWidth: 760, gap: 20 }}>
      <h2>{t.navSettings}</h2>

      <section className="card pad stack">
        <h3>{t.instagram}</h3>
        {igStatus && igStatus !== 'connected' && <div className="error-text" role="alert">Instagram: {igStatus}</div>}
        {me.instagram ? (
          <div className="row">
            {me.instagram.picture && <img src={me.instagram.picture} alt="" width={40} height={40} style={{ borderRadius: 99 }} />}
            <strong className="grow">{t.connected(me.instagram.username)}</strong>
            <button className="btn small danger" onClick={() => void disconnect()}>
              {t.disconnect}
            </button>
          </div>
        ) : me.instagramConfigured ? (
          <div>
            <button className="btn primary" onClick={() => void connect()}>
              {t.connect}
            </button>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>{t.igNotConfigured}</p>
        )}
      </section>

      <section className="card pad stack">
        <h3>{t.behaviour}</h3>
        <div>
          {TOGGLES.map((k) => (
            <label key={k} className="toggle">
              <input type="checkbox" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} />
              <span>{t[k]}</span>
            </label>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="faq">{t.faq}</label>
          <textarea id="faq" className="textarea" rows={5} maxLength={4000} placeholder={t.faqPlaceholder} value={s.faq} onChange={(e) => setS({ ...s, faq: e.target.value })} />
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {t.save}
          </button>
          {saved && <span className="chip ok" role="status">{t.saved}</span>}
        </div>
      </section>
    </div>
  );
}
