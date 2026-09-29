/**
 * The conversation engine: runs Claude turns, executes its tools, and moves
 * conversations between states (ai_active → waiting_human → human_active → closed).
 */
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { AGENTS, convChannel, publish } from './bus.js';
import {
  addMessage, getConversation, listMessages, saveLead, summary, toWire, updateConversation,
  type Conversation, type Message,
} from './conversations.js';
import { search } from './knowledge.js';
import { getSite, humansAllowed, withinHours, assistantName, type Site } from './sites.js';
import { alertRecipients, appForegroundAgentIds, hasAnyDevice, onlineAgentIds, deviceTokens, type Agent } from './agents.js';
import { sendPush } from './push.js';
import { enqueueWebhook } from './webhooks.js';
import { overLimit } from './redis.js';
import { query } from './db.js';
import { history, systemBlocks, tools } from './ai/prompt.js';
import { runTurn } from './ai/claude.js';
import { log, errMsg } from './log.js';

const DEFAULT_OFFLINE = "Nobody from the team is free right now. Leave your email and we'll follow up as soon as we can.";

/* ---------- Broadcasting ---------- */

export async function notifyAgents(conversationId: string): Promise<void> {
  const s = await summary(conversationId);
  if (s) publish(AGENTS, { type: 'conversation.updated', conversation: s });
}

function broadcast(conv: Conversation, m: Message, origin?: string) {
  const wire = toWire(m);
  publish(convChannel(conv.id), { type: 'message', ...wire, _origin: origin });
  publish(AGENTS, { type: 'message', conversation_id: conv.id, message: wire });
  notifyAgents(conv.id).catch(() => {});
}

async function post(conv: Conversation, role: 'ai' | 'system', text: string): Promise<Message> {
  const { message } = await addMessage(conv.id, { role, text });
  broadcast(conv, message);
  return message;
}

function sendState(conv: Conversation, agent?: { name: string; avatar_url?: string | null } | null) {
  publish(convChannel(conv.id), {
    type: 'state',
    state: conv.state,
    agent: agent ? { name: agent.name, avatar: agent.avatar_url || null } : undefined,
  });
  notifyAgents(conv.id).catch(() => {});
}

/** Is someone on the team reachable right now (in hours, and online or reachable by push)? */
export async function teamAvailable(site: Site): Promise<boolean> {
  if (!humansAllowed(site) || !withinHours(site)) return false;
  if ((await onlineAgentIds()).size > 0) return true;
  return hasAnyDevice();
}

/* ---------- Alerts: sound + banner for the team ---------- */

type AlertKind = 'handoff' | 'new_chat' | 'message';

/**
 * Alerts everyone whose settings ask for this kind of event.
 * - People with the phone app open get an in-app alert (the app plays the sound).
 * - Everyone else gets a push notification on their phones.
 * - The web console also receives the in-app alert and beeps.
 */
export async function alertTeam(kind: AlertKind, conv: Conversation, detail: string): Promise<void> {
  const recipients = await alertRecipients(kind, conv.agent_id);
  if (!recipients.length) return;
  const site = await getSite(conv.site_id);
  const siteName = site?.name || 'Chat';
  const who = conv.name || 'Visitor';
  const title =
    kind === 'handoff' ? `${siteName}: a visitor wants a person`
      : kind === 'new_chat' ? `New chat · ${siteName}`
        : `${who} · ${siteName}`;
  const body = kind === 'message' ? detail : kind === 'new_chat' ? `${who}: ${detail}` : detail || `${who} is waiting.`;

  publish(AGENTS, { type: 'alert', kind, conversation_id: conv.id, title, body, to: recipients });

  const onScreen = await appForegroundAgentIds();
  const pushTo = recipients.filter((id) => !onScreen.has(id));
  if (pushTo.length) {
    sendPush(await deviceTokens(pushTo), { title, body, data: { conversation_id: conv.id, kind } }).catch(() => {});
  }
}

/* ---------- Visitor messages ---------- */

