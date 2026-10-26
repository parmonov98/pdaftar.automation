import type { DB } from '../db.js';
import type { AiModels, ChatMessage, ToolSpec, ToolTurn } from './models.js';

/** Thrown when today's AI call budget is used up. Callers fall back to a person. */
export class AiBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`Daily AI budget of ${limit} calls reached`);
  }
}

/**
 * Counts every model call per UTC day and refuses calls above the limit, so a webhook flood
 * or a busy account can never burn the API credits. A limit of 0 means unlimited.
 */
export class BudgetedModels implements AiModels {
  readonly name: string;

  constructor(
    private readonly inner: AiModels,
    private readonly db: DB,
    private readonly dailyLimit: number,
  ) {
    this.name = inner.name;
    db.exec('CREATE TABLE IF NOT EXISTS ai_budget (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0)');
  }

  /** Calls used today. */
  usedToday(): number {
    const row = this.db.prepare('SELECT calls FROM ai_budget WHERE day = ?').get(today()) as { calls: number } | undefined;
    return row?.calls ?? 0;
  }

  private reserve(): void {
    if (this.dailyLimit <= 0) return;
    const ok = this.db.transaction(() => {
      if (this.usedToday() >= this.dailyLimit) return false;
      this.db.prepare('INSERT INTO ai_budget (day, calls) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET calls = calls + 1').run(today());
      return true;
    })();
    if (!ok) throw new AiBudgetError(this.dailyLimit);
  }

  async chat(messages: ChatMessage[], opts?: { json?: boolean; vision?: boolean; maxTokens?: number }): Promise<string> {
    this.reserve();
    return this.inner.chat(messages, opts);
  }

  async chatWithTools(messages: ChatMessage[], tools: ToolSpec[]): Promise<ToolTurn> {
    this.reserve();
    return this.inner.chatWithTools(messages, tools);
  }

  async segmentProduct(image: Buffer, hint: string): Promise<Buffer | null> {
    this.reserve();
    return this.inner.segmentProduct(image, hint);
  }

  async stageProduct(cutout: Buffer, prompt: string): Promise<Buffer | null> {
    this.reserve();
    return this.inner.stageProduct(cutout, prompt);
  }

  async transcribe(audio: Buffer): Promise<string | null> {
    this.reserve();
    return this.inner.transcribe(audio);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
