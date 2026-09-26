/** Conversation and message persistence. */
import { one, query } from './db.js';

export type ConvState = 'ai_active' | 'waiting_human' | 'human_active' | 'closed';

export interface Conversation {
  id: string; site_id: string; visitor_id: string; state: ConvState; topic: string;
  name: string | null; email: string | null; user_id: string | null;
  page_url: string | null; page_title: string | null; referrer: string | null; ip_hash: string | null;
  agent_id: string | null; has_lead: boolean; ai_turns: number;
  waiting_since: Date | null; last_activity_at: Date; created_at: Date; closed_at: Date | null;
}

export interface Message {
  id: string; conversation_id: string; role: 'visitor' | 'ai' | 'agent' | 'system'; text: string;
  agent_id: string | null; author_name: string | null; author_avatar: string | null;
  client_id: string | null; rating: string | null; created_at: Date;
}

export interface WireMessage {
  id: string; role: Message['role']; text: string; ts: string; author?: { name: string; avatar?: string | null };
}

export function toWire(m: Message): WireMessage {
  const w: WireMessage = { id: String(m.id), role: m.role, text: m.text, ts: new Date(m.created_at).toISOString() };
  if (m.role === 'agent' && m.author_name) w.author = { name: m.author_name, avatar: m.author_avatar };
  return w;
}

const TOPICS = new Set(['sales', 'technical', 'other', 'auto']);
const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

export async function createConversation(siteId: string, visitorId: string, ctx: Record<string, any>): Promise<Conversation> {
  const topic = TOPICS.has(ctx.topic) ? ctx.topic : 'auto';
  const email = clip(ctx.email, 200);
  const row = await one<Conversation>(
    `INSERT INTO conversations (site_id, visitor_id, topic, name, email, user_id, page_url, page_title, referrer, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      siteId, visitorId, topic, clip(ctx.name, 100),
      email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      Number.isInteger(ctx.user_id) ? ctx.user_id : null,
      clip(ctx.page_url, 1000), clip(ctx.page_title, 300), clip(ctx.referrer, 1000), clip(ctx.ip_hash, 64),
    ],
  );
  return row!;
}

export function getConversation(id: string): Promise<Conversation | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return Promise.resolve(null);
  return one<Conversation>('SELECT * FROM conversations WHERE id = $1', [id]);
}

export async function updateConversation(id: string, fields: Partial<Record<keyof Conversation, unknown>>): Promise<Conversation | null> {
  const keys = Object.keys(fields);
  if (!keys.length) return getConversation(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  return one<Conversation>(`UPDATE conversations SET ${sets} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => (fields as any)[k])]);
}

/** Insert a message. Visitor messages are idempotent by client_id. */
export async function addMessage(
  conversationId: string,
  m: { role: Message['role']; text: string; client_id?: string; agent_id?: string; author_name?: string; author_avatar?: string | null },
): Promise<{ message: Message; duplicate: boolean }> {
  const inserted = await one<Message>(
    `INSERT INTO messages (conversation_id, role, text, client_id, agent_id, author_name, author_avatar)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (conversation_id, client_id) DO NOTHING RETURNING *`,
    [conversationId, m.role, m.text, m.client_id ?? null, m.agent_id ?? null, m.author_name ?? null, m.author_avatar ?? null],
  );
  if (inserted) {
    await query('UPDATE conversations SET last_activity_at = now() WHERE id = $1', [conversationId]);
    return { message: inserted, duplicate: false };
  }
  const existing = await one<Message>('SELECT * FROM messages WHERE conversation_id = $1 AND client_id = $2', [conversationId, m.client_id]);
  return { message: existing!, duplicate: true };
}

export function listMessages(conversationId: string, afterId?: string | null, limit = 200): Promise<Message[]> {
  if (afterId && /^\d+$/.test(afterId)) {
    return query<Message>('SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT $3', [conversationId, afterId, limit]);
  }
  return query<Message>(
    'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id',
    [conversationId, limit],
  );
}

export async function rateMessage(conversationId: string, messageId: string, value: string): Promise<void> {
  if (!/^\d+$/.test(messageId) || !['up', 'down'].includes(value)) return;
  await query("UPDATE messages SET rating = $3 WHERE conversation_id = $1 AND id = $2 AND role = 'ai'", [conversationId, messageId, value]);
}

export async function saveLead(conv: Conversation, kind: 'lead' | 'ticket', d: Record<string, any>) {
  await query(
    'INSERT INTO leads (site_id, conversation_id, kind, name, email, phone, interest, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [conv.site_id, conv.id, kind, clip(d.name, 100), clip(d.email, 200), clip(d.phone, 50), clip(d.interest, 1000), clip(d.summary, 4000)],
  );
  const fields: Record<string, unknown> = { has_lead: true };
  if (!conv.name && d.name) fields.name = clip(d.name, 100);
  if (!conv.email && d.email) fields.email = clip(d.email, 200);
  return updateConversation(conv.id, fields);
}

export interface ConversationSummary {
  id: string; site_id: string; site_name: string; state: ConvState; topic: string;
  name: string | null; email: string | null; page_url: string | null; page_title: string | null;
  agent_id: string | null; agent_name: string | null; last_activity_at: Date; created_at: Date;
  waiting_since: Date | null; last_text: string | null; last_role: string | null;
}

const SUMMARY_SQL = `
  SELECT c.id, c.site_id, s.name AS site_name, c.state, c.topic, c.name, c.email, c.page_url, c.page_title,
         c.agent_id, a.name AS agent_name, c.last_activity_at, c.created_at, c.waiting_since,
         lm.text AS last_text, lm.role AS last_role
    FROM conversations c
    JOIN sites s ON s.id = c.site_id
    LEFT JOIN agents a ON a.id = c.agent_id
    LEFT JOIN LATERAL (SELECT text, role FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) lm ON true`;

export function summaries(opts: { includeClosed?: boolean; limit?: number } = {}): Promise<ConversationSummary[]> {
  // Skip empty conversations (a visitor picked a topic but never wrote anything).
  const base = `(lm.text IS NOT NULL OR c.state = 'waiting_human')`;
  const where = opts.includeClosed
    ? `WHERE ${base} AND c.last_activity_at > now() - interval '7 days'`
    : `WHERE ${base} AND c.state <> 'closed'`;
  return query<ConversationSummary>(
    `${SUMMARY_SQL} ${where}
      ORDER BY (c.state = 'waiting_human') DESC, c.last_activity_at DESC LIMIT $1`,
    [opts.limit ?? 100],
  );
}

export function summary(id: string): Promise<ConversationSummary | null> {
  return one<ConversationSummary>(`${SUMMARY_SQL} WHERE c.id = $1`, [id]);
}
