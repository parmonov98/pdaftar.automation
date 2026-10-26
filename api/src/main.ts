import { join } from 'node:path';
import { BudgetedModels } from './ai/budget.js';
import { createModels } from './ai/models.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildServer } from './server.js';
import type { AppContext } from './services/context.js';
import { handleComment, handleMessage } from './services/inbound.js';
import { enqueue, recoverStuck, startLane, type JobHandler } from './services/jobs.js';
import { handlePublish, handleRefreshTokens, handleRender } from './services/promo.js';

const config = loadConfig();
if (Buffer.from(config.encryptionKey, 'base64').length !== 32) {
  console.error('ENCRYPTION_KEY must be 32 random bytes, base64 (openssl rand -base64 32)');
  process.exit(1);
}

const db = openDb(join(config.dataDir, 'automation.sqlite'));
const ctx: AppContext = {
  config,
  db,
  // Every model call counts against a daily budget so the API credits can't be burned.
  models: new BudgetedModels(createModels(config.ai), db, config.ai.dailyCallLimit),
  fetchImpl: fetch,
  log: (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra })),
};

const handlers: Record<string, JobHandler> = {
  comment: handleComment,
  message: handleMessage,
  render_video: handleRender,
  publish_video: handlePublish,
  refresh_tokens: (c) => handleRefreshTokens(c),
};

recoverStuck(ctx);
if (!ctx.db.prepare(`SELECT 1 FROM jobs WHERE type = 'refresh_tokens' AND status = 'pending'`).get()) enqueue(ctx, 'refresh_tokens', {}, 60);

// Replies must stay fast, so renders get their own lane.
startLane(ctx, handlers, ['comment', 'message', 'publish_video', 'refresh_tokens'], 500);
startLane(ctx, handlers, ['render_video'], 1000);

const app = buildServer(ctx);
await app.listen({ port: config.port, host: config.host });
ctx.log('listening', { port: config.port, ai: ctx.models.name, safeMode: config.instagram.safeMode });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
