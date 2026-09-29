/**
 * Push notifications to team members' phones.
 *
 * The LiveAssist app registers Expo push tokens ("ExponentPushToken[...]"), delivered through
 * Expo's push service to Apple (APNs) and Google (FCM). That needs no credentials on this server.
 * Raw Firebase tokens are also supported if FIREBASE_SERVICE_ACCOUNT is set.
 */
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { removeDevice } from './agents.js';
import { log, errMsg } from './log.js';

export interface PushMessage { title: string; body: string; data?: Record<string, string> }

const EXPO_URL = process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
const isExpo = (t: string) => /^Expo(nent)?PushToken\[.+\]$/.test(t);

export function pushEnabled(): boolean {
  return true; // Expo push works without server configuration.
}

export async function sendPush(tokens: string[], n: PushMessage): Promise<void> {
  const unique = [...new Set(tokens)];
  const expo = unique.filter(isExpo);
  const fcm = unique.filter((t) => !isExpo(t));
  await Promise.all([sendExpo(expo, n), sendFcm(fcm, n)]);
}

/* ---------- Expo push service ---------- */

async function sendExpo(tokens: string[], n: PushMessage): Promise<void> {
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    const body = batch.map((to) => ({
      to, title: n.title, body: n.body.slice(0, 180), data: n.data || {},
      sound: 'default', priority: 'high', channelId: 'chats',
    }));
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
      const res = await fetch(EXPO_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      const json = (await res.json().catch(() => ({}))) as { data?: { status: string; details?: { error?: string }; message?: string }[]; errors?: unknown };
      if (!res.ok) {
        log.warn('expo push rejected', { status: res.status, errors: json.errors });
        continue;
      }
      (json.data || []).forEach((ticket, idx) => {
        if (ticket.status !== 'error') return;
        if (ticket.details?.error === 'DeviceNotRegistered') removeDevice(batch[idx]!).catch(() => {});
        else log.warn('expo push ticket error', { error: ticket.details?.error, message: ticket.message });
      });
    } catch (e) {
      log.error('expo push failed', { error: errMsg(e) });
    }
  }
}

/* ---------- Firebase (optional, for raw FCM tokens) ---------- */

type Messaging = { sendEachForMulticast: (m: any) => Promise<{ responses: { success: boolean; error?: { code: string } }[] }> };
let messaging: Messaging | null | undefined;

async function fcmClient(): Promise<Messaging | null> {
  if (messaging !== undefined) return messaging;
  const raw = config().firebaseServiceAccount;
  if (!raw) return (messaging = null);
  try {
    const json = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    messaging = getMessaging(initializeApp({ credential: cert(JSON.parse(json)) }, 'laic')) as unknown as Messaging;
  } catch (e) {
    log.error('firebase setup failed', { error: errMsg(e) });
    messaging = null;
  }
  return messaging;
}

async function sendFcm(tokens: string[], n: PushMessage): Promise<void> {
  if (!tokens.length) return;
  const m = await fcmClient();
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
        if (!r.success && /registration-token-not-registered|invalid-registration-token/.test(code)) removeDevice(batch[idx]!).catch(() => {});
      });
    } catch (e) {
      log.error('fcm push failed', { error: errMsg(e) });
    }
  }
}
