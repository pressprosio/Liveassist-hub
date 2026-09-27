/** Team members who answer chats: accounts, sign-in tokens, presence and phone devices. */
import { config } from './config.js';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from './crypto.js';
import { one, query } from './db.js';
import { redis } from './redis.js';

export interface Agent {
  id: string; email: string; name: string; avatar_url: string | null; role: 'admin' | 'agent'; token_version: number;
  must_change_password: boolean;
}

const PUBLIC_COLS = 'id, email, name, avatar_url, role, token_version, must_change_password';
export const MIN_PASSWORD = 10;
const TOKEN_TTL_SEC = 30 * 24 * 3600;
const AUD = 'laic-agent';

export async function createAgent(
  email: string, name: string, password: string, role: 'admin' | 'agent' = 'agent', mustChange = false,
): Promise<Agent> {
  if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  try {
    const row = await one<Agent>(
      `INSERT INTO agents (email, name, role, password_hash, must_change_password) VALUES (lower($1), $2, $3, $4, $5) RETURNING ${PUBLIC_COLS}`,
      [email.trim(), name.trim(), role, await hashPassword(password), mustChange],
    );
    return row!;
  } catch (e: any) {
    if (e?.code === '23505') throw new Error(`A team member with email ${email} already exists. Use agent:reset-password to change their password.`);
    throw e;
  }
}

export function getAgent(id: string): Promise<Agent | null> {
  return one<Agent>(`SELECT ${PUBLIC_COLS} FROM agents WHERE id = $1`, [id]);
}

export function listAgents(): Promise<Agent[]> {
  return query<Agent>(`SELECT ${PUBLIC_COLS} FROM agents ORDER BY created_at`);
}

export async function resetPassword(email: string, password: string, mustChange = false): Promise<boolean> {
  if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  // Bumping token_version signs the person out everywhere.
  const rows = await query(
    'UPDATE agents SET password_hash = $2, must_change_password = $3, token_version = token_version + 1 WHERE email = lower($1) RETURNING id',
    [email.trim(), await hashPassword(password), mustChange],
  );
  return rows.length > 0;
}

/**
 * A signed-in team member changes their own password. Signs out their other devices
 * and returns a fresh token for the device making the change.
 */
export async function changePassword(agentId: string, current: string, next: string): Promise<{ token: string; agent: Agent } | { error: string }> {
  const row = await one<{ password_hash: string }>('SELECT password_hash FROM agents WHERE id = $1', [agentId]);
  if (!row || !(await verifyPassword(current, row.password_hash))) return { error: 'Your current password is incorrect.' };
  if (next.length < MIN_PASSWORD) return { error: `Choose a new password of at least ${MIN_PASSWORD} characters.` };
  if (next === current) return { error: 'Choose a password different from your current one.' };
  const agent = await one<Agent>(
    `UPDATE agents SET password_hash = $2, must_change_password = false, token_version = token_version + 1
      WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
    [agentId, await hashPassword(next)],
  );
  return { token: issueToken(agent!), agent: agent! };
}

function issueToken(agent: Agent): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: agent.id, v: agent.token_version, aud: AUD, iat: now, exp: now + TOKEN_TTL_SEC }, config().jwtSecret);
}

export async function removeAgent(email: string): Promise<boolean> {
  const rows = await query('DELETE FROM agents WHERE email = lower($1) RETURNING id', [email.trim()]);
  return rows.length > 0;
}

export async function login(email: string, password: string): Promise<{ token: string; agent: Agent } | null> {
  const row = await one<Agent & { password_hash: string }>(`SELECT ${PUBLIC_COLS}, password_hash FROM agents WHERE email = lower($1)`, [String(email || '').trim()]);
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const ok = await verifyPassword(String(password || ''), row?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!row || !ok) return null;
  const { password_hash: _ignored, ...agent } = row;
  return { token: issueToken(agent), agent };
}

export async function authenticate(token: string): Promise<Agent | null> {
  const claims = verifyJwt(token, config().jwtSecret, AUD);
  if (!claims || typeof claims.sub !== 'string') return null;
  const agent = await getAgent(claims.sub);
  return agent && agent.token_version === claims.v ? agent : null;
}

export function publicAgent(a: Agent) {
  return { id: a.id, name: a.name, email: a.email, avatar: a.avatar_url, role: a.role, must_change_password: a.must_change_password };
}

/* ---------- Presence (shared across hub instances via Redis) ---------- */

const PRESENCE_TTL = 70;

export async function markOnline(agentId: string, connectionId: string): Promise<void> {
  await redis().set(`laic:presence:${agentId}:${connectionId}`, '1', 'EX', PRESENCE_TTL);
}
export async function markOffline(agentId: string, connectionId: string): Promise<void> {
  await redis().del(`laic:presence:${agentId}:${connectionId}`);
}
export async function onlineAgentIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis().scan(cursor, 'MATCH', 'laic:presence:*', 'COUNT', 200);
    cursor = next;
    for (const k of keys) ids.add(k.split(':')[2]!);
  } while (cursor !== '0');
  return ids;
}

/* ---------- Phone devices for push notifications ---------- */

export async function registerDevice(agentId: string, token: string, platform: string): Promise<void> {
  await query(
    `INSERT INTO devices (token, agent_id, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET agent_id = EXCLUDED.agent_id, platform = EXCLUDED.platform, last_seen = now()`,
    [token.slice(0, 4096), agentId, ['ios', 'android', 'web'].includes(platform) ? platform : 'unknown'],
  );
}
export async function removeDevice(token: string): Promise<void> {
  await query('DELETE FROM devices WHERE token = $1', [token]);
}
export async function deviceTokens(agentIds?: string[]): Promise<string[]> {
  const rows = agentIds
    ? await query<{ token: string }>('SELECT token FROM devices WHERE agent_id = ANY($1)', [agentIds])
    : await query<{ token: string }>('SELECT token FROM devices');
  return rows.map((r) => r.token);
}
export async function hasAnyDevice(): Promise<boolean> {
  return (await query('SELECT 1 FROM devices LIMIT 1')).length > 0;
}
