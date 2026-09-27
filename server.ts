/** LiveAssist hub entry point. */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { db, migrate, closeDb } from './db.js';
import { redis, closeRedis } from './redis.js';
import { wpApi } from './http/wp-api.js';
import { agentApi } from './http/agent-api.js';
import { visitorSocket } from './ws/visitor.js';
import { agentSocket } from './ws/agent.js';
import { processWebhooks } from './webhooks.js';
import { applyRetention, checkHandoffTimeouts, closeIdleConversations } from './engine.js';
import { log, errMsg } from './log.js';

async function main() {
  const cfg = config();
  if (!cfg.anthropicKey && !cfg.aiMock) log.warn('ANTHROPIC_API_KEY is empty: the assistant cannot answer until you add it (or set AI_MOCK=1 for test mode).');
  if (cfg.aiMock) log.warn('AI_MOCK=1: using canned test replies instead of Claude.');

  await migrate();

  const app = Fastify({
    logger: { level: cfg.logLevel },
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024,
  });

  // Keep the raw body: request signatures are computed over the exact bytes sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error('Invalid JSON body.') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/health', async (_req, reply) => {
    try {
      await db().query('SELECT 1');
      await redis().ping();
      return { ok: true, version: '0.1.0' };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: errMsg(e) });
    }
  });

  app.get('/', async () => ({ name: 'LiveAssist hub', console: '/console/' }));

  app.register(async (r) => {
    r.get('/ws', { websocket: true }, (socket, req) => visitorSocket(socket, req));
    r.get('/agent/ws', { websocket: true }, (socket) => agentSocket(socket));
  });

  await app.register(wpApi);
  await app.register(agentApi);

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: publicDir, prefix: '/console/', index: ['console.html'] });
  app.get('/console', (_req, reply) => reply.redirect('/console/'));

  // Background jobs. Safe to run on several instances: each step claims its own work.
  const every = (ms: number, name: string, fn: () => Promise<void>) =>
    setInterval(() => fn().catch((e) => log.error(`${name} failed`, { error: errMsg(e) })), ms);
  const timers = [
    every(5_000, 'handoff timeouts', checkHandoffTimeouts),
    every(15_000, 'webhooks', processWebhooks),
    every(60_000, 'idle close', closeIdleConversations),
    every(6 * 3600_000, 'retention', applyRetention),
  ];

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    timers.forEach(clearInterval);
    await app.close().catch(() => {});
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  log.info('hub listening', { port: cfg.port, publicUrl: cfg.publicUrl });
}

main().catch((e) => {
  log.error('startup failed', { error: errMsg(e) });
  process.exit(1);
});
