import { useCallback, useEffect, useState } from 'react';
import { api, type CommentRow, type Conversation, type Message } from '../api';
import { useT } from '../i18n';

function statusChip(status: string): string {
  if (status === 'replied' || status === 'sent') return 'chip ok';
  if (status === 'handoff') return 'chip warn';
  if (status === 'failed') return 'chip err';
  return 'chip';
}

function usePoll<T>(load: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await load());
      setError(false);
    } catch {
      setError(true);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [refresh, ms]);
  return { data, error, refresh };
}

export function Inbox() {
  const { t } = useT();
  const [tab, setTab] = useState<'comments' | 'direct'>('comments');
  return (
    <div>
      <div className="page-head">
        <h2>{t.navInbox}</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
            {t.comments}
          </button>
          <button role="tab" aria-selected={tab === 'direct'} onClick={() => setTab('direct')}>
            {t.direct}
          </button>
        </div>
      </div>
      {tab === 'comments' ? <Comments /> : <Direct />}
    </div>
  );
}

function Comments() {
  const { t } = useT();
  const load = useCallback(() => api<{ comments: CommentRow[] }>('/api/inbox/comments').then((r) => r.comments), []);
  const { data, error, refresh } = usePoll(load, 5000);
  if (error && !data) return <ErrorBox onRetry={refresh} />;
  if (!data) return <p className="muted">{t.loading}</p>;
  if (!data.length) return <EmptyBox />;
  return (
    <div className="list">
      {data.map((c) => (
        <div key={c.id} className="card item stack">
          <div className="row">
            <strong>@{c.from_username ?? '—'}</strong>
            <span className={statusChip(c.status)}>{t.status[c.status] ?? c.status}</span>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
              {new Date(`${c.created_at}Z`).toLocaleString()}
            </span>
          </div>
          <div>{c.text}</div>
          {(c.status === 'draft' || c.status === 'handoff') && c.reply_text !== null ? (
            <DraftEditor initial={c.reply_text} note={c.reason} endpoint={`/api/inbox/comments/${c.id}/send`} onSent={refresh} />
          ) : (
            c.reply_text && <div className="bubble out">{c.reply_text}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function Direct() {
  const { t } = useT();
  const load = useCallback(() => api<{ conversations: Conversation[] }>('/api/inbox/conversations').then((r) => r.conversations), []);
  const { data, error, refresh } = usePoll(load, 5000);
  const [open, setOpen] = useState<number | null>(null);
  if (error && !data) return <ErrorBox onRetry={refresh} />;
  if (!data) return <p className="muted">{t.loading}</p>;
  if (!data.length) return <EmptyBox />;
  return (
    <div className="split">
      <div className="card" style={{ overflow: 'hidden' }}>
        {data.map((c) => (
          <button key={c.id} className="conv" aria-current={open === c.id} onClick={() => setOpen(c.id)}>
            <div className="row">
              <strong className="grow">@{c.username ?? c.igsid}</strong>
              {c.drafts > 0 && <span className="chip">{t.status.draft}</span>}
              {c.status === 'handoff' && <span className="chip warn">{t.status.handoff}</span>}
            </div>
            <div className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.last_text ?? ''}
            </div>
          </button>
        ))}
      </div>
      {open ? <Thread id={open} onChange={refresh} /> : <div className="card pad muted">{t.chooseConversation}</div>}
    </div>
  );
}

function Thread({ id, onChange }: { id: number; onChange: () => void }) {
  const { t } = useT();
  const load = useCallback(
    () => api<{ conversation: { status: string; ai_enabled: number; username: string | null }; messages: Message[] }>(`/api/inbox/conversations/${id}/messages`),
    [id],
  );
  const { data, error, refresh } = usePoll(load, 4000);
  const patch = async (body: Record<string, unknown>) => {
    await api(`/api/inbox/conversations/${id}`, { method: 'PATCH', body });
    await refresh();
    onChange();
  };
  if (error && !data) return <ErrorBox onRetry={refresh} />;
  if (!data) return <div className="card pad muted">{t.loading}</div>;
  return (
    <div className="card pad stack">
      <div className="row">
        <h3 className="grow">@{data.conversation.username ?? '—'}</h3>
        <label className="row" style={{ gap: 6, fontSize: 14 }}>
          <input type="checkbox" checked={!!data.conversation.ai_enabled} onChange={(e) => void patch({ aiEnabled: e.target.checked })} />
          {data.conversation.ai_enabled ? t.aiOn : t.aiOff}
        </label>
        {data.conversation.status === 'handoff' && (
          <button className="btn small" onClick={() => void patch({ status: 'open' })}>
            {t.resolve}
          </button>
        )}
      </div>
      <div className="thread">
        {data.messages.map((m) =>
          m.status === 'draft' ? (
            <div key={m.id} style={{ alignSelf: 'stretch' }}>
              <DraftEditor initial={m.text ?? ''} note={null} endpoint={`/api/inbox/messages/${m.id}/send`} onSent={refresh} />
            </div>
          ) : (
            <div key={m.id} className={`bubble ${m.direction}`}>
              {m.text}
              {JSON.parse(m.attachments_json || '[]').length > 0 && ' 🖼️'}
              {m.direction === 'out' && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{m.handled_by === 'ai' ? 'AI' : '👤'} · {t.status[m.status] ?? m.status}</div>}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function DraftEditor({ initial, note, endpoint, onSent }: { initial: string; note: string | null; endpoint: string; onSent: () => void }) {
  const { t } = useT();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(endpoint, { method: 'POST', body: { text } });
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <span className="chip">{t.status.draft}</span>
        {note && <span className="muted" style={{ fontSize: 13 }}>{note}</span>}
      </div>
      <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} aria-label={t.reply} />
      {error && <div className="error-text" role="alert">{error}</div>}
      <div>
        <button className="btn primary small" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? t.sending : t.send}
        </button>
      </div>
    </div>
  );
}

function EmptyBox() {
  const { t } = useT();
  return (
    <div className="card pad stack" style={{ textAlign: 'center' }}>
      <h3>{t.empty}</h3>
      <p className="muted" style={{ margin: 0 }}>{t.emptyInboxHint}</p>
    </div>
  );
}

export function ErrorBox({ onRetry }: { onRetry: () => void }) {
  const { t } = useT();
  return (
    <div className="card pad row" role="alert">
      <span className="grow error-text">{t.error}</span>
      <button className="btn small" onClick={onRetry}>
        {t.retry}
      </button>
    </div>
  );
}
