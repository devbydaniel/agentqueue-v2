import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import {
  FlowRunRepository,
  type FlowRun,
} from '../infrastructure/flow-run.repository.js';
import { UnexpectedFlowError } from './flows.errors.js';

interface ListFlowRunsCommand {
  flowName: string;
}

@Injectable()
export class ListFlowRunsUseCase {
  private readonly logger = new Logger(ListFlowRunsUseCase.name);

  constructor(private readonly flowRunRepository: FlowRunRepository) {}

  async execute(command: ListFlowRunsCommand): Promise<FlowRun[]> {
    this.logger.log('Listing flow runs', { flowName: command.flowName });

    try {
      return await this.flowRunRepository.findByFlowName(command.flowName);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error listing flow runs', { error: error as Error });
      throw new UnexpectedFlowError(error);
    }
  }
}
