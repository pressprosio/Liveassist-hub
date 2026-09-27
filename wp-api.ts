/** Signed REST API used by the WordPress plugin. Protocol: HUB-PROTOCOL.md section 3. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifySignature } from '../crypto.js';
import { getSite, saveConfig, type Site } from '../sites.js';
import { commitSync, countDocs, deleteDocs, upsertDocs } from '../knowledge.js';
import { query } from '../db.js';

declare module 'fastify' {
  interface FastifyRequest { rawBody?: string; site?: Site }
}

type Req = FastifyRequest<{ Params: { site: string } }>;

async function verify(req: Req, reply: FastifyReply) {
  const site = await getSite(req.params.site);
  const header = String(req.headers['x-laic-site'] || '');
  if (!site || header !== site.id) return reply.code(401).send({ error: 'Unknown site ID. Check the Site ID in WordPress matches the hub.' });
  if (!site.active) return reply.code(403).send({ error: 'This site is disabled on the hub.' });
  const ok = verifySignature(site.secret, String(req.headers['x-laic-timestamp'] || ''), req.rawBody || '', String(req.headers['x-laic-signature'] || ''));
  if (!ok) return reply.code(401).send({ error: 'Signature check failed. Re-paste the Site secret in WordPress, and check the server clocks are correct.' });
  req.site = site;
}

export async function wpApi(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', verify);

    r.get('/api/v1/sites/:site/ping', async (req) => ({
      ok: true,
      site_name: req.site!.name,
      documents: await countDocs(req.site!.id),
    }));

    r.put('/api/v1/sites/:site/config', async (req) => {
      const body = (req.body || {}) as Record<string, unknown>;
      await saveConfig(req.site!.id, body);
      return { ok: true };
    });

    r.post('/api/v1/sites/:site/knowledge', async (req, reply) => {
      const b = (req.body || {}) as { upsert?: unknown; delete?: unknown; full?: boolean; sync_id?: string };
      const ups = Array.isArray(b.upsert) ? b.upsert.slice(0, 200) : [];
      const dels = Array.isArray(b.delete) ? b.delete.filter((x) => typeof x === 'string').slice(0, 1000) : [];
      if (b.full && !b.sync_id) return reply.code(400).send({ error: 'Full sync batches need a sync_id.' });
      const upserted = await upsertDocs(req.site!.id, ups as any[], b.full ? String(b.sync_id) : null);
      const deleted = await deleteDocs(req.site!.id, dels as string[]);
      return { ok: true, upserted, deleted };
    });

    r.post('/api/v1/sites/:site/knowledge/commit', async (req, reply) => {
      const b = (req.body || {}) as { sync_id?: string };
      if (!b.sync_id) return reply.code(400).send({ error: 'Missing sync_id.' });
      return { ok: true, pruned: await commitSync(req.site!.id, String(b.sync_id)) };
    });

    r.post('/api/v1/sites/:site/privacy/erase', async (req, reply) => {
      const email = String(((req.body || {}) as { email?: string }).email || '').trim().toLowerCase();
      if (!email) return reply.code(400).send({ error: 'Missing email.' });
      // Leads first: deleting conversations would cascade-delete their leads and hide the count.
      const leads = await query('DELETE FROM leads WHERE site_id = $1 AND lower(email) = $2 RETURNING id', [req.site!.id, email]);
      const convs = await query('DELETE FROM conversations WHERE site_id = $1 AND lower(email) = $2 RETURNING id', [req.site!.id, email]);
      return { ok: true, conversations: convs.length, leads: leads.length };
    });
  });
}