export async function handleVisitorMessage(conv: Conversation, text: string, clientId: string, origin: string) {
  const { message, duplicate } = await addMessage(conv.id, { role: 'visitor', text, client_id: clientId });
  if (duplicate) return message;
  broadcast(conv, message, origin);

  const count = await query<{ n: string }>("SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1 AND role = 'visitor'", [conv.id]);
  const first = Number(count[0]?.n || 0) === 1;
  alertTeam(first ? 'new_chat' : 'message', conv, text).catch((e) => log.warn('alert failed', { error: errMsg(e) }));

  if (conv.state === 'ai_active') queueAiTurn(conv.id);
  return message;
}

/* ---------- AI turns (serialized per conversation) ---------- */

const turns = new Map<string, { again: boolean }>();

export function queueAiTurn(conversationId: string) {
  const running = turns.get(conversationId);
  if (running) {
    running.again = true; // the next run reads the full history, so one extra run covers any number of new messages
    return;
  }
  const slot = { again: false };
  turns.set(conversationId, slot);
  (async () => {
    try {
      do {
        slot.again = false;
        await runAi(conversationId);
      } while (slot.again);
    } finally {
      turns.delete(conversationId);
    }
  })().catch((e) => log.error('ai turn loop failed', { error: errMsg(e) }));
}

