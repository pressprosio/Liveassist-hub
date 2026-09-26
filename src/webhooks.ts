/** Outbox for signed webhooks to WordPress, retried with backoff for up to 24 hours. */
import { config } from './config.js';
import { signedHeaders } from './crypto.js';
import { query } from './db.js';
import { getSite } from './sites.js';
import { log, errMsg } from './log.js';

const GIVE_UP_MS = 24 * 3600 * 1000;

export async function enqueueWebhook(siteId: string, event: string, data: Record<string, unknown>): Promise<void> {
  await query('INSERT INTO webhook_outbox (site_id, event, payload) VALUES ($1, $2, $3)', [siteId, event, JSON.stringify({ event, data })]);
  setImmediate(() => processWebhooks().catch(() => {}));
}

let running = false;

export async function processWebhooks(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Claim a batch atomically so several hub instances never double-send.
    const due = await query<{ id: string; site_id: string; payload: any; attempts: number; created_at: Date }>(
      `UPDATE webhook_outbox SET next_attempt_at = now() + interval '5 minutes'
        WHERE id IN (SELECT id FROM webhook_outbox
                      WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
                      ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING id, site_id, payload, attempts, created_at`,
    );
    for (const job of due) await deliver(job);
  } finally {
    running = false;
  }
}

async function deliver(job: { id: string; site_id: string; payload: any; attempts: number; created_at: Date }) {
  const site = await getSite(job.site_id);
  const url = site?.config.site?.webhook;
  let error = '';
  if (!site || !url) {
    error = 'Site has no webhook URL yet (WordPress has not sent its settings).';
  } else if (!url.startsWith('https://') && !config().allowInsecureWebhooks) {
    error = 'Webhook URL must use https.';
  } else {
    const body = JSON.stringify(job.payload);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'LiveAssist-Hub/0.1', ...signedHeaders(site.id, site.secret, body) },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        await query('UPDATE webhook_outbox SET delivered_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [job.id]);
        return;
      }
      error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    } catch (e) {
      error = errMsg(e);
    }
  }

  const attempts = job.attempts + 1;
  const expired = Date.now() - new Date(job.created_at).getTime() > GIVE_UP_MS;
  const delaySec = Math.min(2 * 3600, 30 * 2 ** (attempts - 1));
  await query(
    `UPDATE webhook_outbox SET attempts = $2, last_error = $3,
            next_attempt_at = now() + make_interval(secs => $4), failed_at = CASE WHEN $5 THEN now() END
      WHERE id = $1`,
    [job.id, attempts, error, delaySec, expired],
  );
  log.warn('webhook delivery failed', { site: job.site_id, event: job.payload?.event, attempts, error, gaveUp: expired });
}
