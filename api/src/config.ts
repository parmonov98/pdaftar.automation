import { resolve } from 'node:path';

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export type AiProvider = 'meta' | 'mock';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  publicBaseUrl: string;
  webDistDir: string | null;
  /** 32-byte key (base64) used to encrypt stored third-party tokens. */
  encryptionKey: string;
  sessionTtlDays: number;
  /** 'pipeline' (fixed steps) or 'agent' (Muse Spark calls tools itself). */
  replyEngine: 'pipeline' | 'agent';

  ai: {
    provider: AiProvider;
    baseUrl: string;
    apiKey: string;
    textModel: string;
    visionModel: string;
    imageModel: string;
    segmentModel: string;
    transcribeModel: string;
    timeoutMs: number;
    /** Max model calls per UTC day across all shops (0 = unlimited). Protects the API credits. */
    dailyCallLimit: number;
  };

  instagram: {
    appId: string;
    appSecret: string;
    webhookVerifyToken: string;
    graphVersion: string;
    redirectUri: string;
    /** Instagram accounts (ig user ids) allowed to be connected at all. Empty = any. */
    allowedAccountIds: string[];
    /**
     * Safe mode: replies are only SENT to the usernames below; to anyone else they are
     * saved as drafts for a human to approve. On by default — the dev box must not
     * message real people on its own.
     */
    safeMode: boolean;
    safeModeAllowedUsernames: string[];
    /** pDaftar's own accounts: their comments, story mentions and DMs also verify ambassador tasks. */
    officialAccountIds: string[];
  };

  pdaftar: {
    apiBaseUrl: string;
    /** Token with the social-verification right (issued with automation:issue-token --social). */
    socialToken: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? './data');
  return {
    port: Number(env.PORT ?? 8095),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:8095').replace(/\/$/, ''),
    webDistDir: env.WEB_DIST_DIR ? resolve(env.WEB_DIST_DIR) : null,
    encryptionKey: env.ENCRYPTION_KEY ?? '',
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    replyEngine: env.REPLY_ENGINE === 'agent' ? 'agent' : 'pipeline',
    ai: {
      provider: (env.AI_PROVIDER as AiProvider) === 'meta' ? 'meta' : 'mock',
      baseUrl: (env.META_API_BASE_URL ?? 'https://api.meta.ai/v1').replace(/\/$/, ''),
      apiKey: env.META_API_KEY ?? '',
      textModel: env.META_TEXT_MODEL ?? 'muse-spark-1.3',
      visionModel: env.META_VISION_MODEL ?? env.META_TEXT_MODEL ?? 'muse-spark-1.3',
      imageModel: env.META_IMAGE_MODEL ?? 'muse-image-1.0',
      segmentModel: env.META_SEGMENT_MODEL ?? 'sam-3.1',
      transcribeModel: env.META_TRANSCRIBE_MODEL ?? 'muse-voice-transcribe-1.0',
      timeoutMs: Number(env.META_TIMEOUT_MS ?? 30000),
      dailyCallLimit: Number(env.AI_DAILY_CALL_LIMIT ?? 3000),
    },
    instagram: {
      appId: env.IG_APP_ID ?? '',
      appSecret: env.IG_APP_SECRET ?? '',
      webhookVerifyToken: env.IG_WEBHOOK_VERIFY_TOKEN ?? '',
      graphVersion: env.IG_GRAPH_VERSION ?? 'v26.0',
      redirectUri: env.IG_REDIRECT_URI ?? '',
      allowedAccountIds: list(env.IG_ALLOWED_ACCOUNT_IDS),
      safeMode: bool(env.IG_SAFE_MODE, true),
      safeModeAllowedUsernames: list(env.IG_SAFE_MODE_ALLOWED_USERNAMES).map((u) => u.replace(/^@/, '').toLowerCase()),
      officialAccountIds: list(env.IG_OFFICIAL_ACCOUNT_IDS),
    },
    pdaftar: {
      apiBaseUrl: (env.PDAFTAR_API_BASE_URL ?? 'https://dev-api.pdaftar.uz').replace(/\/$/, ''),
      socialToken: env.PDAFTAR_SOCIAL_TOKEN ?? '',
    },
  };
}
