import type { AiModels } from '../ai/models.js';
import { DEFAULT_SETTINGS, type WorkspaceSettings } from '../ai/replies.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { InstagramClient } from '../instagram/client.js';
import { decrypt } from '../lib/crypto.js';
import { PdaftarClient } from '../pdaftar/client.js';

/** Everything a request handler or job needs, created once at startup. */
export interface AppContext {
  config: Config;
  db: DB;
  models: AiModels;
  fetchImpl: typeof fetch;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface WorkspaceRow {
  id: number;
  pdaftar_shop_id: number;
  shop_name: string;
  pdaftar_token_enc: string;
  settings_json: string;
}

export interface IgAccountRow {
  id: number;
  workspace_id: number;
  ig_user_id: string;
  username: string;
  profile_picture_url: string | null;
  access_token_enc: string;
  token_expires_at: string | null;
}

export function getWorkspace(ctx: AppContext, id: number): WorkspaceRow | undefined {
  return ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
}

export function settingsOf(ws: Pick<WorkspaceRow, 'settings_json'>): WorkspaceSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(ws.settings_json) as Partial<WorkspaceSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function pdaftarFor(ctx: AppContext, ws: WorkspaceRow): PdaftarClient {
  return new PdaftarClient(ctx.config.pdaftar.apiBaseUrl, decrypt(ws.pdaftar_token_enc, ctx.config.encryptionKey), ctx.fetchImpl);
}

export function igAccountForWorkspace(ctx: AppContext, workspaceId: number): IgAccountRow | undefined {
  return ctx.db.prepare('SELECT * FROM ig_accounts WHERE workspace_id = ?').get(workspaceId) as IgAccountRow | undefined;
}

export function igAccountByIgId(ctx: AppContext, igUserId: string): IgAccountRow | undefined {
  return ctx.db.prepare('SELECT * FROM ig_accounts WHERE ig_user_id = ?').get(igUserId) as IgAccountRow | undefined;
}

export function igClientFor(ctx: AppContext, acc: IgAccountRow): InstagramClient {
  return new InstagramClient(acc.ig_user_id, decrypt(acc.access_token_enc, ctx.config.encryptionKey), ctx.config.instagram.graphVersion, ctx.fetchImpl);
}

/**
 * Whether a reply may actually be sent. With safe mode on (the default), only the
 * allowlisted test usernames receive messages; everyone else gets a draft that a
 * person approves in the inbox. Settings can also force drafts.
 */
export function sendMode(ctx: AppContext, settings: WorkspaceSettings, counterpartUsername: string | null): 'send' | 'draft' {
  const ig = ctx.config.instagram;
  if (ig.safeMode) {
    const u = (counterpartUsername ?? '').toLowerCase();
    if (!u || !ig.safeModeAllowedUsernames.includes(u)) return 'draft';
  }
  return settings.autoSend ? 'send' : 'draft';
}

/** Approving a draft by hand is also blocked in safe mode for non-allowlisted people. */
export function manualSendAllowed(ctx: AppContext, counterpartUsername: string | null): boolean {
  const ig = ctx.config.instagram;
  if (!ig.safeMode) return true;
  return !!counterpartUsername && ig.safeModeAllowedUsernames.includes(counterpartUsername.toLowerCase());
}
