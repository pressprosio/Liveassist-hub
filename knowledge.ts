/** Knowledge documents synced from WordPress, searched with Postgres full-text search. */
import { query } from './db.js';

export interface KnowledgeDoc {
  id: string; type?: string; track?: string; title?: string; url?: string; modified?: string;
  excerpt?: string; content?: string; meta?: Record<string, unknown>; hash?: string;
}

export interface SearchHit {
  doc_id: string; title: string; url: string; type: string; excerpt: string; snippet: string; meta: any; rank: number;
}

const MAX_CONTENT = 30_000;
const s = (v: unknown, max = 2000) => (typeof v === 'string' ? v : '').slice(0, max);

export async function upsertDocs(siteId: string, docs: KnowledgeDoc[], syncId: string | null): Promise<number> {
  let n = 0;
  for (const d of docs) {
    if (!d || typeof d.id !== 'string' || !d.id) continue;
    await query(
      `INSERT INTO knowledge_docs (site_id, doc_id, type, track, title, url, excerpt, content, meta, hash, sync_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (site_id, doc_id) DO UPDATE SET
         type = EXCLUDED.type, track = EXCLUDED.track, title = EXCLUDED.title, url = EXCLUDED.url,
         excerpt = EXCLUDED.excerpt, content = EXCLUDED.content, meta = EXCLUDED.meta, hash = EXCLUDED.hash,
         sync_id = EXCLUDED.sync_id, updated_at = now()`,
      [
        siteId, d.id.slice(0, 100), s(d.type, 40) || 'page', d.track === 'sales' ? 'sales' : 'general',
        s(d.title, 300), s(d.url, 1000), s(d.excerpt, 3000), s(d.content, MAX_CONTENT),
        JSON.stringify(d.meta && typeof d.meta === 'object' ? d.meta : {}), s(d.hash, 64), syncId,
      ],
    );
    n++;
  }
  return n;
}

export async function deleteDocs(siteId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await query('DELETE FROM knowledge_docs WHERE site_id = $1 AND doc_id = ANY($2) RETURNING doc_id', [siteId, ids]);
  return rows.length;
}

/** After a full sync, remove anything WordPress didn't send in that sync. */
export async function commitSync(siteId: string, syncId: string): Promise<number> {
  const rows = await query(
    'DELETE FROM knowledge_docs WHERE site_id = $1 AND sync_id IS DISTINCT FROM $2 RETURNING doc_id',
    [siteId, syncId],
  );
  return rows.length;
}

export async function countDocs(siteId: string): Promise<number> {
  const rows = await query<{ n: string }>('SELECT count(*)::text AS n FROM knowledge_docs WHERE site_id = $1', [siteId]);
  return Number(rows[0]?.n || 0);
}

const STOP = new Set('the and for are but not you your with this that what how can does have from about when where which will would could should there their they them our was were has had any all get got just like want need into also than then its it\'s i\'m please thanks hello hi'.split(' '));

function terms(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9][a-z0-9\-]{1,30}/g) || [])
    .map((w) => w.replace(/-/g, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 12);
}

function snippet(content: string, words: string[], size = 1800): string {
  if (content.length <= size) return content;
  const lower = content.toLowerCase();
  let pos = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  const start = Math.max(0, (pos === -1 ? 0 : pos) - Math.floor(size / 4));
  return (start > 0 ? '…' : '') + content.slice(start, start + size) + (start + size < content.length ? '…' : '');
}

export async function search(siteId: string, text: string, track: string | null, limit = 5): Promise<SearchHit[]> {
  const words = terms(text);
  if (!words.length) return [];
  const tsq = words.map((w) => `${w}:*`).join(' | ');
  const rows = await query<SearchHit & { content: string }>(
    `SELECT doc_id, title, url, type, excerpt, content, meta,
            ts_rank_cd(tsv, q) + CASE WHEN track = $3 THEN 0.05 ELSE 0 END AS rank
       FROM knowledge_docs, to_tsquery('english', $2) q
      WHERE site_id = $1 AND tsv @@ q
      ORDER BY rank DESC
      LIMIT $4`,
    [siteId, tsq, track || 'general', limit],
  );
  return rows.map((r) => ({ ...r, snippet: snippet(r.content, words) }));
}
