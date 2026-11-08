import { readFileSync } from 'node:fs';
import { db } from '../lib/db.js';
import { syncSources } from '../lib/pipeline.js';

/** Usage:  DATABASE_URL=... npm run migrate   (safe to run again) */
const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
await db().query(sql);
console.log('Tables ready.');
console.log(`Sources loaded: ${await syncSources()}`);
await db().end();
