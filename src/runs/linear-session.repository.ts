import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.tokens.js';
import { DRIZZLE } from '../database/database.tokens.js';
import { linearSessions } from '../database/linear-sessions.schema.js';

/**
 * Maps external webhook session IDs (for example Linear `agentSessionId`) to
 * the local pi session file path so follow-up messages can resume the same pi
 * session.
 *
 * Backed by Postgres via Drizzle.
 */
@Injectable()
export class LinearSessionRepository {
  private readonly logger = new Logger(LinearSessionRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async findFilePath(externalSessionId: string): Promise<string | null> {
    const rows = await this.db
      .select({ filePath: linearSessions.filePath })
      .from(linearSessions)
      .where(eq(linearSessions.externalSessionId, externalSessionId))
      .limit(1);

    return rows[0]?.filePath ?? null;
  }

  async saveFilePath(
    externalSessionId: string,
    filePath: string,
  ): Promise<void> {
    await this.db
      .insert(linearSessions)
      .values({ externalSessionId, filePath })
      .onConflictDoUpdate({
        target: linearSessions.externalSessionId,
        set: { filePath },
      });

    this.logger.debug('Stored session file mapping', {
      externalSessionId,
      filePath,
    });
  }
}
