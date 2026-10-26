import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { LangSwitch } from '../App';
import { useT } from '../i18n';

export function Landing({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useT();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/session', { method: 'POST', body: { token: token.trim() } });
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError && err.status < 500 ? err.message : t.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <div className="landing-inner">
        <section className="hero">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="brand">
              <span className="logo-dot" aria-hidden>
                p
              </span>
              {t.appName}
            </div>
            <LangSwitch />
          </div>
          <h1>{t.tagline}</h1>
          <ul>
            {t.heroPoints.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="muted" style={{ marginTop: 18, fontSize: 13 }}>
            {t.poweredBy}
          </p>
        </section>
        <form className="card pad stack" onSubmit={submit} noValidate>
          <div>
            <label className="label" htmlFor="token">
              {t.tokenLabel}
            </label>
            <input
              id="token"
              className="input"
              autoComplete="off"
              spellCheck={false}
              placeholder="pda_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-invalid={!!error}
              aria-describedby="token-help token-error"
            />
            <div id="token-help" className="help">
              {t.tokenHelp}
            </div>
            {error && (
              <div id="token-error" className="error-text" role="alert" style={{ marginTop: 8 }}>
                {error}
              </div>
            )}
          </div>
          <button className="btn primary" type="submit" disabled={busy || token.trim().length < 10}>
            {busy ? t.signingIn : t.signIn}
          </button>
        </form>
      </div>
    </div>
  );
}
