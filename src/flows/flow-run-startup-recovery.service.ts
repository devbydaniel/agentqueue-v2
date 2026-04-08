import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FlowRunRepository } from './flow-run.repository.js';

/**
 * Marks abandoned `running` flow runs as `interrupted` on startup.
 *
 * If the process crashed or was killed while flows were in progress,
 * those rows will be stuck in `running` status forever. This service
 * recovers them so the dashboard surfaces them and the user can decide
 * whether to retry.
 */
@Injectable()
export class FlowRunStartupRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(FlowRunStartupRecoveryService.name);

  constructor(private readonly flowRunRepository: FlowRunRepository) {}

  async onModuleInit(): Promise<void> {
    try {
      const result = await this.flowRunRepository.markRunningAsInterrupted();

      if (result.length > 0) {
        this.logger.warn(`Recovered ${result.length} interrupted flow run(s)`, {
          flowRunIds: result.map((r) => r.flowRunId),
        });
      } else {
        this.logger.log('No abandoned flow runs found at startup');
      }
    } catch (error) {
      this.logger.error('Failed to recover interrupted flow runs at startup', {
        error: error as Error,
      });
    }
  }
}
