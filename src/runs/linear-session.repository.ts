import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.tokens.js';
import { DRIZZLE } from '../database/database.tokens.js';
import { linearSessions } from '../database/linear-sessions.schema.js';

/**
 * Maps external Linear session keys (`agentSessionId`) to the local pi
 * session file path so a follow-up message in the same Linear session can
 * resume the previous pi session.
 *
 * Backed by Postgres via Drizzle.
 */
@Injectable()
export class LinearSessionRepository {
  private readonly logger = new Logger(LinearSessionRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async findFilePath(sessionKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ filePath: linearSessions.filePath })
      .from(linearSessions)
      .where(eq(linearSessions.sessionKey, sessionKey))
      .limit(1);

    return rows[0]?.filePath ?? null;
  }

  async saveFilePath(sessionKey: string, filePath: string): Promise<void> {
    await this.db
      .insert(linearSessions)
      .values({ sessionKey, filePath })
      .onConflictDoUpdate({
        target: linearSessions.sessionKey,
        set: { filePath },
      });

    this.logger.debug('Stored session file mapping', { sessionKey, filePath });
  }
}
