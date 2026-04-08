import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

export type PgPool = Pool;
export type DrizzleDb = NodePgDatabase;
