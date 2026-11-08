import { q } from './db.js';

type Level = 'info' | 'warn' | 'error';

export async function log(level: Level, scope: string, message: string, meta?: unknown): Promise<void> {
  const line = `[${level}] ${scope}: ${message}`;
  (level === 'error' ? console.error : console.log)(line, meta ? JSON.stringify(meta).slice(0, 500) : '');
  try {
    await q('INSERT INTO logs(level, scope, message, meta) VALUES ($1,$2,$3,$4)', [
      level,
      scope,
      message.slice(0, 1000),
      meta === undefined ? null : JSON.stringify(meta).slice(0, 4000),
    ]);
  } catch {
    /* logging must never break the pipeline */
  }
}
