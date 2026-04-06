import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import {
  FlowRunRepository,
  type FlowRun,
} from '../infrastructure/flow-run.repository.js';
import { FlowRunNotFoundError, UnexpectedFlowError } from './flows.errors.js';

interface GetFlowRunCommand {
  flowRunId: string;
}

@Injectable()
export class GetFlowRunUseCase {
  private readonly logger = new Logger(GetFlowRunUseCase.name);

  constructor(private readonly flowRunRepository: FlowRunRepository) {}

  async execute(command: GetFlowRunCommand): Promise<FlowRun> {
    this.logger.log('Getting flow run', { flowRunId: command.flowRunId });

    try {
      const run = await this.flowRunRepository.findById(command.flowRunId);
      if (!run) {
        throw new FlowRunNotFoundError(command.flowRunId);
      }
      return run;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error getting flow run', { error: error as Error });
      throw new UnexpectedFlowError(error);
    }
  }
}
