/** Environment configuration. Fails fast on missing required values. */

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return v.trim();
}
function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}
function int(name: string, fallback: number): number {
  const n = Number.parseInt(opt(name, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
}

let cached: ReturnType<typeof load> | null = null;

function load() {
  const encKey = req('HUB_ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    throw new Error('HUB_ENCRYPTION_KEY must be 64 hex characters. Generate one with: openssl rand -hex 32');
  }
  const jwtSecret = req('HUB_JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('HUB_JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32');

  return {
    port: int('PORT', 3000),
    publicUrl: opt('HUB_PUBLIC_URL', `https://${opt('HUB_DOMAIN', 'localhost')}`),
    databaseUrl: req('DATABASE_URL'),
    redisUrl: opt('REDIS_URL', 'redis://redis:6379'),
    encryptionKey: Buffer.from(encKey, 'hex'),
    jwtSecret,
    anthropicKey: opt('ANTHROPIC_API_KEY', ''),
    aiMock: opt('AI_MOCK', '0') === '1',
    models: {
      economy: opt('MODEL_ECONOMY', 'claude-haiku-4-5-20251001'),
      balanced: opt('MODEL_BALANCED', 'claude-sonnet-5'),
      best: opt('MODEL_BEST', 'claude-opus-5-5'),
    } as Record<string, string>,
    maxTokens: int('AI_MAX_TOKENS', 1024),
    maxAiTurnsPerConversation: int('AI_MAX_TURNS_PER_CONVERSATION', 40),
    maxAiTurnsPerSiteDaily: int('AI_MAX_TURNS_PER_SITE_DAILY', 2000),
    visitorMessagesPerMinute: int('VISITOR_MESSAGES_PER_MINUTE', 12),
    idleCloseMinutes: int('IDLE_CLOSE_MINUTES', 30),
    firebaseServiceAccount: opt('FIREBASE_SERVICE_ACCOUNT', ''),
    allowInsecureWebhooks: opt('ALLOW_INSECURE_WEBHOOKS', '0') === '1',
    logLevel: opt('LOG_LEVEL', 'info'),
  };
}

export type Config = ReturnType<typeof load>;
export function config(): Config {
  if (!cached) cached = load();
  return cached;
}
