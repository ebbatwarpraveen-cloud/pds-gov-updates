import pg from 'pg';
import { env } from './config.js';

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    const url = env('DATABASE_URL');
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db().query(text, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}
