import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';
import { DICTS, I18n, initialLang, type Lang, useT } from './i18n';
import { Inbox } from './pages/Inbox';
import { Landing } from './pages/Landing';
import { Playground } from './pages/Playground';
import { SettingsPage } from './pages/Settings';
import { Studio } from './pages/Studio';

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
  }, []);
  const i18n = useMemo(() => ({ t: DICTS[lang], lang, setLang }), [lang, setLang]);

  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const loadMe = useCallback(async () => {
    setLoadError(false);
    try {
      setMe(await api<Me>('/api/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const path = usePath();
  useEffect(() => {
    if (me === null && path.startsWith('/app')) navigate('/');
    if (me && !path.startsWith('/app')) navigate('/app/inbox');
  }, [me, path]);

  let body: ReactNode;
  if (loadError) body = <FullMessage onRetry={loadMe} />;
  else if (me === undefined) body = <div className="landing muted">{DICTS[lang].loading}</div>;
  else if (me === null) body = <Landing onSignedIn={loadMe} />;
  else body = <Shell me={me} path={path} onChange={loadMe} />;

  return <I18n.Provider value={i18n}>{body}</I18n.Provider>;
}

function FullMessage({ onRetry }: { onRetry: () => void }) {
  const { t } = useT();
  return (
    <div className="landing">
      <div className="card pad stack" role="alert">
        <p>{t.error}</p>
        <button className="btn primary" onClick={onRetry}>
          {t.retry}
        </button>
      </div>
    </div>
  );
}

export function LangSwitch() {
  const { lang, setLang } = useT();
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {(['uz', 'ru', 'en'] as Lang[]).map((l) => (
        <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function Shell({ me, path, onChange }: { me: Me; path: string; onChange: () => void }) {
  const { t } = useT();
  const [usage, setUsage] = useState<{ replies: number; videos: number } | null>(null);
  useEffect(() => {
    api<{ usage: { replies: number; videos: number } }>('/api/usage')
      .then((r) => setUsage(r.usage))
      .catch(() => setUsage(null));
  }, [path]);

  const links = [
    { href: '/app/inbox', label: t.navInbox, icon: '💬' },
    { href: '/app/studio', label: t.navStudio, icon: '🎬' },
    { href: '/app/playground', label: t.navPlayground, icon: '🧪' },
    { href: '/app/settings', label: t.navSettings, icon: '⚙️' },
  ];
  const page = path.startsWith('/app/studio') ? (
    <Studio me={me} />
  ) : path.startsWith('/app/playground') ? (
    <Playground />
  ) : path.startsWith('/app/settings') ? (
    <SettingsPage me={me} onChange={onChange} />
  ) : (
    <Inbox />
  );

  const signOut = async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => undefined);
    onChange();
  };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="logo-dot" aria-hidden>
            p
          </span>
          <span className="brand-name">{t.appName}</span>
        </div>
        <nav className="nav" aria-label="Main">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={path.startsWith(l.href) ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(l.href);
              }}
            >
              <span aria-hidden>{l.icon}</span>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="side-extra stack" style={{ marginTop: 'auto' }}>
          <div className="side-info">
            <div style={{ fontWeight: 700 }}>{me.shop.name}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {me.instagram ? `@${me.instagram.username}` : t.connectFirst}
            </div>
            {usage && (
              <div className="muted" style={{ fontSize: 13 }}>
                {t.usage(usage.replies, usage.videos)}
              </div>
            )}
          </div>
          <LangSwitch />
          <button className="btn small" onClick={signOut}>
            {t.signOut}
          </button>
          <div className="side-powered muted" style={{ fontSize: 12 }}>
            {t.poweredBy}
          </div>
        </div>
      </aside>
      <main className="main">
        {me.safeMode && (
          <div className="banner" style={{ marginBottom: 16 }}>
            {t.safeModeBanner}
          </div>
        )}
        {page}
      </main>
    </div>
  );
}
