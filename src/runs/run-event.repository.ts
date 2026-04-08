import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.tokens.js';
import { DRIZZLE } from '../database/database.tokens.js';
import { runEvents } from '../database/run-events.schema.js';
import type { RunEvent } from '../database/run-events.schema.js';

const MAX_LIMIT = 500;

export interface RunEventPagination {
  limit?: number;
  offset?: number;
}

@Injectable()
export class RunEventRepository {
  private readonly logger = new Logger(RunEventRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async append(runId: string, type: string, payload: unknown): Promise<void> {
    await this.db.insert(runEvents).values({
      runId,
      type,
      payload,
    });
  }

  async findByRunId(
    runId: string,
    pagination: RunEventPagination = {},
  ): Promise<RunEvent[]> {
    const { limit = 100, offset = 0 } = pagination;
    const safeLim = Math.min(limit, MAX_LIMIT);

    return this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.createdAt))
      .limit(safeLim)
      .offset(offset);
  }
}
