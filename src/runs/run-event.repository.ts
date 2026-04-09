import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PgPool } from '../database/database.tokens.js';
import { PG_POOL } from '../database/database.tokens.js';
import { mapRows } from '../database/query-helpers.js';
import type { RunEvent } from '../database/run-events.schema.js';

const MAX_LIMIT = 500;

export interface RunEventPagination {
  limit?: number;
  offset?: number;
}

@Injectable()
export class RunEventRepository {
  private readonly logger = new Logger(RunEventRepository.name);

  constructor(@Inject(PG_POOL) private readonly pool: PgPool) {}

  async append(runId: string, type: string, payload: unknown): Promise<void> {
    await this.pool.query(
      'INSERT INTO run_events (run_id, type, payload) VALUES ($1, $2, $3)',
      [runId, type, payload ?? null],
    );
  }

  async findByRunId(
    runId: string,
    pagination: RunEventPagination = {},
  ): Promise<RunEvent[]> {
    const { limit = 100, offset = 0 } = pagination;
    const safeLim = Math.min(limit, MAX_LIMIT);

    const result = await this.pool.query(
      `SELECT * FROM run_events
      WHERE run_id = $1
      ORDER BY created_at ASC
      LIMIT $2
      OFFSET $3`,
      [runId, safeLim, offset],
    );

    return mapRows<RunEvent>(result.rows as Record<string, unknown>[]);
  }
}
