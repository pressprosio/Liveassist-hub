/** Agent WebSocket (/agent/ws) used by the web console and the mobile app. */
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { AGENTS, convChannel, publish, subscribe } from '../bus.js';
import { authenticate, markOffline, markOnline, publicAgent, type Agent } from '../agents.js';
import { getConversation, listMessages, summaries, summary, toWire } from '../conversations.js';
import { agentReturnToAi, agentSend, agentTakeOver, closeConversation, suggestReply } from '../engine.js';
import { log, errMsg } from '../log.js';

export function agentSocket(socket: WebSocket) {
  const connId = randomUUID();
  let agent: Agent | null = null;
  let unsubscribe: (() => void) | null = null;
  let presence: NodeJS.Timeout | null = null;

  const send = (o: Record<string, unknown>) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(o));
  };
  const authTimer = setTimeout(() => socket.close(4001, 'auth timeout'), 10_000);

  async function convOrError(id: unknown) {
    const c = await getConversation(String(id || ''));
    if (!c) send({ type: 'error', code: 'not_found', message: 'That conversation no longer exists.' });
    return c;
  }

  async function onMessage(msg: any) {
    if (!agent) {
      if (msg.type !== 'auth') return socket.close(4001, 'auth required');
      agent = await authenticate(String(msg.token || ''));
      if (!agent) return socket.close(4001, 'invalid token');
      clearTimeout(authTimer);
      await markOnline(agent.id, connId);
      presence = setInterval(() => markOnline(agent!.id, connId).catch(() => {}), 30_000);
      unsubscribe = subscribe(AGENTS, (evt) => {
        const { _origin, ...rest } = evt;
        send(rest);
      });
      send({ type: 'hello', agent: publicAgent(agent), conversations: await summaries() });
      return;
    }

    switch (msg.type) {
      case 'list':
        return send({ type: 'conversations', conversations: await summaries({ includeClosed: Boolean(msg.include_closed) }) });

      case 'open': {
        const c = await convOrError(msg.conversation_id);
        if (!c) return;
        const messages = (await listMessages(c.id, null, 300)).map(toWire);
        return send({ type: 'conversation.detail', conversation: await summary(c.id), messages });
      }
      case 'accept': {
        const c = await convOrError(msg.conversation_id);
        if (!c) return;
        if (c.state === 'closed') return send({ type: 'error', code: 'closed', message: 'This conversation has ended.' });
        await agentTakeOver(c, agent);
        return;
      }
      case 'send': {
        const c = await convOrError(msg.conversation_id);
        if (!c) return;
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 4000) : '';
        if (!text) return;
        if (c.state === 'closed') return send({ type: 'error', code: 'closed', message: 'This conversation has ended, so the visitor will not see new messages.' });
        const m = await agentSend(c, agent, text, typeof msg.client_id === 'string' ? msg.client_id.slice(0, 80) : undefined);
        if (m) send({ type: 'ack', client_id: msg.client_id, id: String(m.id), conversation_id: c.id });
        return;
      }
      case 'return_to_ai': {
        const c = await convOrError(msg.conversation_id);
        if (c) await agentReturnToAi(c);
        return;
      }
      case 'close': {
        const c = await convOrError(msg.conversation_id);
        if (c) await closeConversation(c, 'agent');
        return;
      }
      case 'typing':
        if (msg.conversation_id) publish(convChannel(String(msg.conversation_id)), { type: 'typing', role: 'agent', state: Boolean(msg.state) });
        return;
      case 'suggest': {
        const c = await convOrError(msg.conversation_id);
        if (!c) return;
        const text = await suggestReply(c).catch((e) => {
          log.warn('suggest failed', { error: errMsg(e) });
          return '';
        });
        return send({ type: 'suggestion', conversation_id: c.id, text });
      }
      case 'ping':
        await markOnline(agent.id, connId);
        return send({ type: 'pong' });
    }
  }

  let busy: Promise<void> = Promise.resolve();
  socket.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    busy = busy.then(() => onMessage(msg)).catch((e) => {
      log.error('agent frame failed', { error: errMsg(e), type: msg.type });
      send({ type: 'error', code: 'server_error', message: 'That action failed. Try again.' });
    });
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    if (presence) clearInterval(presence);
    unsubscribe?.();
    if (agent) markOffline(agent.id, connId).catch(() => {});
  });
}
