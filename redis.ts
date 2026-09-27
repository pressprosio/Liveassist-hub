/** Redis connections: one for commands/publishing, one dedicated to subscriptions. */
import { Redis } from 'ioredis';
import { config } from './config.js';
import { log } from './log.js';

let cmd: Redis | null = null;
let sub: Redis | null = null;

function make(name: string): Redis {
  const r = new Redis(config().redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  r.on('error', (e) => log.warn(`redis ${name} error`, { error: e.message }));
  return r;
}

export function redis(): Redis {
  if (!cmd) cmd = make('cmd');
  return cmd;
}
export function redisSub(): Redis {
  if (!sub) sub = make('sub');
  return sub;
}

/** Fixed-window counter. Returns true when the limit is exceeded. */
export async function overLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const r = redis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, windowSec);
  return n > limit;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([cmd?.quit(), sub?.quit()]);
  cmd = sub = null;
}
