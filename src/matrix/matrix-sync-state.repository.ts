import { Inject, Injectable } from '@nestjs/common';
import type { PgPool } from '../database/database.tokens.js';
import { PG_POOL } from '../database/database.tokens.js';

/** Persists each Matrix bot's /sync `next_batch` token across restarts. */
@Injectable()
export class MatrixSyncStateRepository {
  constructor(@Inject(PG_POOL) private readonly pool: PgPool) {}

  async getNextBatch(botName: string): Promise<string | undefined> {
    const result = await this.pool.query(
      'SELECT next_batch FROM matrix_sync_state WHERE bot_name = $1',
      [botName],
    );
    const row = result.rows[0] as { next_batch?: string } | undefined;
    return row?.next_batch;
  }

  async setNextBatch(botName: string, nextBatch: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO matrix_sync_state (bot_name, next_batch, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (bot_name) DO UPDATE SET
         next_batch = EXCLUDED.next_batch,
         updated_at = EXCLUDED.updated_at`,
      [botName, nextBatch],
    );
  }
}
