/**
 * Normalises Instagram webhook payloads into the two events we act on.
 * Meta sends comments as `entry[].changes[]` and DMs as `entry[].messaging[]`;
 * we parse both defensively and skip echoes of our own messages.
 */

export interface IncomingComment {
  kind: 'comment';
  accountId: string;
  commentId: string;
  mediaId: string | null;
  fromId: string | null;
  fromUsername: string | null;
  text: string;
  parentId: string | null;
}

export interface IncomingMessage {
  kind: 'message';
  accountId: string;
  senderId: string;
  mid: string;
  text: string;
  imageUrls: string[];
  /** Voice notes and other audio attachments. */
  audioUrls: string[];
  timestamp: number;
}

export type IncomingEvent = IncomingComment | IncomingMessage;

interface RawEntry {
  id?: string | number;
  changes?: { field?: string; value?: Record<string, unknown> }[];
  messaging?: {
    sender?: { id?: string };
    recipient?: { id?: string };
    timestamp?: number;
    message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; attachments?: { type?: string; payload?: { url?: string } }[] };
  }[];
  field?: string;
  value?: Record<string, unknown>;
}

export function parseWebhook(body: unknown): IncomingEvent[] {
  const b = body as { object?: string; entry?: RawEntry[] } | null;
  if (!b || b.object !== 'instagram' || !Array.isArray(b.entry)) return [];
  const out: IncomingEvent[] = [];
  for (const entry of b.entry) {
    const accountId = String(entry.id ?? '');
    const changes = entry.changes ?? (entry.field ? [{ field: entry.field, value: entry.value }] : []);
    for (const change of changes) {
      if (change.field !== 'comments' || !change.value) continue;
      const v = change.value as {
        id?: string;
        text?: string;
        parent_id?: string;
        from?: { id?: string; username?: string };
        media?: { id?: string };
      };
      if (!v.id || typeof v.text !== 'string') continue;
      // Our own replies come back as comment events too.
      if (v.from?.id && v.from.id === accountId) continue;
      out.push({
        kind: 'comment',
        accountId,
        commentId: v.id,
        mediaId: v.media?.id ?? null,
        fromId: v.from?.id ?? null,
        fromUsername: v.from?.username ?? null,
        text: v.text,
        parentId: v.parent_id ?? null,
      });
    }
    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      if (!msg?.mid || msg.is_echo || msg.is_deleted) continue;
      const senderId = m.sender?.id;
      if (!senderId || senderId === accountId) continue;
      const imageUrls = (msg.attachments ?? [])
        .filter((a) => a.type === 'image' && a.payload?.url)
        .map((a) => a.payload!.url!);
      const audioUrls = (msg.attachments ?? [])
        .filter((a) => a.type === 'audio' && a.payload?.url)
        .map((a) => a.payload!.url!);
      if (!msg.text && imageUrls.length === 0 && audioUrls.length === 0) continue;
      out.push({
        kind: 'message',
        accountId: String(m.recipient?.id ?? accountId),
        senderId,
        mid: msg.mid,
        text: msg.text ?? '',
        imageUrls,
        audioUrls,
        timestamp: m.timestamp ?? Date.now(),
      });
    }
  }
  return out;
}
