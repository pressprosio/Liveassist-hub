/** Minimal JSON-lines logger (the HTTP server uses Fastify's own logger). */
const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const min = levels[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (levels[level] < min) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => write('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => write('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => write('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => write('error', m, e),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