async function runAi(conversationId: string) {
  const conv = await getConversation(conversationId);
  if (!conv || conv.state !== 'ai_active') return;
  const site = await getSite(conv.site_id);
  if (!site || !site.active) return;
  const cfg = config();

  if (conv.ai_turns >= cfg.maxAiTurnsPerConversation) {
    const already = await query("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'system' AND text LIKE 'This chat has reached%' LIMIT 1", [conv.id]);
    if (!already.length) {
      await post(conv, 'system', 'This chat has reached its length limit. Leave your email or ask for a person and the team will follow up.');
    }
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  if (await overLimit(`laic:ai:day:${site.id}:${day}`, cfg.maxAiTurnsPerSiteDaily, 26 * 3600)) {
    log.warn('site daily AI limit reached', { site: site.id });
    await post(conv, 'system', 'The assistant is unavailable right now. Leave your email and the team will get back to you.');
    return;
  }

  const messages = await listMessages(conv.id, null, 40);
  const lastVisitor = [...messages].reverse().find((m) => m.role === 'visitor');
  if (!lastVisitor) return;
  const lastAiIdx = messages.map((m) => m.role).lastIndexOf('ai');
  const lastVisIdx = messages.lastIndexOf(lastVisitor);
  if (lastAiIdx > lastVisIdx) return; // already answered

  const track = conv.topic === 'sales' ? 'sales' : null;
  const [hits, available] = await Promise.all([
    search(site.id, lastVisitor.text, track, 4).catch(() => []),
    teamAvailable(site),
  ]);

  const channel = convChannel(conv.id);
  const streamId = `s-${randomUUID()}`;
  let started = false;
  let current: Conversation = conv;
  publish(channel, { type: 'typing', role: 'ai', state: true });

  const runTool = async (name: string, input: Record<string, any>): Promise<string> => {
    current = (await getConversation(conv.id)) || current;
    switch (name) {
      case 'search_knowledge': {
        const found = await search(site.id, String(input.query || ''), track, 4);
        if (!found.length) return 'No matching pages found.';
        return found.map((h) => `<doc title="${h.title.replace(/"/g, "'")}" url="${h.url}">\n${h.excerpt}\n${h.snippet}\n</doc>`).join('\n');
      }
      case 'capture_lead':
      case 'create_ticket': {
        const kind = name === 'capture_lead' ? 'lead' : 'ticket';
        const email = String(input.email || current.email || '').trim();
        const phone = String(input.phone || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !phone) {
          return 'Not saved: ask the visitor for their email address first.';
        }
        const data = {
          name: input.name || current.name, email, phone,
          interest: input.interest || input.summary, summary: input.summary || input.interest,
        };
        current = (await saveLead(current, kind, data)) || current;
        await enqueueWebhook(site.id, kind === 'lead' ? 'lead.captured' : 'ticket.created', {
          conversation_id: conv.id, topic: conv.topic, page_url: conv.page_url, ...data,
        });
        notifyAgents(conv.id).catch(() => {});
        return kind === 'lead' ? 'Saved. The team will follow up.' : 'Ticket created. Support will reply by email.';
      }
      case 'request_human': {
        if (!humansAllowed(site)) return 'Live chat with the team is not offered. Collect the visitor\'s email instead.';
        if (!available) return 'The team is offline. Tell the visitor, and collect their email for follow-up.';
        const ok = await startHandoff(current, String(input.reason || ''));
        return ok
          ? 'Handoff started. Tell the visitor someone from the team is joining shortly. Do not answer further questions until they join.'
          : 'Handoff is not possible right now. Offer to take their email instead.';
      }
      default:
        return `Unknown tool ${name}.`;
    }
  };

  const onText = (delta: string) => {
    if (!started) {
      started = true;
      publish(channel, { type: 'typing', role: 'ai', state: false });
      publish(channel, { type: 'stream_start', id: streamId, role: 'ai' });
    }
    publish(channel, { type: 'stream_delta', id: streamId, text: delta });
  };

  try {
    const model = cfg.models[site.config.assistant?.model_tier || 'balanced'] || cfg.models.balanced!;
    const result = await runTurn(
      {
        model,
        system: systemBlocks(site, conv, hits, { teamAvailable: available }),
        messages: history(messages),
        tools: tools(site),
      },
      onText,
      runTool,
    );
    await query('UPDATE conversations SET ai_turns = ai_turns + 1 WHERE id = $1', [conv.id]);
    log.info('ai turn', { site: site.id, conversation: conv.id, ...result.usage });

    const text = result.text || "I'm not sure how to answer that. Would you like me to connect you with the team?";
    const { message } = await addMessage(conv.id, { role: 'ai', text });
    if (started) {
      publish(channel, { type: 'stream_end', id: streamId, text, message_id: String(message.id) });
      publish(AGENTS, { type: 'message', conversation_id: conv.id, message: toWire(message) });
      notifyAgents(conv.id).catch(() => {});
    } else {
      publish(channel, { type: 'typing', role: 'ai', state: false });
      broadcast(conv, message);
    }
  } catch (e) {
    log.error('ai turn failed', { site: site.id, conversation: conv.id, error: errMsg(e) });
    publish(channel, { type: 'typing', role: 'ai', state: false });
    if (started) publish(channel, { type: 'stream_end', id: streamId });
    await post(conv, 'system', humansAllowed(site)
      ? 'The assistant is having trouble answering right now. You can ask for a person or try again in a moment.'
      : 'The assistant is having trouble answering right now. Please try again in a moment.');
  }
}

/* ---------- Handoff ---------- */

export async function startHandoff(conv: Conversation, reason: string): Promise<boolean> {
  const updated = await one_state(conv.id, ['ai_active'], { state: 'waiting_human', waiting_since: new Date() });
  if (!updated) return false;
  sendState(updated);
  publish(AGENTS, { type: 'handoff.requested', conversation_id: conv.id, reason });
  alertTeam('handoff', updated, reason).catch((e) => log.warn('alert failed', { error: errMsg(e) }));
  return true;
}

/** Visitor pressed "Talk to a person". */
export async function visitorRequestsHuman(conv: Conversation): Promise<void> {
  if (conv.state !== 'ai_active') return;
  const site = await getSite(conv.site_id);
  if (!site) return;
  if (await teamAvailable(site)) {
    await startHandoff(conv, 'Visitor pressed "Talk to a person".');
  } else {
    await post(conv, 'ai', humansAllowed(site) ? site.config.routing?.offline_notice || DEFAULT_OFFLINE : DEFAULT_OFFLINE);
  }
}

/** Atomic state change guarded by the allowed current states. */
async function one_state(id: string, from: string[], fields: Record<string, unknown>): Promise<Conversation | null> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const rows = await query<Conversation>(
    `UPDATE conversations SET ${sets}, last_activity_at = now() WHERE id = $1 AND state = ANY($2) RETURNING *`,
    [id, from, ...keys.map((k) => fields[k])],
  );
  return rows[0] || null;
}

export async function agentTakeOver(conv: Conversation, agent: Agent): Promise<Conversation | null> {
  const updated = await one_state(conv.id, ['ai_active', 'waiting_human', 'human_active'], {
    state: 'human_active', agent_id: agent.id, waiting_since: null,
  });
  if (updated) sendState(updated, agent);
  return updated;
}

export async function agentReturnToAi(conv: Conversation): Promise<Conversation | null> {
  const updated = await one_state(conv.id, ['human_active', 'waiting_human'], { state: 'ai_active', agent_id: null, waiting_since: null });
  if (updated) sendState(updated);
  return updated;
}

