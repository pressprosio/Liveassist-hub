/** Secrets at rest, request signing, JWTs and password hashing. No native dependencies. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/* ---------- Encryption at rest (AES-256-GCM) ---------- */

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config().encryptionKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognized encrypted value');
  const d = createDecipheriv('aes-256-gcm', config().encryptionKey, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export function newSiteSecret(): string {
  return randomBytes(32).toString('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ---------- Request signing (matches the WordPress plugin) ---------- */

export const SIGNATURE_TOLERANCE_SEC = 300;

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signedHeaders(siteId: string, secret: string, body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'X-LAIC-Site': siteId, 'X-LAIC-Timestamp': ts, 'X-LAIC-Signature': sign(secret, ts, body) };
}

export function verifySignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SEC) return false;
  return safeEqual(sign(secret, timestamp, body), signature || '');
}

/* ---------- JWT (HS256) ---------- */

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(claims));
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

/** Decode without verifying, to find which site's secret to verify with. */
export function peekJwt(token: string): Record<string, any> | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function verifyJwt(token: string, secret: string, audience?: string): Record<string, any> | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: any;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256') return null;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (!safeEqual(expected, s)) return null;
  const claims = peekJwt(token);
  if (!claims) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && now >= claims.exp) return null;
  if (typeof claims.nbf === 'number' && now < claims.nbf - 30) return null;
  if (audience && claims.aud !== audience) return null;
  return claims;
}

/* ---------- Passwords (scrypt) ---------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function randomPassword(): string {
  return randomBytes(12).toString('base64url');
}
