import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import { UnexpectedFlowError } from './flows.errors.js';

export interface AbortFlowCommand {
  flowRunId: string;
}

export interface AbortFlowResult {
  aborted: boolean;
}

@Injectable()
export class AbortFlowUseCase {
  private readonly logger = new Logger(AbortFlowUseCase.name);

  constructor(private readonly flowAbortTracker: FlowAbortTrackerService) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async signature for use-case consistency; tracker is sync
  async execute(command: AbortFlowCommand): Promise<AbortFlowResult> {
    this.logger.log('Aborting flow run', { flowRunId: command.flowRunId });

    try {
      const aborted = this.flowAbortTracker.abort(command.flowRunId);
      return { aborted };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error aborting flow run', { error: error as Error });
      throw new UnexpectedFlowError(error);
    }
  }
}
