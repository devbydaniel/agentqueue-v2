import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../src/database/database.tokens.js';

let pool: pg.Pool;
let db: DrizzleDb;

export function getTestDb(): DrizzleDb {
  if (!db) {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'TEST_DATABASE_URL not set — is the global setup running?',
      );
    }
    pool = new pg.Pool({ connectionString });
    db = drizzle(pool);
  }
  return db;
}

export function getTestPool(): pg.Pool {
  getTestDb(); // ensures pool is initialised
  return pool;
}

export async function truncateAll(): Promise<void> {
  const testDb = getTestDb();
  await testDb.execute(
    sql`TRUNCATE TABLE linear_sessions, flow_steps, flow_runs, run_events, runs CASCADE`,
  );
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
