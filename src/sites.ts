/** Sites: credentials, configuration pushed from WordPress, and business-hours logic. */
import { decrypt, encrypt, newSiteSecret } from './crypto.js';
import { one, query } from './db.js';

export interface DayHours { on: number | boolean; start: string; end: string }

export interface SiteConfig {
  site?: { name?: string; url?: string; timezone?: string; language?: string; webhook?: string };
  assistant?: {
    name?: string; avatar_url?: string; greeting?: string; business_intro?: string;
    tone?: 'friendly' | 'professional' | 'concise'; sales_prompt?: string; tech_prompt?: string;
    blocked_topics?: string; model_tier?: 'economy' | 'balanced' | 'best';
  };
  routing?: {
    allow_human?: number | boolean; handoff_timeout?: number; notify_email?: string;
    offline_notice?: string; hours?: Record<string, DayHours>;
  };
  privacy?: { retention_days?: number; ai_disclosure?: string };
  faq?: string;
  plugin?: string;
}

export interface Site {
  id: string;
  name: string;
  url: string;
  active: boolean;
  config: SiteConfig;
  secret: string;
}

interface Row { id: string; name: string; url: string; active: boolean; config: SiteConfig; secret_enc: string }

const cache = new Map<string, { site: Site | null; at: number }>();
const TTL_MS = 10_000;

function hydrate(r: Row): Site {
  return { id: r.id, name: r.name, url: r.url, active: r.active, config: r.config || {}, secret: decrypt(r.secret_enc) };
}

export async function getSite(id: string): Promise<Site | null> {
  if (!id) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.site;
  const row = await one<Row>('SELECT id, name, url, active, config, secret_enc FROM sites WHERE id = $1', [id]);
  const site = row ? hydrate(row) : null;
  cache.set(id, { site, at: Date.now() });
  return site;
}

export function forgetSite(id: string) {
  cache.delete(id);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

export function normalizeUrl(u: string): string {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Site URL must start with https:// or http://');
  return `${url.protocol}//${url.host}`;
}

export async function createSite(name: string, url: string, id?: string): Promise<{ id: string; secret: string }> {
  const siteId = id ? slugify(id) : slugify(name);
  const secret = newSiteSecret();
  try {
    await query('INSERT INTO sites (id, name, url, secret_enc) VALUES ($1, $2, $3, $4)', [siteId, name, normalizeUrl(url), encrypt(secret)]);
  } catch (e: any) {
    if (e?.code === '23505') throw new Error(`A site with ID "${siteId}" already exists. Choose another with --id, or use site:rotate-secret to get a new secret for it.`);
    throw e;
  }
  return { id: siteId, secret };
}

export async function rotateSecret(id: string): Promise<string | null> {
  const secret = newSiteSecret();
  const rows = await query('UPDATE sites SET secret_enc = $2, updated_at = now() WHERE id = $1 RETURNING id', [id, encrypt(secret)]);
  forgetSite(id);
  return rows.length ? secret : null;
}

export async function setActive(id: string, active: boolean): Promise<boolean> {
  const rows = await query('UPDATE sites SET active = $2, updated_at = now() WHERE id = $1 RETURNING id', [id, active]);
  forgetSite(id);
  return rows.length > 0;
}

export async function saveConfig(id: string, cfg: SiteConfig): Promise<void> {
  await query('UPDATE sites SET config = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(cfg)]);
  forgetSite(id);
}

export async function listSites() {
  return query<{ id: string; name: string; url: string; active: boolean; created_at: Date; plugin: string | null }>(
    "SELECT id, name, url, active, created_at, config->>'plugin' AS plugin FROM sites ORDER BY created_at",
  );
}

/** Origins allowed to open visitor chat sockets: the site's origin and its www/non-www twin. */
export function allowedOrigins(site: Site): Set<string> {
  const u = new URL(site.url);
  const host = u.host.replace(/^www\./, '');
  return new Set([`${u.protocol}//${host}`, `${u.protocol}//www.${host}`]);
}

export function assistantName(site: Site): string {
  return site.config.assistant?.name || 'Assistant';
}

export function humansAllowed(site: Site): boolean {
  const v = site.config.routing?.allow_human;
  return v === undefined ? true : Boolean(Number(v));
}

/** Is the team within its configured hours right now (site timezone)? */
export function withinHours(site: Site, now = new Date()): boolean {
  const hours = site.config.routing?.hours;
  if (!hours || !Object.keys(hours).length) return true;
  const tz = site.config.site?.timezone || 'UTC';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const day = get('weekday').toLowerCase().slice(0, 3);
  const hm = `${get('hour').padStart(2, '0')}:${get('minute').padStart(2, '0')}`;
  const today = hours[day];
  if (!today || !Number(today.on)) return false;
  if (today.start <= today.end) return hm >= today.start && hm < today.end;
  return hm >= today.start || hm < today.end; // overnight shift, e.g. 22:00–06:00
}
