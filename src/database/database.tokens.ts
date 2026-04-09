import type { Pool, PoolClient } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

export type PgPool = Pool;
export type PgClient = PoolClient;
