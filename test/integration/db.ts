import pg from 'pg';
import type { PgPool } from '../../src/database/database.tokens.js';

let pool: pg.Pool;
let db: PgPool;

export function getTestDb(): PgPool {
  if (!db) {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'TEST_DATABASE_URL not set — is the global setup running?',
      );
    }
    pool = new pg.Pool({ connectionString });
    db = pool;
  }
  return db;
}

export function getTestPool(): pg.Pool {
  getTestDb(); // ensures pool is initialised
  return pool;
}

export async function truncateAll(): Promise<void> {
  await getTestDb().query(
    'TRUNCATE TABLE external_sessions, flow_steps, flow_runs, run_events, runs CASCADE',
  );
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
