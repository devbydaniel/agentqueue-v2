import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { LinearCallbackHandlerFactory } from '../callbacks/handlers/linear.callback-handler.js';
import { RunRepository, type InterruptedRun } from './run.repository.js';

/**
 * Marks abandoned `running` rows as `interrupted` on startup.
 *
 * If the process crashed or was killed while runs were in progress,
 * those rows will be stuck in `running` status forever. This service
 * recovers them so the dashboard surfaces them and the user can decide
 * whether to retry. Linear runs also get the error in their agent session,
 * where the person who started them is watching.
 */
@Injectable()
export class RunStartupRecoveryService
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly logger = new Logger(RunStartupRecoveryService.name);
  private recovered: InterruptedRun[] = [];

  constructor(
    private readonly runRepository: RunRepository,
    private readonly linearFactory: LinearCallbackHandlerFactory,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.recovered = await this.runRepository.markRunningAsInterrupted();

      if (this.recovered.length > 0) {
        this.logger.warn(
          `Recovered ${this.recovered.length} interrupted run(s)`,
          { runIds: this.recovered.map((r) => r.id) },
        );
      } else {
        this.logger.log('No abandoned runs found at startup');
      }
    } catch (error) {
      this.logger.error('Failed to recover interrupted runs at startup', {
        error: error as Error,
      });
    }
  }

  // Linear triggers are loaded in onModuleInit, so the handlers can only be
  // built once every module has initialised. Not awaited: boot must not wait
  // on Linear, and emitError logs its own failures.
  onApplicationBootstrap(): void {
    for (const run of this.recovered) {
      if (run.source !== 'linear' || !run.triggerName) continue;
      if (!run.externalSessionId || !run.errorMessage) continue;

      void this.linearFactory
        .createForRun(run.triggerName, run.externalSessionId)
        ?.emitError(run.errorMessage);
    }
  }
}
