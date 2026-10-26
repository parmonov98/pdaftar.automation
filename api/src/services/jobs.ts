import type { AppContext } from './context.js';

/**
 * A small durable job queue on SQLite. Webhooks only enqueue; the worker loop does the
 * slow work (model calls, Instagram calls, video renders) so Meta always gets a fast 200.
 */
export type JobHandler = (ctx: AppContext, payload: Record<string, unknown>) => Promise<void>;

export interface JobRow {
  id: number;
  type: string;
  payload_json: string;
  attempts: number;
}

const MAX_ATTEMPTS = 4;

export function enqueue(ctx: AppContext, type: string, payload: Record<string, unknown>, delaySeconds = 0): number {
  const r = ctx.db
    .prepare(`INSERT INTO jobs (type, payload_json, run_after) VALUES (?, ?, datetime('now', ?))`)
    .run(type, JSON.stringify(payload), `+${Math.max(0, Math.floor(delaySeconds))} seconds`);
  return Number(r.lastInsertRowid);
}

/** Claims and runs one due job of the given types. Returns false when none was due. */
export async function runOne(ctx: AppContext, handlers: Record<string, JobHandler>, types = Object.keys(handlers)): Promise<boolean> {
  const placeholders = types.map(() => '?').join(',');
  const claim = ctx.db.transaction(() => {
    const job = ctx.db
      .prepare(`SELECT id, type, payload_json, attempts FROM jobs WHERE status = 'pending' AND run_after <= datetime('now') AND type IN (${placeholders}) ORDER BY id LIMIT 1`)
      .get(...types) as JobRow | undefined;
    if (job) ctx.db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?`).run(job.id);
    return job;
  });
  const job = claim();
  if (!job) return false;
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`No handler for ${job.type}`);
    await handler(ctx, JSON.parse(job.payload_json) as Record<string, unknown>);
    ctx.db.prepare(`UPDATE jobs SET status = 'done', last_error = NULL WHERE id = ?`).run(job.id);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      ctx.db.prepare(`UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?`).run(err.slice(0, 1000), job.id);
    } else {
      const backoff = 10 * 3 ** (attempts - 1);
      ctx.db
        .prepare(`UPDATE jobs SET status = 'pending', last_error = ?, run_after = datetime('now', ?) WHERE id = ?`)
        .run(err.slice(0, 1000), `+${backoff} seconds`, job.id);
    }
    ctx.log('job failed', { id: job.id, type: job.type, attempts, error: err });
  }
  return true;
}

/** Jobs left 'running' by a crash go back to the queue on startup. */
export function recoverStuck(ctx: AppContext): void {
  ctx.db.prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`).run();
}

/** Runs a worker lane forever. Separate lanes keep slow renders from blocking replies. */
export function startLane(ctx: AppContext, handlers: Record<string, JobHandler>, types: string[], idleMs = 1000): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      let worked = false;
      try {
        worked = await runOne(ctx, handlers, types);
      } catch (e) {
        ctx.log('worker error', { error: e instanceof Error ? e.message : String(e) });
      }
      if (!worked) await new Promise((r) => setTimeout(r, idleMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
