/** Visitor WebSocket (/ws). Protocol: HUB-PROTOCOL.md section 5. */
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { convChannel, subscribe, AGENTS, publish } from '../bus.js';
import { peekJwt, verifyJwt } from '../crypto.js';
import { createConversation, getConversation, listMessages, rateMessage, toWire, type Conversation } from '../conversations.js';
import { getAgent } from '../agents.js';
import { allowedOrigins, getSite, type Site } from '../sites.js';
import { closeConversation, handleVisitorMessage, visitorRequestsHuman } from '../engine.js';
import { overLimit } from '../redis.js';
import { config } from '../config.js';
import { log, errMsg } from '../log.js';

const CLOSE_AUTH = 4001;
const CLOSE_FORBIDDEN = 4003;
const CLOSE_RATE = 4029;

export function visitorSocket(socket: WebSocket, req: FastifyRequest) {
  const socketId = randomUUID();
  const origin = String(req.headers.origin || '');
  let site: Site | null = null;
  let visitorId = '';
  let claims: Record<string, any> = {};
  let conv: Conversation | null = null;
  let unsubscribe: (() => void) | null = null;
  let busy: Promise<void> = Promise.resolve();

  const send = (o: Record<string, unknown>) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(o));
  };
  const authTimer = setTimeout(() => socket.close(CLOSE_AUTH, 'auth timeout'), 10_000);

  async function agentInfo(c: Conversation) {
    if (c.state !== 'human_active' || !c.agent_id) return undefined;
    const a = await getAgent(c.agent_id);
    return a ? { name: a.name, avatar: a.avatar_url } : undefined;
  }

  function attach(c: Conversation) {
    unsubscribe?.();
    conv = c;
    unsubscribe = subscribe(convChannel(c.id), (evt) => {
      if (evt._origin === socketId) return;
      const { _origin, ...rest } = evt;
      send(rest);
    });
  }

  async function ensureConversation(extra: Record<string, any> = {}): Promise<Conversation> {
    if (conv) {
      const fresh = await getConversation(conv.id);
      if (fresh && fresh.state !== 'closed') return (conv = fresh);
    }
    const ctx = claims.ctx || {};
    const user = claims.user || {};
    const page = extra.page && typeof extra.page === 'object' ? extra.page : {};
    const c = await createConversation(site!.id, visitorId, {
      topic: extra.topic,
      name: extra.name || user.name,
      email: extra.email || user.email,
      user_id: user.id,
      page_url: page.url || ctx.page_url,
      page_title: page.title || ctx.page_title,
      referrer: extra.referrer,
      ip_hash: ctx.ip_hash,
    });
    attach(c);
    return c;
  }

  async function onAuth(msg: any) {
    const peek = peekJwt(msg.token);
    site = peek?.iss ? await getSite(String(peek.iss)) : null;
    if (!site) return socket.close(CLOSE_AUTH, 'unknown site');
    if (!site.active) return socket.close(CLOSE_FORBIDDEN, 'site disabled');
    const verified = verifyJwt(msg.token, site.secret, 'laic-hub');
    if (!verified || typeof verified.sub !== 'string' || !verified.sub.startsWith('visitor:')) return socket.close(CLOSE_AUTH, 'invalid token');
    if (!allowedOrigins(site).has(origin)) {
      log.warn('visitor origin rejected', { site: site.id, origin });
      return socket.close(CLOSE_FORBIDDEN, 'origin not allowed');
    }
    clearTimeout(authTimer);
    claims = verified;
    visitorId = verified.sub;

    const existing = msg.conversation_id ? await getConversation(String(msg.conversation_id)) : null;
    if (existing && existing.site_id === site.id && existing.visitor_id === visitorId && existing.state !== 'closed') {
      attach(existing);
      const agent = await agentInfo(existing);
      if (msg.after) {
        send({ type: 'ready', conversation_id: existing.id, state: existing.state, agent });
        for (const m of await listMessages(existing.id, String(msg.after))) send({ type: 'message', ...toWire(m) });
      } else {
        const history = (await listMessages(existing.id, null, 100)).map(toWire);
        send({ type: 'ready', conversation_id: existing.id, state: existing.state, agent, history });
      }
    } else {
      send({ type: 'ready', conversation_id: null });
    }
  }

  async function onMessage(msg: any) {
    if (!site) {
      if (msg.type === 'auth') return onAuth(msg);
      return socket.close(CLOSE_AUTH, 'auth required');
    }
    switch (msg.type) {
      case 'start': {
        const c = await ensureConversation(msg);
        send({ type: 'conversation', conversation_id: c.id, state: c.state, agent: await agentInfo(c) });
        return;
      }
      case 'message': {
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 4000) : '';
        const clientId = typeof msg.client_id === 'string' ? msg.client_id.slice(0, 80) : '';
        if (!text || !clientId) return send({ type: 'error', code: 'invalid', message: 'Empty message.', client_id: clientId || undefined });
        if (await overLimit(`laic:rl:msg:${site.id}:${visitorId}`, config().visitorMessagesPerMinute, 60)) {
          return send({ type: 'error', code: 'rate_limited', message: 'You are sending messages too quickly. Please wait a moment.', client_id: clientId });
        }
        const wasNew = !conv;
        const c = await ensureConversation({ topic: 'auto' });
        if (wasNew) send({ type: 'conversation', conversation_id: c.id, state: c.state });
        const m = await handleVisitorMessage(c, text, clientId, socketId);
        send({ type: 'ack', client_id: clientId, id: String(m.id) });
        return;
      }
      case 'typing':
        if (conv) publish(AGENTS, { type: 'typing', conversation_id: conv.id, role: 'visitor', state: Boolean(msg.state) });
        return;
      case 'request_human': {
        const c = await ensureConversation({ topic: 'other' });
        await visitorRequestsHuman(c);
        return;
      }
      case 'rate':
        if (conv) await rateMessage(conv.id, String(msg.message_id || ''), String(msg.value || ''));
        return;
      case 'end':
        if (conv) {
          const c = await getConversation(conv.id);
          if (c) await closeConversation(c, 'visitor');
        }
        return;
      case 'ping':
        return send({ type: 'pong' });
    }
  }

  let frames = 0;
  const frameWindow = setInterval(() => (frames = 0), 10_000);

  socket.on('message', (raw) => {
    if (++frames > 60) return socket.close(CLOSE_RATE, 'too many frames');
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    // Handle frames one at a time so ordering is preserved.
    busy = busy.then(() => onMessage(msg)).catch((e) => {
      log.error('visitor frame failed', { error: errMsg(e), type: msg.type });
      send({ type: 'error', code: 'server_error', message: 'Something went wrong. Please try again.', client_id: msg.client_id });
    });
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    clearInterval(frameWindow);
    unsubscribe?.();
  });
}
