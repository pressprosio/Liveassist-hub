/** REST API for agents (mobile app and console): sign-in, devices, conversation history. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, changePassword, deviceTokens, login, publicAgent, registerDevice, removeDevice, type Agent } from '../agents.js';
import { getConversation, listMessages, summaries, summary, toWire } from '../conversations.js';
import { overLimit } from '../redis.js';
import { pushEnabled, sendPush } from '../push.js';

declare module 'fastify' {
  interface FastifyRequest { agent?: Agent }
}

async function requireAgent(req: FastifyRequest, reply: FastifyReply) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const agent = token ? await authenticate(token) : null;
  if (!agent) return reply.code(401).send({ error: 'Sign in again.' });
  req.agent = agent;
}

export async function agentApi(app: FastifyInstance) {
  app.post('/agent/login', async (req, reply) => {
    if (await overLimit(`laic:rl:login:${req.ip}`, 10, 15 * 60)) {
      return reply.code(429).send({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
    }
    const b = (req.body || {}) as { email?: string; password?: string };
    const res = await login(String(b.email || ''), String(b.password || ''));
    if (!res) return reply.code(401).send({ error: 'Email or password is incorrect.' });
    return { token: res.token, agent: publicAgent(res.agent), push: pushEnabled() };
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireAgent);

    r.get('/agent/me', async (req) => ({ agent: publicAgent(req.agent!), push: pushEnabled() }));

    r.post('/agent/password', async (req, reply) => {
      if (await overLimit(`laic:rl:pw:${req.agent!.id}`, 5, 15 * 60)) {
        return reply.code(429).send({ error: 'Too many attempts. Wait 15 minutes and try again.' });
      }
      const b = (req.body || {}) as { current_password?: string; new_password?: string };
      const res = await changePassword(req.agent!.id, String(b.current_password || ''), String(b.new_password || ''));
      if ('error' in res) return reply.code(400).send({ error: res.error });
      return { token: res.token, agent: publicAgent(res.agent) };
    });

    r.get('/agent/conversations', async (req) => {
      const q = req.query as { closed?: string };
      return { conversations: await summaries({ includeClosed: q.closed === '1' }) };
    });

    r.get('/agent/conversations/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const c = await getConversation(id);
      if (!c) return reply.code(404).send({ error: 'Conversation not found.' });
      return { conversation: await summary(id), messages: (await listMessages(id, null, 300)).map(toWire) };
    });

    r.post('/agent/devices', async (req, reply) => {
      const b = (req.body || {}) as { token?: string; platform?: string };
      if (!b.token) return reply.code(400).send({ error: 'Missing device token.' });
      await registerDevice(req.agent!.id, b.token, String(b.platform || 'unknown'));
      return { ok: true };
    });

    r.post('/agent/devices/test', async (req) => {
      const tokens = await deviceTokens([req.agent!.id]);
      await sendPush(tokens, { title: 'LiveAssist', body: 'Notifications are working on this phone.', data: { kind: 'test' } });
      return { ok: true, devices: tokens.length };
    });

    r.delete('/agent/devices', async (req, reply) => {
      const b = (req.body || {}) as { token?: string };
      if (!b.token) return reply.code(400).send({ error: 'Missing device token.' });
      await removeDevice(b.token);
      return { ok: true };
    });
  });
}
