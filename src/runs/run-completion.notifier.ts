import { Inject, Injectable, Logger } from '@nestjs/common';
import { PG_POOL } from '../database/database.tokens.js';
import type { PgPool } from '../database/database.tokens.js';

export const RUN_COMPLETED_CHANNEL = 'run_completed';

@Injectable()
export class RunCompletionNotifier {
  private readonly logger = new Logger(RunCompletionNotifier.name);

  constructor(@Inject(PG_POOL) private readonly pool: PgPool) {}

  async notify(runId: string): Promise<void> {
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [
        RUN_COMPLETED_CHANNEL,
        runId,
      ]);
      this.logger.debug('Sent run completion notification', { runId });
    } catch (error) {
      this.logger.warn('Failed to send run completion notification', {
        runId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
