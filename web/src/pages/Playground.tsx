import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, formatPrice } from '../api';
import { useT } from '../i18n';

interface Result {
  reply: string;
  handoff: boolean;
  reason: string | null;
  understanding: { intent: string; productQuery: string | null; language: string; confidence: number };
  products: { id: number; name: string; price: number | null; currency: string | null; stock: number | null; image: string | null }[];
  ms: number;
  model: string;
  transcript: string | null;
}

const MAX_RECORD_SECONDS = 60;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });
}

/** Phone photos are large; send at most 1280 px as JPEG. */
async function shrinkPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Playground() {
  const { t } = useT();
  const [channel, setChannel] = useState<'dm' | 'comment'>('dm');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [voice, setVoice] = useState<{ data: string; url: string } | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => () => recorder.current?.stream.getTracks().forEach((tr) => tr.stop()), []);
  useEffect(() => {
    if (recording === null) return;
    if (recording >= MAX_RECORD_SECONDS) {
      recorder.current?.stop();
      return;
    }
    const id = window.setTimeout(() => setRecording((s) => (s === null ? null : s + 1)), 1000);
    return () => window.clearTimeout(id);
  }, [recording]);

  const setVoiceBlob = async (blob: Blob) => {
    if (voice) URL.revokeObjectURL(voice.url);
    setVoice({ data: await readAsDataUrl(blob), url: URL.createObjectURL(blob) });
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRecording(null);
        void setVoiceBlob(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      };
      recorder.current = rec;
      rec.start();
      setRecording(0);
    } catch {
      setError(t.micDenied);
    }
  };

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<Result>('/api/playground', {
          method: 'POST',
          body: { channel, text, imageData: channel === 'dm' ? photo ?? undefined : undefined, audioData: channel === 'dm' ? voice?.data : undefined },
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'transcribe_empty' ? t.voiceUnclear : err instanceof ApiError && err.status === 413 ? t.fileTooBig : t.error);
    } finally {
      setBusy(false);
    }
  };

  const canRun = !!text.trim() || (channel === 'dm' && (!!photo || !!voice));

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
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="stack upload-col" style={{ gap: 8 }}>
              <span className="label" style={{ marginBottom: 0 }}>{t.photo}</span>
              <label className="btn small file-btn">
                🖼️ {t.choosePhoto}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    setPhoto(f ? await shrinkPhoto(f) : null);
                    e.target.value = '';
                  }}
                />
              </label>
              {photo && (
                <div className="row">
                  <img src={photo} alt="" width={72} height={72} style={{ objectFit: 'cover', borderRadius: 10 }} />
                  <button type="button" className="btn small" onClick={() => setPhoto(null)}>
                    {t.remove}
                  </button>
                </div>
              )}
            </div>
            <div className="stack upload-col" style={{ gap: 8 }}>
              <span className="label" style={{ marginBottom: 0 }}>{t.voiceNote}</span>
              <div className="row">
                {recording === null ? (
                  <button type="button" className="btn small" onClick={() => void startRecording()} disabled={typeof MediaRecorder === 'undefined'}>
                    🎤 {t.record}
                  </button>
                ) : (
                  <button type="button" className="btn small danger" onClick={() => recorder.current?.stop()} aria-live="polite">
                    ⏹ {t.stop} · {recording}s
                  </button>
                )}
                <label className="btn small file-btn">
                  📁 {t.chooseAudio}
                  <input
                    type="file"
                    accept="audio/*"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void setVoiceBlob(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              {voice && (
                <div className="row">
                  <audio src={voice.url} controls style={{ width: '100%', maxWidth: 260 }} />
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      URL.revokeObjectURL(voice.url);
                      setVoice(null);
                    }}
                  >
                    {t.remove}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
        <div>
          <button className="btn primary" type="submit" disabled={busy || !canRun || recording !== null}>
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
          {result.transcript && (
            <div className="bubble in" style={{ maxWidth: '100%' }}>
              🎤 {result.transcript}
            </div>
          )}
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
                    {p.image && <img src={p.image} alt="" width={44} height={44} style={{ borderRadius: 8, objectFit: 'cover' }} onError={(e) => (e.currentTarget.style.display = 'none')} />}
                    <span className="grow" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{p.name}</span>
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