export async function agentSend(conv: Conversation, agent: Agent, text: string, clientId?: string): Promise<Message | null> {
  let c: Conversation | null = conv;
  if (conv.state !== 'human_active' || conv.agent_id !== agent.id) c = await agentTakeOver(conv, agent);
  if (!c) return null;
  const { message, duplicate } = await addMessage(c.id, {
    role: 'agent', text, client_id: clientId, agent_id: agent.id, author_name: agent.name, author_avatar: agent.avatar_url,
  });
  if (!duplicate) broadcast(c, message);
  return message;
}

export async function closeConversation(conv: Conversation, _by: 'visitor' | 'agent' | 'idle'): Promise<void> {
  const updated = await one_state(conv.id, ['ai_active', 'waiting_human', 'human_active'], { state: 'closed', closed_at: new Date(), waiting_since: null });
  if (!updated) return;
  sendState(updated);
  if (updated.has_lead) {
    const msgs = await listMessages(conv.id, null, 500);
    const site = await getSite(conv.site_id);
    await enqueueWebhook(conv.site_id, 'conversation.closed', {
      conversation_id: conv.id,
      messages: msgs.map((m) => ({
        role: m.role,
        name: m.role === 'agent' ? m.author_name : m.role === 'ai' && site ? assistantName(site) : m.role === 'visitor' ? conv.name || 'Visitor' : '',
        text: m.text,
        ts: new Date(m.created_at).toISOString(),
      })),
    });
  }
}

/** Draft a reply for an agent (not sent to the visitor). */
export async function suggestReply(conv: Conversation): Promise<string> {
  const site = await getSite(conv.site_id);
  if (!site) return '';
  const messages = await listMessages(conv.id, null, 40);
  const lastVisitor = [...messages].reverse().find((m) => m.role === 'visitor');
  const hits = lastVisitor ? await search(site.id, lastVisitor.text, null, 4).catch(() => []) : [];
  const system = systemBlocks(site, conv, hits, { teamAvailable: true });
  system.push({ type: 'text', text: 'You are drafting a reply for a human team member to review and send in their own voice. Write only the reply text. Do not mention that you are an AI.' });
  const hist = history(messages);
  if (!hist.length) return '';
  const res = await runTurn(
    { model: config().models[site.config.assistant?.model_tier || 'balanced'] || config().models.balanced!, system, messages: hist, tools: [] },
    () => {},
    async () => 'Tools are not available when drafting.',
  );
  return res.text;
}

/* ---------- Background checks ---------- */

export async function checkHandoffTimeouts(): Promise<void> {
  const waiting = await query<Conversation>("SELECT * FROM conversations WHERE state = 'waiting_human'");
  for (const conv of waiting) {
    const site = await getSite(conv.site_id);
    const timeout = Number(site?.config.routing?.handoff_timeout) || 90;
    if (!conv.waiting_since || Date.now() - new Date(conv.waiting_since).getTime() < timeout * 1000) continue;
    const updated = await one_state(conv.id, ['waiting_human'], { state: 'ai_active', waiting_since: null });
    if (!updated) continue;
    sendState(updated);
    await post(updated, 'ai', site?.config.routing?.offline_notice || DEFAULT_OFFLINE);
  }
}

export async function closeIdleConversations(): Promise<void> {
  const idle = await query<Conversation>(
    `SELECT * FROM conversations WHERE state <> 'closed' AND last_activity_at < now() - make_interval(mins => $1) LIMIT 200`,
    [config().idleCloseMinutes],
  );
  for (const conv of idle) await closeConversation(conv, 'idle');
}

export async function applyRetention(): Promise<void> {
  const sites = await query<{ id: string; days: string | null }>("SELECT id, config->'privacy'->>'retention_days' AS days FROM sites");
  for (const s of sites) {
    const days = Number(s.days ?? 365);
    if (!days || days <= 0) continue;
    await query("DELETE FROM conversations WHERE site_id = $1 AND state = 'closed' AND closed_at < now() - make_interval(days => $2)", [s.id, days]);
    await query('DELETE FROM leads WHERE site_id = $1 AND created_at < now() - make_interval(days => $2)', [s.id, days]);
  }
  await query("DELETE FROM webhook_outbox WHERE created_at < now() - interval '14 days'");
}
