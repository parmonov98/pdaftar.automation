import { describe, expect, it } from 'vitest';
import { AiBudgetError, BudgetedModels } from '../src/ai/budget.js';
import { MockModels } from '../src/ai/models.js';
import { encrypt } from '../src/lib/crypto.js';
import { handleMessage } from '../src/services/inbound.js';
import { fakeFetch, pdaftarRoutes, testContext } from './helpers.js';

describe('daily AI budget', () => {
  it('counts calls and refuses above the limit', async () => {
    const ctx = testContext(fakeFetch([]).impl);
    const m = new BudgetedModels(new MockModels(), ctx.db, 2);
    await m.chat([{ role: 'user', content: 'a' }]);
    await m.transcribe(Buffer.from('x'));
    await expect(m.chat([{ role: 'user', content: 'b' }])).rejects.toBeInstanceOf(AiBudgetError);
    expect(m.usedToday()).toBe(2);
  });

  it('a limit of 0 means unlimited', async () => {
    const ctx = testContext(fakeFetch([]).impl);
    const m = new BudgetedModels(new MockModels(), ctx.db, 0);
    for (let i = 0; i < 5; i++) await m.chat([{ role: 'user', content: String(i) }]);
  });

  it('over budget, a DM gets a holding draft for a person and nothing is sent', async () => {
    const f = fakeFetch([pdaftarRoutes(), (url) => (url.hostname === 'graph.instagram.com' ? new Response(JSON.stringify({ username: 'pdaftar_uz' })) : undefined)]);
    const ctx = testContext(f.impl, { IG_SAFE_MODE_ALLOWED_USERNAMES: 'pdaftar_uz' });
    ctx.models = new BudgetedModels(new MockModels(), ctx.db, 1);
    await ctx.models.chat([{ role: 'user', content: 'use up the budget' }]);
    ctx.db.prepare(`INSERT INTO workspaces (pdaftar_shop_id, shop_name, pdaftar_token_enc, settings_json) VALUES (729, 'S', ?, '{"autoSend":true}')`).run(encrypt('pda_valid_token_123', ctx.config.encryptionKey));
    ctx.db.prepare(`INSERT INTO ig_accounts (workspace_id, ig_user_id, username, access_token_enc) VALUES (1, '178', 'shop', ?)`).run(encrypt('T', ctx.config.encryptionKey));
    await handleMessage(ctx, { kind: 'message', accountId: '178', senderId: '55', mid: 'b1', text: 'cola narxi?', imageUrls: [], audioUrls: [], timestamp: 1 });
    const out = ctx.db.prepare(`SELECT status, ai_meta_json FROM messages WHERE direction = 'out'`).get() as { status: string; ai_meta_json: string };
    expect(out.status).toBe('draft');
    expect(JSON.parse(out.ai_meta_json).reason).toBe('daily AI budget reached');
    expect(f.calls.some((c) => c.url.endsWith('/178/messages'))).toBe(false);
  });
});
