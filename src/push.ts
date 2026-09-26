/**
 * Push notifications to agents' phones through Firebase Cloud Messaging.
 * FCM delivers to Android directly and to iOS through APNs (upload your APNs key in Firebase).
 * Optional: without FIREBASE_SERVICE_ACCOUNT the hub runs normally, just without push.
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { removeDevice } from './agents.js';
import { log, errMsg } from './log.js';

type Messaging = { sendEachForMulticast: (m: any) => Promise<{ responses: { success: boolean; error?: { code: string } }[] }> };
let messaging: Messaging | null | undefined;

async function client(): Promise<Messaging | null> {
  if (messaging !== undefined) return messaging;
  const raw = config().firebaseServiceAccount;
  if (!raw) return (messaging = null);
  try {
    const json = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    const app = initializeApp({ credential: cert(JSON.parse(json)) }, 'laic');
    messaging = getMessaging(app) as unknown as Messaging;
    log.info('push notifications enabled');
  } catch (e) {
    log.error('push setup failed; continuing without push', { error: errMsg(e) });
    messaging = null;
  }
  return messaging;
}

export function pushEnabled(): boolean {
  return Boolean(config().firebaseServiceAccount);
}

export async function sendPush(tokens: string[], n: { title: string; body: string; data?: Record<string, string> }): Promise<void> {
  if (!tokens.length) return;
  const m = await client();
  if (!m) return;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    try {
      const res = await m.sendEachForMulticast({
        tokens: batch,
        notification: { title: n.title, body: n.body.slice(0, 180) },
        data: n.data || {},
        android: { priority: 'high', notification: { channelId: 'chats', sound: 'default' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      res.responses.forEach((r, idx) => {
        const code = r.error?.code || '';
        if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument'))) {
          removeDevice(batch[idx]!).catch(() => {});
        }
      });
    } catch (e) {
      log.error('push send failed', { error: errMsg(e) });
    }
  }
}
