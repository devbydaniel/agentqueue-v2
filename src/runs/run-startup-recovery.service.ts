import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { RunRepository } from './run.repository.js';

/**
 * Marks abandoned `running` rows as `interrupted` on startup.
 *
 * If the process crashed or was killed while runs were in progress,
 * those rows will be stuck in `running` status forever. This service
 * recovers them so the dashboard surfaces them and the user can decide
 * whether to retry.
 */
@Injectable()
export class RunStartupRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(RunStartupRecoveryService.name);

  constructor(private readonly runRepository: RunRepository) {}

  async onModuleInit(): Promise<void> {
    try {
      const result = await this.runRepository.markRunningAsInterrupted();

      if (result.length > 0) {
        this.logger.warn(`Recovered ${result.length} interrupted run(s)`, {
          runIds: result.map((r) => r.id),
        });
      } else {
        this.logger.log('No abandoned runs found at startup');
      }
    } catch (error) {
      this.logger.error('Failed to recover interrupted runs at startup', {
        error: error as Error,
      });
    }
  }
}
