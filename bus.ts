/**
 * Event bus over Redis pub/sub so every hub instance sees every event.
 * Channels:
 *   conv:<conversationId>  events for the visitor's open sockets
 *   agents                 events for all connected agents
 */
import { redis, redisSub } from './redis.js';
import { log } from './log.js';

export type BusEvent = Record<string, unknown> & { type: string };
type Handler = (e: BusEvent) => void;

const PREFIX = 'laic:';
const handlers = new Map<string, Set<Handler>>();
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  redisSub().on('message', (channel: string, raw: string) => {
    const set = handlers.get(channel.slice(PREFIX.length));
    if (!set) return;
    let evt: BusEvent;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    for (const h of set) {
      try {
        h(evt);
      } catch (e) {
        log.error('bus handler failed', { error: (e as Error).message });
      }
    }
  });
}

export function publish(channel: string, evt: BusEvent): void {
  redis().publish(PREFIX + channel, JSON.stringify(evt)).catch((e) => log.error('publish failed', { error: e.message }));
}

export function subscribe(channel: string, h: Handler): () => void {
  wire();
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    redisSub().subscribe(PREFIX + channel).catch((e) => log.error('subscribe failed', { error: e.message }));
  }
  set.add(h);
  return () => {
    const s = handlers.get(channel);
    if (!s) return;
    s.delete(h);
    if (!s.size) {
      handlers.delete(channel);
      redisSub().unsubscribe(PREFIX + channel).catch(() => {});
    }
  };
}

export const convChannel = (id: string) => `conv:${id}`;
export const AGENTS = 'agents';
